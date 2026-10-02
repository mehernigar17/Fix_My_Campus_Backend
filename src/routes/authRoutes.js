const express = require('express');
const { body } = require('express-validator');
const { login, register, getMe } = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// ── Validation Rules ──
const loginValidation = [
  body('email')
    .isEmail().withMessage('Please enter a valid email address.')
    .normalizeEmail(),
  body('password')
    .notEmpty().withMessage('Password is required.')
    .isLength({ min: 6 }).withMessage('Password must be at least 6 characters.'),
  body('role')
    .isIn(['student', 'admin']).withMessage('Role must be either student or admin.'),
];

const registerValidation = [
  body('name')
    .trim()
    .notEmpty().withMessage('Name is required.')
    .isLength({ min: 2 }).withMessage('Name must be at least 2 characters.'),
  body('email')
    .isEmail().withMessage('Please enter a valid email address.')
    .normalizeEmail(),
  body('password')
    .isLength({ min: 6 }).withMessage('Password must be at least 6 characters.'),
  body('role')
    .optional()
    .isIn(['student', 'admin']).withMessage('Role must be either student or admin.'),
];

// ── Routes ──
// POST /api/auth/login
router.post('/login', loginValidation, login);

// POST /api/auth/register
router.post('/register', registerValidation, register);

// GET /api/auth/me  (protected)
router.get('/me', protect, getMe);

module.exports = router;
