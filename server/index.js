const express = require('express');
const cors = require('cors');
require('dotenv').config();

const connectDB = require('./config/db');
const jobRoutes = require('./routes/jobRoutes');

const app = express();
const PORT = process.env.PORT || 5000;

// Connect to Database
connectDB();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/jobs', jobRoutes);

// Start Server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});