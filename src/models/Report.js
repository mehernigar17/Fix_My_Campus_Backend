const mongoose = require('mongoose');

const CATEGORIES = ['Electrical', 'Water', 'Cleanliness', 'Furniture', 'Internet', 'Other'];
const STATUSES = ['open', 'in_progress', 'resolved', 'Open', 'In Progress', 'Resolved'];

// ── Moderation (admin review before a report reaches the campus board) ──
// A report is filed as `pending` and stays off the public board until an
// admin approves it. `rejected` reports are hidden too — the reporter can
// still see why, and editing one sends it back for review.
const MODERATION_STATES = ['pending', 'approved', 'rejected'];

// Reports filed before the moderation gate existed have no `moderation`
// field at all. They were published the moment they were filed, so they
// stay published: the public filter matches "no field" as well as
// "approved". `scripts/backfill-moderation.js` normalises them.
const PUBLISHED_FILTER = {
  $or: [{ moderation: { $exists: false } }, { 'moderation.state': 'approved' }],
};

// ── Duplicate detection ──
// Two reports describe the same problem when they name the same thing in the
// same place: the same category, plus a title and location that match once
// case, spacing and punctuation are ignored ("Tap leaking - Block C" and
// "tap leaking in block c" are one complaint, not two).
// Only unresolved reports block a new one: once staff resolve a problem the
// same complaint may be filed again, because a fixed fault can come back.
const UNRESOLVED_STATUSES = ['open', 'in_progress'];

const normalizeForCompare = (value) =>
  String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // drop accents so "café" matches "cafe"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ') // punctuation and separators collapse to one space
    .trim();

const duplicateKey = ({ title, location, category }) =>
  [String(category ?? ''), normalizeForCompare(location), normalizeForCompare(title)].join(' | ');

// ── Report Schema (Model) ──
const reportSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      minlength: [5, 'Title must be at least 5 characters'],
      maxlength: [120, 'Title cannot exceed 120 characters'],
    },
    description: {
      type: String,
      required: [true, 'Description is required'],
      trim: true,
      minlength: [10, 'Description must be at least 10 characters'],
      maxlength: [2000, 'Description cannot exceed 2000 characters'],
    },
    category: {
      type: String,
      required: [true, 'Category is required'],
      enum: {
        values: CATEGORIES,
        message: 'Category must be one of: ' + CATEGORIES.join(', '),
      },
    },
    location: {
      type: String,
      required: [true, 'Location is required'],
      trim: true,
      minlength: [3, 'Location must be at least 3 characters'],
      maxlength: [160, 'Location cannot exceed 160 characters'],
    },
    photo: {
      filename: { type: String, default: null },
      url: { type: String, default: null },
      mimetype: { type: String, default: null },
      size: { type: Number, default: null },
    },
    status: {
      type: String,
      enum: STATUSES,
      default: 'open',
    },
    resolutionNote: {
      type: String,
      trim: true,
      maxlength: [1000, 'Resolution note cannot exceed 1000 characters'],
      default: '',
    },
    // ── Moderation gate ──
    // Nothing reaches the campus board until an admin approves it. Only the
    // reporter and admins can see a report while it is `pending`, and the
    // review trail (who decided, when, why) lives here.
    moderation: {
      state: {
        type: String,
        enum: MODERATION_STATES,
        default: 'pending',
      },
      reviewedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
      },
      reviewedAt: {
        type: Date,
        default: null,
      },
      // Why an admin approved or turned a report down — shown to the reporter
      reviewNote: {
        type: String,
        trim: true,
        maxlength: [500, 'Review note cannot exceed 500 characters'],
        default: '',
      },
    },
    reportedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // ── Upvotes: one entry per user (toggle via /issues/:id/upvote) ──
    upvotes: [
      {
        _id: false,
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    // Denormalised count so sorting by votes is a plain numeric sort
    // (MongoDB cannot sort by array length).
    upvoteCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // ── Comments (embedded, newest last) ──
    comments: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        text: {
          type: String,
          required: [true, 'Comment cannot be empty'],
          trim: true,
          minlength: [1, 'Comment cannot be empty'],
          maxlength: [1000, 'Comment cannot exceed 1000 characters'],
        },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    resolvedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// ── Indexes: fast listing + filtering ──
reportSchema.index({ createdAt: -1 });
reportSchema.index({ category: 1, status: 1 });
reportSchema.index({ reportedBy: 1, createdAt: -1 });
reportSchema.index({ title: 'text', description: 'text', location: 'text' });
reportSchema.index({ upvoteCount: -1, createdAt: -1 });
reportSchema.index({ 'moderation.state': 1, createdAt: -1 });

// ── Instance Method: Public JSON shape ──
reportSchema.methods.toPublicObject = function () {
  return {
    _id: this._id,
    title: this.title,
    description: this.description,
    category: this.category,
    location: this.location,
    photo: this.photo && this.photo.url
      ? {
          filename: this.photo.filename,
          url: this.photo.url,
          mimetype: this.photo.mimetype,
          size: this.photo.size,
        }
      : null,
    status: this.status,
    resolutionNote: this.resolutionNote,
    // `note` and `reviewedBy` are stripped by the controller for anyone who
    // is neither the reporter nor an admin — see serialize() in issueController.
    moderation: {
      state: this.moderation?.state || 'approved',
      reviewedAt: this.moderation?.reviewedAt || null,
      reviewedBy: this.moderation?.reviewedBy || null,
      note: this.moderation?.reviewNote || '',
    },
    upvoteCount: this.upvoteCount ?? this.upvotes?.length ?? 0,
    upvotedByMe: false, // set per-request by the controller when req.user is known
    commentCount: (this.comments || []).length,
    comments: (this.comments || []).map((c) => ({
      _id: c._id,
      text: c.text,
      createdAt: c.createdAt,
      user: c.user
        ? { _id: c.user._id || c.user, name: c.user.name, email: c.user.email }
        : c.user,
    })),
    reportedBy: this.reportedBy
      ? {
          _id: this.reportedBy._id,
          name: this.reportedBy.name,
          email: this.reportedBy.email,
        }
      : this.reportedBy,
    resolvedAt: this.resolvedAt,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

// ── Static Method: Find an unresolved report of the same problem ──
// `excludeId` skips a document (used when editing, so a report never
// collides with itself). The Mongo filter narrows by category and status —
// the comparison that decides is the normalised key, done here in JS, so
// existing documents need no new field and no backfill.
reportSchema.statics.findActiveDuplicate = async function ({ title, location, category, excludeId = null }) {
  const key = duplicateKey({ title, location, category });
  if (!normalizeForCompare(title) || !normalizeForCompare(location)) return null;

  const filter = { category, status: { $in: UNRESOLVED_STATUSES } };
  if (excludeId) filter._id = { $ne: excludeId };

  const candidates = await this.find(filter);
  return candidates.find((doc) => duplicateKey(doc) === key) || null;
};

const Report = mongoose.model('Report', reportSchema);

module.exports = Report;
module.exports.CATEGORIES = CATEGORIES;
module.exports.STATUSES = STATUSES;
module.exports.UNRESOLVED_STATUSES = UNRESOLVED_STATUSES;
module.exports.MODERATION_STATES = MODERATION_STATES;
module.exports.PUBLISHED_FILTER = PUBLISHED_FILTER;
module.exports.normalizeForCompare = normalizeForCompare;
module.exports.duplicateKey = duplicateKey;

/**
 * The moderation state of a document, defaulting to 'approved' for reports
 * filed before the gate existed. Safe on plain objects and query results.
 */
Report.moderationStateOf = (doc) => doc?.moderation?.state || 'approved';

/**
 * True when the report may appear on the public campus board.
 */
Report.isPublished = (doc) => Report.moderationStateOf(doc) === 'approved';