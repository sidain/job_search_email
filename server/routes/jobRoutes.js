const express = require('express');
const router = express.Router();
const Job = require('../models/Job');

// GET all active jobs
router.get('/', async (req, res) => {
    try {
        const jobs = await Job.find({ deleted: { $ne: true } }).sort({ last_updated: -1 });
        res.json(jobs);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching jobs', error });
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