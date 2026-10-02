const mongoose = require('mongoose');
const dns = require('dns');

// Force use of Google's public DNS (8.8.8.8) to resolve MongoDB Atlas SRV records
// This fixes "querySrv ECONNREFUSED" caused by routers that block SRV DNS queries
dns.setServers(['8.8.8.8', '8.8.4.4']);

/**
 * Connect to MongoDB Atlas with auto-retry
 */
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 15000,
      family: 4, // Force IPv4
    });
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`❌ MongoDB connection error: ${error.message}`);
    console.error(`   → Retrying in 5 seconds...`);
    // Retry after 5 seconds instead of crashing the server
    setTimeout(connectDB, 5000);
  }
};

module.exports = connectDB;
