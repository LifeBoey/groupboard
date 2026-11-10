// Resets the database and fills it with demo data so you can try the access rule straight away.
// Demo accounts (test values only — not real credentials):
//   alice / password123
//   ben   / password123
//   chloe / password123
const bcrypt = require('bcryptjs');
const db = require('../src/db');

const DEMO_PASSWORD = 'password123';

db.exec('DELETE FROM tasks; DELETE FROM users; DELETE FROM sqlite_sequence;');

const insertUser = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
const ids = {};
for (const name of ['alice', 'ben', 'chloe']) {
  ids[name] = Number(insertUser.run(name, bcrypt.hashSync(DEMO_PASSWORD, 10)).lastInsertRowid);
}

// Date n days from today as YYYY-MM-DD, in local time (not UTC).
const inDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const insertTask = db.prepare(
  `INSERT INTO tasks (title, description, status, assignee_id, due_date, created_by)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const tasks = [
  ['Write the introduction', 'Problem statement + research question, ~300 words.', 'doing', ids.alice, inDays(3), ids.alice],
  ['Collect survey responses', 'Need at least 30 responses from the course mailing list.', 'todo', ids.ben, inDays(5), ids.alice],
  ['Make the slide deck', '10 slides max for the final presentation.', 'todo', null, inDays(10), ids.chloe],
  ['Book a study room', 'Thursday afternoon, library level 3.', 'done', ids.chloe, inDays(-1), ids.chloe],
  ['Proofread the full report', '', 'todo', null, inDays(12), ids.ben],
];
for (const t of tasks) insertTask.run(...t);

console.log(`Seeded 3 users (alice, ben, chloe — password "${DEMO_PASSWORD}") and ${tasks.length} tasks.`);
