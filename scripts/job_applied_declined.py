import os
import base64
import csv
import glob
import json
import logging
import random
import re
import requests
import shutil
import time
from datetime import datetime
from email.utils import parsedate_to_datetime
from pathlib import Path
from google.auth.exceptions import RefreshError
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
import pymongo

# --- SCOPES & CONFIGURATION ---
SCOPES = [
    'https://www.googleapis.com/auth/gmail.modify'
]

APPLIED_LABEL = '_ _ JOB SEARCH/a APPLIED'
DECLINED_LABEL = '_ _ JOB SEARCH/a DECLINED'
PROCESSED_LABEL = '_ _ JOB SEARCH/IC'

TOKEN_PATH = 'secrets/token.json'

# --- MongoDB Config ---
MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017/")
MONGO_DB_NAME = os.getenv("MONGO_DB_NAME", "job_search")
MONGO_COLLECTION = "job_listings"

# --- Local Directory & Logging Config ---
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent if SCRIPT_DIR.name == 'scripts' else SCRIPT_DIR

LOG_DIR = PROJECT_ROOT / 'logs'
ARCHIVE_DIR = LOG_DIR / 'archives' / 'job_applied_declined'
RUN_TIMESTAMP = datetime.now().strftime('%Y_%m_%d_%S')

LOG_PATH = LOG_DIR / f'{RUN_TIMESTAMP}_job_applied_declined.log'
CSV_PATH = LOG_DIR / f'{RUN_TIMESTAMP}_processed_applications.csv'

# --- Local LLM (Ollama) config ---
OLLAMA_URL = 'http://localhost:11434/api/generate'
OLLAMA_MODEL = 'qwen2.5:7b-instruct'
OLLAMA_TIMEOUT = 30

EXTRACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "company": {"type": "string"},
        "source": {"type": "string"},
        "category": {
            "type": "string",
            "enum": [
                "application_confirmation", "recruiter_followup", "cold_outreach",
                "rejection", "interview_request", "status_update", "other"
            ]
        },
        "notes": {"type": "string"}
    },
    "required": ["title", "company", "source", "category", "notes"]
}


def setup_logging():
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    logger = logging.getLogger('job_applied_declined')
    logger.setLevel(logging.DEBUG)

    if not logger.handlers:
        file_handler = logging.FileHandler(LOG_PATH, encoding='utf-8')
        file_handler.setLevel(logging.DEBUG)
        file_handler.setFormatter(logging.Formatter('%(asctime)s [%(levelname)s] %(message)s'))

        console_handler = logging.StreamHandler()
        console_handler.setLevel(logging.INFO)
        console_handler.setFormatter(logging.Formatter('%(message)s'))

        logger.addHandler(file_handler)
        logger.addHandler(console_handler)

    logger.info(f"Log file for this run: {LOG_PATH}")
    return logger


def archive_old_files(logger):
    """Moves older logs and CSV backups into archive subfolders."""
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    
    patterns = {
        'CSV': list(LOG_DIR.glob('processed_applications_*.csv')),
        'log': list(LOG_DIR.glob('*_job_applied_declined.log')),
    }

    for label, files in patterns.items():
        valid_files = [f for f in files if f.is_file()]
        if len(valid_files) <= 1:
            continue
        
        valid_files.sort(key=lambda x: x.stat().st_mtime, reverse=True)
        older_files = valid_files[1:]
        
        moved = 0
        for f in older_files:
            try:
                dest = ARCHIVE_DIR / f.name
                shutil.move(str(f), str(dest))
                moved += 1
            except Exception as e:
                logger.error(f"Failed to archive {label} file {f.name}: {e}")
        if moved:
            logger.info(f"Archived {moved} old {label} file(s) to {ARCHIVE_DIR}")


def append_to_csv(row_data, logger):
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    file_exists = CSV_PATH.exists()
    headers = ["Date", "Title", "Company", "Email", "URL", "Status", "Source", "MessageID", "Notes", "Gmail Link"]
    
    try:
        with open(CSV_PATH, mode='a', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            if not file_exists:
                writer.writerow(headers)
            writer.writerow(row_data)
        logger.debug(f"Successfully appended entry to local CSV backup: {CSV_PATH.name}")
    except Exception as e:
        logger.error(f"Failed to write to local CSV backup: {e}")


def parse_email_date(date_str):
    try:
        dt = parsedate_to_datetime(date_str)
        return dt.strftime('%Y-%m-%d')
    except Exception:
        return date_str


def build_gmail_link(msg_id):
    return f"https://mail.google.com/mail/u/0/#all/{msg_id}"


def get_valid_creds():
    creds = None
    if os.path.exists(TOKEN_PATH):
        creds = Credentials.from_authorized_user_file(TOKEN_PATH, SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
            except RefreshError as e:
                logging.getLogger('job_applied_declined').warning(
                    f"Token refresh failed ({e}); re-authenticating."
                )
                creds = None
        if not creds or not creds.valid:
            flow = InstalledAppFlow.from_client_secrets_file('secrets/credentials.json', SCOPES)
            creds = flow.run_local_server(port=0)
        with open(TOKEN_PATH, 'w') as token:
            token.write(creds.to_json())
    return creds


def get_gmail_service():
    return build('gmail', 'v1', credentials=get_valid_creds())


def get_mongo_collection(logger):
    try:
        client = pymongo.MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
        client.admin.command('ping')
        db = client[MONGO_DB_NAME]
        collection = db[MONGO_COLLECTION]
        
        collection.create_index(
            [("title", 1), ("company", 1), ("message_id", 1)],
            unique=True
        )
        return collection
    except Exception as e:
        logger.error(f"Failed to connect to MongoDB at {MONGO_URI}: {e}")
        return None


def extract_email_body(payload):
    body = ""
    if 'body' in payload and payload['body'].get('data'):
        data = payload['body']['data']
        try:
            body = base64.urlsafe_b64decode(data.encode('ASCII')).decode('utf-8', errors='ignore')
        except Exception:
            pass

    if body:
        return body

    if 'parts' in payload:
        for part in payload['parts']:
            if part.get('mimeType', '') == 'text/plain':
                data = part['body'].get('data')
                if data:
                    try:
                        return base64.urlsafe_b64decode(data.encode('ASCII')).decode('utf-8', errors='ignore')
                    except Exception:
                        pass
            elif 'parts' in part:
                sub_body = extract_email_body(part)
                if sub_body:
                    return sub_body

    if 'parts' in payload:
        for part in payload['parts']:
            if part.get('mimeType', '') == 'text/html':
                data = part['body'].get('data')
                if data:
                    try:
                        return base64.urlsafe_b64decode(data.encode('ASCII')).decode('utf-8', errors='ignore')
                    except Exception:
                        pass
    return ""


def guess_source_from_domain(from_email):
    match = re.search(r'@([\w.-]+)', from_email)
    if not match:
        return "Unknown"
    domain = match.group(1).lower()
    domain = re.sub(r'^(mail|email|notifications?|no-?reply|alerts?|us|jobs|careers)\.', '', domain)
    core = domain.split('.')[0] if domain else domain
    core = re.sub(r'-?(mail|notifications?|alerts?)$', '', core)
    return core.replace('-', ' ').replace('_', ' ').title() if core else "Unknown"


def regex_fallback_extract(subject, body, from_email):
    company = "Needs Review"
    title = subject if subject else "Unknown Title"
    source = guess_source_from_domain(from_email)

    match_company = re.search(r'(?:applying to|to|sent to)\s+([A-Z0-9a-z\s\.\,\&]+?)(?:!|\.|\n|$)', subject, re.IGNORECASE)
    if match_company:
        comp_candidate = match_company.group(1).strip()
        company = re.sub(r'[\!\.\,\?]+$', '', comp_candidate).strip()

    return title, company, source, "LLM unavailable - used regex fallback, verify manually"


def build_llm_prompt(subject, body, from_email):
    body_snippet = body[:2500]
    return f"""You are helping extract structured metadata from a job-search email.

FROM: {from_email}
SUBJECT: {subject}
BODY:
{body_snippet}

RULES FOR EXTRACTION:
1. "title": The specific job position/role. Look in the subject line or body snippet. If missing, use "Unknown Title".
2. "company": The REAL hiring company name receiving the application. 
   - Do NOT use "LinkedIn", "Indeed", "Greenhouse", "Workday", etc. unless they are the actual employer hiring. If missing, use "Needs Review".
3. "source": ATS or Job Board Platform (e.g., Greenhouse, Lever, Workday, LinkedIn, Indeed, Direct).
4. "category": One of "application_confirmation", "recruiter_followup", "cold_outreach", "rejection", "interview_request", "status_update", "other".
5. "notes": DEFAULT TO AN EMPTY STRING "".

Respond with ONLY a raw JSON object matching the schema."""


def extract_metadata_with_llm(subject, body, from_email, logger):
    prompt = build_llm_prompt(subject, body, from_email)
    try:
        resp = requests.post(
            OLLAMA_URL,
            json={
                "model": OLLAMA_MODEL,
                "prompt": prompt,
                "stream": False,
                "format": EXTRACTION_SCHEMA
            },
            timeout=OLLAMA_TIMEOUT
        )
        resp.raise_for_status()
        raw_text = resp.json().get('response', '').strip()

        cleaned = re.sub(r'^```(?:json)?|```$', '', raw_text, flags=re.MULTILINE).strip()
        parsed = json.loads(cleaned)

        title = parsed.get('title') or "Unknown Title"
        company = parsed.get('company') or "Needs Review"
        source = parsed.get('source') or "Unknown"
        notes = parsed.get('notes') or ""

        return title, company, source, notes

    except Exception as e:
        logger.warning(f"LLM extraction failed ({e}); falling back to regex heuristic.")
        return regex_fallback_extract(subject, body, from_email)


def execute_with_backoff(request, logger, max_retries=5, what=""):
    for attempt in range(max_retries):
        try:
            return request.execute()
        except HttpError as e:
            status = getattr(e, 'status_code', None) or getattr(e.resp, 'status', None)
            retryable = status in (403, 429, 500, 503)
            if not retryable or attempt == max_retries - 1:
                raise
            wait = (2 ** attempt) + random.uniform(0, 1)
            logger.warning(f"{what or 'API call'} hit retryable error (status {status}), backing off {wait:.1f}s")
            time.sleep(wait)


def list_all_messages(gmail_service, query, logger):
    all_messages = []
    page_token = None
    while True:
        request = gmail_service.users().messages().list(
            userId='me', q=query, maxResults=500, pageToken=page_token
        )
        resp = execute_with_backoff(request, logger, what="messages.list")
        all_messages.extend(resp.get('messages', []))
        page_token = resp.get('nextPageToken')
        if not page_token:
            break
    logger.debug(f"Listed {len(all_messages)} total message(s) for query: {query}")
    return all_messages


def _is_retryable_http_error(exc):
    status = getattr(exc, 'status_code', None) or getattr(getattr(exc, 'resp', None), 'status', None)
    return status in (403, 429, 500, 503)


def batch_fetch_messages(gmail_service, message_briefs, logger, batch_size=20,
                          inter_chunk_delay=0.5, max_retry_rounds=5):
    fetched = {}
    pending = list(message_briefs)

    for round_num in range(1, max_retry_rounds + 1):
        round_errors = {}

        def make_callback(msg_id):
            def callback(request_id, response, exception):
                if exception is not None:
                    round_errors[msg_id] = exception
                else:
                    fetched[msg_id] = response
            return callback

        for i in range(0, len(pending), batch_size):
            chunk = pending[i:i + batch_size]
            batch = gmail_service.new_batch_http_request()
            for msg_brief in chunk:
                msg_id = msg_brief['id']
                batch.add(
                    gmail_service.users().messages().get(userId='me', id=msg_id, format='full'),
                    callback=make_callback(msg_id)
                )
            execute_with_backoff(batch, logger, what=f"batch fetch round {round_num}")
            if inter_chunk_delay:
                time.sleep(inter_chunk_delay)

        retryable_ids = {msg_id for msg_id, exc in round_errors.items() if _is_retryable_http_error(exc)}
        if not retryable_ids:
            break

        pending = [m for m in pending if m['id'] in retryable_ids]
        if round_num < max_retry_rounds:
            time.sleep((2 ** round_num) + random.uniform(0, 1))
            batch_size = max(5, batch_size // 2)

    return fetched


def get_or_create_label_id(service, label_name, logger):
    results = execute_with_backoff(service.users().labels().list(userId='me'), logger, what="labels.list")
    for label in results.get('labels', []):
        if label['name'].lower() == label_name.lower():
            return label['id']
    created = execute_with_backoff(
        service.users().labels().create(userId='me', body={'name': label_name}),
        logger, what="labels.create"
    )
    return created['id']


def write_to_mongodb(collection, documents, logger):
    if collection is None or not documents:
        return 0

    operations = [
        pymongo.UpdateOne(
            {
                "title": doc["title"],
                "company": doc["company"],
                "message_id": doc["message_id"]
            },
            {"$set": doc},
            upsert=True
        )
        for doc in documents
    ]

    try:
        result = collection.bulk_write(operations, ordered=False)
        upserted_count = result.upserted_count + result.modified_count
        logger.info(f"Successfully upserted {upserted_count} document(s) into MongoDB.")
        return upserted_count
    except Exception as e:
        logger.error(f"Error bulk writing to MongoDB: {e}")
        return 0


def main():
    logger = setup_logging()
    logger.info("Script starting...")

    gmail_service = get_gmail_service()
    mongo_coll = get_mongo_collection(logger)
    if mongo_coll is None:
        logger.critical("Aborting execution due to database connectivity failure.")
        return

    processed_label_id = get_or_create_label_id(gmail_service, PROCESSED_LABEL, logger)

    query_applied = f'label:"{APPLIED_LABEL}" -label:"{PROCESSED_LABEL}"'
    query_declined = f'label:"{DECLINED_LABEL}" -label:"{PROCESSED_LABEL}"'

    applied_msgs = list_all_messages(gmail_service, query_applied, logger)
    declined_msgs = list_all_messages(gmail_service, query_declined, logger)

    messages = [(msg, 'APPLIED') for msg in applied_msgs] + [(msg, 'DECLINED') for msg in declined_msgs]

    if not messages:
        logger.info("No new job search emails found matching criteria.")
        return

    logger.info(f"Found {len(messages)} new message(s) to process.")

    briefs = [m for m, _ in messages]
    fetched = batch_fetch_messages(gmail_service, briefs, logger)

    documents_to_upsert = []
    processed_ids = []

    for msg_brief, forced_status in messages:
        msg_id = msg_brief['id']
        msg = fetched.get(msg_id)
        if msg is None:
            logger.warning(f"Skipping message {msg_id} - batch fetch failed.")
            continue

        headers = msg['payload'].get('headers', [])
        date_raw = next((h['value'] for h in headers if h['name'].lower() == 'date'), 'Unknown Date')
        date = parse_email_date(date_raw)
        subject = next((h['value'] for h in headers if h['name'].lower() == 'subject'), '')
        from_header = next((h['value'] for h in headers if h['name'].lower() == 'from'), '')

        raw_email_body = extract_email_body(msg['payload']) or msg.get('snippet', '')
        gmail_link = build_gmail_link(msg_id)

        logger.info(f"--- Processing Email ID: {msg_id} ---")
        logger.info(f"  Date:    {date}")
        logger.info(f"  From:    {from_header}")
        logger.info(f"  Subject: {subject}")

        start_time = time.time()
        title, company, source, notes = extract_metadata_with_llm(subject, raw_email_body, from_header, logger)
        elapsed = time.time() - start_time

        logger.info(f"  LLM Result ({elapsed:.2f}s) -> Title: '{title}' | Company: '{company}' | Status: '{forced_status}'")

        doc = {
            "date": date,
            "title": title,
            "company": company,
            "email": from_header,
            "url": "",
            "status": forced_status,
            "source": source,
            "message_id": msg_id,
            "notes": notes,
            "gmail_link": gmail_link,
            "created_at": datetime.utcnow()
        }

        documents_to_upsert.append(doc)

        # 1. Propagation for DECLINED status across matching company/title records
        if forced_status == 'DECLINED' and company and company != "Needs Review":
            try:
                update_result = mongo_coll.update_many(
                    {
                        "company": {"$regex": f"^{re.escape(company)}$", "$options": "i"},
                        "title": {"$regex": f"^{re.escape(title)}$", "$options": "i"}
                    },
                    {"$set": {"status": "DECLINED"}}
                )
                logger.info(f"Propagated DECLINED status to {update_result.modified_count} existing record(s) for '{company} - {title}'.")
            except Exception as e:
                logger.error(f"Failed to propagate declined status for {company} - {title}: {e}")

        # 2. Propagation for APPLIED status when a confirmation/thank-you email arrives
        if forced_status == 'APPLIED' and company and company != "Needs Review":
            try:
                update_result = mongo_coll.update_many(
                    {
                        "company": {"$regex": f"^{re.escape(company)}$", "$options": "i"},
                        "title": {"$regex": f"^{re.escape(title)}$", "$options": "i"}
                    },
                    {"$set": {"status": "APPLIED"}}
                )
                logger.info(f"Propagated APPLIED status to {update_result.modified_count} existing record(s) for '{company} - {title}'.")
            except Exception as e:
                logger.error(f"Failed to propagate applied status for {company} - {title}: {e}")

        # Stream backup to local CSV
        row_data = [date, title, company, from_header, "", forced_status, source, msg_id, notes, gmail_link]
        append_to_csv(row_data, logger)

        processed_ids.append(msg_id)

    write_to_mongodb(mongo_coll, documents_to_upsert, logger)

    if processed_ids:
        request = gmail_service.users().messages().batchModify(
            userId='me',
            body={'ids': processed_ids, 'addLabelIds': [processed_label_id]}
        )
        execute_with_backoff(request, logger, what="gmail batchModify")
        logger.info(f"Marked {len(processed_ids)} message(s) as processed in Gmail.")

    logger.info("Script finished execution successfully.")
    archive_old_files(logger)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        try:
            logging.getLogger('job_applied_declined').exception(f"CRITICAL ERROR: {e}")
        except Exception:
            print(f"\nCRITICAL ERROR: {e}")
        import traceback
        traceback.print_exc()