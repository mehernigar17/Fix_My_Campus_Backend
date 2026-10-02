const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

// ── Upload Directory ──
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Disk storage: unique random filename, original extension kept
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    const unique = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
    cb(null, unique);
  },
});

const fileFilter = (req, file, cb) => {
  if (ALLOWED_TYPES.includes(file.mimetype)) {
    return cb(null, true);
  }
  cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Only JPG, PNG, WEBP or GIF images are allowed.'));
};

// Single optional photo under field name "photo"
const uploadPhoto = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
}).single('photo');

// Wrapper: turns multer errors into clean JSON responses
const withPhotoUpload = (req, res, next) => {
  uploadPhoto(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'Photo must be 5 MB or smaller.'
          : err.field || 'Photo upload failed.';
      return res.status(400).json({ message });
    }
    return res.status(400).json({ message: err.message || 'Photo upload failed.' });
  });
};

/**
 * Public URL for a stored photo, relative to the API host.
 * @param {string} filename
 * @returns {string}
 */
const buildPhotoUrl = (filename) => `/uploads/${filename}`;

/**
 * Remove a stored photo file (best effort).
 * @param {string|null} filename
 */
const deletePhotoFile = (filename) => {
  if (!filename) return;
  const filePath = path.join(UPLOAD_DIR, path.basename(filename));
  fs.promises.unlink(filePath).catch(() => {});
};

module.exports = {
  uploadPhoto,
  withPhotoUpload,
  buildPhotoUrl,
  deletePhotoFile,
  UPLOAD_DIR,
  MAX_FILE_SIZE,
  ALLOWED_TYPES,
};