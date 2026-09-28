const fs = require('fs');
const path = require('path');

function archiveOldEmailScanLogs(logsDir, rootDir) {
    if (!fs.existsSync(logsDir)) return;

    const archiveBase = path.join(rootDir, 'archives', 'logs');

    const files = fs.readdirSync(logsDir);
    for (const file of files) {
        const filePath = path.join(logsDir, file);
        const stat = fs.statSync(filePath);

        if (stat.isFile()) {
            let subfolder = 'other';
            if (file.startsWith('email_scan')) {
                subfolder = 'email_scan';
            } else if (file.includes('errors')) {
                subfolder = 'errors';
            } else if (file.includes('summary')) {
                subfolder = 'summary';
            } else if (file.startsWith('job_listings')) {
                subfolder = 'job_listings';
            }

            const targetDir = path.join(archiveBase, subfolder);
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }

            const targetPath = path.join(targetDir, file);
            try {
                fs.renameSync(filePath, targetPath);
            } catch (err) {
                console.error(`Failed to archive log file ${file}:`, err);
            }
        }
    }
}

module.exports = { archiveOldEmailScanLogs };