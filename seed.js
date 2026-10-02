/**
 * Seed Script — creates a demo student and admin account in MongoDB Atlas
 * Run with: node seed.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./src/models/User');

const seedUsers = [
  {
    name: 'Demo Student',
    email: 'student@campus.edu',
    password: 'student123',
    role: 'student',
  },
  {
    name: 'Campus Admin',
    email: 'admin@campus.edu',
    password: 'admin123',
    role: 'admin',
  },
];

const seed = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB Atlas');

    for (const userData of seedUsers) {
      const exists = await User.findOne({ email: userData.email });
      if (exists) {
        console.log(`⚠️  User already exists: ${userData.email} — skipping`);
        continue;
      }
      const user = await User.create(userData);
      console.log(`✅ Created ${user.role}: ${user.email}`);
    }

    console.log('\n🎉 Seed complete!');
    console.log('   student@campus.edu / student123');
    console.log('   admin@campus.edu   / admin123');
  } catch (err) {
    console.error('❌ Seed failed:', err.message);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
};

seed();
