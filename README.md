# GroupBoard

A tiny Trello for one student project group: a single board with three columns where up to 10 people track **who is doing what before the deadline**.

## Product thinking

**Audience.** A student project group of 4–10 people working on one assignment, such as a report or a presentation, over a few weeks.

**The problem.** Work gets split up in a group chat ("I'll do the intro!"), and two weeks later nobody remembers who promised what, what's finished, or what's still unclaimed. Trello and similar tools can do this, but they're built for ongoing teams. You have to create a workspace, invite people and learn the features, and that's too much for a 3-week assignment.

**Why this exists.** One board, one shared link, and signing up takes seconds. Everyone sees the same three columns, so the state of the project is obvious at a glance, and so is whose name is on each task.

**What it is not.** It has no multiple boards, labels, comments, attachments, notifications, real-time sync or mobile app. Those are deliberately left out.

## Scope (the three constraints)

| Constraint | Choice |
|---|---|
| **One main record** | **Task**: title, description, status (To Do / In Progress / Done), assignee, due date, created by, timestamps |
| **One shared action** | **Moving a task across the board**: To Do → In Progress → Done (← / → buttons on each card) |
| **One access rule** | **Everyone signed in can view every task, but only the task's creator or its current assignee can change it** (edit, move, reassign or delete). The server enforces this, not just the UI. Other members see the card as "View only". |

Other limits:
- At most **10 accounts**. The 11th sign-up is refused.
- New passwords need at least **8 characters**.
- **Login rate limits:** after 5 failed logins for one username from the same IP address, or 20 failed logins of any kind from one IP address, further attempts from that IP get **429 Too Many Requests** for 15 minutes, even with the right password. Everyone behind one IP address (one machine or one shared Wi-Fi) shares the 20-failure budget. Sign-up is limited to 10 attempts per IP address every 15 minutes. The counters are kept in memory, so restarting the server resets them.
- Any member can create a task and can assign it to anyone in the group, or leave it unassigned.
- The assignee can hand a task to someone else or unassign themselves. Once they do, the rule no longer lets them change it, unless they also created it.
- Delete is permanent, after a confirmation prompt.
- There are no live updates. Click **↻ Refresh** to see teammates' changes.

## Stack

- **Node.js + Express**: the HTTP server and JSON API.
- **SQLite** through Node's built-in `node:sqlite`: the database is a single file at `data/groupboard.db`, with no database server or native build step.
- **bcryptjs** for password hashing and **express-session** for login cookies.
- **Plain HTML/CSS/JavaScript** frontend, with no build step.

Requires **Node.js 22.13 or newer** (`node:sqlite`).

## Run it

```bash
npm install
npm run seed   # optional: demo data — wipes the database first
npm start
```

Then open <http://localhost:3000>.

The seed creates three demo accounts, **alice**, **ben** and **chloe**, all with the password `password123`. To see the rule in action, log in as **ben**: he can move "Collect survey responses" (he's the assignee) and "Proofread the full report" (he created it), but "Make the slide deck" is view-only for him.

Sessions are kept in memory, so restarting the server logs everyone out. Your tasks and accounts stay in the database.

## API

All routes except signup and login need a logged-in session.

| Method | Route | Who |
|---|---|---|
| POST | `/api/signup`, `/api/login`, `/api/logout` | anyone |
| GET | `/api/me`, `/api/users` | any member |
| GET | `/api/tasks` | any member (read) |
| POST | `/api/tasks` | any member (create) |
| PATCH | `/api/tasks/:id` | creator or assignee (update / move) |
| DELETE | `/api/tasks/:id` | creator or assignee (delete) |

## Files

```
src/db.js        schema + SQLite connection
src/server.js    API, auth, and the access rule (canChange)
src/rateLimit.js in-memory login/sign-up rate limiter
public/          login page, board page, app.js, style.css
scripts/seed.js  demo data
```
