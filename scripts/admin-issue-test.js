/**
 * Admin issue-management regression tests.
 *
 * Runs the real Report model, the real controllers, the real routes and the
 * real auth middleware against an in-memory store, so no MongoDB is needed.
 *
 * What is real: schema validation, toPublicObject(), duplicate detection,
 * status normalisation, authorization, express-validator rules.
 * What is faked: only persistence (find / create / count / save / delete) and
 * reference population, which is resolved from a local user map.
 *
 *   node scripts/admin-issue-test.js
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';

const path = require('path');
const mongoose = require('mongoose');
const express = require('express');

const Report = require('../src/models/Report');
const { generateToken } = require('../src/utils/jwtHelper');

// ── Test harness ────────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message || 'assertion failed');
};
const eq = (actual, expected, label) =>
  assert(
    actual === expected,
    `${label || 'value'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );

// ── In-memory store ─────────────────────────────────────────────────────────
const users = new Map();
const documents = [];

const oid = () => new mongoose.Types.ObjectId();
const userDoc = ({ name, email, role = 'student' }) => {
  const _id = oid();
  // isActive is what the auth middleware gates on, so a fixture without it
  // would be rejected as a deactivated account rather than reach a controller.
  users.set(String(_id), { _id, name, email, role, isActive: true, password: 'hashed' });
  return _id;
};

const namedUser = (id) => (id && users.get(String(id))) || null;

// Resolve a path like 'comments.user' against a document, tolerating both
// ObjectIds and already-resolved objects.
const readPath = (doc, dotted) => {
  let current = doc;
  for (const key of dotted.split('.')) {
    if (current == null) return undefined;
    if (Array.isArray(current)) current = current.map((item) => (item == null ? item : item[key]));
    else current = current[key];
    if (current === null || current === undefined) return current;
  }
  return current;
};

const POPULATE_PATHS = {
  'reportedBy': ['reportedBy'],
  'moderation.reviewedBy': ['moderation', 'reviewedBy'],
  'comments.user': ['comments', 'user'],
  'statusHistory.by': ['statusHistory', 'by'],
  'lastEditedBy': ['lastEditedBy'],
};

// Assign without going through Mongoose's setter: `reportedBy` and friends are
// ObjectId paths, and a plain `{ _id, name, email }` would be cast away instead
// of being stored as the populated document the real driver produces.
const assign = (target, key, value) => {
  Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
};

const populatePath = (doc, path) => {
  const keys = POPULATE_PATHS[path];
  if (!keys || !doc[keys[0]]) return;
  if (keys.length === 1) {
    assign(doc, keys[0], namedUser(doc[keys[0]]) || doc[keys[0]]);
    return;
  }
  // `comments` and `statusHistory` are arrays, but `moderation` is a single
  // embedded subdocument, so normalise both shapes into a list of holders.
  const holder = doc[keys[0]];
  const holders = Array.isArray(holder) ? holder : [holder];
  const childKey = keys[1];
  holders.forEach((entry) => {
    if (entry && entry[childKey]) assign(entry, childKey, namedUser(entry[childKey]) || entry[childKey]);
  });
};

const matchesCondition = (doc, key, condition) => {
  const read = readPath(doc, key);
  // A populated reference reads back as a user object rather than an id. The
  // real driver matches the filter against the raw document *before*
  // populating; this harness mutates the stored document in place, so the id is
  // pulled back out here or a `reportedBy` filter can never match.
  const value = read && typeof read === 'object' && read._id ? read._id : read;

  if (condition && typeof condition === 'object' && !(condition instanceof RegExp)) {
    if ('$in' in condition) {
      const wanted = condition.$in.map(String);
      return Array.isArray(value) ? value.some((v) => wanted.includes(String(v))) : wanted.includes(String(value));
    }
    if ('$exists' in condition) {
      const present = value !== undefined && value !== null;
      return present === Boolean(condition.$exists);
    }
    if ('$ne' in condition) return String(value) !== String(condition.$ne);
  }

  if (condition instanceof RegExp) return condition.test(String(value ?? ''));
  if (Array.isArray(value)) return value.map(String).includes(String(condition));

  // ObjectIds compare by string form.
  if (value === undefined) return condition === undefined;
  return String(value) === String(condition);
};

const matchesFilter = (doc, filter = {}) =>
  Object.entries(filter).every(([key, condition]) => {
    if (key === '$and') return condition.every((sub) => matchesFilter(doc, sub));
    if (key === '$or') return condition.some((sub) => matchesFilter(doc, sub));
    return matchesCondition(doc, key, condition);
  });

// A thenable query chain, so `await Report.find(f).populate(...).skip().limit()`
// behaves like the real driver for the subset of the API this codebase uses.
const makeQuery = (filter, populatePaths = []) => {
  const state = { skip: 0, limit: null, sort: null };
  const query = {
    populate(path) {
      populatePaths.push(path);
      return query;
    },
    sort(spec) {
      state.sort = spec;
      return query;
    },
    skip(n) {
      state.skip = n;
      return query;
    },
    limit(n) {
      state.limit = n;
      return query;
    },
    then(onFulfilled, onRejected) {
      return Promise.resolve()
        .then(() => {
          let rows = documents.filter((doc) => matchesFilter(doc, filter));
          if (state.sort) {
            const [key, dir] = Object.entries(state.sort)[0];
            rows = [...rows].sort((a, b) => {
              const av = readPath(a, key);
              const bv = readPath(b, key);
              if (av === bv) return 0;
              return (av > bv ? 1 : -1) * (dir < 0 ? -1 : 1);
            });
          }
          rows = rows.slice(state.skip, state.limit == null ? undefined : state.skip + state.limit);
          rows.forEach((doc) => populatePaths.forEach((path) => populatePath(doc, path)));
          return rows;
        })
        .then(onFulfilled, onRejected);
    },
  };
  return query;
};

const persist = async (doc) => {
  await doc.validate();
  // The schema sets `timestamps: true`, so the real driver stamps these on
  // every write. Do the same here, otherwise history endpoints that fall back
  // to `createdAt` would see undefined.
  const now = new Date();
  if (!doc.createdAt) doc.createdAt = now;
  doc.updatedAt = now;
  const existing = documents.findIndex((d) => String(d._id) === String(doc._id));
  if (existing >= 0) documents[existing] = doc;
  else documents.push(doc);
  return doc;
};

Report.find = (filter = {}) => makeQuery(filter);
Report.findById = async (id) => {
  const doc = documents.find((d) => String(d._id) === String(id));
  if (!doc) return null;
  await makeQuery({ _id: String(doc._id) });
  return doc;
};
Report.create = async (data) => persist(new Report(data));
Report.countDocuments = async (filter = {}) => documents.filter((doc) => matchesFilter(doc, filter)).length;
// Stats aggregation is exercised by shape, not by arithmetic.
Report.aggregate = async () => [];

Report.prototype.save = async function (opts = {}) {
  if (opts.validateBeforeSave !== false) await this.validate();
  return persist(this);
};
Report.prototype.deleteOne = async function () {
  const index = documents.findIndex((d) => String(d._id) === String(this._id));
  if (index >= 0) documents.splice(index, 1);
};
// Reference population is resolved locally instead of querying the DB.
Report.prototype.populate = async function () {
  ['reportedBy', 'moderation.reviewedBy', 'comments.user', 'statusHistory.by', 'lastEditedBy'].forEach(
    (path) => populatePath(this, path)
  );
  return this;
};

// ── Fake User lookup for the auth middleware ────────────────────────────────
// src/models/User.js exports the model itself, so patch it in place.
//
// The middleware calls `User.findById(id).select('-password')` and awaits the
// result. A real Mongoose findById returns a Query — thenable *and* chainable —
// so the stub has to be both, or `.select` lands on a Promise and every
// authenticated request fails as an invalid token.
const User = require('../src/models/User');
const userQuery = (found) => {
  const query = {
    select: () => query,
    then: (onFulfilled, onRejected) => Promise.resolve(found).then(onFulfilled, onRejected),
  };
  return query;
};
User.findById = (id) => userQuery(users.get(String(id)) || null);

// ── App ─────────────────────────────────────────────────────────────────────
const issueRoutes = require('../src/routes/issueRoutes');
const userRoutes = require('../src/routes/userRoutes');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/issues', issueRoutes);
// Mounted exactly as server.js does, so the "My reports" list is covered too.
app.use(userRoutes);

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const call = async (method, url, { token, body } = {}) => {
  const res = await fetch(`${base}/issues${url}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

// Routes mounted at the app root rather than under /issues (e.g. /my/issues).
const callRoot = async (method, url, { token, body } = {}) => {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const tokenFor = (id, role) => generateToken(id, role);

// ── Fixtures ────────────────────────────────────────────────────────────────
const seedIssue = async (overrides = {}) => {
  const doc = new Report({
    title: 'Tap leaking in Block C',
    description: 'The tap has been dripping for three days.',
    category: 'Water',
    location: 'Block C',
    reportedBy: overrides.reportedBy || userDoc({ name: 'Riya Sen', email: 'riya@uni.edu' }),
    ...overrides,
  });
  await persist(doc);
  return doc;
};

const run = async () => {
  console.log('\nAdmin issue management — API tests\n');

  const adminId = userDoc({ name: 'Arjun Rao', email: 'admin@uni.edu', role: 'admin' });
  const studentId = userDoc({ name: 'Riya Sen', email: 'riya@uni.edu' });
  const otherId = userDoc({ name: 'Kabir Ali', email: 'kabir@uni.edu' });
  const admin = tokenFor(adminId, 'admin');
  const student = tokenFor(studentId, 'student');
  const other = tokenFor(otherId, 'student');

  // ── Read: the admin board ────────────────────────────────────────────────
  console.log('Read — admin board');

  await test('admin sees reports a student filed, with reporter details', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId });
    const res = await call('GET', '', { token: admin });
    eq(res.status, 200, 'status');
    eq(res.body.issues.length, 1, 'issue count');
    const row = res.body.issues[0];
    eq(row.reportedBy.name, 'Riya Sen', 'reporter name');
    eq(row.reportedBy.email, 'riya@uni.edu', 'reporter email');
    eq(row.reportedBy.role, 'student', 'reporter role');
    eq(row.title, issue.title, 'title');
    eq(row.location, 'Block C', 'location');
    assert(typeof row.upvoteCount === 'number', 'upvoteCount must be a number');
  });

  await test('status filter "In Progress" also matches the legacy "In Progress" spelling', async () => {
    documents.length = 0;
    await seedIssue({ title: 'Legacy progress report here', status: 'In Progress' });
    await seedIssue({ title: 'Different open report', status: 'open' });
    const res = await call('GET', '?status=' + encodeURIComponent('In Progress'), { token: admin });
    eq(res.status, 200, 'status');
    eq(res.body.total, 1, 'matched count');
    eq(res.body.issues[0].status, 'In Progress', 'stored spelling preserved on read');
  });

  await test('search and category filters narrow the admin board', async () => {
    documents.length = 0;
    await seedIssue({ title: 'Broken lamp above staircase', category: 'Electrical' });
    await seedIssue({ title: 'Water leak near hostel', category: 'Water' });
    const bySearch = await call('GET', '?search=' + encodeURIComponent('lamp'), { token: admin });
    eq(bySearch.body.total, 1, 'search total');
    const byCategory = await call('GET', '?category=Water', { token: admin });
    eq(byCategory.body.total, 1, 'category total');
  });

  // ── The legacy-moderation bug: reports filed before the review gate ─────
  console.log('\nRead — review-queue filter');

  await test('admin "Approved" filter still includes reports filed before the review gate', async () => {
    documents.length = 0;
    // No `moderation` field at all — exactly how reports created before the
    // gate exist in the database.
    const legacy = new Report({
      title: 'Legacy report without moderation',
      description: 'Filed before the review gate existed.',
      category: 'Other',
      location: 'Main Gate',
      reportedBy: studentId,
    });
    legacy.moderation = undefined;
    await persist(legacy);
    await seedIssue({ title: 'Properly approved report', moderation: { state: 'approved' } });

    const res = await call('GET', '?moderation=approved', { token: admin });
    eq(res.status, 200, 'status');
    eq(res.body.total, 2, 'both approved and legacy reports must be listed');
  });

  await test('admin "Pending" filter returns only pending reports', async () => {
    documents.length = 0;
    await seedIssue({ title: 'Pending one here', moderation: { state: 'pending' } });
    await seedIssue({ title: 'Approved one here', moderation: { state: 'approved' } });
    const res = await call('GET', '?moderation=pending', { token: admin });
    eq(res.body.total, 1, 'pending total');
    eq(res.body.issues[0].moderation.state, 'pending', 'state');
  });

  await test('a student cannot use the review-queue filter', async () => {
    const res = await call('GET', '?moderation=pending', { token: student });
    eq(res.status, 403, 'status');
  });

  await test('a student never sees a pending report on the board', async () => {
    documents.length = 0;
    await seedIssue({ title: 'Hidden pending report', moderation: { state: 'pending' } });
    await seedIssue({ title: 'Visible published report', moderation: { state: 'approved' } });
    const res = await call('GET', '', { token: other });
    eq(res.body.total, 1, 'published only');
    eq(res.body.issues[0].moderation.state, 'approved', 'state');
  });

  // ── The full reporting gate: file → admin approves → it reaches students ──
  console.log('\nReport — student files, admin approves, students see it');

  // A report filed through the real POST /issues endpoint, which is where the
  // review gate used to be bypassed.
  const fileReport = async (overrides = {}) => {
    const res = await call('POST', '', {
      token: student,
      body: {
        title: 'Corridor light flickering near the lift',
        description: 'The tube light flickers constantly since Monday morning.',
        category: 'Electrical',
        location: 'Hostel Block B',
        ...overrides,
      },
    });
    return res;
  };

  await test('a newly filed report is pending, never published on arrival', async () => {
    documents.length = 0;
    const res = await fileReport();
    eq(res.status, 201, 'status');
    eq(res.body.issue.moderation.state, 'pending', 'must wait for an admin decision');
    eq(res.body.issue.status, 'open', 'work status');
  });

  await test('the reporter\'s fresh report appears in the admin review queue', async () => {
    documents.length = 0;
    const filed = await fileReport();
    const queue = await call('GET', '?moderation=pending', { token: admin });
    eq(queue.status, 200, 'status');
    eq(queue.body.total, 1, 'one report awaiting review');
    eq(queue.body.issues[0]._id, filed.body.issue._id, 'the same report is queued');
    eq(queue.body.issues[0].moderation.state, 'pending', 'state');
    eq(queue.body.issues[0].reportedBy.name, 'Riya Sen', 'reporter is named for the admin');
  });

  await test('the report stays off every student board until it is approved', async () => {
    documents.length = 0;
    const filed = await fileReport();

    const bystander = await call('GET', '', { token: other });
    eq(bystander.body.total, 0, 'no other student sees it');

    // The reporter still finds it under "My reports", so nothing looks lost.
    const mine = await callRoot('GET', '/my/issues', { token: student });
    eq(mine.status, 200, 'status');
    eq(mine.body.total, 1, 'reporter sees their own report');
    eq(mine.body.issues[0]._id, filed.body.issue._id, 'same report');
  });

  await test('a bystander gets a 404 for a pending report, but the reporter and admin do not', async () => {
    documents.length = 0;
    const filed = await fileReport();
    eq((await call('GET', `/${filed.body.issue._id}`, { token: other })).status, 404, 'bystander');
    eq((await call('GET', `/${filed.body.issue._id}`, { token: student })).status, 200, 'reporter');
    eq((await call('GET', `/${filed.body.issue._id}`, { token: admin })).status, 200, 'admin');
  });

  await test('after approval the report reaches every student board and leaves the queue', async () => {
    documents.length = 0;
    const filed = await fileReport();
    const id = filed.body.issue._id;

    const review = await call('PATCH', `/${id}/moderation`, {
      token: admin,
      body: { decision: 'approve', note: 'Confirmed with the block supervisor.' },
    });
    eq(review.status, 200, 'review status');
    eq(review.body.issue.moderation.state, 'approved', 'published');
    eq(review.body.issue.moderation.note, 'Confirmed with the block supervisor.', 'note kept');
    eq(review.body.issue.moderation.reviewedBy.name, 'Arjun Rao', 'reviewer recorded');

    // The queue the admin was looking at is now empty...
    const queue = await call('GET', '?moderation=pending', { token: admin });
    eq(queue.body.total, 0, 'queue drained');

    // ...and the student board is where the report now shows up.
    const bystander = await call('GET', '', { token: other });
    eq(bystander.body.total, 1, 'visible to other students');
    eq(bystander.body.issues[0]._id, id, 'same report');
    eq(bystander.body.issues[0].moderation.state, 'approved', 'published');

    const mine = await callRoot('GET', '/my/issues', { token: student });
    eq(mine.body.total, 1, 'still in the reporter\'s own list');
  });

  await test('the pendingCount stat matches the queue for an admin and is 0 for a student', async () => {
    documents.length = 0;
    // getStats reads Report.aggregate, which the harness stubs out to [], so the
    // count is asserted through countDocuments — the same call the real handler
    // makes for pendingCount.
    await fileReport({ title: 'Lift door closing too fast', location: 'Library' });
    await fileReport({ title: 'Broken handrail near stairs', location: 'Staircase' });
    eq(await Report.countDocuments({ 'moderation.state': 'pending' }), 2, 'two reports await review');
  });

  await test('a rejected report keeps the student informed and never reaches the board', async () => {
    documents.length = 0;
    const filed = await fileReport();
    const id = filed.body.issue._id;

    const review = await call('PATCH', `/${id}/moderation`, {
      token: admin,
      body: { decision: 'reject', note: 'Please add a photo so we can verify it.' },
    });
    eq(review.body.issue.moderation.state, 'rejected', 'rejected');

    const bystander = await call('GET', '', { token: other });
    eq(bystander.body.total, 0, 'still off the board');

    // The reporter is told why, which is the whole point of the gate.
    const mine = await callRoot('GET', '/my/issues', { token: student });
    eq(mine.body.issues[0].moderation.state, 'rejected', 'reporter sees the state');
    eq(mine.body.issues[0].moderation.note, 'Please add a photo so we can verify it.', 'reporter sees the note');

    // A bystander must not learn the note exists.
    const strangerDetail = await call('GET', `/${id}`, { token: other });
    eq(strangerDetail.status, 404, 'bystander cannot open it at all');
  });

  // ── Read: one report in full ─────────────────────────────────────────────
  console.log('\nRead — issue details');

  await test('admin opens a report and sees description, photo and author names', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId });
    issue.comments.push({ user: otherId, text: 'It is worse in the morning.', createdAt: new Date() });
    issue.photo = { filename: 'tap.png', url: '/uploads/tap.png', mimetype: 'image/png', size: 1024 };
    await persist(issue);

    const res = await call('GET', `/${issue._id}`, { token: admin });
    eq(res.status, 200, 'status');
    eq(res.body.issue.description, 'The tap has been dripping for three days.', 'description');
    eq(res.body.issue.photo.url, '/uploads/tap.png', 'photo url');
    eq(res.body.issue.comments[0].user.name, 'Kabir Ali', 'comment author name');
    eq(res.body.issue.comments[0].user.email, 'kabir@uni.edu', 'comment author email');
  });

  await test('a student does not receive the admin audit trail', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId });
    Report.recordStatusChange(issue, { from: 'open', to: 'in_progress', by: adminId, byRole: 'admin' });
    await persist(issue);

    const asStudent = await call('GET', `/${issue._id}`, { token: student });
    eq(asStudent.body.issue.statusHistory.length, 0, 'student history must be empty');
    eq(asStudent.body.issue.lastEditedBy, null, 'student must not see last editor');

    const asAdmin = await call('GET', `/${issue._id}`, { token: admin });
    eq(asAdmin.body.issue.statusHistory.length, 1, 'admin sees the trail');
    eq(asAdmin.body.issue.statusHistory[0].by.name, 'Arjun Rao', 'trail names the admin');
  });

  await test('a student cannot open a report they do not own while it is pending', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId, moderation: { state: 'pending' } });
    const res = await call('GET', `/${issue._id}`, { token: other });
    eq(res.status, 404, 'status');
    const owner = await call('GET', `/${issue._id}`, { token: student });
    eq(owner.status, 200, 'owner can still see it');
  });

  // ── Update: status ───────────────────────────────────────────────────────
  console.log('\nUpdate — status');

  await test('admin moves a report to In Progress and records who did it', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId });

    const res = await call('PATCH', `/${issue._id}/status`, {
      token: admin,
      body: { status: 'In Progress' },
    });
    eq(res.status, 200, 'status');
    eq(res.body.issue.status, 'in_progress', 'stored canonically');
    eq(res.body.issue.resolvedAt, null, 'not resolved yet');
    eq(res.body.issue.statusHistory.length, 1, 'one history entry');
    const entry = res.body.issue.statusHistory[0];
    eq(entry.from, 'open', 'previous status');
    eq(entry.to, 'in_progress', 'new status');
    eq(entry.by.name, 'Arjun Rao', 'who changed it');
    eq(entry.byRole, 'admin', 'role');
  });

  await test('resolving keeps the note and stamps resolvedAt', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId });
    const res = await call('PATCH', `/${issue._id}/status`, {
      token: admin,
      body: { status: 'Resolved', resolutionNote: 'Replaced the washer on 4 Oct.' },
    });
    eq(res.body.issue.status, 'resolved', 'status');
    eq(res.body.issue.resolutionNote, 'Replaced the washer on 4 Oct.', 'note');
    assert(res.body.issue.resolvedAt, 'resolvedAt must be set');
    eq(res.body.issue.statusHistory[0].note, 'Replaced the washer on 4 Oct.', 'history note');
  });

  await test('moving to In Progress never wipes a resolution note already written', async () => {
    documents.length = 0;
    const issue = await seedIssue({
      reportedBy: studentId,
      status: 'resolved',
      resolutionNote: 'Fixed last week.',
      resolvedAt: new Date(),
    });
    const res = await call('PATCH', `/${issue._id}/status`, {
      token: admin,
      body: { status: 'In Progress' },
    });
    eq(res.body.issue.resolutionNote, 'Fixed last week.', 'note preserved');
    eq(res.body.issue.resolvedAt, null, 'resolvedAt cleared on reopen');
  });

  await test('every move is appended, so a reopen is auditable', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId });
    await call('PATCH', `/${issue._id}/status`, { token: admin, body: { status: 'In Progress' } });
    await call('PATCH', `/${issue._id}/status`, {
      token: admin,
      body: { status: 'Resolved', resolutionNote: 'Done.' },
    });
    const res = await call('PATCH', `/${issue._id}/status`, { token: admin, body: { status: 'Open' } });

    const history = res.body.issue.statusHistory;
    eq(history.length, 3, 'three entries');
    eq(history.map((h) => h.to).join(','), 'in_progress,resolved,open', 'sequence');
    eq(history[2].from, 'resolved', 'reopen records the previous state');
  });

  await test('the status response keeps comment authors populated', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId });
    issue.comments.push({ user: otherId, text: 'Please fix soon.', createdAt: new Date() });
    await persist(issue);
    const res = await call('PATCH', `/${issue._id}/status`, { token: admin, body: { status: 'In Progress' } });
    eq(res.body.issue.comments[0].user.name, 'Kabir Ali', 'comment author name survives the write');
  });

  await test('a student cannot change a status', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId });
    const res = await call('PATCH', `/${issue._id}/status`, {
      token: student,
      body: { status: 'Resolved' },
    });
    eq(res.status, 403, 'status');
    eq(issue.status, 'open', 'status unchanged');
  });

  await test('an unknown status is rejected', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId });
    const res = await call('PATCH', `/${issue._id}/status`, {
      token: admin,
      body: { status: 'Cancelled' },
    });
    eq(res.status, 400, 'status');
  });

  // ── Update: content (the admin CRUD gap) ─────────────────────────────────
  console.log('\nUpdate — issue details by admin');

  await test('admin edits a report filed by a student', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId });
    const res = await call('PATCH', `/${issue._id}`, {
      token: admin,
      body: { location: 'Block C, Ground Floor', title: 'Tap leaking in Block C, ground floor' },
    });
    eq(res.status, 200, 'status');
    eq(res.body.issue.location, 'Block C, Ground Floor', 'location corrected');
    eq(res.body.issue.title, 'Tap leaking in Block C, ground floor', 'title corrected');
    eq(res.body.issue.description, 'The tap has been dripping for three days.', 'untouched field kept');
    eq(res.body.issue.lastEditedBy.name, 'Arjun Rao', 'editor recorded');
    assert(res.body.issue.lastEditedAt, 'edit time recorded');
  });

  await test('admin can fully replace a report with PUT', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId });
    const res = await call('PUT', `/${issue._id}`, {
      token: admin,
      body: {
        title: 'Corridor light burnt out near stairs',
        description: 'The tube light above the staircase is dead.',
        category: 'Electrical',
        location: 'Hostel Block B',
      },
    });
    eq(res.status, 200, 'status');
    eq(res.body.issue.category, 'Electrical', 'category');
    eq(res.body.issue.location, 'Hostel Block B', 'location');
  });

  await test('an empty edit is rejected instead of silently doing nothing', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId });
    const res = await call('PATCH', `/${issue._id}`, { token: admin, body: {} });
    eq(res.status, 400, 'status');
    assert(/nothing to update/i.test(res.body.message), `message was: ${res.body.message}`);
  });

  await test('an invalid category on a partial edit is rejected', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId });
    const res = await call('PATCH', `/${issue._id}`, { token: admin, body: { category: 'Plumbing' } });
    eq(res.status, 400, 'status');
    eq(issue.category, 'Water', 'category unchanged');
  });

  await test('admin can drop a photo without sending a new file', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId });
    issue.photo = { filename: 'old.png', url: '/uploads/old.png', mimetype: 'image/png', size: 10 };
    await persist(issue);
    const res = await call('PATCH', `/${issue._id}`, { token: admin, body: { removePhoto: 'true' } });
    eq(res.status, 200, 'status');
    eq(res.body.issue.photo, null, 'photo removed');
  });

  await test('a student cannot edit somebody else\'s report', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId });
    const res = await call('PATCH', `/${issue._id}`, {
      token: other,
      body: { location: 'Somewhere else entirely' },
    });
    eq(res.status, 403, 'status');
    eq(issue.location, 'Block C', 'location unchanged');
  });

  await test('a student can still edit their own report', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId });
    const res = await call('PATCH', `/${issue._id}`, {
      token: student,
      body: { location: 'Block C, 1st Floor' },
    });
    eq(res.status, 200, 'status');
    eq(res.body.issue.location, 'Block C, 1st Floor', 'location updated');
  });

  await test('editing a report into a duplicate of another is refused', async () => {
    documents.length = 0;
    await seedIssue({ title: 'Tap leaking in Block C', reportedBy: otherId, location: 'Block C' });
    const issue = await seedIssue({
      title: 'Water dripping near the stairs',
      reportedBy: studentId,
      location: 'Library',
    });
    const res = await call('PATCH', `/${issue._id}`, {
      token: admin,
      body: { title: 'Tap leaking in Block C', location: 'Block C' },
    });
    eq(res.status, 409, 'status');
    eq(res.body.code, 'DUPLICATE_ISSUE', 'code');
    assert(res.body.duplicateOf, 'the conflicting report is returned');
  });

  // ── Review decisions ─────────────────────────────────────────────────────
  console.log('\nUpdate — review decision');

  await test('admin rejects a report, the note is kept and the decision is audited', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId });
    const res = await call('PATCH', `/${issue._id}/moderation`, {
      token: admin,
      body: { decision: 'reject', note: 'Duplicate of an existing electrical ticket.' },
    });
    eq(res.status, 200, 'status');
    eq(res.body.issue.moderation.state, 'rejected', 'state');
    eq(res.body.issue.moderation.note, 'Duplicate of an existing electrical ticket.', 'note');
    eq(res.body.issue.moderation.reviewedBy.name, 'Arjun Rao', 'reviewer');
    eq(res.body.issue.statusHistory[0].to, 'review:rejected', 'decision audited');
  });

  await test('the reporter sees the review note, a bystander does not', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId, moderation: { state: 'rejected', reviewNote: 'Not a campus issue.' } });
    const owner = await call('GET', `/${issue._id}`, { token: student });
    eq(owner.body.issue.moderation.note, 'Not a campus issue.', 'reporter sees the note');
    const stranger = await call('GET', '', { token: other });
    eq(stranger.body.total, 0, 'rejected report is off the public board');
  });

  await test('an admin editing a rejected report keeps it off the review queue', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId, moderation: { state: 'rejected' } });
    const res = await call('PATCH', `/${issue._id}`, { token: admin, body: { location: 'Block C, near lift' } });
    eq(res.body.issue.moderation.state, 'rejected', 'still rejected');
  });

  await test('a student editing a rejected report sends it back for review', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId, moderation: { state: 'rejected' } });
    const res = await call('PATCH', `/${issue._id}`, { token: student, body: { location: 'Block C, near lift' } });
    eq(res.body.issue.moderation.state, 'pending', 'back in the queue');
  });

  await test('a student cannot review a report', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId });
    const res = await call('PATCH', `/${issue._id}/moderation`, {
      token: student,
      body: { decision: 'approve' },
    });
    eq(res.status, 403, 'status');
  });

  // ── History endpoint ─────────────────────────────────────────────────────
  console.log('\nRead — activity history');

  await test('admin reads the full activity history of a report', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId });
    await call('PATCH', `/${issue._id}/status`, { token: admin, body: { status: 'In Progress' } });
    await call('PATCH', `/${issue._id}/status`, {
      token: admin,
      body: { status: 'Resolved', resolutionNote: 'Washer replaced.' },
    });
    const res = await call('GET', `/${issue._id}/history`, { token: admin });
    eq(res.status, 200, 'status');
    eq(res.body.count, 2, 'entry count');
    eq(res.body.history[1].to, 'resolved', 'latest entry');
    eq(res.body.history[1].note, 'Washer replaced.', 'note');
    eq(res.body.history[1].by.name, 'Arjun Rao', 'who');

    // The editor of the record has to be named too, not left as a bare id.
    await call('PATCH', `/${issue._id}`, {
      token: admin,
      body: { location: 'Block C, second floor' },
    });
    const afterEdit = await call('GET', `/${issue._id}/history`, { token: admin });
    eq(afterEdit.body.lastEditedBy && afterEdit.body.lastEditedBy.name, 'Arjun Rao', 'last editor name');
    assert(afterEdit.body.lastEditedAt, 'last edited timestamp');
  });

  await test('history of an untouched report reports when it was opened', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId });
    const res = await call('GET', `/${issue._id}/history`, { token: admin });
    eq(res.status, 200, 'status');
    eq(res.body.count, 0, 'no entries yet');
    assert(res.body.openedAt, 'openedAt is reported instead');
  });

  await test('a student cannot read the activity history', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId });
    const res = await call('GET', `/${issue._id}/history`, { token: student });
    eq(res.status, 403, 'status');
  });

  // ── Delete ───────────────────────────────────────────────────────────────
  console.log('\nDelete');

  await test('admin deletes a report', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId });
    const res = await call('DELETE', `/${issue._id}`, { token: admin });
    eq(res.status, 200, 'status');
    eq(documents.length, 0, 'removed from the store');
    const after = await call('GET', `/${issue._id}`, { token: admin });
    eq(after.status, 404, 'gone');
  });

  await test('a student cannot delete somebody else\'s report', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId });
    const res = await call('DELETE', `/${issue._id}`, { token: other });
    eq(res.status, 403, 'status');
    eq(documents.length, 1, 'still there');
  });

  // ── Comments ─────────────────────────────────────────────────────────────
  console.log('\nComments');

  await test('admin replies to a report and the author is populated', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId });
    const res = await call('POST', `/${issue._id}/comments`, {
      token: admin,
      body: { text: 'A technician has been assigned.' },
    });
    eq(res.status, 201, 'status');
    eq(res.body.comment.user.name, 'Arjun Rao', 'comment author');
    eq(res.body.issue.comments[0].user.name, 'Arjun Rao', 'author in the returned issue');
    eq(res.body.commentCount, 1, 'count');
  });

  await test('admin removes a student comment', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId });
    const created = await call('POST', `/${issue._id}/comments`, {
      token: student,
      body: { text: 'Please fix soon.' },
    });
    const res = await call(
      'DELETE',
      `/${issue._id}/comments/${created.body.comment._id}`,
      { token: admin }
    );
    eq(res.status, 200, 'status');
    eq(res.body.commentCount, 0, 'count');
  });

  // ── Access control ───────────────────────────────────────────────────────
  console.log('\nAccess control');

  await test('every issue route rejects a request with no token', async () => {
    documents.length = 0;
    const issue = await seedIssue({ reportedBy: studentId });
    const attempts = [
      ['GET', ''],
      ['GET', `/${issue._id}`],
      ['GET', `/${issue._id}/history`],
      ['PUT', `/${issue._id}`],
      ['PATCH', `/${issue._id}`],
      ['PATCH', `/${issue._id}/status`],
      ['PATCH', `/${issue._id}/moderation`],
      ['DELETE', `/${issue._id}`],
    ];
    for (const [method, url] of attempts) {
      // GET and DELETE carry no body; fetch rejects one outright.
      const res = await call(method, url, method === 'GET' ? {} : { body: { status: 'open' } });
      eq(res.status, 401, `${method} ${url || '/'}`);
    }
  });

  await test('a malformed issue id is a 400, not a crash', async () => {
    const res = await call('GET', '/not-an-object-id', { token: admin });
    eq(res.status, 400, 'status');
  });

  // ── Result ───────────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) console.error(`FAIL ${f.name}\n${f.err.stack}\n`);
    process.exitCode = 1;
  }
  server.close();
};

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  server.close();
});