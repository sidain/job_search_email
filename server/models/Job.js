const mongoose = require('mongoose');

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

const COLLECTION_NAME = process.env.MONGO_COLLECTION_NAME || 'job_listings';

module.exports = mongoose.model('Job', jobSchema, COLLECTION_NAME);