const express = require('express');
const {
  listMyIssues,
  getStats,
} = require('../controllers/issueController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// Mounted at the app root: /my/issues and /stats (plus their /api equivalents via server.js)

// GET /my/issues — the logged-in user's issues
router.get('/my/issues', protect, listMyIssues);

// GET /stats — counts by status and category, plus top upvoted issues
router.get('/stats', protect, getStats);

module.exports = router;