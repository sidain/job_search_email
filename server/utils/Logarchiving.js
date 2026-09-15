const fs = require('fs');
const path = require('path');

// Moves any email_scan_*.log files left over from previous runs into archives/logs/ so
// logs/ only ever contains the current run's file. Mirrors the archive_old_logs()
// convention already used for job_listings_*.log in job_search_email.py.
function archiveOldEmailScanLogs(logsDir, rootDir) {
    if (!fs.existsSync(logsDir)) return;

    const oldLogs = fs.readdirSync(logsDir)
        .filter(f => f.startsWith('email_scan_') && f.endsWith('.log'));

    if (oldLogs.length === 0) return;

    const archiveDir = path.join(rootDir, 'archives', 'logs');
    if (!fs.existsSync(archiveDir)) {
        fs.mkdirSync(archiveDir, { recursive: true });
    }

    for (const file of oldLogs) {
        try {
            fs.renameSync(path.join(logsDir, file), path.join(archiveDir, file));
        } catch (err) {
            console.error(`Failed to archive log ${file}:`, err.message); // best-effort; a stuck file here shouldn't block a new run
        }
    }
}

module.exports = { archiveOldEmailScanLogs };