const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const db = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const MAX_USERS = 10;
const STATUSES = ['todo', 'doing', 'done'];
// Compared against when the username doesn't exist, so a wrong username takes as long as a
// wrong password and response timing doesn't reveal which usernames are registered.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const app = express();
app.use(express.json({ limit: '32kb' })); // plenty for a task (description max 2000 chars)
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

app.post('/api/signup', (req, res, next) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) {
    return res.status(400).json({ error: 'Username: 3–30 letters, numbers, _ . or -' });
  }
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

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
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = Number(lastInsertRowid);
    res.status(201).json({ id: Number(lastInsertRowid), username });
  });
});

app.post('/api/login', (req, res, next) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const passwordOk = bcrypt.compareSync(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !passwordOk) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = user.id;
    res.json({ id: user.id, username: user.username });
  });
});

app.post('/api/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.json({ ok: true });
  });
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

// Unknown API routes get a JSON 404, not Express's HTML "Cannot GET" page.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// ---------- pages ----------

app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- errors ----------

// Last-resort error handler. Without it, Express's default handler returns an HTML page with a
// full stack trace and logs the error. For malformed JSON, that error message quotes part of
// the request body, which could be a password.
const CLIENT_ERROR_MESSAGES = {
  'entity.parse.failed': 'Request body is not valid JSON.',
  'entity.too.large': 'Request is too large.',
};
// Express only treats a middleware as an error handler if it takes all four arguments.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const raw = err.status || err.statusCode;
  const status = Number.isInteger(raw) && raw >= 400 && raw < 600 ? raw : 500;

  let message;
  if (status >= 500) {
    // Server bugs: log the details for us, but only send the client a generic message.
    console.error(`${req.method} ${req.path} failed:`, err);
    message = 'Something went wrong on the server.';
  } else {
    // Client errors aren't logged: their messages can echo the request body.
    message = CLIENT_ERROR_MESSAGES[err.type] || 'Invalid request.';
  }

  if (req.path.startsWith('/api')) res.status(status).json({ error: message });
  else res.status(status).type('text/plain').send(message);
});

app.listen(PORT, () => {
  console.log(`GroupBoard running at http://localhost:${PORT}`);
});
