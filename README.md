"""
job_listings_scanner.py

Scans Gmail for job-alert digest emails (label: '_ _ JOB SEARCH/a SEARCHES'), extracts
EVERY individual job posting contained in each email (a single digest email from LinkedIn/
Indeed/etc. commonly lists many jobs at once), optionally visits each job's URL to fill in
missing location/compensation, and writes the results to:
  - a new 'Job Listings' tab in the same Google Sheet used by job_search_email.py
  - a local CSV, dated/named for the current run only (no accumulating master file)

Only emails from the last TWO_WEEKS_DAYS days are considered -- older digest backlog is
left alone. Processed emails have the 'a SEARCHES' label removed and '_ _ JOB SEARCH/IC'
(shared with job_search_email.py's "processed" convention) added.

Companion script to job_search_email.py (which tracks APPLIED/DECLINED status on emails
you've already acted on). This one is upstream of that -- it's for mining the raw job-alert
noise into a structured backlog of postings worth reviewing.

Setup
-----
1. pip install ollama google-api-python-client google-auth-oauthlib requests beautifulsoup4
2. Put your OAuth client secret at secrets/credentials.json (same as job_search_email.py).
3. First run will open a browser for the OAuth consent flow, then store the resulting
   access/refresh token in .env as GMAIL_TOKEN_JSON (see _load_or_create_gmail_creds below).
   Every run after that reads the token from .env -- no token.json file needed. If you'd
   rather keep using a token.json file, that's supported too as a fallback.
4. Make sure Ollama is running locally (ollama serve) with OLLAMA_MODEL pulled.
5. In Gmail, apply the label '_ _ JOB SEARCH/a SEARCHES' to your job-alert digest emails
   (a filter that auto-labels mail from LinkedIn/Indeed/etc. is the easy way to keep this fed).

Usage
-----
  python job_listings_scanner.py               # normal run
  python job_listings_scanner.py --dry-run      # extract + enrich, print results, touch
                                                 # nothing in Gmail or Sheets (CSV still written)
  python job_listings_scanner.py --no-enrich    # skip visiting job URLs (faster, for testing
                                                 # the extraction prompt on its own)
"""

import argparse
import base64
import csv
import http.client as http_client
import json
import logging
import os
import random
import re
import shutil
import socket
import ssl
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse

import ollama
import requests
from bs4 import BeautifulSoup
from google.auth.exceptions import RefreshError
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ==================== CONFIGURATION ====================
SCOPES = [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/spreadsheets',
]

SEARCHES_LABEL = '_ _ JOB SEARCH/a SEARCHES'
PROCESSED_LABEL = '_ _ JOB SEARCH/IC'   # added on process; SEARCHES_LABEL is removed at the same time

TWO_WEEKS_DAYS = 14   # only emails newer than this are considered

# Same spreadsheet as job_search_email.py, new tab just for scanned listings.
SPREADSHEET_ID = '1EUFfZjv1Pb_3hueE15fJ7Eccze79gM4hOcK-0lQ0umk'
SHEET_NAME = 'Job Listings'
RANGE_NAME = f'{SHEET_NAME}!A:M'
# Columns: Date, Title, Company, Location, Comp, Platform, URL, MessageID, GmailLink, Notes,
#          Status, StaffingAgency, USEligible

# First tab in the same spreadsheet -- job_search_email.py's applied/declined tracker.
# Columns: Date, Title, Company, Email, URL, Status, Source, MessageID, Notes, GMAIL
APPLIED_SHEET_NAME = 'Applied'
APPLIED_RANGE_NAME = f'{APPLIED_SHEET_NAME}!A:J'
APPLIED_TITLE_COL = 1
APPLIED_COMPANY_COL = 2
APPLIED_STATUS_COL = 5

TOKEN_PATH = 'secrets/token.json'          # fallback if not using .env token storage
CREDENTIALS_PATH = 'secrets/credentials.json'
ENV_FILE = Path('./.env')

LOGS_DIR = Path('./logs')
ARCHIVES_DIR = Path('./archives')
CSV_DIR = Path('./csv_output')
DATA_DIR = Path('./data')
LOGS_ARCHIVE_DIR = ARCHIVES_DIR / 'logs'
PLATFORM_STATS_PATH = DATA_DIR / 'platform_stats.json'  # persists across runs

CSV_HEADERS = ["Date", "Title", "Company", "Location", "Comp", "Platform",
               "URL", "MessageID", "GmailLink", "Notes", "Status", "StaffingAgency", "USEligible"]

TIMESTAMP = datetime.now().strftime("%Y%m%d%H%M%S")
RUN_DATE = datetime.now().strftime("%Y-%m-%d")
LOG_FILE = LOGS_DIR / f"job_listings_{TIMESTAMP}.log"
ERROR_LOG_FILE = LOGS_DIR / f"job_listings_{TIMESTAMP}_errors.log"
SUMMARY_LOG_FILE = LOGS_DIR / f"job_listings_{TIMESTAMP}_summary.log"
# One CSV per run, dated and timestamped -- no accumulating master file.
CSV_PATH = CSV_DIR / f"job_listings_{RUN_DATE}_{TIMESTAMP}.csv"

# --- Local LLM (Ollama) config ---
OLLAMA_HOST = 'http://localhost:11434'
OLLAMA_MODEL = 'qwen2.5:14b-instruct'  # requires: ollama pull qwen2.5:14b-instruct (~9GB, fits comfortably in 20GB VRAM)
OLLAMA_TEMPERATURE = 0.1

# --- Enrichment (visiting each job URL) ---
FETCH_WORKERS = 8          # concurrent threads for visiting job URLs (network I/O-bound)
CLASSIFY_WORKERS = 2       # concurrent threads for Ollama calls -- keep low unless
                            # OLLAMA_NUM_PARALLEL is raised on the Ollama server
REQUEST_TIMEOUT = 12
MAX_PAGE_TEXT_CHARS = 4000

# Progress heartbeat during the extraction loop: whichever threshold hits first triggers a
# log line, so a long backlog run (e.g. first-ever run against weeks of digest email)
# doesn't sit silent for minutes at a time.
PROGRESS_LOG_EVERY_N = 10
PROGRESS_LOG_EVERY_SECS = 30

DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Connection": "keep-alive",
}

# Known job-platform sender domains -> friendly display name. Used to tag the "Platform"
# column and as a fallback name when the LLM can't tell which board a job came from.
PLATFORM_DOMAINS = {
    'linkedin.com': 'LinkedIn',
    'indeed.com': 'Indeed',
    'ziprecruiter.com': 'ZipRecruiter',
    'glassdoor.com': 'Glassdoor',
    'dice.com': 'Dice',
    'monster.com': 'Monster',
    'simplyhired.com': 'SimplyHired',
    'careerbuilder.com': 'CareerBuilder',
    'weworkremotely.com': 'We Work Remotely',
    'wellfound.com': 'Wellfound',
    'angel.co': 'Wellfound',
    'flexjobs.com': 'FlexJobs',
    'remote.co': 'Remote.co',
    'themuse.com': 'The Muse',
    'builtin.com': 'Built In',
    'lever.co': 'Lever',
    'greenhouse.io': 'Greenhouse',
    'jobs.google.com': 'Google Jobs',
}

# Known staffing/recruiting agencies -- these post the SAME underlying client role through
# multiple firms and reuse generic titles ("Software Developer", ".NET Engineer") across
# genuinely different openings. Company-name fuzzy-matching is unreliable for these, so any
# company matching here gets flagged and skipped from dedup entirely (see plan_row_action) --
# better a harmless duplicate row you can eyeball than a real distinct opening silently
# vanishing because it matched on a generic title + agency name.
STAFFING_AGENCY_KEYWORDS = [
    'robert half', 'insight global', 'teksystems', 'tek systems', 'kforce', 'randstad',
    'manpower', 'adecco', 'aerotek', 'beacon hill', 'cybercoders', 'motion recruitment',
    'actalent', 'apex systems', 'collabera', 'the judge group', 'judge group', 'modis',
    'yoh', 'signature consultants', 'mondo', 'jobot', 'vaco', 'eliassen group',
    'software guidance', 'katalyst', 'harnham', 'lancesoft', 'genesis10', 'ledgent',
    'volt', 'onward search', 'artech', 'diverse lynx', 'nesco resource', 'general staffing',
    'staffing agency', 'staffing solutions', 'talent acquisition group', 'hays', 'roc search',
    'sparks group', 'brooksource', 'improving', 'trigyn', 'systemone', 'system one',
    'consult solutions', 'sirius', 'motion recruitment partners', 'contract staffing',
]


def is_staffing_agency(company: str) -> bool:
    clean = (company or "").strip().lower()
    return any(keyword in clean for keyword in STAFFING_AGENCY_KEYWORDS)


# US 2-letter state/territory codes -- used to confirm a "City, XX" location is genuinely
# US-based rather than, say, "City, ON" (Ontario) getting missed.
US_STATE_CODES = {
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA",
    "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT",
    "VA", "WA", "WV", "WI", "WY", "DC", "PR",
}

# Best-effort, not authoritative -- country/region names and city names that show up often
# enough in these digests to be worth flagging. False negatives (a non-US location that
# isn't caught) are expected; the goal is catching the obvious cases so they don't need to
# be individually clicked through, not a legal work-authorization determination.
NON_US_LOCATION_KEYWORDS = [
    'united kingdom', ' uk', 'u.k.', 'england', 'scotland', 'wales', 'london', 'canada',
    'ontario', 'toronto', 'vancouver', 'montreal', 'germany', 'berlin', 'munich', 'france',
    'paris', 'india', 'bangalore', 'bengaluru', 'hyderabad', 'mumbai', 'pune', 'delhi',
    'brazil', 'brasil', 'são paulo', 'sao paulo', 'mexico', 'méxico', 'poland', 'warsaw',
    'spain', 'madrid', 'barcelona', 'italy', 'milan', 'rome', 'netherlands', 'amsterdam',
    'ireland', 'dublin', 'australia', 'sydney', 'melbourne', 'singapore', 'philippines',
    'manila', 'ukraine', 'kyiv', 'romania', 'bucharest', 'portugal', 'lisbon', 'argentina',
    'buenos aires', 'colombia', 'bogota', 'bogotá', 'japan', 'tokyo', 'china', 'shanghai',
    'beijing', 'vietnam', 'hanoi', 'pakistan', 'nigeria', 'lagos', 'south africa', 'israel',
    'tel aviv', 'uae', 'dubai', 'egypt', 'cairo', 'turkey', 'istanbul', 'sweden',
    'stockholm', 'norway', 'oslo', 'denmark', 'copenhagen', 'finland', 'helsinki',
    'switzerland', 'zurich', 'austria', 'vienna', 'belgium', 'brussels', 'greece', 'athens',
    'czech republic', 'prague', 'hungary', 'budapest', 'new zealand', 'auckland',
    'indonesia', 'jakarta', 'malaysia', 'kuala lumpur', 'thailand', 'bangkok', 'south korea',
    'seoul', 'costa rica', 'chile', 'santiago', 'peru', 'lima',
]

NON_USD_CURRENCY_SIGNALS = ['£', '€', '₹', '¥', 'r$', 'c$', 'a$', 'gbp', 'eur', 'cad', 'aud', 'inr']


def classify_us_eligibility(location: str, comp: str):
    """Heuristic, not authoritative -- flags the obvious cases (an explicit non-US country in
    the location, or comp quoted in a non-USD currency) so they're easy to filter out or
    double-check, rather than a real work-authorization determination. Returns
    (eligibility, reason) where eligibility is 'Yes' / 'No' / 'Unclear'."""
    loc = (location or "").strip()
    loc_lower = loc.lower()
    comp_lower = (comp or "").strip().lower()

    # Comp currency is a stronger signal than location text when both are present -- a
    # company can list a US office location on a role that's actually paid/based elsewhere.
    for signal in NON_USD_CURRENCY_SIGNALS:
        if signal in comp_lower:
            return 'No', f"comp quoted in non-USD currency ('{signal}')"

    if re.search(r'\b(us|usa|united states)\b', loc_lower):
        return 'Yes', ''

    for keyword in NON_US_LOCATION_KEYWORDS:
        if keyword in loc_lower:
            return 'No', f"location mentions '{keyword.strip()}'"

    state_match = re.search(r',\s*([A-Za-z]{2})\b', loc)
    if state_match and state_match.group(1).upper() in US_STATE_CODES:
        return 'Yes', ''

    if loc_lower in ('remote', ''):
        return 'Unclear', 'remote with no country specified'

    return 'Unclear', ''


EXTRACTION_SYSTEM_PROMPT = """You extract individual job postings from a job-alert digest \
email sent by a job board or job search platform.

Links in the email have been replaced with short tokens in the form: link text <<L7>>

Find every distinct job posting mentioned in the text. For each one, output a JSON object \
with exactly these fields:
- "title": the job title
- "company": the hiring company name
- "location": "Remote" if remote, otherwise "City, ST" (or country); "" if not stated
- "comp": compensation/salary range if explicitly stated (e.g. "$90,000 - $110,000"), \
otherwise ""
- "url": the token (just the id, e.g. "L7" -- NOT the surrounding << >>) from the link most \
closely associated with that specific job posting; "" if none found nearby. Copy the token \
exactly as it appears -- never invent one, never write out a real URL.

Respond with ONLY a JSON array of these objects -- no markdown fences, no commentary. If no \
distinct job postings are found in the text, respond with [].

Example output:
[{"title": "Senior Backend Engineer", "company": "Acme Corp", "location": "Remote", "comp": \
"$120,000 - $150,000", "url": "L3"}, {"title": "PHP Developer", \
"company": "Beta LLC", "location": "Columbus, OH", "comp": "", "url": "L5"}]
"""

ENRICH_SYSTEM_PROMPT = """You are filling in missing details for a single job posting using \
text scraped from its job listing page.

Only use information found in the page text below -- never guess or invent a number. \
Respond with ONLY a JSON object: {"location": "...", "comp": "..."}. Use "" for a field if \
the page text doesn't state it. If the current value already looks correct and the page \
confirms it, repeat it back unchanged.
"""

# JSON schemas passed to Ollama's `format` param -- grammar-constrains generation so the
# model literally cannot emit syntactically invalid JSON, independent of prompt wording.
JOB_ARRAY_SCHEMA = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "company": {"type": "string"},
            "location": {"type": "string"},
            "comp": {"type": "string"},
            "url": {"type": "string"},
        },
        "required": ["title", "company", "location", "comp", "url"],
    },
}

ENRICH_OBJECT_SCHEMA = {
    "type": "object",
    "properties": {
        "location": {"type": "string"},
        "comp": {"type": "string"},
    },
    "required": ["location", "comp"],
}

# ==================== LOGGING ====================

def archive_old_logs():
    """Moves any log files left over from previous runs into archives/logs/ so LOGS_DIR
    only ever contains the current run's files. Mirrors the archiving behavior used in the
    image_sort/url_organizer scripts."""
    if not LOGS_DIR.exists():
        return
    LOGS_ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    for f in LOGS_DIR.glob("job_listings_*.log"):
        try:
            shutil.move(str(f), str(LOGS_ARCHIVE_DIR / f.name))
        except Exception:
            pass  # best-effort; a stuck file here shouldn't block a new run


def setup_logging():
    """Three-file logging: full debug log, errors-only log, and a plain-language run
    summary -- same structure used in image_sort.py."""
    logger = logging.getLogger("JobListingsScanner")
    logger.setLevel(logging.DEBUG)
    if logger.handlers:
        return logger

    LOGS_DIR.mkdir(parents=True, exist_ok=True)

    file_formatter = logging.Formatter('%(asctime)s [%(levelname)s] %(filename)s:%(lineno)d - %(message)s')
    console_formatter = logging.Formatter('[%(levelname)s] %(message)s')

    fh = logging.FileHandler(LOG_FILE, mode='w', encoding='utf-8')
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(file_formatter)

    eh = logging.FileHandler(ERROR_LOG_FILE, mode='w', encoding='utf-8')
    eh.setLevel(logging.ERROR)
    eh.setFormatter(file_formatter)

    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    ch.setFormatter(console_formatter)

    logger.addHandler(fh)
    logger.addHandler(eh)
    logger.addHandler(ch)
    return logger


def write_summary_log(stats: dict):
    SUMMARY_LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        f"Job Listings Scanner -- run {TIMESTAMP}",
        "-" * 40,
        f"Digest emails scanned:     {stats.get('emails_scanned', 0)}",
        f"Job postings extracted:    {stats.get('jobs_extracted', 0)}",
        f"New rows added to Sheet:   {stats.get('rows_appended', 0)}",
        f"Existing rows updated:     {stats.get('rows_updated', 0)}",
        f"URLs enriched:             {stats.get('urls_enriched', 0)}",
        f"Enrichment failures:       {stats.get('enrich_failures', 0)}",
        f"Duration:                  {format_duration(stats.get('duration_secs', 0))}",
    ]
    SUMMARY_LOG_FILE.write_text("\n".join(lines) + "\n", encoding='utf-8')


def format_duration(seconds: float) -> str:
    seconds = max(0, int(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h {m:02d}m {s:02d}s"
    if m:
        return f"{m}m {s:02d}s"
    return f"{s}s"


# ==================== .ENV HELPERS ====================

def _load_dotenv(path: Path = ENV_FILE) -> dict:
    """Minimal .env parser (KEY=VALUE per line, '#' comments, optional quotes)."""
    values = {}
    if not path.exists():
        return values
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key:
                values[key] = value
    except OSError:
        pass
    return values


def _save_dotenv_value(key: str, value: str, path: Path = ENV_FILE):
    """Writes/updates a single KEY=VALUE line in .env, preserving everything else. Used to
    persist a refreshed Gmail token back to .env so the next run doesn't need the browser
    OAuth flow again."""
    lines = []
    found = False
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith(f"{key}="):
                lines.append(f"{key}={value}")
                found = True
            else:
                lines.append(line)
    if not found:
        lines.append(f"{key}={value}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


DOTENV_VALUES = _load_dotenv()


def _env(key: str, default: str = "") -> str:
    """Real environment variable wins over .env, matching standard precedence."""
    val = os.environ.get(key, "").strip()
    if val:
        return val
    return DOTENV_VALUES.get(key, default).strip()


# ==================== GOOGLE AUTH ====================

def _load_or_create_gmail_creds(logger) -> Credentials:
    """Access token is stored in .env as GMAIL_TOKEN_JSON whenever possible, so the script
    can run headless without a token.json file sitting on disk. Falls back to token.json if
    no env value is set (e.g. first-ever run), and always writes the resulting/refreshed
    token back to .env afterward."""
    creds = None

    token_json = _env("GMAIL_TOKEN_JSON")
    if token_json:
        try:
            creds = Credentials.from_authorized_user_info(json.loads(token_json), SCOPES)
        except Exception as e:
            logger.warning(f"Could not parse GMAIL_TOKEN_JSON from .env ({e}); ignoring it.")
            creds = None

    if not creds and os.path.exists(TOKEN_PATH):
        creds = Credentials.from_authorized_user_file(TOKEN_PATH, SCOPES)

    if not creds or not creds.valid:
        refreshed = False
        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
                refreshed = True
            except RefreshError as e:
                # Google rejected the refresh token itself (revoked, expired from
                # inactivity, or the OAuth consent screen is still in "Testing" mode and
                # tokens expire after 7 days). No amount of retrying fixes this -- fall
                # through to a fresh interactive login instead of crashing the whole run.
                logger.warning(f"Stored refresh token was rejected ({e}); re-authenticating interactively.")

        if not refreshed:
            flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_PATH, SCOPES)
            creds = flow.run_local_server(port=0)

        # Persist to both .env (primary) and token.json (fallback/compat with job_search_email.py)
        _save_dotenv_value("GMAIL_TOKEN_JSON", creds.to_json(), ENV_FILE)
        os.makedirs(os.path.dirname(TOKEN_PATH) or ".", exist_ok=True)
        with open(TOKEN_PATH, 'w') as token_file:
            token_file.write(creds.to_json())
        logger.info("Gmail token stored in .env (GMAIL_TOKEN_JSON) and secrets/token.json.")

    return creds


def get_google_services(logger):
    creds = _load_or_create_gmail_creds(logger)
    gmail_service = build('gmail', 'v1', credentials=creds)
    sheets_service = build('sheets', 'v4', credentials=creds)
    return gmail_service, sheets_service


# ==================== RESILIENT HTTP SESSION ====================

def create_resilient_session() -> requests.Session:
    session = requests.Session()
    retries = Retry(total=2, backoff_factor=0.5, status_forcelist=[500, 502, 503, 504],
                     raise_on_status=False)
    adapter = HTTPAdapter(max_retries=retries, pool_connections=FETCH_WORKERS * 2,
                           pool_maxsize=FETCH_WORKERS * 2)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session


# ==================== GMAIL HELPERS ====================

# Raw socket/TLS-level drops (VPN blip, Windows killing an idle connection mid-request,
# wifi hiccup) never raise HttpError -- they come straight from httplib2/ssl/socket and
# were previously uncaught, crashing the whole run even when Google's API was never the
# problem. Treat these as retryable too, same backoff as a retryable HttpError.
NETWORK_RETRYABLE_EXCEPTIONS = (ConnectionError, TimeoutError, socket.error, ssl.SSLError,
                                 http_client.HTTPException)


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
            logger.warning(f"{what or 'API call'} hit a retryable error (status {status}), backing off {wait:.1f}s")
            time.sleep(wait)
        except NETWORK_RETRYABLE_EXCEPTIONS as e:
            if attempt == max_retries - 1:
                raise
            wait = (2 ** attempt) + random.uniform(0, 1)
            logger.warning(f"{what or 'API call'} hit a network-level error "
                           f"({type(e).__name__}: {e}), retrying in {wait:.1f}s "
                           f"(attempt {attempt + 1}/{max_retries})")
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
    logger.debug(f"Listed {len(all_messages)} message(s) for query: {query}")
    return all_messages


def _is_retryable_http_error(exc):
    status = getattr(exc, 'status_code', None) or getattr(getattr(exc, 'resp', None), 'status', None)
    return status in (403, 429, 500, 503)


def batch_fetch_messages(gmail_service, message_briefs, logger, batch_size=20,
                          inter_chunk_delay=0.5, max_retry_rounds=5, msg_format='full',
                          metadata_headers=None):
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
                get_kwargs = {'userId': 'me', 'id': msg_id, 'format': msg_format}
                if msg_format == 'metadata' and metadata_headers:
                    get_kwargs['metadataHeaders'] = metadata_headers
                batch.add(
                    gmail_service.users().messages().get(**get_kwargs),
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


def parse_email_date(date_str):
    from email.utils import parsedate_to_datetime
    try:
        return parsedate_to_datetime(date_str).strftime('%Y-%m-%d')
    except Exception:
        return date_str or "Unknown Date"


def build_gmail_link(msg_id):
    return f"https://mail.google.com/mail/u/0/#all/{msg_id}"


def extract_html_body(payload):
    """Walks the MIME tree looking specifically for the text/html part -- we need the HTML,
    not stripped plain text, so links can be preserved and mapped to their job listings."""
    if payload.get('mimeType', '') == 'text/html' and payload.get('body', {}).get('data'):
        try:
            return base64.urlsafe_b64decode(payload['body']['data'].encode('ASCII')).decode('utf-8', errors='ignore')
        except Exception:
            return ""

    for part in payload.get('parts', []) or []:
        if part.get('mimeType', '') == 'text/html' and part.get('body', {}).get('data'):
            try:
                return base64.urlsafe_b64decode(part['body']['data'].encode('ASCII')).decode('utf-8', errors='ignore')
            except Exception:
                continue
        if 'parts' in part:
            nested = extract_html_body(part)
            if nested:
                return nested
    return ""


def extract_plain_body(payload):
    if payload.get('mimeType', '') == 'text/plain' and payload.get('body', {}).get('data'):
        try:
            return base64.urlsafe_b64decode(payload['body']['data'].encode('ASCII')).decode('utf-8', errors='ignore')
        except Exception:
            return ""
    for part in payload.get('parts', []) or []:
        if part.get('mimeType', '') == 'text/plain' and part.get('body', {}).get('data'):
            try:
                return base64.urlsafe_b64decode(part['body']['data'].encode('ASCII')).decode('utf-8', errors='ignore')
            except Exception:
                continue
        if 'parts' in part:
            nested = extract_plain_body(part)
            if nested:
                return nested
    return ""


def guess_platform_from_email(from_header, subject=""):
    """Recognized boards get their canonical name from PLATFORM_DOMAINS. Everything else
    used to collapse into a useless 'Unknown' bucket -- which hides exactly the pattern
    worth noticing (a specific low-value source you keep getting mail from and never any
    real leads from). Instead, fall back to the sender's display name (e.g. "RemoteHunter
    Job Alerts" -> "RemoteHunter"), which is what actually shows up in the platform-yield
    report and lets a chronically-empty source get identified by name."""
    match = re.search(r'@([\w.-]+)', from_header or "")
    domain = match.group(1).lower() if match else ""
    for known_domain, name in PLATFORM_DOMAINS.items():
        if known_domain in domain:
            return name
    # fall back to scanning the subject line for a platform name
    for known_domain, name in PLATFORM_DOMAINS.items():
        if name.lower() in (subject or "").lower():
            return name

    display_match = re.match(r'^\s*"?([^"<]+?)"?\s*<', from_header or "")
    if display_match:
        display_name = display_match.group(1).strip()
        # strip generic boilerplate suffixes so "FlexBoard Job Alerts" -> "FlexBoard"
        display_name = re.sub(r'\s*[-|:]?\s*(job\s*alerts?|notifications?|alerts?|digest|jobs?)\s*$',
                               '', display_name, flags=re.IGNORECASE).strip()
        if display_name:
            return display_name

    return domain if domain else "Unknown"


def html_to_text_with_links(html_body):
    """Converts an HTML email body into plain text, with every link replaced by a short
    placeholder token like <<L7>> right where it appeared, plus a link_map from token -> real
    URL. Job-alert emails (RemoteHunter, LinkedIn, etc.) commonly wrap links in enormous
    base64-encoded tracking payloads (300-500+ chars). Asking a local LLM to reproduce one of
    those verbatim is what triggers degenerate repetition loops -- it gets partway through
    retyping the blob and gets stuck looping the same fragment until it hits the token cap.
    Short placeholders sidestep that entirely: the model only ever has to copy back "L7"."""
    soup = BeautifulSoup(html_body, "html.parser")
    for tag in soup(["script", "style"]):
        tag.decompose()

    link_map = {}
    counter = [0]

    for a in soup.find_all('a', href=True):
        href = a['href'].strip()
        text = a.get_text(strip=True)
        if href.startswith('http://') or href.startswith('https://'):
            counter[0] += 1
            token = f"L{counter[0]}"
            link_map[token] = href
            a.replace_with(f"{text} <<{token}>>")

    raw_text = soup.get_text(separator="\n")
    lines = [ln.strip() for ln in raw_text.splitlines() if ln.strip()]
    return "\n".join(lines), link_map


# ==================== OLLAMA / EXTRACTION ====================

def safe_json_parse(text):
    if not text:
        return None
    text = text.strip()
    text = re.sub(r'^```(?:json)?', '', text).strip()
    text = re.sub(r'```$', '', text).strip()
    try:
        return json.loads(text)
    except Exception:
        pass
    match = re.search(r'(\[.*\]|\{.*\})', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except Exception:
            pass
    return _attempt_repair_truncated_array(text)


def _attempt_repair_truncated_array(text):
    """If the model's output got cut off mid-array (ran out of generation tokens before
    finishing), salvage whatever complete job objects came before the cutoff instead of
    losing the whole chunk. Finds the last fully-closed '}' and re-closes the array there."""
    text = text.strip()
    start = text.find('[')
    if start == -1:
        return None
    last_close = text.rfind('}')
    if last_close == -1 or last_close < start:
        return None
    candidate = text[start:last_close + 1] + ']'
    try:
        return json.loads(candidate)
    except Exception:
        return None


def call_ollama(client, system_prompt, user_prompt, logger, note="", extra_options=None, schema=None):
    """schema, when given, is a JSON-schema dict passed straight through to Ollama's `format`
    parameter. Since Ollama 0.5 this grammar-constrains token generation so the model is
    structurally unable to emit invalid JSON -- a much stronger guarantee than prompting
    alone, and it works regardless of which model is loaded."""
    options = {"temperature": OLLAMA_TEMPERATURE, "num_predict": 4096, "num_ctx": 8192}
    if extra_options:
        options.update(extra_options)
    try:
        resp = client.generate(
            model=OLLAMA_MODEL,
            prompt=f"{system_prompt}\n\n{user_prompt}",
            options=options,
            format=schema if schema is not None else "",
            stream=False,
        )
        return resp.get('response', '')
    except Exception as e:
        logger.error(f"Ollama call failed {note}: {e}")
        return ""


def chunk_text(text, max_chars=6000):
    """Splits on line boundaries so a job listing's title/company/link stay together in
    one chunk rather than being sliced mid-entry."""
    if len(text) <= max_chars:
        return [text]
    chunks, current, current_len = [], [], 0
    for line in text.splitlines():
        if current_len + len(line) + 1 > max_chars and current:
            chunks.append("\n".join(current))
            current, current_len = [], 0
        current.append(line)
        current_len += len(line) + 1
    if current:
        chunks.append("\n".join(current))
    return chunks


FAILED_CHUNKS_DIR = LOGS_DIR / 'failed_chunks'


def _dump_failed_chunk(email_label, chunk_index, total_chunks, chunk_text_in, raw_first, raw_retry, logger):
    """Writes everything needed to debug a chunk that never parsed: the input text sent to
    the model, and both raw responses (first attempt + retry). Saved separately from the
    main log so failures are easy to find and inspect without wading through debug output."""
    try:
        FAILED_CHUNKS_DIR.mkdir(parents=True, exist_ok=True)
        safe_label = re.sub(r'[^\w\-]+', '_', email_label)[:60]
        out_path = FAILED_CHUNKS_DIR / f"{TIMESTAMP}_{safe_label}_chunk{chunk_index}of{total_chunks}.txt"
        content = (
            f"Email: {email_label}\n"
            f"Chunk: {chunk_index}/{total_chunks}\n"
            f"Chunk input length: {len(chunk_text_in)} chars\n"
            f"{'=' * 60}\nCHUNK INPUT TEXT:\n{'=' * 60}\n{chunk_text_in}\n\n"
            f"{'=' * 60}\nRAW RESPONSE (1st attempt, {len(raw_first)} chars):\n{'=' * 60}\n{raw_first}\n\n"
            f"{'=' * 60}\nRAW RESPONSE (retry, {len(raw_retry)} chars):\n{'=' * 60}\n{raw_retry}\n"
        )
        out_path.write_text(content, encoding='utf-8')
        return out_path
    except Exception as e:
        logger.error(f"Could not write failed-chunk diagnostic file: {e}")
        return None


def extract_jobs_from_email(client, email_text, logger, link_map=None, email_label="unknown email"):
    link_map = link_map or {}
    jobs = []
    chunks = chunk_text(email_text)
    for i, chunk in enumerate(chunks):
        note = f"(extraction chunk {i + 1}/{len(chunks)}, '{email_label}')"
        raw = call_ollama(client, EXTRACTION_SYSTEM_PROMPT, chunk, logger, note=note, schema=JOB_ARRAY_SCHEMA)
        parsed = safe_json_parse(raw)
        raw_retry = ""

        if not isinstance(parsed, list):
            # One retry with a blunter reminder -- covers the common case where the model
            # added stray commentary before/after the JSON, or got cut off mid-array.
            logger.debug(f"Chunk {i + 1}/{len(chunks)} of '{email_label}' didn't parse "
                         f"({len(raw)} chars back); raw response started with: {raw[:200]!r}")
            retry_prompt = chunk + "\n\nReminder: respond with ONLY the JSON array. No other text."
            raw_retry = call_ollama(client, EXTRACTION_SYSTEM_PROMPT, retry_prompt, logger,
                                     note=f"{note} retry", schema=JOB_ARRAY_SCHEMA)
            parsed = safe_json_parse(raw_retry)

        if isinstance(parsed, list):
            for item in parsed:
                if isinstance(item, dict) and str(item.get('title', '')).strip():
                    token = str(item.get('url', '')).strip().strip('<>').strip()
                    resolved_url = link_map.get(token, "")
                    if token and not resolved_url:
                        logger.debug(f"'{email_label}': model returned link token '{token}' "
                                     f"with no match in link_map (chunk {i + 1}/{len(chunks)}).")
                    jobs.append({
                        'title': str(item.get('title', '')).strip(),
                        'company': str(item.get('company', '')).strip() or "Needs Review",
                        'location': str(item.get('location', '')).strip(),
                        'comp': str(item.get('comp', '')).strip(),
                        'url': resolved_url,
                    })
        else:
            dump_path = _dump_failed_chunk(email_label, i + 1, len(chunks), chunk, raw, raw_retry, logger)
            reason = "empty response from Ollama" if not raw and not raw_retry else "response wasn't valid/repairable JSON"
            logger.warning(
                f"Could not parse job JSON from chunk {i + 1}/{len(chunks)} of '{email_label}' "
                f"even after retry ({reason}, 1st={len(raw)} chars, retry={len(raw_retry)} chars) "
                f"-- skipping it. Details: {dump_path or '(failed to write diagnostic file)'}"
            )

    seen, unique = set(), []
    for j in jobs:
        key = (j['title'].lower(), j['company'].lower(), j['url'])
        if key in seen:
            continue
        seen.add(key)
        unique.append(j)
    return unique


# ==================== ENRICHMENT (visiting each job URL) ====================

# Per-domain throttle: FETCH_WORKERS threads with no coordination can all land on the same
# domain at once, which is what trips rate limiting (seen heavily on linkedin.com and
# google.com) even when the fetch would otherwise succeed. This enforces a minimum spacing
# between requests to the *same* domain across all threads, without slowing down requests to
# different domains at all.
DOMAIN_MIN_INTERVAL_SECS = 2.0
_domain_last_request = {}
_domain_lock = threading.Lock()

# Domains observed to hard-block scraping outright (bot/fingerprint detection returning a
# flat HTTP 403 on essentially every attempt) rather than rate-limit it. Pacing requests to
# these doesn't improve the odds -- it just spends real time (2s/request * hundreds of jobs)
# waiting on a result that was never going to succeed. Skip the throttle for these specifically
# and let the request fail fast instead. linkedin.com/google.com are deliberately NOT here --
# those returned 429 (rate limiting), which pacing genuinely helps with.
NO_THROTTLE_DOMAINS = {'glassdoor.com', 'ziprecruiter.com', 'monster.com'}


def _throttle_domain(url, logger):
    domain = urlparse(url).netloc.lower()
    if not domain:
        return
    if any(known in domain for known in NO_THROTTLE_DOMAINS):
        logger.debug(f"Skipping throttle for {domain} -- known hard-block, pacing won't change the outcome.")
        return
    with _domain_lock:
        now = time.time()
        last = _domain_last_request.get(domain, 0)
        wait = DOMAIN_MIN_INTERVAL_SECS - (now - last)
        # Reserve the next slot up front (even before sleeping) so two threads that arrive
        # together don't both compute the same "last" and both proceed immediately.
        _domain_last_request[domain] = (last + DOMAIN_MIN_INTERVAL_SECS) if wait > 0 else now
    if wait > 0:
        logger.debug(f"Throttling {domain}: waiting {wait:.1f}s (min {DOMAIN_MIN_INTERVAL_SECS}s between requests)")
        time.sleep(wait)


def stage1_resolve_and_fetch(job, session, logger):
    """Resolves tracking-redirect URLs to their final destination and grabs page text.
    Runs in the network-bound FETCH_WORKERS thread pool."""
    url = job.get('url', '')
    if not url:
        job['_page_text'] = None
        job['notes'] = "No URL to enrich"
        return job
    try:
        _throttle_domain(url, logger)
        resp = session.get(url, headers=DEFAULT_HEADERS, timeout=REQUEST_TIMEOUT, allow_redirects=True)
        job['url'] = resp.url  # unwrap the tracking redirect
        if resp.status_code >= 400:
            job['_page_text'] = None
            job['notes'] = f"Job page returned HTTP {resp.status_code}"
        else:
            soup = BeautifulSoup(resp.text, "html.parser")
            for tag in soup(["script", "style", "nav", "footer", "header"]):
                tag.decompose()
            job['_page_text'] = soup.get_text(separator=" ", strip=True)[:MAX_PAGE_TEXT_CHARS]
            job['notes'] = ""
    except requests.RequestException as e:
        job['_page_text'] = None
        job['notes'] = f"Fetch failed: {e}"
        logger.warning(f"Enrichment fetch failed for {url}: {e}")
    return job


def stage2_llm_fill(job, client, logger):
    """Fills in location/comp from the fetched page text via Ollama. Runs in the small
    CLASSIFY_WORKERS pool so Ollama isn't flooded with concurrent requests."""
    page_text = job.pop('_page_text', None)
    if page_text and (not job.get('location') or not job.get('comp')):
        user_prompt = (
            f"Title: {job.get('title', '')}\n"
            f"Company: {job.get('company', '')}\n"
            f"Current location: {job.get('location', '')}\n"
            f"Current comp: {job.get('comp', '')}\n\n"
            f"Page text:\n{page_text}"
        )
        raw = call_ollama(client, ENRICH_SYSTEM_PROMPT, user_prompt, logger,
                           note=f"(enrich '{job.get('title', '')[:40]}')", schema=ENRICH_OBJECT_SCHEMA)
        parsed = safe_json_parse(raw)
        if isinstance(parsed, dict):
            new_loc = str(parsed.get('location', '')).strip()
            new_comp = str(parsed.get('comp', '')).strip()
            if new_loc and not job.get('location'):
                job['location'] = new_loc
            if new_comp and not job.get('comp'):
                job['comp'] = new_comp
    if job.get('platform', 'Unknown') == 'Unknown' and job.get('url'):
        match = re.search(r'https?://(?:www\.)?([\w.-]+)', job['url'])
        if match:
            domain = match.group(1).lower()
            for known_domain, name in PLATFORM_DOMAINS.items():
                if known_domain in domain:
                    job['platform'] = name
                    break
    return job


def enrich_all_jobs(jobs, logger, stats):
    session = create_resilient_session()
    client = ollama.Client(host=OLLAMA_HOST)

    with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as ex:
        fetched = list(ex.map(lambda j: stage1_resolve_and_fetch(j, session, logger), jobs))

    with ThreadPoolExecutor(max_workers=CLASSIFY_WORKERS) as ex:
        enriched = list(ex.map(lambda j: stage2_llm_fill(j, client, logger), fetched))

    stats['urls_enriched'] = sum(1 for j in enriched if j.get('url'))
    stats['enrich_failures'] = sum(1 for j in enriched if j.get('notes', '').startswith('Fetch failed')
                                    or 'HTTP' in j.get('notes', ''))
    return enriched


# ==================== SHEETS + CSV ====================

def ensure_sheet_tab_exists(sheets_service, logger):
    meta = execute_with_backoff(
        sheets_service.spreadsheets().get(spreadsheetId=SPREADSHEET_ID), logger, what="spreadsheets.get"
    )
    existing_titles = {s['properties']['title'] for s in meta.get('sheets', [])}
    if SHEET_NAME in existing_titles:
        return
    execute_with_backoff(
        sheets_service.spreadsheets().batchUpdate(
            spreadsheetId=SPREADSHEET_ID,
            body={'requests': [{'addSheet': {'properties': {'title': SHEET_NAME}}}]}
        ),
        logger, what="spreadsheets.batchUpdate (addSheet)"
    )
    execute_with_backoff(
        sheets_service.spreadsheets().values().update(
            spreadsheetId=SPREADSHEET_ID,
            range=f'{SHEET_NAME}!A1',
            valueInputOption='RAW',
            body={'values': [CSV_HEADERS]}
        ),
        logger, what="sheets values.update (header row)"
    )
    logger.info(f"Created new '{SHEET_NAME}' tab with header row.")


def get_existing_sheet_data(sheets_service, logger):
    request = sheets_service.spreadsheets().values().get(spreadsheetId=SPREADSHEET_ID, range=RANGE_NAME)
    result = execute_with_backoff(request, logger, what="sheets values.get")
    rows = result.get('values', [])
    return rows[1:] if rows and rows[0] and rows[0][0] == "Date" else rows


def get_applied_sheet_data(sheets_service, logger):
    """Pulls job_search_email.py's 'Applied' tab (Date, Title, Company, Email, URL, Status,
    Source, MessageID, Notes, GMAIL) so scanned listings can be flagged if you've already
    applied or declined. Missing tab / empty range is treated as "no applied history yet"
    rather than a hard failure, since this tab is owned by the other script."""
    try:
        request = sheets_service.spreadsheets().values().get(
            spreadsheetId=SPREADSHEET_ID, range=APPLIED_RANGE_NAME)
        result = execute_with_backoff(request, logger, what="sheets values.get (Applied tab)")
    except Exception as e:
        logger.warning(f"Couldn't read '{APPLIED_SHEET_NAME}' tab ({type(e).__name__}: {e}); "
                        f"proceeding without applied/declined flags.")
        return []
    rows = result.get('values', [])
    if rows and rows[0] and rows[0][0] == "Date":
        rows = rows[1:]
    return rows


def check_applied_status(applied_rows, company, title):
    """Fuzzy-matches (title, company) against the Applied tab the same way plan_row_action
    de-dupes against Job Listings -- substring match either direction on both fields.
    Returns the Status string (e.g. 'Applied', 'Declined') from the first match, or None."""
    clean_company = company.strip().lower()
    clean_title = title.strip().lower()
    if not clean_company or clean_company == "needs review":
        return None

    for existing in applied_rows:
        if len(existing) <= max(APPLIED_TITLE_COL, APPLIED_COMPANY_COL):
            continue
        row_title = existing[APPLIED_TITLE_COL].strip().lower()
        row_company = existing[APPLIED_COMPANY_COL].strip().lower()
        if not row_company or not row_title:
            continue
        if (clean_company in row_company or row_company in clean_company) and \
           (clean_title in row_title or row_title in clean_title):
            status = existing[APPLIED_STATUS_COL].strip() if len(existing) > APPLIED_STATUS_COL else ""
            return status or "Applied"
    return None


def plan_row_action(existing_rows, rows_to_append, row, company, title, is_staffing, logger):
    """De-dupes against jobs already in the sheet (e.g. the same posting showing up in a
    second digest email) by fuzzy-matching title+company, same approach as job_search_email.py.

    Staffing/recruiting agencies are excluded from this matching entirely -- they repost the
    same client role through multiple firms under generic titles, so a company+title match
    is as likely to be two genuinely different openings as it is a true duplicate. Better to
    let a harmless duplicate row through than silently drop a real opening."""
    if is_staffing:
        return 'append', None, "staffing agency -- dedup skipped"

    clean_company = company.strip().lower()
    clean_title = title.strip().lower()

    if clean_company not in ("needs review", ""):
        for idx, existing in enumerate(existing_rows):
            if len(existing) >= 3:
                row_title = existing[1].strip().lower()
                row_company = existing[2].strip().lower()
                if (clean_company in row_company or row_company in clean_company) and \
                   (clean_title in row_title or row_title in clean_title):
                    return 'skip', idx + 2, "fuzzy match (already on sheet)"

        for existing in rows_to_append:
            row_title = existing[1].strip().lower()
            row_company = existing[2].strip().lower()
            if (clean_company in row_company or row_company in clean_company) and \
               (clean_title in row_title or row_title in clean_title):
                return 'skip', None, "fuzzy match (queued this run)"

    return 'append', None, None


def write_run_csv(rows, logger):
    """Writes this run's results to a single dated/timestamped CSV -- e.g.
    csv_output/job_listings_2026-08-07_20260807153000.csv. Nothing accumulates across runs;
    each run gets its own file."""
    if not rows:
        return
    CSV_DIR.mkdir(parents=True, exist_ok=True)
    try:
        with open(CSV_PATH, mode='w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerow(CSV_HEADERS)
            writer.writerows(rows)
        logger.info(f"Wrote run CSV: {CSV_PATH}")
    except Exception as e:
        logger.error(f"Failed to write run CSV: {e}")


# ==================== PLATFORM YIELD TRACKING (cross-run) ====================
# Tracks emails-seen and jobs-extracted per source across every run, persisted to a small
# JSON file. A single run's sample isn't enough to call a source dead -- 12 emails from
# FlexBoard yielding 0 jobs in one run could be noise, but the same pattern holding after
# 40 emails over a month is a real signal worth acting on (unsubscribe, mute the filter).

def load_platform_stats():
    if not PLATFORM_STATS_PATH.exists():
        return {}
    try:
        return json.loads(PLATFORM_STATS_PATH.read_text(encoding='utf-8'))
    except Exception:
        return {}


def save_platform_stats(stats, logger):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    try:
        PLATFORM_STATS_PATH.write_text(json.dumps(stats, indent=2, sort_keys=True), encoding='utf-8')
    except Exception as e:
        logger.error(f"Failed to save platform stats to {PLATFORM_STATS_PATH}: {e}")


def update_platform_stats(run_counts, logger):
    """run_counts: {platform: {'emails': n, 'jobs': n}} for this run only. Merges into the
    persisted totals and returns the merged dict."""
    stats = load_platform_stats()
    for platform, counts in run_counts.items():
        entry = stats.setdefault(platform, {'emails': 0, 'jobs': 0})
        entry['emails'] += counts.get('emails', 0)
        entry['jobs'] += counts.get('jobs', 0)
    save_platform_stats(stats, logger)
    return stats


def print_platform_report(stats, min_emails=3):
    """Sorted worst-yield-first so the sources actually worth dropping surface at the top.
    min_emails filters out sources with too small a sample to mean anything yet."""
    if not stats:
        print("No platform stats recorded yet -- run the scanner normally first.")
        return
    rows = []
    for platform, counts in stats.items():
        emails = counts.get('emails', 0)
        jobs = counts.get('jobs', 0)
        yield_rate = (jobs / emails) if emails else 0
        rows.append((platform, emails, jobs, yield_rate))
    rows.sort(key=lambda r: (r[3], -r[1]))  # worst yield first, then most emails (most data)

    print(f"\n{'Platform':<28} {'Emails':>8} {'Jobs':>8} {'Jobs/Email':>12}")
    print("-" * 60)
    for platform, emails, jobs, rate in rows:
        flag = "  <-- consider dropping" if emails >= min_emails and rate == 0 else ""
        print(f"{platform:<28} {emails:>8} {jobs:>8} {rate:>12.2f}{flag}")
    zero_yield = [r for r in rows if r[1] >= min_emails and r[3] == 0]
    if zero_yield:
        print(f"\n{len(zero_yield)} source(s) with {min_emails}+ emails and zero jobs extracted, ever:")
        for platform, emails, _, _ in zero_yield:
            print(f"  - {platform} ({emails} emails, 0 leads)")
    else:
        print("\nNo source has hit zero yield with a meaningful sample size yet.")


PROCESSED_EXPORT_HEADERS = ["Date", "Subject", "Platform", "MessageID", "GmailLink"]


def export_processed_emails_csv(gmail_service, logger):
    """One-off report: every email currently carrying the '_ _ JOB SEARCH/IC' label (i.e.
    everything the scanner has ever marked processed), written to a local CSV. Doesn't touch
    Sheets or change any labels -- purely a local snapshot for review."""
    logger.info(f"Listing all emails labeled '{PROCESSED_LABEL}' (all-time, no date cutoff)...")
    briefs = list_all_messages(gmail_service, f'label:"{PROCESSED_LABEL}"', logger)
    if not briefs:
        logger.info("No processed emails found yet -- nothing to export.")
        return

    logger.info(f"Found {len(briefs)} processed email(s); fetching headers...")
    # metadata format + a specific header list keeps this fast -- no bodies, no MIME walk.
    fetched = batch_fetch_messages(gmail_service, briefs, logger, msg_format='metadata',
                                    metadata_headers=['Date', 'Subject', 'From'])

    rows = []
    for brief in briefs:
        msg_id = brief['id']
        msg = fetched.get(msg_id)
        if msg is None:
            logger.warning(f"Skipping {msg_id} in export -- metadata fetch failed for it.")
            continue
        headers = msg.get('payload', {}).get('headers', [])
        date = parse_email_date(next((h['value'] for h in headers if h['name'].lower() == 'date'), ''))
        subject = next((h['value'] for h in headers if h['name'].lower() == 'subject'), '')
        from_header = next((h['value'] for h in headers if h['name'].lower() == 'from'), '')
        platform = guess_platform_from_email(from_header, subject)
        rows.append([date, subject, platform, msg_id, build_gmail_link(msg_id)])

    CSV_DIR.mkdir(parents=True, exist_ok=True)
    out_path = CSV_DIR / f"processed_emails_{RUN_DATE}_{TIMESTAMP}.csv"
    try:
        with open(out_path, mode='w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerow(PROCESSED_EXPORT_HEADERS)
            writer.writerows(rows)
        logger.info(f"Wrote {len(rows)} processed email(s) to {out_path}")
    except Exception as e:
        logger.error(f"Failed to write processed-emails export: {e}")


GMAIL_BATCH_MODIFY_MAX_IDS = 1000  # Gmail API hard limit per batchModify call


def archive_existing_processed(gmail_service, logger):
    """One-off cleanup pass: finds every '_ _ JOB SEARCH/IC'-labeled email still sitting in
    the inbox (from before archive/mark-read was added to the normal end-of-run labeling) and
    removes INBOX/UNREAD from them. No extraction, no Sheets writes -- just label cleanup."""
    query = f'label:"{PROCESSED_LABEL}" label:"INBOX"'
    logger.info(f"Finding already-processed emails still sitting in the inbox: {query}")
    briefs = list_all_messages(gmail_service, query, logger)

    if not briefs:
        logger.info("Nothing to archive -- no IC-labeled emails are currently in the inbox.")
        print("Nothing to archive -- no IC-labeled emails are currently in the inbox.")
        return

    logger.info(f"Found {len(briefs)} already-processed email(s) still in the inbox. Archiving + marking read...")
    ids = [b['id'] for b in briefs]
    archived = 0
    for start in range(0, len(ids), GMAIL_BATCH_MODIFY_MAX_IDS):
        chunk = ids[start:start + GMAIL_BATCH_MODIFY_MAX_IDS]
        request = gmail_service.users().messages().batchModify(
            userId='me', body={'ids': chunk, 'removeLabelIds': ['INBOX', 'UNREAD']}
        )
        try:
            execute_with_backoff(request, logger, what=f"archive batch ({start + 1}-{start + len(chunk)}/{len(ids)})")
            archived += len(chunk)
        except Exception as e:
            logger.error(f"Archive batch {start + 1}-{start + len(chunk)} failed even after retries "
                        f"({type(e).__name__}: {e}). {archived} email(s) archived so far; "
                        f"re-run --archive-existing-processed to pick up the rest.")
            break

    logger.info(f"Archived + marked read: {archived}/{len(ids)} email(s).")
    print(f"Archived + marked read: {archived}/{len(ids)} email(s).")


SHEET_APPEND_BATCH_SIZE = 200  # rows per append call -- smaller requests are less exposed to
                                # a dropped connection mid-transfer, and a failure partway
                                # through only costs the current batch, not everything


def flush_sheet_writes(sheets_service, rows_to_append, logger, add_separator=False):
    """Writes in batches rather than one giant append. If a batch fails even after retries,
    logs exactly which rows didn't make it (with their index range) and re-raises -- the
    caller already has everything in the local CSV as a fallback, so nothing is lost, but the
    person running it needs to know which rows still need a manual push to Sheets.

    add_separator=True prepends one blank row before this run's data, so consecutive runs are
    visually broken up in the sheet. Skipped when the tab has no prior data yet (nothing to
    separate from), and never written to the CSV or counted in the "rows appended" total."""
    if not rows_to_append:
        return

    total = len(rows_to_append)
    written = 0
    for i, start in enumerate(range(0, total, SHEET_APPEND_BATCH_SIZE)):
        batch = rows_to_append[start:start + SHEET_APPEND_BATCH_SIZE]
        payload = ([[''] * len(CSV_HEADERS)] + batch) if (i == 0 and add_separator) else batch
        request = sheets_service.spreadsheets().values().append(
            spreadsheetId=SPREADSHEET_ID,
            range=RANGE_NAME,
            valueInputOption='USER_ENTERED',
            body={'values': payload}
        )
        try:
            execute_with_backoff(request, logger, what=f"sheets append (rows {start + 1}-{start + len(batch)}/{total})")
            written += len(batch)
        except Exception as e:
            logger.error(f"Sheets append failed for rows {start + 1}-{start + len(batch)} of {total} "
                        f"even after retries ({e}). {written} row(s) made it to the sheet before this; "
                        f"the rest are safe in the local run CSV and can be pasted in manually if needed.")
            raise

    logger.info(f"Appended {written} new row(s) to '{SHEET_NAME}'"
                f"{' (with a separator row before them)' if add_separator else ''}.")


# ==================== PER-EMAIL WORKER (for multitasked extraction) ====================

def process_one_email(brief, fetched, logger):
    """Parses one email and runs LLM extraction on it. Designed to be called concurrently
    across emails -- creates its own Ollama client since ollama.Client wraps its own
    requests session and isn't guaranteed shareable across threads."""
    msg_id = brief['id']
    msg = fetched.get(msg_id)
    if msg is None:
        logger.warning(f"Skipping message {msg_id} -- batch fetch failed for it.")
        return msg_id, [], False, None

    headers = msg['payload'].get('headers', [])
    date = parse_email_date(next((h['value'] for h in headers if h['name'].lower() == 'date'), ''))
    subject = next((h['value'] for h in headers if h['name'].lower() == 'subject'), '')
    from_header = next((h['value'] for h in headers if h['name'].lower() == 'from'), '')
    platform = guess_platform_from_email(from_header, subject)
    gmail_link = build_gmail_link(msg_id)

    html_body = extract_html_body(msg['payload'])
    if html_body:
        text_with_links, link_map = html_to_text_with_links(html_body)
    else:
        text_with_links = extract_plain_body(msg['payload']) or msg.get('snippet', '')
        link_map = {}
        logger.warning(f"Email {msg_id} ('{subject}') has no HTML part -- job links won't be captured.")

    logger.info(f"--- Processing '{subject}' from {platform} ({msg_id}) ---")
    client = ollama.Client(host=OLLAMA_HOST)
    email_label = f"{subject[:80]} ({msg_id})"
    jobs = extract_jobs_from_email(client, text_with_links, logger, link_map=link_map, email_label=email_label)
    logger.info(f"  Extracted {len(jobs)} job posting(s) from '{subject}'.")

    for j in jobs:
        j['date'] = date
        j['platform'] = platform
        j['message_id'] = msg_id
        j['gmail_link'] = gmail_link

    return msg_id, jobs, True, platform


# ==================== MAIN ====================

def main(dry_run=False, no_enrich=False, reprocess_recent=None, export_processed=False,
         archive_existing=False):
    start_time = time.time()
    archive_old_logs()
    logger = setup_logging()

    if export_processed:
        logger.info("Job listings scanner starting... (--export-processed-emails)")
        gmail_service, _ = get_google_services(logger)
        export_processed_emails_csv(gmail_service, logger)
        return

    if archive_existing:
        logger.info("Job listings scanner starting... (--archive-existing-processed)")
        gmail_service, _ = get_google_services(logger)
        archive_existing_processed(gmail_service, logger)
        return

    logger.info(f"Job listings scanner starting... "
                f"(dry_run={dry_run}, no_enrich={no_enrich}, reprocess_recent={reprocess_recent})")

    stats = {'emails_scanned': 0, 'jobs_extracted': 0, 'rows_appended': 0,
              'rows_updated': 0, 'urls_enriched': 0, 'enrich_failures': 0}

    gmail_service, sheets_service = get_google_services(logger)
    ensure_sheet_tab_exists(sheets_service, logger)
    processed_label_id = get_or_create_label_id(gmail_service, PROCESSED_LABEL, logger)
    searches_label_id = get_or_create_label_id(gmail_service, SEARCHES_LABEL, logger)
    existing_rows = get_existing_sheet_data(sheets_service, logger)
    applied_rows = get_applied_sheet_data(sheets_service, logger)

    if reprocess_recent:
        # Normal runs remove SEARCHES_LABEL once an email is processed, so the usual
        # `label:SEARCHES -label:IC` query can't find already-processed emails anymore.
        # Match on IC instead (still present) so we can re-run extraction against them.
        cutoff_date = (datetime.now() - timedelta(days=reprocess_recent)).strftime('%Y/%m/%d')
        query = f'label:"{PROCESSED_LABEL}" after:{cutoff_date}'
        logger.info(f"--reprocess-recent {reprocess_recent}: re-scanning already-processed "
                    f"emails from the last {reprocess_recent} day(s), ignoring the IC filter.")
    else:
        cutoff_date = (datetime.now() - timedelta(days=TWO_WEEKS_DAYS)).strftime('%Y/%m/%d')
        query = f'label:"{SEARCHES_LABEL}" -label:"{PROCESSED_LABEL}" after:{cutoff_date}'

    briefs = list_all_messages(gmail_service, query, logger)

    if not briefs:
        window_desc = f"the last {reprocess_recent} day(s)" if reprocess_recent else f"the last {TWO_WEEKS_DAYS} days"
        logger.info(f"No {'processed' if reprocess_recent else 'new'} job-alert digest emails found in {window_desc}.")
        write_summary_log(stats)
        return

    logger.info(f"Found {len(briefs)} digest email(s) to {'re-' if reprocess_recent else ''}process "
                f"(newer than {cutoff_date}).")
    if len(briefs) > 50:
        est_secs = len(briefs) * 25  # rough: ~15-40s/email seen in practice, varies with digest size
        logger.info(f"That's a large batch -- rough estimate {format_duration(est_secs)}, "
                    f"could run longer depending on digest size. Progress logs every "
                    f"{PROGRESS_LOG_EVERY_N} email(s) or {PROGRESS_LOG_EVERY_SECS}s below.")
    fetched = batch_fetch_messages(gmail_service, briefs, logger)

    # Multitask extraction across emails -- each email's chunked LLM calls happen
    # sequentially within its own worker, but multiple emails run concurrently, bounded by
    # CLASSIFY_WORKERS so Ollama isn't flooded with more parallel requests than it can serve.
    all_jobs = []
    processed_ids = []
    completed = 0
    last_progress_log = time.time()
    run_platform_counts = {}  # platform -> {'emails': n, 'jobs': n}, this run only
    with ThreadPoolExecutor(max_workers=CLASSIFY_WORKERS) as ex:
        futures = {ex.submit(process_one_email, brief, fetched, logger): brief for brief in briefs}
        for fut in as_completed(futures):
            msg_id, jobs, fetch_ok, platform = fut.result()
            if fetch_ok:
                processed_ids.append(msg_id)
                stats['emails_scanned'] += 1
                entry = run_platform_counts.setdefault(platform, {'emails': 0, 'jobs': 0})
                entry['emails'] += 1
                entry['jobs'] += len(jobs)
            all_jobs.extend(jobs)

            completed += 1
            now = time.time()
            if completed % PROGRESS_LOG_EVERY_N == 0 or (now - last_progress_log) >= PROGRESS_LOG_EVERY_SECS:
                elapsed = now - start_time
                rate = completed / elapsed if elapsed > 0 else 0
                remaining = (len(briefs) - completed) / rate if rate > 0 else 0
                logger.info(f"Progress: {completed}/{len(briefs)} email(s), "
                            f"{len(all_jobs)} job(s) extracted so far. "
                            f"Est. {format_duration(remaining)} remaining.")
                last_progress_log = now

    stats['jobs_extracted'] = len(all_jobs)
    sheet_write_failed = False

    if not all_jobs:
        logger.info("No individual job postings were extracted from any email.")
    else:
        if no_enrich:
            logger.info("Skipping URL enrichment (--no-enrich).")
        else:
            logger.info(f"Visiting all {len(all_jobs)} job URL(s) to fill in missing details...")
            all_jobs = enrich_all_jobs(all_jobs, logger, stats)

        rows_to_append = []
        for j in all_jobs:
            status = "Needs Review" if (not j.get('location') or not j.get('comp')) else "OK"
            staffing = is_staffing_agency(j['company'])
            us_eligible, eligibility_reason = classify_us_eligibility(j['location'], j['comp'])
            notes = j.get('notes', '')
            if eligibility_reason:
                notes = f"{notes}; {eligibility_reason}" if notes else eligibility_reason
            applied_status = check_applied_status(applied_rows, j['company'], j['title'])
            if applied_status:
                tag = f"[{applied_status}]"
                notes = f"{tag} {notes}" if notes else tag
            row = [j['date'], j['title'], j['company'], j['location'], j['comp'], j['platform'],
                   j['url'], j['message_id'], j['gmail_link'], notes, status,
                   "Yes" if staffing else "No", us_eligible]

            action, _, method = plan_row_action(existing_rows, rows_to_append, row, j['company'],
                                                 j['title'], staffing, logger)
            if action == 'append':
                rows_to_append.append(row)
                stats['rows_appended'] += 1
            else:
                logger.debug(f"Skipping duplicate: {j['company']} - {j['title']} ({method})")

        write_run_csv(rows_to_append, logger)

        if dry_run:
            logger.info("--dry-run: not writing to Sheets, CSV written for review above.")
            print(f"\n{len(rows_to_append)} job(s) would be written to Sheets:")
            for row in rows_to_append:
                agency_tag = " [AGENCY]" if row[11] == "Yes" else ""
                eligibility_tag = " [NON-US]" if row[12] == "No" else ""
                print(f"  [{row[10]}]{agency_tag}{eligibility_tag} {row[2]} -- {row[1]} ({row[3]}, {row[4] or 'comp n/a'}) [{row[5]}] {row[6]}")
        else:
            try:
                flush_sheet_writes(sheets_service, rows_to_append, logger, add_separator=bool(existing_rows))
            except Exception as e:
                # Already logged in detail inside flush_sheet_writes (which rows made it,
                # which didn't). Don't let a Sheets outage crash the whole run and don't mark
                # these emails as processed -- next run will safely re-extract and retry them.
                # The CSV above already has everything regardless.
                sheet_write_failed = True
                logger.error(f"Continuing without marking this run's emails as processed, "
                            f"since the Sheets write didn't fully succeed ({type(e).__name__}). "
                            f"Re-run normally and they'll be picked up again.")

    if processed_ids and not dry_run and not sheet_write_failed:
        try:
            request = gmail_service.users().messages().batchModify(
                userId='me',
                body={'ids': processed_ids, 'addLabelIds': [processed_label_id],
                      # Removing Gmail's system INBOX/UNREAD labels is what "archive" and
                      # "mark as read" actually are under the hood -- so processed emails
                      # drop out of the default inbox view instead of sitting there unread.
                      'removeLabelIds': [searches_label_id, 'INBOX', 'UNREAD']}
            )
            execute_with_backoff(request, logger, what="gmail batchModify")
            logger.info(f"Marked {len(processed_ids)} email(s) as processed "
                        f"(added IC, removed '{SEARCHES_LABEL}', archived + marked read).")
        except Exception as e:
            # Sheets already has the data at this point -- worst case here is just that
            # these emails get harmlessly re-extracted next run instead of skipped.
            logger.error(f"Couldn't mark emails as processed after Sheets write succeeded "
                        f"({type(e).__name__}: {e}). Not fatal -- they'll just get "
                        f"re-scanned (and safely de-duped) next run.")
    elif processed_ids and dry_run:
        logger.info(f"--dry-run: would have marked {len(processed_ids)} email(s) as processed "
                    f"(IC added, '{SEARCHES_LABEL}' removed).")
    elif processed_ids and sheet_write_failed:
        logger.info(f"Not marking {len(processed_ids)} email(s) as processed -- Sheets write "
                    f"didn't fully succeed this run, so they're left for next time.")

    if run_platform_counts and not dry_run:
        merged_stats = update_platform_stats(run_platform_counts, logger)
        zero_yield_now = [p for p, c in run_platform_counts.items() if c['emails'] > 0 and c['jobs'] == 0]
        if zero_yield_now:
            logger.info(f"Zero jobs extracted this run from: {', '.join(sorted(zero_yield_now))} "
                        f"(run --platform-report for the all-time picture before deciding to drop any).")

    stats['duration_secs'] = time.time() - start_time
    write_summary_log(stats)
    logger.info(f"Done in {format_duration(stats['duration_secs'])}. "
                f"{stats['jobs_extracted']} job(s) extracted, {stats['rows_appended']} new row(s) written.")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="Scan job-alert digest emails and extract individual postings.")
    parser.add_argument('--dry-run', action='store_true',
                         help="Extract and enrich, print/write CSV for review, but don't touch Gmail labels or Sheets.")
    parser.add_argument('--no-enrich', action='store_true',
                         help="Skip visiting job URLs -- faster, useful for testing the extraction prompt alone.")
    parser.add_argument('--reprocess-recent', type=int, default=None, metavar='N',
                         help="One-time cleanup pass: re-scan emails already marked IC from the last N days "
                              "(e.g. after a bug fix). Ignores the normal 'already processed' skip.")
    parser.add_argument('--export-processed-emails', action='store_true',
                         help="Write a local CSV listing every email ever marked processed (IC label), "
                              "all-time. Doesn't touch Sheets/Gmail labels -- just a local report, then exits.")
    parser.add_argument('--archive-existing-processed', action='store_true',
                         help="One-off cleanup: archive + mark-read every IC-labeled email still sitting "
                              "in the inbox from before this behavior was added to normal runs. No "
                              "extraction, no Sheets writes -- just label cleanup, then exits.")
    parser.add_argument('--platform-report', action='store_true',
                         help="Print the all-time per-source yield (emails seen vs. jobs extracted) from "
                              "data/platform_stats.json, worst-yield first. Purely local, no Gmail/Sheets "
                              "auth needed, then exits.")
    args = parser.parse_args()

    if args.platform_report:
        print_platform_report(load_platform_stats())
        raise SystemExit(0)

    try:
        main(dry_run=args.dry_run, no_enrich=args.no_enrich,
             reprocess_recent=args.reprocess_recent, export_processed=args.export_processed_emails,
             archive_existing=args.archive_existing_processed)
    except Exception as e:
        try:
            logging.getLogger("JobListingsScanner").exception(f"CRITICAL ERROR: {e}")
        except Exception:
            print(f"\nCRITICAL ERROR: {e}")
        import traceback
        traceback.print_exc()