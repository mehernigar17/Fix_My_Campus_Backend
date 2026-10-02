const mongoose = require('mongoose');

const CATEGORIES = ['Electrical', 'Water', 'Cleanliness', 'Furniture', 'Internet', 'Other'];
const STATUSES = ['open', 'in_progress', 'resolved'];

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
    upvoteCount: this.upvoteCount ?? this.upvotes?.length ?? 0,
    upvotedByMe: false, // set per-request by the controller when req.user is known
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

const Report = mongoose.model('Report', reportSchema);

module.exports = Report;
module.exports.CATEGORIES = CATEGORIES;
module.exports.STATUSES = STATUSES;