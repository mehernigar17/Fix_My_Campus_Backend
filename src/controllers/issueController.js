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

// Shapes a single comment (user is populated with name + email).
const serializeComment = (c) => ({
  _id: c._id,
  text: c.text,
  createdAt: c.createdAt,
  user: c.user
    ? { _id: c.user._id || c.user, name: c.user.name, email: c.user.email }
    : c.user,
});

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

    // One board, one entry per problem: if this exact complaint is still
    // unresolved, hand the reporter the existing report to upvote instead of
    // creating a near-identical copy of it.
    const existing = await Report.findActiveDuplicate({ title, location, category });
    if (existing) {
      if (req.file) deletePhotoFile(req.file.filename);
      await existing.populate('reportedBy', 'name email');
      return res.status(409).json({
        message:
          'This problem is already reported. Upvote the existing report instead of creating a duplicate.',
        code: 'DUPLICATE_ISSUE',
        duplicateOf: serialize(existing, req.user._id),
      });
    }

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
 * Campus board: every signed-in user can browse every issue so that upvotes
 * and filters are meaningful. `mine=true` narrows the list to the caller.
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
    if (req.query.status) {
      // Accepts "open", "Open", "in_progress", "In Progress", "resolved", …
      // and matches every casing variant already stored in the database.
      const key = String(req.query.status).trim().toLowerCase().replace(/\s+/g, '_');
      const variants = {
        open: ['open', 'Open'],
        in_progress: ['in_progress', 'In Progress'],
        resolved: ['resolved', 'Resolved'],
      };
      filter.status = variants[key]
        ? { $in: variants[key] }
        : String(req.query.status).trim();
    }
    if (req.query.search) {
      const safe = req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { title: new RegExp(safe, 'i') },
        { description: new RegExp(safe, 'i') },
        { location: new RegExp(safe, 'i') },
      ];
    }
    if (req.query.location) {
      // Case-insensitive partial match so "room 204" finds "Block B, Room 204"
      const safe = req.query.location.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.location = new RegExp(safe, 'i');
    }
    // The campus board is shared; `mine=true` narrows it to the caller's own
    if (req.query.mine === 'true') {
      filter.reportedBy = req.user._id;
    }

    const sortMap = {
      newest: { createdAt: -1 },
      oldest: { createdAt: 1 },
      upvotes: { upvoteCount: -1, createdAt: -1 },
    };

    const query = Report.find(filter)
      .populate('reportedBy', 'name email')
      .populate('comments.user', 'name email')
      .sort(sortMap[req.query.sort] || sortMap.newest);

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

    // Editing must not smuggle a duplicate onto the board either — compare
    // against every other unresolved report, never against this one.
    const clash = await Report.findActiveDuplicate({
      title,
      location,
      category,
      excludeId: issue._id,
    });
    if (clash) {
      await clash.populate('reportedBy', 'name email');
      return res.status(409).json({
        message:
          'Another report already covers this problem. Upvote it instead of editing this report into a duplicate.',
        code: 'DUPLICATE_ISSUE',
        duplicateOf: serialize(clash, req.user._id),
      });
    }

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
      issue.upvoteCount = Math.max((issue.upvoteCount || 0) - 1, 0);
    } else {
      issue.upvotes.push({ user: req.user._id });
      issue.upvoteCount = (issue.upvoteCount || 0) + 1;
    }
    await issue.save({ validateBeforeSave: false });

    res.status(200).json({
      message: already ? 'Upvote removed.' : 'Issue upvoted.',
      upvoted: !already,
      upvoteCount: issue.upvoteCount,
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
      comment: serializeComment(created),
      commentCount: issue.comments.length,
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
 * GET /issues/:id/comments  (protected)
 * Comments for one issue, oldest first, paginated.
 */
const listComments = async (req, res) => {
  try {
    const issue = await findIssueOr404(req.params.id);
    if (!issue) {
      return res.status(404).json({ message: 'Issue not found.' });
    }

    await issue.populate('comments.user', 'name email');

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

    const all = issue.comments || [];
    const slice = all.slice((page - 1) * limit, page * limit);

    res.status(200).json({
      count: slice.length,
      total: all.length,
      page,
      pages: Math.ceil(all.length / limit) || 1,
      comments: slice.map(serializeComment),
    });
  } catch (error) {
    console.error('ListComments error:', error);
    res.status(500).json({ message: 'Server error. Please try again later.' });
  }
};

/**
 * DELETE /issues/:id/comments/:commentId  (protected — comment author or admin)
 */
const deleteComment = async (req, res) => {
  try {
    const issue = await findIssueOr404(req.params.id);
    if (!issue) {
      return res.status(404).json({ message: 'Issue not found.' });
    }

    const comment = (issue.comments || []).id(req.params.commentId);
    if (!comment) {
      return res.status(404).json({ message: 'Comment not found.' });
    }

    const isAuthor = String(comment.user) === String(req.user._id);
    if (!isAuthor && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Only the comment author or an admin can delete it.' });
    }

    comment.deleteOne();
    await issue.save({ validateBeforeSave: false });

    res.status(200).json({ message: 'Comment deleted successfully.', commentCount: issue.comments.length });
  } catch (error) {
    console.error('DeleteComment error:', error);
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
    const isResolved = status === 'resolved' || status === 'Resolved';
    issue.resolvedAt = isResolved ? (issue.resolvedAt || new Date()) : null;

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
    if (req.query.status) {
      const s = req.query.status.trim();
      if (s.toLowerCase() === 'open') {
        filter.status = { $in: ['open', 'Open'] };
      } else if (s.toLowerCase() === 'in progress' || s.toLowerCase() === 'in_progress') {
        filter.status = { $in: ['in_progress', 'In Progress'] };
      } else if (s.toLowerCase() === 'resolved') {
        filter.status = { $in: ['resolved', 'Resolved'] };
      } else {
        filter.status = s;
      }
    }
    if (req.query.category) filter.category = req.query.category;
    if (req.query.search) {
      const safe = req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { title: new RegExp(safe, 'i') },
        { description: new RegExp(safe, 'i') },
        { location: new RegExp(safe, 'i') },
      ];
    }
    if (req.query.location) {
      const safe = req.query.location.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.location = new RegExp(safe, 'i');
    }

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
 * Campus-wide counts by status and category, plus the most upvoted issues,
 * how many were resolved in the last 30 days and the average resolution time.
 */
const getStats = async (req, res) => {
  try {
    const scope = {};
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [byStatus, byCategory, topUpvoted, avgResolution, resolvedThisMonth] =
      await Promise.all([
        Report.aggregate([{ $match: scope }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
        Report.aggregate([{ $match: scope }, { $group: { _id: '$category', count: { $sum: 1 } } }]),
        Report.find(scope)
          .populate('reportedBy', 'name email')
          .populate('comments.user', 'name email')
          .sort({ upvoteCount: -1, createdAt: -1 })
          .limit(5),
        // Average time from report to resolution, in days
        Report.aggregate([
          { $match: { ...scope, status: { $in: ['resolved', 'Resolved'] }, resolvedAt: { $ne: null } } },
          {
            $group: {
              _id: null,
              avgMs: { $avg: { $subtract: ['$resolvedAt', '$createdAt'] } },
            },
          },
        ]),
        Report.countDocuments({ ...scope, status: { $in: ['resolved', 'Resolved'] }, resolvedAt: { $gte: thirtyDaysAgo } }),
      ]);

    const statusCounts = {
      open: 0,
      in_progress: 0,
      resolved: 0,
      Open: 0,
      'In Progress': 0,
      Resolved: 0,
    };
    let totalIssues = 0;
    byStatus.forEach((s) => {
      const count = s.count || 0;
      totalIssues += count;
      const key = String(s._id).toLowerCase();
      if (key === 'open') {
        statusCounts.open += count;
        statusCounts.Open += count;
      } else if (key === 'in_progress' || key === 'in progress') {
        statusCounts.in_progress += count;
        statusCounts['In Progress'] += count;
      } else if (key === 'resolved') {
        statusCounts.resolved += count;
        statusCounts.Resolved += count;
      } else if (s._id) {
        statusCounts[s._id] = count;
      }
    });

    const categoryCounts = {};
    byCategory.forEach((c) => { categoryCounts[c._id] = c.count; });

    const avgResolutionDays =
      avgResolution[0]?.avgMs != null
        ? Math.round((avgResolution[0].avgMs / 86400000) * 10) / 10
        : null;

    res.status(200).json({
      total: totalIssues,
      byStatus: statusCounts,
      byCategory: categoryCounts,
      resolvedThisMonth,
      avgResolutionDays,
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
  listComments,
  deleteComment,
  updateIssueStatus,
  listMyIssues,
  getStats,
};