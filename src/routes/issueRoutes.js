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
  listComments,
  deleteComment,
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
const commentIdParam = param('commentId')
  .isMongoId()
  .withMessage('Invalid comment id.');

// Accepts human-friendly status spellings from the UI. Express 5 re-parses
// req.query on every access, so normalisation has to happen where the value is
// read (the controller); here we only accept the valid spellings.
// Accepts human-friendly status spellings from the UI, e.g. "In Progress",
// "in-progress", "OPEN" -> "in_progress". Express 5 re-parses req.query on every
// access, so query values are normalised in the controller instead; this
// middleware handles the PATCH body, which is safe to rewrite.
const CANONICAL_STATUSES = ['open', 'in_progress', 'resolved'];

const canonicalStatus = (value) =>
  String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');

const normalizeStatusBody = (req, res, next) => {
  if (req.body && req.body.status) {
    const key = canonicalStatus(req.body.status);
    req.body.status = CANONICAL_STATUSES.includes(key) ? key : req.body.status;
  }
  next();
};

const listValidation = [
  query('category').optional().isIn(CATEGORIES).withMessage('Invalid category filter.'),
  query('status')
    .optional()
    .customSanitizer(canonicalStatus)
    .isIn(CANONICAL_STATUSES)
    .withMessage('Invalid status filter.'),
  query('search').optional().trim().isLength({ max: 100 }).withMessage('Search is too long.'),
  query('location').optional().trim().isLength({ max: 160 }).withMessage('Location filter is too long.'),
  query('sort').optional().isIn(['newest', 'oldest', 'upvotes']).withMessage('Invalid sort option.'),
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be 1 or greater.'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100.'),
];

// ── Routes (all require a valid JWT) ──
// Mounted at /issues and /api/issues, so paths below are relative to that.

// POST /issues — multipart/form-data with optional "photo"
router.post('/', protect, withPhotoUpload, createValidation, check, createIssue);

// GET /issues?search=&category=&status=&location=&page=&limit=&sort=
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

// POST /issues/:id/comments — add a comment
router.post('/:id/comments', protect, idParam, commentValidation, check, addComment);

// GET /issues/:id/comments?page=&limit= — list comments (oldest first)
router.get('/:id/comments', protect, idParam, check, listComments);

// DELETE /issues/:id/comments/:commentId — comment author or admin
router.delete('/:id/comments/:commentId', protect, idParam, commentIdParam, check, deleteComment);

// PATCH /issues/:id/status — admin only
router.patch('/:id/status', protect, idParam, normalizeStatusBody, statusValidation, check, updateIssueStatus);

module.exports = router;