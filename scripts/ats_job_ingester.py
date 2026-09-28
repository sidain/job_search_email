"""
ats_job_ingester.py

Fetches active job listings from external ATS platforms (Greenhouse & Lever)
and upserts them into the local MongoDB database.
"""

import os
import logging
from pathlib import Path
from datetime import datetime, timezone
import requests
import pymongo

# ==================== CONFIGURATION ====================
ENV_FILE = Path('./.env')

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
    return val if val else DOTENV_VALUES.get(key, default).strip()

# Database Config
MONGO_URI = _env("MONGO_URI", "mongodb://localhost:27017")
MONGO_DB_NAME = _env("MONGO_DB_NAME", "job_listings_scanner")
MONGO_COLLECTION = _env("MONGO_COLLECTION_NAME", "job_listings")

# Target Companies
GREENHOUSE_TARGETS = ["cloudflare", "gitlab", "stripe"]
LEVER_TARGETS = []  # Add Lever company slugs here when ready

# Setup Logger
logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
logger = logging.getLogger("ATSIngester")

# ==================== DATABASE CONNECTION ====================
def get_mongo_collection():
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
        logger.error(f"Failed to connect to MongoDB: {e}")
        return None

# ==================== GREENHOUSE INGESTER ====================
def fetch_greenhouse_jobs(board_token: str):
    url = f"https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true"
    logger.info(f"Fetching Greenhouse jobs for target: '{board_token}'...")
    
    try:
        # ⏱️ Increased timeout from 10 to 25 seconds
        response = requests.get(url, timeout=25)
        response.raise_for_status()
        data = response.json()
        return data.get("jobs", [])
    except Exception as e:
        logger.error(f"Error fetching Greenhouse jobs for '{board_token}': {e}")
        return []

    

def process_greenhouse_job(job_data: dict, company_slug: str) -> dict:
    title = job_data.get("title", "Unknown Title")
    job_id = job_data.get("id")
    job_url = job_data.get("absolute_url", "")
    location = job_data.get("location", {}).get("name", "Remote / Unspecified")
    
    today_str = datetime.now().strftime("%Y-%m-%d")

    return {
        "date": today_str,
        "title": title,
        "company": company_slug.capitalize(),
        "location": location,
        "comp": "N/A",
        "platform": "Greenhouse",
        "url": job_url,
        "message_id": f"gh_{company_slug}_{job_id}",
        "gmail_link": "",
        "notes": f"Ingested from Greenhouse API ({company_slug})",
        "status": "New",
        "is_staffing_agency": "No",
        "us_eligible": "Yes",
        "last_updated": datetime.now(timezone.utc)  # ⏰ Updated to avoid deprecation warning
    }



# ==================== MAIN EXECUTION ====================
def run_ingestion():
    collection = get_mongo_collection()
    if collection is None:
        logger.error("Database connection unavailable. Exiting ingestion.")
        return

    all_docs = []

    # 1. Fetch and Process Greenhouse Jobs
    for slug in GREENHOUSE_TARGETS:
        raw_jobs = fetch_greenhouse_jobs(slug)
        logger.info(f"Retrieved {len(raw_jobs)} raw job listings from {slug}.")
        for raw in raw_jobs:
            doc = process_greenhouse_job(raw, slug)
            all_docs.append(doc)

    if not all_docs:
        logger.info("No jobs fetched to process.")
        return

    # 2. Bulk Upsert into MongoDB
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
        for doc in all_docs
    ]

    try:
        result = collection.bulk_write(operations, ordered=False)
        logger.info(
            f"Ingestion Complete! Upserted: {result.upserted_count}, Modified: {result.modified_count}"
        )
    except Exception as e:
        logger.error(f"Error writing batch to MongoDB: {e}")

if __name__ == "__main__":
    run_ingestion()