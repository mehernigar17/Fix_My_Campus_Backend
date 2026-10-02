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
  getIssueHistory,
  reviewIssue,
} = require('../controllers/issueController');
const { protect } = require('../middleware/authMiddleware');
const { withPhotoUpload } = require('../middleware/uploadMiddleware');
const {
  CATEGORIES,
  STATUSES,
  MODERATION_STATES,
  CANONICAL_STATUSES,
  canonicalStatus,
} = require('../models/Report');

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

// PATCH /issues/:id — every field optional, but whatever is sent must be
// valid. An admin uses this to correct one field (e.g. a wrong location)
// without resending the whole report; a student uses it to fix their own.
const partialUpdateValidation = [
  body('title').optional({ values: 'falsy' }).trim()
    .isLength({ min: 5, max: 120 }).withMessage('Title must be 5-120 characters.'),
  body('description').optional({ values: 'falsy' }).trim()
    .isLength({ min: 10, max: 2000 }).withMessage('Description must be 10-2000 characters.'),
  body('category').optional({ values: 'falsy' })
    .isIn(CATEGORIES).withMessage(`Category must be one of: ${CATEGORIES.join(', ')}.`),
  body('location').optional({ values: 'falsy' }).trim()
    .isLength({ min: 3, max: 160 }).withMessage('Location must be 3-160 characters.'),
  // Drop the photo without sending a new file. Accepts "true" or 1/true.
  body('removePhoto').optional({ values: 'falsy' })
    .isIn(['true', 'false', '1', '0', true, false])
    .withMessage('removePhoto must be true or false.'),
];

const statusValidation = [
  // normalizeStatusBody has already rewritten the value to its canonical
  // spelling by the time this runs, so only the three snake_case forms can
  // reach it.
  body('status').notEmpty().withMessage('Status is required.')
    .isIn(CANONICAL_STATUSES).withMessage(`Status must be one of: ${CANONICAL_STATUSES.join(', ')}.`),
  body('resolutionNote').optional().trim().isLength({ max: 1000 })
    .withMessage('Resolution note cannot exceed 1000 characters.'),
];

const commentValidation = [
  body('text')
    .trim()
    .notEmpty().withMessage('Comment text is required.')
    .isLength({ max: 1000 }).withMessage('Comment cannot exceed 1000 characters.'),
];

// The admin review decision: 'approve' publishes the report to the campus
// board, 'reject' keeps it off the board and shows the note to the reporter.
const moderationValidation = [
  body('decision')
    .notEmpty().withMessage('Decision is required.')
    .isIn(['approve', 'reject']).withMessage('Decision must be either approve or reject.'),
  body('note').optional().trim().isLength({ max: 500 })
    .withMessage('Review note cannot exceed 500 characters.'),
];

const idParam = param('id').isMongoId().withMessage('Invalid issue id.');
const commentIdParam = param('commentId')
  .isMongoId()
  .withMessage('Invalid comment id.');

// Accepts human-friendly status spellings from the UI, e.g. "In Progress",
// "in-progress", "OPEN" -> "in_progress". Express 5 re-parses req.query on every
// access, so query values are normalised by the controller instead (and by
// Report.statusFilterFor, which then matches every casing already stored).
// This middleware handles the PATCH /issues/:id/status body, which is safe to
// rewrite, and canonicalStatus itself lives in the model so the routes, the
// controller and the stored data can never disagree about what a status is.
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
  // Admin-only review filter; the controller rejects it for anyone else.
  query('moderation').optional()
    .isIn([...MODERATION_STATES, 'all'])
    .withMessage(`Review filter must be one of: ${MODERATION_STATES.join(', ')}.`),
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be 1 or greater.'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100.'),
];

// ── Routes (all require a valid JWT) ──
// Mounted at /issues and /api/issues, so paths below are relative to that.

// POST /issues — multipart/form-data with optional "photo"
router.post('/', protect, withPhotoUpload, createValidation, check, createIssue);

// GET /issues?search=&category=&status=&location=&page=&limit=&sort=
router.get('/', protect, listValidation, check, (req, res) => listIssues(req, res));

// GET /issues/categories — category/status lists for the frontend UI
router.get('/categories', (req, res) => {
  res.status(200).json({ categories: CATEGORIES, statuses: STATUSES });
});

// GET /issues/pending — the admin review queue (admin only).
// Express 5 re-parses req.query on every access, so the forced filter is a
// third argument instead of a rewrite of the query object.
router.get('/pending', protect, listValidation, check, (req, res) => listIssues(req, res, 'pending'));

// GET /issues/:id
router.get('/:id', protect, idParam, check, getIssue);

// PUT /issues/:id — owner, or any admin. Full edit of the four fields.
// multipart/form-data is accepted so an admin can replace the photo in the
// same request.
router.put('/:id', protect, idParam, withPhotoUpload, updateValidation, check, updateIssue);

// PATCH /issues/:id — owner, or any admin. Partial edit: send only what
// changes. Also the admin's way to drop a photo (removePhoto=true).
router.patch('/:id', protect, idParam, withPhotoUpload, partialUpdateValidation, check, updateIssue);

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

// GET /issues/:id/history — admin only. Every status change and review
// decision on one report, oldest first, with who made it.
router.get('/:id/history', protect, idParam, check, getIssueHistory);

// PATCH /issues/:id/moderation — admin only. Approve publishes the report to
// the campus board, reject keeps it off and shows the note to the reporter.
router.patch('/:id/moderation', protect, idParam, moderationValidation, check, reviewIssue);

module.exports = router;