const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGO_DB_NAME || 'job_listings_scanner';
const COLLECTION_NAME = process.env.MONGO_COLLECTION_NAME || 'job_listings';

mongoose.connect(MONGO_URI, {
    dbName: DB_NAME
})
.then(() => console.log(`MongoDB connected to database: ${DB_NAME}`))
.catch(err => console.error('MongoDB connection error:', err));

    // Define the Job model
const jobSchema = new mongoose.Schema({
    title: String,
    company: String,
    location: String,
    comp: String,
    platform: String,
    url: String,
    message_id: String,
    gmail_link: String,
    notes: String,
    status: String,
    is_staffing_agency: Boolean,
    us_eligible: Boolean,
    last_updated: Date,
    deleted: { type: Boolean, default: false },
});


// ... and bind your model using the env variable collection name
const Job = mongoose.model('Job', jobSchema, COLLECTION_NAME);


app.get('/api/jobs', async (req, res) => {
    try {
        // 🚩 Filter for active (non-deleted) jobs only
        const jobs = await Job.find({ deleted: { $ne: true } }).sort({ last_updated: -1 });
        res.json(jobs);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching jobs', error });
    }
});

app.delete('/api/jobs/:id', async (req,res) => {
    try {
        // 🚩 Filter for active (non-deleted) jobs only
        const { id } = req.params;

        // 🚩 Soft delete the job by updating its deleted flag
        const updatedJob = await Job.findByIdAndUpdate(
            id, 
            { deleted: true }, 
            { returnDocument: true } // Returns the updated document
        );

        if (!updatedJob) {
            return res.status(404).json({ message: 'Job not found' });
        }

        res.json({ message: 'Job deleted successfully', job: updatedJob });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting job', error });
    }
});



app.post('/api/jobs/:id/undo', async (req, res) => {
    try {
        const { id } = req.params;
        const restoredJob = await Job.findByIdAndUpdate(
            id, 
            { deleted: false }, 
            { returnDocument: 'after' },   
        );

        if (!restoredJob) {
            return res.status(404).json({ message: 'Job not found' });
        }

        res.json({ message: 'Job restored successfully', job: restoredJob });
    } catch (error) {
        res.status(500).json({ message: 'Error restoring job', error });
    }
});


app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

