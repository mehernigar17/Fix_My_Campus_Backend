const { validationResult } = require('express-validator');
const Report = require('../models/Report');
const { buildPhotoUrl, deletePhotoFile } = require('../middleware/uploadMiddleware');

// ── Controller: Issues ──

// The review trail is private: only the reporter and admins learn who reviewed
// a report or why it was turned down.
const canSeeReviewDetail = (report, viewer) =>
  !!viewer &&
  (viewer.role === 'admin' || String(report.reportedBy?._id || report.reportedBy) === String(viewer._id));

// Shapes a report for the response, marking whether the current user upvoted it.
const serialize = (report, viewer) => {
  const obj = report.toPublicObject();
  const userId = viewer?._id;
  obj.upvotedByMe = (report.upvotes || []).some((u) => String(u.user) === String(userId));

  if (!canSeeReviewDetail(report, viewer)) {
    obj.moderation.reviewedBy = null;
    obj.moderation.note = '';
  } else if (obj.moderation.reviewedBy?._id) {
    obj.moderation.reviewedBy = {
      _id: obj.moderation.reviewedBy._id,
      name: obj.moderation.reviewedBy.name,
    };
  }

  return obj;
};

// Who is allowed to see a report at all. A report that is still awaiting
// admin review is private to its reporter and to admins — everyone else
// must not learn that it exists.
const canViewIssue = (issue, viewer) => {
  if (Report.isPublished(issue)) return true;
  if (viewer?.role === 'admin') return true;
  const owner = issue.reportedBy?._id || issue.reportedBy;
  return !!viewer && !!owner && String(owner) === String(viewer._id);
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
 * Create a new issue with title, description, category, location and an
 * optional photo. It is filed as `pending`: it stays off the campus board
 * until an admin approves it (PATCH /issues/:id/moderation).
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

      const isOwner = String(existing.reportedBy) === String(req.user._id);
      const isPublished = Report.isPublished(existing);

      // Your own report — the only case where a pending duplicate may be shown
      // back to you, because you filed it.
      if (isOwner) {
        if (isPublished) {
          await existing.populate('reportedBy', 'name email');
          return res.status(409).json({
            message:
              'You already reported this problem. Upvote your existing report instead of filing a duplicate.',
            code: 'DUPLICATE_ISSUE',
            duplicateOf: serialize(existing, req.user),
          });
        }
        return res.status(409).json({
          message: 'You already have a report waiting for review on this problem.',
          code: 'DUPLICATE_PENDING',
        });
      }

      // Someone else's report that is still awaiting review must stay private:
      // confirm the problem is known, but reveal no details, location or author.
      if (!isPublished && req.user.role !== 'admin') {
        return res.status(409).json({
          message:
            'Someone has already reported this problem and campus staff are checking it.',
          code: 'DUPLICATE_PENDING',
        });
      }

      await existing.populate('reportedBy', 'name email');
      return res.status(409).json({
        message:
          'This problem is already reported. Upvote the existing report instead of creating a duplicate.',
        code: 'DUPLICATE_ISSUE',
        duplicateOf: serialize(existing, req.user),
      });
    }

    const issue = await Report.create({
      title,
      description,
      category,
      location,
      reportedBy: req.user._id,
      moderation: { state: 'pending' },
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
      message: 'Report submitted. Campus staff will review it before it goes on the board.',
      issue: serialize(issue, req.user),
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
 * GET /issues?search=&category=&status=&page=&limit=&sort=&moderation=
 * Campus board: every signed-in user can browse every *approved* issue so
 * that upvotes and filters are meaningful. `mine=true` narrows the list to
 * the caller, who also sees their own reports while those are still
 * awaiting admin review. `moderation` is an admin-only queue filter; the
 * optional third argument forces one (GET /issues/pending).
 */
const listIssues = async (req, res, moderationOverride) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg, errors: errors.array() });
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const isAdmin = req.user.role === 'admin';
    const mine = req.query.mine === 'true';

    const filter = {};
    // Conditions that can each carry their own $or go into $and, so a keyword
    // search and the moderation gate can both be applied at the same time.
    const conditions = [];

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
      conditions.push({
        $or: [
          { title: new RegExp(safe, 'i') },
          { description: new RegExp(safe, 'i') },
          { location: new RegExp(safe, 'i') },
        ],
      });
    }
    if (req.query.location) {
      // Case-insensitive partial match so "room 204" finds "Block B, Room 204"
      const safe = req.query.location.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.location = new RegExp(safe, 'i');
    }
    // The campus board is shared; `mine=true` narrows it to the caller's own
    if (mine) {
      filter.reportedBy = req.user._id;
    }

    // ── Moderation gate ──
    const moderation = moderationOverride || req.query.moderation;
    if (moderation && !isAdmin) {
      return res.status(403).json({ message: 'Only an admin can browse reports by review state.' });
    }
    if (isAdmin) {
      // Admins work the whole queue: they see pending, approved and rejected
      // reports unless they narrow it down.
      if (moderation && moderation !== 'all') {
        filter['moderation.state'] = moderation;
      }
    } else if (!mine) {
      // Everyone else sees the published board only. A reporter's own list
      // (`mine=true`) also shows their reports while those await review.
      conditions.push(Report.PUBLISHED_FILTER);
    }

    if (conditions.length) filter.$and = conditions;

    const sortMap = {
      newest: { createdAt: -1 },
      oldest: { createdAt: 1 },
      upvotes: { upvoteCount: -1, createdAt: -1 },
    };

    const query = Report.find(filter)
      .populate('reportedBy', 'name email')
      .populate('moderation.reviewedBy', 'name')
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
      issues: issues.map((i) => serialize(i, req.user)),
    });
  } catch (error) {
    console.error('ListIssues error:', error);
    res.status(500).json({ message: 'Server error. Please try again later.' });
  }
};

/**
 * GET /issues/:id  (protected)
 * Anyone signed in can open an approved report. A report still awaiting
 * admin review is private to its reporter and to admins — everyone else
 * gets the same 404 as for a report that does not exist.
 */
const getIssue = async (req, res) => {
  try {
    const issue = await findIssueOr404(req.params.id);
    if (!issue || !canViewIssue(issue, req.user)) {
      return res.status(404).json({ message: 'Issue not found.' });
    }

    await issue.populate('reportedBy', 'name email');
    await issue.populate('moderation.reviewedBy', 'name');
    await issue.populate('comments.user', 'name email');

    res.status(200).json({ issue: serialize(issue, req.user) });
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
        duplicateOf: serialize(clash, req.user),
      });
    }

    issue.title = title;
    issue.description = description;
    issue.category = category;
    issue.location = location;

    // Fixing a report that was turned down sends it back for review, so the
    // board can never pick up an edit nobody has looked at. An approved
    // report stays published.
    const resubmitted = Report.moderationStateOf(issue) === 'rejected';
    if (resubmitted) {
      issue.moderation = {
        state: 'pending',
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: '',
      };
    }

    await issue.save();
    await issue.populate('reportedBy', 'name email');

    res.status(200).json({
      message: resubmitted
        ? 'Report updated and sent back for review.'
        : 'Issue updated successfully.',
      issue: serialize(issue, req.user),
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
 * One upvote per user — calling it again removes the upvote. Support for an
 * unapproved report is pointless (nobody else can see it yet), so it is
 * reserved for the reporter and admins.
 */
const toggleUpvote = async (req, res) => {
  try {
    const issue = await findIssueOr404(req.params.id);
    if (!issue || !canViewIssue(issue, req.user)) {
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
    if (!issue || !canViewIssue(issue, req.user)) {
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
      issue: serialize(issue, req.user),
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
    if (!issue || !canViewIssue(issue, req.user)) {
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
    if (!issue || !canViewIssue(issue, req.user)) {
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
 * Work state only. Approving a report for the board is a separate decision
 * made with PATCH /issues/:id/moderation — moving a pending report to
 * "Resolved" must not publish it.
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
      issue: serialize(issue, req.user),
    });
  } catch (error) {
    console.error('UpdateIssueStatus error:', error);
    res.status(500).json({ message: 'Server error. Please try again later.' });
  }
};

/**
 * PATCH /issues/:id/moderation  (protected, admin only)
 * The review gate. `decision: 'approve'` publishes the report to the campus
 * board; `'reject'` keeps it off the board and the reporter sees the note.
 * Either decision can be reversed later — the report simply moves between
 * pending, approved and rejected.
 */
const reviewIssue = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg, errors: errors.array() });
    }

    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Only an admin can review reports.' });
    }

    const issue = await findIssueOr404(req.params.id);
    if (!issue) {
      return res.status(404).json({ message: 'Issue not found.' });
    }

    const { decision, note } = req.body;
    const state = decision === 'approve' ? 'approved' : 'rejected';
    const wasPublished = Report.isPublished(issue);

    issue.moderation = {
      state,
      reviewedBy: req.user._id,
      reviewedAt: new Date(),
      reviewNote: note || '',
    };

    await issue.save();
    await issue.populate('reportedBy', 'name email');
    await issue.populate('moderation.reviewedBy', 'name');

    // Pulling a published report back off the board is a real change the
    // reporter should hear about, so the message says what happened.
    const message =
      state === 'approved'
        ? wasPublished
          ? 'Report is approved and live on the campus board.'
          : 'Report approved. It is now live on the campus board.'
        : 'Report rejected. It stays off the campus board and the student can see your note.';

    res.status(200).json({
      message,
      issue: serialize(issue, req.user),
    });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ message: Object.values(error.errors)[0].message });
    }
    console.error('ReviewIssue error:', error);
    res.status(500).json({ message: 'Server error. Please try again later.' });
  }
};

/**
 * GET /my/issues  (protected) — the logged-in user's issues.
 * Includes reports still awaiting admin review and reports that were
 * rejected, so the reporter can always see what happened to their report.
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
        .populate('moderation.reviewedBy', 'name')
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
      issues: issues.map((i) => serialize(i, req.user)),
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
 * Students count the published board; admins additionally get the size of
 * the review queue.
 */
const getStats = async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    // An unapproved report is not on the board, so it must not inflate the
    // campus numbers either. Admins see the whole picture.
    const scope = isAdmin ? {} : Report.PUBLISHED_FILTER;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [byStatus, byCategory, topUpvoted, avgResolution, resolvedThisMonth, upvoteTotals, pendingCount] =
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
          { $match: { $and: [scope, { status: { $in: ['resolved', 'Resolved'] }, resolvedAt: { $ne: null } }] } },
          {
            $group: {
              _id: null,
              avgMs: { $avg: { $subtract: ['$resolvedAt', '$createdAt'] } },
            },
          },
        ]),
        Report.countDocuments({ $and: [scope, { status: { $in: ['resolved', 'Resolved'] }, resolvedAt: { $gte: thirtyDaysAgo } }] }),
        // Total community support across the whole board, for the admin overview
        isAdmin
          ? Report.aggregate([{ $group: { _id: null, totalUpvotes: { $sum: '$upvoteCount' } } }])
          : Report.aggregate([
              { $match: scope },
              { $group: { _id: null, totalUpvotes: { $sum: '$upvoteCount' } } },
            ]),
        // Reports waiting for an admin decision — admin only
        isAdmin
          ? Report.countDocuments({ 'moderation.state': 'pending' })
          : Promise.resolve(0),
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
      totalUpvotes: upvoteTotals[0]?.totalUpvotes ?? 0,
      // 0 for students: the review queue is not campus information.
      pendingCount: isAdmin ? pendingCount : 0,
      topUpvoted: topUpvoted.map((i) => serialize(i, req.user)),
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
  reviewIssue,
  listMyIssues,
  getStats,
};