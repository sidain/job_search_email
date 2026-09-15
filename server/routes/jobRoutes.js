const { spawn } = require('child_process');
const Job = require('../models/Job');
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const { archiveOldEmailScanLogs } = require('../utils/logArchiving');



// GET all active jobs
router.get('/', async (req, res) => {
    try {
        const jobs = await Job.find({ deleted: { $ne: true } }).sort({ last_updated: -1 });
        res.json(jobs);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching jobs', error });
    }
});

// trigger python email scanner
router.post('/emailScan', async (req, res) => {
    try{
        const { dryRun, noEnrich} = req.body;

        const args = [ 'job_search_email.py'];

        if( dryRun) args.push('--dry-run');
        if( noEnrich) args.push('--no-enrich');

        const rootDir = path.join(__dirname, '../../');
        const logsDir = path.join(rootDir, 'logs');

        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }

        archiveOldEmailScanLogs(logsDir, rootDir);

        const logFilename = `email_scan_${Date.now()}.log`;
        const logFilePath = path.join(logsDir, logFilename);
        const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

        const pythonProcess = spawn( 'python3', args, {
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
            stdoutData += data.toString() 
        });

        pythonProcess.stderr.on('data', data => { 
            stderrData += data.toString() 
        });

        pythonProcess.on('close', (code) => {
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