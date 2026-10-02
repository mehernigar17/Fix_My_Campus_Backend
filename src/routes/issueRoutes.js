const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const {
  createIssue,
  listIssues,
  getIssue,
  updateIssue,
  deleteIssue,
  toggleUpvote,
  addComment,
  updateIssueStatus,
} = require('../controllers/issueController');
const { protect } = require('../middleware/authMiddleware');
const { withPhotoUpload } = require('../middleware/uploadMiddleware');
const { CATEGORIES, STATUSES } = require('../models/Report');

const router = express.Router();

// Short-circuits with 400 on any failed rule before the controller runs.
const check = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: errors.array()[0].msg, errors: errors.array() });
  }
  next();
};

// ── Validation Rules ──
const createValidation = [
  body('title')
    .trim()
    .notEmpty().withMessage('Title is required.')
    .isLength({ min: 5, max: 120 }).withMessage('Title must be 5-120 characters.'),
  body('description')
    .trim()
    .notEmpty().withMessage('Description is required.')
    .isLength({ min: 10, max: 2000 }).withMessage('Description must be 10-2000 characters.'),
  body('category')
    .notEmpty().withMessage('Category is required.')
    .isIn(CATEGORIES).withMessage(`Category must be one of: ${CATEGORIES.join(', ')}.`),
  body('location')
    .trim()
    .notEmpty().withMessage('Location is required.')
    .isLength({ min: 3, max: 160 }).withMessage('Location must be 3-160 characters.'),
];

const updateValidation = [
  body('title').trim().notEmpty().withMessage('Title is required.')
    .isLength({ min: 5, max: 120 }).withMessage('Title must be 5-120 characters.'),
  body('description').trim().notEmpty().withMessage('Description is required.')
    .isLength({ min: 10, max: 2000 }).withMessage('Description must be 10-2000 characters.'),
  body('category').isIn(CATEGORIES)
    .withMessage(`Category must be one of: ${CATEGORIES.join(', ')}.`),
  body('location').trim().notEmpty().withMessage('Location is required.')
    .isLength({ min: 3, max: 160 }).withMessage('Location must be 3-160 characters.'),
];

const statusValidation = [
  body('status').notEmpty().withMessage('Status is required.')
    .isIn(STATUSES).withMessage(`Status must be one of: ${STATUSES.join(', ')}.`),
  body('resolutionNote').optional().trim().isLength({ max: 1000 })
    .withMessage('Resolution note cannot exceed 1000 characters.'),
];

const commentValidation = [
  body('text')
    .trim()
    .notEmpty().withMessage('Comment text is required.')
    .isLength({ max: 1000 }).withMessage('Comment cannot exceed 1000 characters.'),
];

const idParam = param('id').isMongoId().withMessage('Invalid issue id.');

const listValidation = [
  query('category').optional().isIn(CATEGORIES).withMessage('Invalid category filter.'),
  query('status').optional().isIn(STATUSES).withMessage('Invalid status filter.'),
  query('search').optional().trim().isLength({ max: 100 }).withMessage('Search is too long.'),
  query('sort').optional().isIn(['newest', 'oldest', 'upvotes']).withMessage('Invalid sort option.'),
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be 1 or greater.'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100.'),
];

// ── Routes (all require a valid JWT) ──
// Mounted at /issues and /api/issues, so paths below are relative to that.

// POST /issues — multipart/form-data with optional "photo"
router.post('/', protect, withPhotoUpload, createValidation, check, createIssue);

// GET /issues?search=&category=&status=&page=&limit=&sort=
router.get('/', protect, listValidation, check, listIssues);

// GET /issues/categories — category/status lists for the frontend UI
router.get('/categories', (req, res) => {
  res.status(200).json({ categories: CATEGORIES, statuses: STATUSES });
});

// GET /issues/:id
router.get('/:id', protect, idParam, check, getIssue);

// PUT /issues/:id — owner only
router.put('/:id', protect, idParam, updateValidation, check, updateIssue);

// DELETE /issues/:id — owner or admin
router.delete('/:id', protect, idParam, check, deleteIssue);

// POST /issues/:id/upvote — add or remove (one per user)
router.post('/:id/upvote', protect, idParam, check, toggleUpvote);

// POST /issues/:id/comments
router.post('/:id/comments', protect, idParam, commentValidation, check, addComment);

// PATCH /issues/:id/status — admin only
router.patch('/:id/status', protect, idParam, statusValidation, check, updateIssueStatus);

module.exports = router;