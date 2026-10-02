/**
 * Backfill Script — marks every report filed before the admin review gate as
 * approved.
 *
 * Those reports were published the moment they were filed, so they must stay
 * on the campus board. The API already treats a missing `moderation` field
 * as approved, which makes this script optional — but running it makes the
 * data explicit and lets the `moderation.state` index be used by the queries.
 *
 * Run with: npm run migrate:moderation
 */
require('dotenv').config();
const mongoose = require('mongoose');
const dns = require('dns');

// Force public DNS so MongoDB Atlas SRV records resolve (same fix as src/config/db.js)
dns.setServers(['8.8.8.8', '8.8.4.4']);
const Report = require('../src/models/Report');

const migrate = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB Atlas');

    const result = await Report.updateMany(
      { $or: [{ moderation: { $exists: false } }, { 'moderation.state': { $exists: false } }] },
      { $set: { 'moderation.state': 'approved' } }
    );

    const pending = await Report.countDocuments({ 'moderation.state': 'pending' });
    const rejected = await Report.countDocuments({ 'moderation.state': 'rejected' });

    console.log(`✅ Approved ${result.modifiedCount} existing report(s).`);
    console.log(`   Waiting for review: ${pending}`);
    console.log(`   Rejected:            ${rejected}`);
    console.log('\n🎉 Backfill complete!');
  } catch (err) {
    console.error('❌ Backfill failed:', err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    process.exit(process.exitCode || 0);
  }
};

migrate();