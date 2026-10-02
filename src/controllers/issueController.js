const { validationResult } = require('express-validator');
const Report = require('../models/Report');
const { buildPhotoUrl, deletePhotoFile } = require('../middleware/uploadMiddleware');

// ── Controller: Issues ──

// Shapes a report for the response, marking whether the current user upvoted it.
const serialize = (report, userId) => {
  const obj = report.toPublicObject();
  obj.upvotedByMe = (report.upvotes || []).some((u) => String(u.user) === String(userId));
  return obj;
};

const findIssueOr404 = async (id) => {
  if (!id.match(/^[a-f\d]{24}$/i)) return null;
  return Report.findById(id);
};

/**
 * POST /issues  (protected, multipart/form-data)
 * Create a new issue with title, description, category, location and an optional photo.
 */
const createIssue = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      if (req.file) deletePhotoFile(req.file.filename);
      return res.status(400).json({ message: errors.array()[0].msg, errors: errors.array() });
    }

    const { title, description, category, location } = req.body;

    const issue = await Report.create({
      title,
      description,
      category,
      location,
      reportedBy: req.user._id,
      photo: req.file
        ? {
            filename: req.file.filename,
            url: buildPhotoUrl(req.file.filename),
            mimetype: req.file.mimetype,
            size: req.file.size,
          }
        : undefined,
    });

    await issue.populate('reportedBy', 'name email');

    res.status(201).json({
      message: 'Issue created successfully.',
      issue: serialize(issue, req.user._id),
    });
  } catch (error) {
    if (req.file) deletePhotoFile(req.file.filename);
    console.error('CreateIssue error:', error);
    if (error.name === 'ValidationError') {
      return res.status(400).json({ message: Object.values(error.errors)[0].message });
    }
    res.status(500).json({ message: 'Server error. Please try again later.' });
  }
};

/**
 * GET /issues?search=&category=&status=&page=&limit=&sort=
 * Search + filters. Students see only their own issues; admins see all.
 */
const listIssues = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg, errors: errors.array() });
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);

    const filter = {};
    if (req.query.category) filter.category = req.query.category;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.search) filter.$text = { $search: req.query.search };
    if (req.user.role !== 'admin' && req.query.mine !== 'true') {
      filter.reportedBy = req.user._id;
    } else if (req.query.mine === 'true') {
      filter.reportedBy = req.user._id;
    }

    const sortMap = {
      newest: { createdAt: -1 },
      oldest: { createdAt: 1 },
      upvotes: { upvoteCount: -1, createdAt: -1 },
    };
    const sort = sortMap[req.query.sort] || sortMap.newest;

    let query = Report.find(filter)
      .populate('reportedBy', 'name email')
      .populate('comments.user', 'name email');

    // "upvotes" is computed from the array length
    if (req.query.sort === 'upvotes') {
      query = query.sort({ upvotes: -1, createdAt: -1 });
    } else {
      query = query.sort(sort);
    }

    const [issues, total] = await Promise.all([
      query.skip((page - 1) * limit).limit(limit),
      Report.countDocuments(filter),
    ]);

    res.status(200).json({
      count: issues.length,
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
      issues: issues.map((i) => serialize(i, req.user._id)),
    });
  } catch (error) {
    console.error('ListIssues error:', error);
    res.status(500).json({ message: 'Server error. Please try again later.' });
  }
};

/**
 * GET /issues/:id  (protected — any logged-in user can browse issues)
 */
const getIssue = async (req, res) => {
  try {
    const issue = await findIssueOr404(req.params.id);
    if (!issue) {
      return res.status(404).json({ message: 'Issue not found.' });
    }

    await issue.populate('reportedBy', 'name email');
    await issue.populate('comments.user', 'name email');

    res.status(200).json({ issue: serialize(issue, req.user._id) });
  } catch (error) {
    console.error('GetIssue error:', error);
    res.status(500).json({ message: 'Server error. Please try again later.' });
  }
};

/**
 * PUT /issues/:id  (protected, owner only)
 * Full edit of title, description, category and location.
 */
const updateIssue = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg, errors: errors.array() });
    }

    const issue = await findIssueOr404(req.params.id);
    if (!issue) {
      return res.status(404).json({ message: 'Issue not found.' });
    }

    if (String(issue.reportedBy) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Only the owner can edit this issue.' });
    }

    const { title, description, category, location } = req.body;
    issue.title = title;
    issue.description = description;
    issue.category = category;
    issue.location = location;

    await issue.save();
    await issue.populate('reportedBy', 'name email');

    res.status(200).json({
      message: 'Issue updated successfully.',
      issue: serialize(issue, req.user._id),
    });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ message: Object.values(error.errors)[0].message });
    }
    console.error('UpdateIssue error:', error);
    res.status(500).json({ message: 'Server error. Please try again later.' });
  }
};

/**
 * DELETE /issues/:id  (protected, owner or admin)
 */
const deleteIssue = async (req, res) => {
  try {
    const issue = await findIssueOr404(req.params.id);
    if (!issue) {
      return res.status(404).json({ message: 'Issue not found.' });
    }

    const isOwner = String(issue.reportedBy) === String(req.user._id);
    if (!isOwner && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Only the owner or an admin can delete this issue.' });
    }

    deletePhotoFile(issue.photo?.filename);
    await issue.deleteOne();

    res.status(200).json({ message: 'Issue deleted successfully.' });
  } catch (error) {
    console.error('DeleteIssue error:', error);
    res.status(500).json({ message: 'Server error. Please try again later.' });
  }
};

/**
 * POST /issues/:id/upvote  (protected)
 * One upvote per user — calling it again removes the upvote.
 */
const toggleUpvote = async (req, res) => {
  try {
    const issue = await findIssueOr404(req.params.id);
    if (!issue) {
      return res.status(404).json({ message: 'Issue not found.' });
    }

    const already = (issue.upvotes || []).some((u) => String(u.user) === String(req.user._id));
    if (already) {
      issue.upvotes = issue.upvotes.filter((u) => String(u.user) !== String(req.user._id));
    } else {
      issue.upvotes.push({ user: req.user._id });
    }
    await issue.save({ validateBeforeSave: false });

    res.status(200).json({
      message: already ? 'Upvote removed.' : 'Issue upvoted.',
      upvoted: !already,
      upvoteCount: issue.upvotes.length,
    });
  } catch (error) {
    console.error('ToggleUpvote error:', error);
    res.status(500).json({ message: 'Server error. Please try again later.' });
  }
};

/**
 * POST /issues/:id/comments  (protected)
 */
const addComment = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg, errors: errors.array() });
    }

    const issue = await findIssueOr404(req.params.id);
    if (!issue) {
      return res.status(404).json({ message: 'Issue not found.' });
    }

    const comment = { user: req.user._id, text: req.body.text, createdAt: new Date() };
    issue.comments.push(comment);
    await issue.save({ validateBeforeSave: false });

    await issue.populate('reportedBy', 'name email');
    await issue.populate('comments.user', 'name email');

    const created = issue.comments[issue.comments.length - 1];

    res.status(201).json({
      message: 'Comment added successfully.',
      comment: {
        _id: created._id,
        text: created.text,
        createdAt: created.createdAt,
        user: {
          _id: req.user._id,
          name: req.user.name,
          email: req.user.email,
        },
      },
      issue: serialize(issue, req.user._id),
    });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ message: Object.values(error.errors)[0].message });
    }
    console.error('AddComment error:', error);
    res.status(500).json({ message: 'Server error. Please try again later.' });
  }
};

/**
 * PATCH /issues/:id/status  (protected, admin only)
 */
const updateIssueStatus = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg, errors: errors.array() });
    }

    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Only an admin can change issue status.' });
    }

    const issue = await findIssueOr404(req.params.id);
    if (!issue) {
      return res.status(404).json({ message: 'Issue not found.' });
    }

    const { status, resolutionNote } = req.body;
    issue.status = status;
    if (resolutionNote !== undefined) issue.resolutionNote = resolutionNote;
    issue.resolvedAt = status === 'resolved' ? new Date() : null;

    await issue.save();
    await issue.populate('reportedBy', 'name email');

    res.status(200).json({
      message: 'Issue status updated successfully.',
      issue: serialize(issue, req.user._id),
    });
  } catch (error) {
    console.error('UpdateIssueStatus error:', error);
    res.status(500).json({ message: 'Server error. Please try again later.' });
  }
};

/**
 * GET /my/issues  (protected) — the logged-in user's issues
 */
const listMyIssues = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);

    const filter = { reportedBy: req.user._id };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.category) filter.category = req.query.category;

    const [issues, total] = await Promise.all([
      Report.find(filter)
        .populate('reportedBy', 'name email')
        .populate('comments.user', 'name email')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Report.countDocuments(filter),
    ]);

    res.status(200).json({
      count: issues.length,
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
      issues: issues.map((i) => serialize(i, req.user._id)),
    });
  } catch (error) {
    console.error('ListMyIssues error:', error);
    res.status(500).json({ message: 'Server error. Please try again later.' });
  }
};

/**
 * GET /stats  (protected)
 * Counts by status and category, plus the most upvoted issues.
 */
const getStats = async (req, res) => {
  try {
    const scope = req.user.role === 'admin' ? {} : { reportedBy: req.user._id };

    const [byStatus, byCategory, topUpvoted] = await Promise.all([
      Report.aggregate([{ $match: scope }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
      Report.aggregate([{ $match: scope }, { $group: { _id: '$category', count: { $sum: 1 } } }]),
      Report.find(scope)
        .populate('reportedBy', 'name email')
        .populate('comments.user', 'name email')
        .sort({ upvotes: -1, createdAt: -1 })
        .limit(5),
    ]);

    const statusCounts = { open: 0, in_progress: 0, resolved: 0 };
    byStatus.forEach((s) => { statusCounts[s._id] = s.count; });

    const categoryCounts = {};
    byCategory.forEach((c) => { categoryCounts[c._id] = c.count; });

    res.status(200).json({
      total: Object.values(statusCounts).reduce((a, b) => a + b, 0),
      byStatus: statusCounts,
      byCategory: categoryCounts,
      topUpvoted: topUpvoted.map((i) => serialize(i, req.user._id)),
    });
  } catch (error) {
    console.error('GetStats error:', error);
    res.status(500).json({ message: 'Server error. Please try again later.' });
  }
};

module.exports = {
  createIssue,
  listIssues,
  getIssue,
  updateIssue,
  deleteIssue,
  toggleUpvote,
  addComment,
  updateIssueStatus,
  listMyIssues,
  getStats,
};