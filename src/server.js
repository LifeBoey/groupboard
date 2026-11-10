const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { createLimiter } = require('./rateLimit');

const PORT = Number(process.env.PORT) || 3000;
const MAX_USERS = 10;
const STATUSES = ['todo', 'doing', 'done'];
// Compared against when the username doesn't exist, so a wrong username takes as long as a
// wrong password and response timing doesn't reveal which usernames are registered.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
const MIN_PASSWORD_LENGTH = 8;

// Brute-force protection. Limits are checked *before* bcrypt runs, so blocked attempts also
// cost no hashing time.
const FIFTEEN_MIN = 15 * 60 * 1000;
// 5 failed logins for one username from one IP...
// (Keyed on IP + username on purpose: a username-only limit would let anyone lock a classmate
// out of their account just by typing wrong passwords for them.)
const loginFailuresPerAccount = createLimiter({ max: 5, windowMs: FIFTEEN_MIN });
// ...and 20 failed logins from one IP across all usernames (stops password spraying).
const loginFailuresPerIp = createLimiter({ max: 20, windowMs: FIFTEEN_MIN });
// 10 sign-up attempts per IP, successful or not.
const signupsPerIp = createLimiter({ max: 10, windowMs: FIFTEEN_MIN });

// Sends a 429 with a Retry-After header and a human-readable wait time.
function tooMany(res, seconds, what) {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  res.set('Retry-After', String(seconds));
  return res
    .status(429)
    .json({ error: `Too many ${what}. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` });
}

const app = express();
app.use(express.json());
app.use(
  session({
    // A random secret per start is fine locally: restarting the server just logs everyone out.
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 7 },
  })
);

// ---------- helpers ----------

function requireLogin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Please log in.' });
  next();
}

// THE RULE: everyone signed in can view every task,
// but only the task's creator or its current assignee can change it (edit, move, delete).
function canChange(task, userId) {
  return task.created_by === userId || task.assignee_id === userId;
}

const TASK_SELECT = `
  SELECT t.*, c.username AS created_by_name, a.username AS assignee_name
  FROM tasks t
  JOIN users c ON c.id = t.created_by
  LEFT JOIN users a ON a.id = t.assignee_id`;

function getTask(id) {
  return db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id);
}

function withPermission(task, userId) {
  return { ...task, can_change: canChange(task, userId) };
}

// True for a real calendar date in YYYY-MM-DD form. Date.parse alone accepts "2026-02-31"
// (it rolls over to March 3), so check the date survives a round trip unchanged.
function isRealDate(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const parsed = new Date(d + 'T00:00:00Z');
  return !isNaN(parsed) && parsed.toISOString().slice(0, 10) === d;
}

// Validates task fields from a request body. `partial` = only check fields that are present.
function validateTask(body, partial) {
  const out = {};
  if (!partial || 'title' in body) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return { error: 'Title is required.' };
    if (title.length > 120) return { error: 'Title must be 120 characters or fewer.' };
    out.title = title;
  }
  if ('description' in body) {
    const d = typeof body.description === 'string' ? body.description.trim() : '';
    if (d.length > 2000) return { error: 'Description must be 2000 characters or fewer.' };
    out.description = d;
  }
  if ('status' in body) {
    if (!STATUSES.includes(body.status)) return { error: 'Invalid status.' };
    out.status = body.status;
  }
  if ('assignee_id' in body) {
    const a = body.assignee_id;
    if (a === null || a === '' || a === undefined) out.assignee_id = null;
    else {
      const id = Number(a);
      if (!Number.isInteger(id) || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) {
        return { error: 'Assignee must be a group member.' };
      }
      out.assignee_id = id;
    }
  }
  if ('due_date' in body) {
    const d = body.due_date;
    if (d === null || d === '' || d === undefined) out.due_date = null;
    else if (!isRealDate(d)) {
      return { error: 'Due date must be YYYY-MM-DD.' };
    } else out.due_date = d;
  }
  return { data: out };
}

// ---------- auth ----------

app.post('/api/signup', (req, res) => {
  const wait = signupsPerIp.retryAfter(req.ip);
  if (wait) return tooMany(res, wait, 'sign-up attempts');
  signupsPerIp.hit(req.ip);

  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) {
    return res.status(400).json({ error: 'Username: 3–30 letters, numbers, _ . or -' });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }

  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n >= MAX_USERS) {
    return res.status(403).json({ error: `This board is full (max ${MAX_USERS} members).` });
  }
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'That username is taken.' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
    .run(username, hash);
  req.session.regenerate(() => {
    req.session.userId = Number(lastInsertRowid);
    res.status(201).json({ id: Number(lastInsertRowid), username });
  });
});

app.post('/api/login', (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  // Once blocked, even the correct password is refused until the window expires.
  const accountKey = `${req.ip}|${username.toLowerCase()}`;
  const wait = Math.max(loginFailuresPerAccount.retryAfter(accountKey), loginFailuresPerIp.retryAfter(req.ip));
  if (wait) return tooMany(res, wait, 'failed login attempts');

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const passwordOk = bcrypt.compareSync(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !passwordOk) {
    loginFailuresPerAccount.hit(accountKey);
    loginFailuresPerIp.hit(req.ip);
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  loginFailuresPerAccount.reset(accountKey);
  req.session.regenerate(() => {
    req.session.userId = user.id;
    res.json({ id: user.id, username: user.username });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', requireLogin, (req, res) => {
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Please log in.' });
  res.json(user);
});

app.get('/api/users', requireLogin, (req, res) => {
  res.json(db.prepare('SELECT id, username FROM users ORDER BY username').all());
});

// ---------- tasks (CRUD) ----------

// Read: everyone signed in sees all tasks.
app.get('/api/tasks', requireLogin, (req, res) => {
  const tasks = db
    .prepare(`${TASK_SELECT} ORDER BY t.due_date IS NULL, t.due_date, t.created_at`)
    .all();
  res.json(tasks.map((t) => withPermission(t, req.session.userId)));
});

// Create: any member can add a task.
app.post('/api/tasks', requireLogin, (req, res) => {
  const { data, error } = validateTask(req.body, false);
  if (error) return res.status(400).json({ error });
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO tasks (title, description, status, assignee_id, due_date, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.title,
      data.description ?? '',
      data.status ?? 'todo',
      data.assignee_id ?? null,
      data.due_date ?? null,
      req.session.userId
    );
  res.status(201).json(withPermission(getTask(lastInsertRowid), req.session.userId));
});

// Update (includes moving between columns): creator or assignee only.
app.patch('/api/tasks/:id', requireLogin, (req, res) => {
  const task = getTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (!canChange(task, req.session.userId)) {
    return res.status(403).json({ error: 'Only the task creator or assignee can change this task.' });
  }
  const { data, error } = validateTask(req.body, true);
  if (error) return res.status(400).json({ error });
  const fields = Object.keys(data);
  if (fields.length) {
    const sets = fields.map((f) => `${f} = ?`).join(', ');
    db.prepare(`UPDATE tasks SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(
      ...fields.map((f) => data[f]),
      task.id
    );
  }
  res.json(withPermission(getTask(task.id), req.session.userId));
});

// Delete: creator or assignee only.
app.delete('/api/tasks/:id', requireLogin, (req, res) => {
  const task = getTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (!canChange(task, req.session.userId)) {
    return res.status(403).json({ error: 'Only the task creator or assignee can delete this task.' });
  }
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
  res.json({ ok: true });
});

// ---------- pages ----------

app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`GroupBoard running at http://localhost:${PORT}`);
});
