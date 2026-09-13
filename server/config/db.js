const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
        const DB_NAME = process.env.MONGO_DB_NAME || 'job_listings_scanner';

        await mongoose.connect(MONGO_URI, { dbName: DB_NAME });
        console.log(`MongoDB connected to database: ${DB_NAME}`);
    } catch (error) {
        console.error('MongoDB connection error:', error);
        process.exit(1);
    }
};

module.exports = connectDB;