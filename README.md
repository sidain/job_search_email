# Job Search Email

Automated processing of Gmail job-alert emails into structured job-search data.

## Overview

`job_search_email` processes job-alert digest emails from services such as LinkedIn, Indeed, and other job boards.

Instead of treating an entire digest email as a single item, the application extracts the individual job postings contained within each message and converts them into structured records suitable for job-search tracking and analysis.

The workflow combines Gmail API access, local LLM processing through Ollama, optional web enrichment, Google Sheets integration, and CSV output.

## Features

* Scans Gmail for job-alert digest emails
* Processes individual job postings within each digest
* Extracts structured job information
* Supports job-description enrichment from posting URLs
* Uses a locally hosted Ollama model for classification and extraction
* Writes results to Google Sheets
* Produces a dated CSV export for each run
* Maintains Gmail labels to identify processed messages
* Supports dry-run processing
* Supports reprocessing of recently processed emails
* Processes multiple emails concurrently while limiting LLM concurrency
* Maintains processing logs and failed-chunk information

## Workflow

```text
Gmail Job Alerts
       │
       ▼
Find matching emails
       │
       ▼
Fetch digest messages
       │
       ▼
Extract individual job postings
       │
       ▼
Optional URL enrichment
       │
       ▼
Local LLM processing
       │
       ▼
Structured job records
       │
       ├──────────────► Google Sheets
       │
       └──────────────► CSV export
```

## Requirements

* Python 3.10+
* Gmail API access
* Google OAuth credentials
* Google Sheets access
* Ollama
* An Ollama model configured for the application
* Internet access for optional job-page enrichment

## Python Dependencies

Install the required packages with:

```bash
pip install ollama google-api-python-client google-auth-oauthlib requests beautifulsoup4
```

## Gmail Configuration

The application expects job-alert messages to be organized using Gmail labels.

By default, job-search messages are identified using:

```text
_ _ JOB SEARCH/a SEARCHES
```

Processed messages use:

```text
_ _ JOB SEARCH/IC
```

A Gmail filter can be used to automatically apply the search label to incoming job-alert messages.

## Authentication

Place the Google OAuth client credentials at:

```text
secrets/credentials.json
```

The first execution launches the Google OAuth consent flow.

After authentication, the application stores the resulting credentials for subsequent runs.

## Ollama

Ollama must be running locally.

Start the service with:

```bash
ollama serve
```

Then ensure the configured model has been downloaded.

## Usage

Normal processing:

```bash
python job_search_email.py
```

Dry run:

```bash
python job_search_email.py --dry-run
```

Dry-run mode processes and displays results without modifying Gmail or Google Sheets.

Recent-message reprocessing is also supported for troubleshooting and correcting extraction behavior.

## Output

The application produces:

### Google Sheets

A structured `Job Listings` worksheet containing extracted job postings.

### CSV

A dated CSV file containing the results from the current run.

### Logs

Processing and failed-chunk information is retained for troubleshooting and auditing.

## Design Goals

The project is designed around a few principles:

* **Local processing:** LLM processing can be performed locally through Ollama.
* **Repeatability:** Gmail labels provide an explicit processing boundary.
* **Fault tolerance:** Individual processing failures should not prevent the remaining batch from completing.
* **Structured output:** Unstructured job-alert emails are converted into records that can be searched and analyzed.
* **Controlled concurrency:** Network operations and LLM operations use separate concurrency limits.

## Project Status

🚧 **Active development**

The extraction and classification workflow is evolving as new job-alert formats and edge cases are encountered.

## License

No license has currently been specified for this repository.
