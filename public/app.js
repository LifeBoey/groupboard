// Board page: loads tasks, renders three columns, handles create / edit / move / delete.
const STATUSES = ['todo', 'doing', 'done'];
const STATUS_LABEL = { todo: 'To Do', doing: 'In Progress', done: 'Done' };

let me = null;
let users = [];
let tasks = [];
let editingId = null; // null = creating a new task

const dialog = document.getElementById('task-dialog');
const form = document.getElementById('task-form');
const boardError = document.getElementById('board-error');
const dialogError = document.getElementById('dialog-error');

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login.html';
    throw new Error('Not logged in');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c); // append() treats strings as text (safe)
  return node;
}

function formatDue(dateStr) {
  if (!dateStr) return null;
  const today = new Date().toISOString().slice(0, 10);
  const d = new Date(dateStr + 'T00:00:00');
  const label = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return { label, overdue: dateStr < today };
}

function renderCard(task) {
  const idx = STATUSES.indexOf(task.status);
  const due = formatDue(task.due_date);
  const overdue = due && due.overdue && task.status !== 'done';

  const meta = el(
    'div',
    { class: 'meta' },
    el('span', { class: 'assignee' + (task.assignee_name ? '' : ' none') }, task.assignee_name ? '👤 ' + task.assignee_name : 'Unassigned'),
    due ? el('span', { class: 'due' + (overdue ? ' overdue' : '') }, '📅 ' + due.label) : null
  );

  const card = el(
    'li',
    { class: 'card' + (task.can_change ? '' : ' readonly') },
    el('h3', {}, task.title),
    task.description ? el('p', { class: 'desc' }, task.description) : null,
    meta,
    el('p', { class: 'created' }, 'Added by ' + task.created_by_name)
  );

  if (task.can_change) {
    const actions = el(
      'div',
      { class: 'card-actions' },
      el('button', {
        type: 'button', title: 'Move left', 'aria-label': 'Move to ' + (STATUS_LABEL[STATUSES[idx - 1]] || ''),
        onclick: () => moveTask(task, -1),
        ...(idx === 0 ? { disabled: '' } : {}),
      }, '←'),
      el('button', { type: 'button', onclick: () => openDialog(task) }, 'Edit'),
      el('button', {
        type: 'button', title: 'Move right', 'aria-label': 'Move to ' + (STATUS_LABEL[STATUSES[idx + 1]] || ''),
        onclick: () => moveTask(task, 1),
        ...(idx === STATUSES.length - 1 ? { disabled: '' } : {}),
      }, '→')
    );
    card.append(actions);
  } else {
    card.append(el('p', { class: 'locked' }, '🔒 View only'));
  }
  return card;
}

function render() {
  for (const status of STATUSES) {
    const col = document.querySelector(`.column[data-status="${status}"]`);
    const list = col.querySelector('.cards');
    const items = tasks.filter((t) => t.status === status);
    list.replaceChildren(...items.map(renderCard));
    if (!items.length) list.append(el('li', { class: 'empty' }, 'No tasks'));
    col.querySelector('.count').textContent = items.length;
  }
}

async function load() {
  boardError.textContent = '';
  try {
    [users, tasks] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/tasks')]);
    render();
  } catch (err) {
    boardError.textContent = err.message;
  }
}

async function moveTask(task, dir) {
  const status = STATUSES[STATUSES.indexOf(task.status) + dir];
  if (!status) return;
  try {
    await api('PATCH', `/api/tasks/${task.id}`, { status });
  } catch (err) {
    boardError.textContent = err.message;
  }
  await load();
}

function openDialog(task) {
  editingId = task ? task.id : null;
  dialogError.textContent = '';
  document.getElementById('dialog-title').textContent = task ? 'Edit task' : 'New task';
  document.getElementById('delete-task').hidden = !task;

  form.assignee_id.replaceChildren(
    el('option', { value: '' }, 'Unassigned'),
    ...users.map((u) => el('option', { value: String(u.id) }, u.username))
  );
  form.title.value = task?.title ?? '';
  form.description.value = task?.description ?? '';
  form.assignee_id.value = task?.assignee_id != null ? String(task.assignee_id) : '';
  form.due_date.value = task?.due_date ?? '';
  form.status.value = task?.status ?? 'todo';
  dialog.showModal();
  form.title.focus();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    title: form.title.value,
    description: form.description.value,
    assignee_id: form.assignee_id.value || null,
    due_date: form.due_date.value || null,
    status: form.status.value,
  };
  try {
    if (editingId) await api('PATCH', `/api/tasks/${editingId}`, body);
    else await api('POST', '/api/tasks', body);
    dialog.close();
    await load();
  } catch (err) {
    dialogError.textContent = err.message;
  }
});

document.getElementById('cancel-task').addEventListener('click', () => dialog.close());

document.getElementById('delete-task').addEventListener('click', async () => {
  if (!editingId || !confirm('Delete this task? This cannot be undone.')) return;
  try {
    await api('DELETE', `/api/tasks/${editingId}`);
    dialog.close();
    await load();
  } catch (err) {
    dialogError.textContent = err.message;
  }
});

document.querySelector('.add-task').addEventListener('click', () => openDialog(null));
document.getElementById('refresh').addEventListener('click', load);
document.getElementById('logout').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  location.href = '/login.html';
});

(async function init() {
  me = await api('GET', '/api/me');
  document.getElementById('me').textContent = 'Signed in as ' + me.username;
  await load();
})();
