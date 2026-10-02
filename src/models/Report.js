const mongoose = require('mongoose');
require('./User'); // Ensure User schema is registered for populate('reportedBy') and populate('comments.user')

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

// ── Status spellings ──
// Statuses were first stored with whatever casing the UI sent ("In Progress")
// and later normalised to snake_case. Both spellings still live in the
// database, so every query and every write accepts either form and always
// stores the canonical one.
const CANONICAL_STATUSES = ['open', 'in_progress', 'resolved'];

// Every stored spelling of one canonical status.
const STATUS_VARIANTS = {
  open: ['open', 'Open'],
  in_progress: ['in_progress', 'in progress', 'In Progress', 'In_Progress'],
  resolved: ['resolved', 'Resolved'],
};

// "In Progress", "in-progress", "IN_PROGRESS" -> "in_progress"
const canonicalStatus = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

/**
 * A Mongo filter matching a status however it is spelled in the database.
 * Returns `{ $in: [...] }` for a known status, or the raw value when the
 * caller passed something that is not one of the three (the route validators
 * reject those before the controller runs).
 */
const statusFilterFor = (value) => {
  const key = canonicalStatus(value);
  return STATUS_VARIANTS[key] ? { $in: STATUS_VARIANTS[key] } : String(value ?? '').trim();
};

/** True when the value names one of the three known statuses. */
const isCanonicalStatus = (value) => CANONICAL_STATUSES.includes(canonicalStatus(value));

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
        default: 'approved',
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
    // ── Status history (admin audit trail, oldest first) ──
    // Every admin status change appends one entry, so "who moved this to
    // In Progress, when, and why" is answerable from the report itself rather
    // than from server logs. `note` carries the resolution note when there was
    // one. Entries are written only by the API and are never accepted from
    // the client.
    statusHistory: [
      {
        _id: false,
        from: { type: String, default: null },
        to: { type: String, required: true },
        note: { type: String, default: '', trim: true, maxlength: 1000 },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        byRole: { type: String, enum: ['student', 'admin'], default: 'admin' },
        at: { type: Date, default: Date.now },
      },
    ],
    // ── Last admin edit (who corrected the report, and when) ──
    lastEditedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    lastEditedAt: {
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
// The admin board lists by work state and review state together
reportSchema.index({ status: 1, 'moderation.state': 1, createdAt: -1 });
// Oldest-first page of one report's audit trail
reportSchema.index({ statusHistory: { $exists: true } });

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
          role: this.reportedBy.role,
        }
      : this.reportedBy,
    resolvedAt: this.resolvedAt,
    // Audit trail. Empty for reports nobody has worked on yet; the controller
    // decides who may read it — see canSeeAuditTrail() in issueController.
    statusHistory: (this.statusHistory || []).map((h) => ({
      _id: h._id,
      from: h.from || null,
      to: h.to,
      note: h.note || '',
      at: h.at,
      by: h.by
        ? { _id: h.by._id || h.by, name: h.by.name, email: h.by.email }
        : null,
      byRole: h.byRole,
    })),
    lastEditedBy: this.lastEditedBy
      ? { _id: this.lastEditedBy._id, name: this.lastEditedBy.name }
      : this.lastEditedBy || null,
    lastEditedAt: this.lastEditedAt || null,
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
module.exports.CANONICAL_STATUSES = CANONICAL_STATUSES;
module.exports.STATUS_VARIANTS = STATUS_VARIANTS;
module.exports.canonicalStatus = canonicalStatus;
module.exports.statusFilterFor = statusFilterFor;
module.exports.isCanonicalStatus = isCanonicalStatus;
module.exports.normalizeForCompare = normalizeForCompare;
module.exports.duplicateKey = duplicateKey;

/**
 * Append one entry to a report's audit trail. Mutates the document but does
 * not save — the caller saves once so a status change is a single write.
 * @param {import('mongoose').Document} report
 * @param {{ from?: string|null, to: string, note?: string, by?: any, byRole?: 'student'|'admin', at?: Date }} entry
 */
Report.recordStatusChange = function (report, { from, to, note = '', by = null, byRole = 'admin', at = new Date() }) {
  if (!Array.isArray(report.statusHistory)) report.statusHistory = [];
  report.statusHistory.push({ from: from || null, to, note, by, byRole, at });
  return report;
};

/**
 * The moderation state of a document, defaulting to 'approved' for reports
 * filed before the gate existed. Safe on plain objects and query results.
 */
Report.moderationStateOf = (doc) => doc?.moderation?.state || 'approved';

/**
 * True when the report may appear on the public campus board.
 */
Report.isPublished = (doc) => Report.moderationStateOf(doc) === 'approved';

/**
 * A Mongo filter for one review state that also matches reports filed before
 * the gate existed. 'approved' has to match "no moderation field at all"
 * (those reports were published the moment they were filed) or an admin
 * filtering the board by Approved would silently lose them.
 */
Report.moderationFilterFor = (state) =>
  state === 'approved'
    ? { $or: [{ 'moderation.state': 'approved' }, { 'moderation.state': { $exists: false } }] }
    : { 'moderation.state': state };