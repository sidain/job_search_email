"""
download_sheets_to_mongo.py

A one-time standalone script to download data from the 'Job Listings' tab in the
shared Google Sheet, parse the rows, and store/upsert them into a local MongoDB database.
"""

import os
import json
import logging
from pathlib import Path
from datetime import datetime

import pymongo
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

# ==================== CONFIGURATION ====================
SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets.readonly',
]

SPREADSHEET_ID = '1EUFfZjv1Pb_3hueE15fJ7Eccze79gM4hOcK-0lQ0umk'
SHEET_NAME = 'Job Listings'
RANGE_NAME = f'{SHEET_NAME}!A:M'

TOKEN_PATH = 'secrets/token.json'
CREDENTIALS_PATH = 'secrets/credentials.json'
ENV_FILE = Path('./.env')

LOGS_DIR = Path('./logs')
LOG_FILE = LOGS_DIR / f"sheets_to_mongo_{datetime.now().strftime('%Y%m%d%H%M%S')}.log"

CSV_HEADERS = [
    "Date", "Title", "Company", "Location", "Comp", "Platform",
    "URL", "MessageID", "GmailLink", "Notes", "Status", "StaffingAgency", "USEligible"
]

# ==================== .ENV HELPERS ====================
def _load_dotenv(path: Path = ENV_FILE) -> dict:
    values = {}
    if not path.exists():
        return values
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip('"').strip("'")
    except OSError:
        pass
    return values

DOTENV_VALUES = _load_dotenv()

def _env(key: str, default: str = "") -> str:
    val = os.environ.get(key, "").strip()
    if val:
        return val
    return DOTENV_VALUES.get(key, default).strip()

# --- Local MongoDB Configuration ---
MONGO_URI = _env("MONGO_URI", "mongodb://localhost:27017")
MONGO_DB_NAME = _env("MONGO_DB_NAME", "job_listings_scanner")
MONGO_COLLECTION_NAME = _env("MONGO_COLLECTION_NAME", "job_listings")


# ==================== LOGGING ====================
def setup_logging():
    logger = logging.getLogger("SheetsToMongo")
    logger.setLevel(logging.DEBUG)
    if logger.handlers:
        return logger

    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    file_formatter = logging.Formatter('%(asctime)s [%(levelname)s] %(filename)s:%(lineno)d - %(message)s')
    console_formatter = logging.Formatter('[%(levelname)s] %(message)s')

    fh = logging.FileHandler(LOG_FILE, mode='w', encoding='utf-8')
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(file_formatter)

    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    ch.setFormatter(console_formatter)

    logger.addHandler(fh)
    logger.addHandler(ch)
    return logger


# ==================== GOOGLE AUTH ====================
def _load_or_create_creds(logger) -> Credentials:
    creds = None
    token_json = _env("GMAIL_TOKEN_JSON")
    if token_json:
        try:
            creds = Credentials.from_authorized_user_info(json.loads(token_json), SCOPES)
        except Exception as e:
            logger.warning(f"Could not parse GMAIL_TOKEN_JSON from .env ({e}); ignoring it.")

    if not creds and os.path.exists(TOKEN_PATH):
        creds = Credentials.from_authorized_user_file(TOKEN_PATH, SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
            except Exception as e:
                logger.warning(f"Token refresh failed ({e}); re-authenticating interactively.")
                flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_PATH, SCOPES)
                creds = flow.run_local_server(port=0)
        else:
            flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_PATH, SCOPES)
            creds = flow.run_local_server(port=0)

    return creds


# ==================== MAIN SCRIPT LOGIC ====================
def main():
    logger = setup_logging()
    logger.info("Starting Google Sheets to MongoDB migration script...")

    # 1. Connect to Google Sheets API
    try:
        creds = _load_or_create_creds(logger)
        sheets_service = build('sheets', 'v4', credentials=creds)
    except Exception as e:
        logger.error(f"Failed to authenticate with Google APIs: {e}")
        return

    # 2. Fetch Spreadsheet Values
    try:
        logger.info(f"Fetching data from spreadsheet {SPREADSISD if 'SPREADSISD' in globals() else SPREADSHEET_ID}, range {RANGE_NAME}...")
        result = sheets_service.spreadsheets().values().get(
            spreadsheetId=SPREADSHEET_ID, range=RANGE_NAME
        ).execute()
        rows = result.get('values', [])
    except HttpError as e:
        logger.error(f"Google Sheets API error: {e}")
        return

    if not rows:
        logger.warning("No rows found in the specified range.")
        return

    # Validate header row and extract data rows
    header = rows[0]
    data_rows = rows[1:]
    logger.info(f"Retrieved {len(data_rows)} data rows (plus header) from Google Sheets.")

    # 3. Connect to Local MongoDB
    try:
        client = pymongo.MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
        client.admin.command('ping')
        db = client[MONGO_DB_NAME]
        collection = db[MONGO_COLLECTION_NAME]
        
        # Ensure unique index matches your existing codebase pattern
        collection.create_index(
            [("title", 1), ("company", 1), ("message_id", 1)],
            unique=True
        )
        logger.info(f"Successfully connected to MongoDB at {MONGO_URI} (DB: {MONGO_DB_NAME}, Collection: {MONGO_COLLECTION_NAME})")
    except Exception as e:
        logger.error(f"Failed to connect to MongoDB: {e}")
        return

    # 4. Map rows to dictionaries and upsert into MongoDB
    upserted_count = 0
    skipped_count = 0

    for idx, row in enumerate(data_rows, start=2):
        # Pad row array if missing trailing optional columns
        padded_row = row + [""] * (len(CSV_HEADERS) - len(row))
        
        doc = {
            "date": padded_row[0],
            "title": padded_row[1],
            "company": padded_row[2],
            "location": padded_row[3],
            "comp": padded_row[4],
            "platform": padded_row[5],
            "url": padded_row[6],
            "message_id": padded_row[7],
            "gmail_link": padded_row[8],
            "notes": padded_row[9],
            "status": padded_row[10],
            "is_staffing_agency": padded_row[11],
            "us_eligible": padded_row[12],
            "last_updated": datetime.utcnow(),
        }

        # Skip completely empty rows
        if not doc["title"] and not doc["company"]:
            skipped_count += 1
            continue

        filter_query = {
            "title": doc["title"],
            "company": doc["company"],
            "message_id": doc["message_id"]
        }

        try:
            collection.update_one(filter_query, {"$set": doc}, upsert=True)
            upserted_count += 1
        except Exception as e:
            logger.error(f"Failed to upsert row {idx} ({doc['title']} at {doc['company']}): {e}")

    logger.info(f"Migration complete. Successfully upserted {upserted_count} records into MongoDB (Skipped {skipped_count} empty rows).")


if __name__ == '__main__':
    main()