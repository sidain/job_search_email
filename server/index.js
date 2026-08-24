const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
// const cheerio = require('cheerio');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// MongoDB connection
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/job_listings_scanner';

mongoose.connect(MONGO_URI)
    .then(() => console.log('MongoDB connected'))
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

const Job = mongoose.model('Job', jobSchema, 'job_listings'); // Specify the collection name

app.get('/api/jobs', async (req, res) => {
    try {
        // 🚩 Filter for active (non-deleted) jobs only
        const jobs = await Job.find({ deleted: false }).sort({ last_updated: -1 });
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
            { new: true } // Returns the updated document
        );

        if (!updatedJob) {
            return res.status(404).json({ message: 'Job not found' });
        }

        res.json({ message: 'Job deleted successfully', job: updatedJob });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting job', error });
    }
});




// app.get('/api/proxy-job', async (req, res) => {
//     try {
//         const { url } = req.query;
//         const response = await axios.get(url, {
//         headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
//         });
//         // Remove frame restriction tags or base targets if present
//         res.send(response.data);
//     } catch (err) {
//         res.status(500).send('Unable to fetch external job page');
//     }
// });


// const puppeteer = require('puppeteer');

// app.get('/api/proxy-job', async (req, res) => {
//   const { url } = req.query;
//   if (!url) return res.status(400).send('URL is required');

//   let browser;
//   try {
//     browser = await puppeteer.launch({ headless: 'new' });
//     const page = await browser.newPage();
    
//     // Set a realistic browser User-Agent
//     await page.setUserAgent(
//       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
//     );

//     // Navigate to page
//     await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

//     // Inject <base> tag so relative CSS/Images load correctly from target site
//     await page.evaluate((targetUrl) => {
//       const base = document.createElement('base');
//       base.href = targetUrl;
//       document.head.appendChild(base);
//     }, url);

//     const content = await page.content();
//     await browser.close();

//     res.setHeader('Content-Type', 'text/html');
//     res.send(content);
//   } catch (err) {
//     if (browser) await browser.close();
//     console.error('Puppeteer fetch error:', err.message);
//     res.status(500).send('Unable to load external preview.');
//   }
// });




app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

