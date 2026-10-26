const { spawn } = require('child_process');
const Job = require('../models/Job');
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const { archiveOldEmailScanLogs } = require('../utils/logArchiving');


let isScanning = false;
let scanStartTime = null;
let lastScanDuration = null;
let currentLogFile = null; // Track the latest log file path


// Helper to generate formatted date-timestamp string: YYYY_MM_DD_SS
function getFormattedTimestamp() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const second = String(now.getSeconds()).padStart(2, '0');
    return `${year}_${month}_${day}_${second}`;
}

// GET all active jobs
router.get('/', async (req, res) => {
    try {
        const currentDate= new Date();
        const oneMonthAgo = new Date();
        oneMonthAgo.setMonth(currentDate.getMonth() - 1);

        const jobs = await Job.find({ 
            deleted: { $ne: true },

            last_updated: { 
                $gte: oneMonthAgo,
                $lte: currentDate
            },
        }).sort({ last_updated: -1 });
        
        res.json(jobs);
        
    } catch (error) {
    }
});


// GET scanner status
router.get('/emailScan/status', async (req, res) => {
    let lastLine = null;

    if (currentLogFile && fs.existsSync(currentLogFile)) {
        try {
            const fileContent = fs.readFileSync(currentLogFile, 'utf8');
            const lines = fileContent.split(/\r?\n/).filter(line => line.trim() !== '');
            if (lines.length > 0) {
                lastLine = lines[lines.length - 1];
            }
        } catch (err) {
            console.error('Error reading log file for status:', err);
        }
    }

    res.json({
        isScanning: isScanning,
        duration: lastScanDuration,
        lastLogLine: lastLine
    });
});


// trigger python email scanner
router.post('/emailScan', async (req, res) => {
    try {
        if (isScanning) {
            return res.status(400).json({ message: 'Already scanning' });
        }

        isScanning = true;
        scanStartTime = Date.now();
        lastScanDuration = null;

        const { dryRun, noEnrich } = req.body;
        const args = ['scripts/job_search_email.py'];

        if (dryRun) args.push('--dry-run');
        if (noEnrich) args.push('--no-enrich');

        const rootDir = path.join(__dirname, '../../');
        const logsDir = path.join(rootDir, 'logs');

        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }

        // Move older log files to archives/logs/<subfolder> before generating new log
        archiveOldEmailScanLogs(logsDir, rootDir);

        const timestampStr = getFormattedTimestamp();
        const logFilename = `${timestampStr}_email_scan.log`;
        const logFilePath = path.join(logsDir, logFilename);
        const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

        currentLogFile = logFilePath; // Store it so status can read it

        const pythonProcess = spawn('python3', args, {
            cwd: rootDir,
        });

        let stdoutData = '';
        let stderrData = '';

        pythonProcess.on('error', (err) => {
            console.error('Failed to start Python subprocess. Is Python installed and in your PATH?', err);
            logStream.write(`ERROR: Failed to start Python process: ${err.message}\n`);
            logStream.end();
        });

        // Pipe Python stdout and stderr directly into our log file stream
        pythonProcess.stdout.pipe(logStream);
        pythonProcess.stderr.pipe(logStream);

        pythonProcess.stdout.on('data', data => { 
            stdoutData += data.toString(); 
        });

        pythonProcess.stderr.on('data', data => { 
            stderrData += data.toString(); 
        });

        pythonProcess.on('close', (code) => {
            isScanning = false;
            lastScanDuration = Math.round((Date.now() - scanStartTime) / 1000);

            console.log(`Scanner finished with code ${code}. Log saved to ${logFilename}`);
            logStream.end();
        });

        return res.json({
            message: 'Scanner started',
            pid: pythonProcess.pid,
            logFile: logFilename
        });

    } catch (error) {
        console.error('Server error triggering scan:', error);
        return res.status(500).json({ message: 'Server error triggering scan', error: error.message });
    }
});

// PATCH update job
router.patch('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updatedJob = await Job.findByIdAndUpdate(
            id, 
            { $set: req.body }, 
            { new: true, runValidators: true }
        );

        if (!updatedJob) {
            return res.status(404).json({ message: 'Job not found' });
        }

        res.json({ message: 'Job updated successfully', job: updatedJob });
    } catch (error) {
        res.status(500).json({ message: 'Error updating job', error });
    }
});

// DELETE (soft delete) job
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updatedJob = await Job.findByIdAndUpdate(
            id, 
            { deleted: true }, 
            { returnDocument: true }
        );

        if (!updatedJob) {
            return res.status(404).json({ message: 'Job not found' });
        }

        res.json({ message: 'Job deleted successfully', job: updatedJob });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting job', error });
    }
});

// POST restore deleted job
router.post('/:id/undo', async (req, res) => {
    try {
        const { id } = req.params;
        const restoredJob = await Job.findByIdAndUpdate(
            id, 
            { deleted: false }, 
            { returnDocument: 'after' }
        );

        if (!restoredJob) {
            return res.status(404).json({ message: 'Job not found' });
        }

        res.json({ message: 'Job restored successfully', job: restoredJob });
    } catch (error) {
        res.status(500).json({ message: 'Error restoring job', error });
    }
});

module.exports = router;