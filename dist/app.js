import {
  COLORS, createList, updateList, deleteList, moveList, addTask, updateTask, deleteTask, moveTask, clearDone,
  validate, sample,
} from './model.js';
import { createLocalStore, safeStorage } from './store.js';

const $ = id => document.getElementById(id);
const HUES = { lavender: 290, sage: 150, peach: 55, sky: 240, rose: 8, teal: 190 };
const UI_KEY = 'quiet-list-ui';
const SVG = 'http://www.w3.org/2000/svg';

const storage = safeStorage();
const store = createLocalStore(storage);
const calm = matchMedia('(prefers-reduced-motion: reduce)');
const wide = matchMedia('(min-width: 900px)');

const loaded = store.load();
let state = loaded.state;
let prefs = {};
try { prefs = JSON.parse(storage.getItem(UI_KEY)) || {}; } catch { prefs = {}; }

let activeId = state.lists.some(l => l.id === prefs.activeId) ? prefs.activeId : state.lists[0].id;
let view = 'list';
let doneOpen = !!prefs.doneOpen;
let editingId = null;
let enteringId = null;
let gesture = null;          // 'swipe' | 'drag' | 'pull' while a touch gesture owns the screen
let undoSnapshot = null;
let toastTimer = 0;

const app = $('app'), home = $('home'), listPane = $('list'), scroller = $('scroller'), content = $('content');
const openEl = $('open'), doneEl = $('done'), listsEl = $('lists'), thought = $('thought'), toast = $('toast');

/* ---------- small helpers ---------- */
const current = () => state.lists.find(l => l.id === activeId) || state.lists[0];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function icon(name) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', '#' + name);
  svg.append(use);
  return svg;
}
function buzz(ms) { try { navigator.vibrate?.(ms); } catch { /* not supported, e.g. iOS */ } }
function announce(message) {
  const live = $('live');
  live.textContent = '';
  requestAnimationFrame(() => { live.textContent = message; });
}
function summary(list) {
  const open = list.tasks.filter(t => !t.done).length;
  if (open) return `${open} open`;
  return list.tasks.length ? 'All clear' : 'Empty';
}
function savePrefs() {
  try { storage.setItem(UI_KEY, JSON.stringify({ activeId, doneOpen })); } catch { /* preference only */ }
}

/* ---------- saving, undo, toast ---------- */
function snapshot() { return { state: structuredClone(state), activeId }; }

// Runs a model mutation, saves, and optionally offers Undo. Returns false if the model refused.
function mutate(fn, { toast: message, undo = false } = {}) {
  const before = undo ? snapshot() : null;
  try { fn(); } catch (error) { announce(error.message); return false; }
  const saved = store.save(state);
  if (!saved) showToast('Could not save in this browser. Download a backup before closing.');
  else if (message) showToast(message, before);
  return true;
}
function showToast(message, before = null) {
  $('toast-text').textContent = message;
  $('toast-undo').hidden = !before;
  undoSnapshot = before;
  toast.hidden = true;
  void toast.offsetWidth;
  toast.hidden = false;
  clearTimeout(toastTimer);
  const tick = () => {
    if (toast.matches(':hover, :focus-within')) toastTimer = setTimeout(tick, 2000);
    else hideToast();
  };
  toastTimer = setTimeout(tick, 7000);
}
function hideToast() {
  clearTimeout(toastTimer);
  const hadFocus = toast.contains(document.activeElement);
  toast.hidden = true;
  undoSnapshot = null;
  // Keep keyboard focus in the app without popping a phone keyboard open.
  if (hadFocus) (view === 'list' ? $('title') : $('new-list')).focus({ preventScroll: true });
}
function undo() {
  if (!undoSnapshot) return;
  state = undoSnapshot.state;
  activeId = state.lists.some(l => l.id === undoSnapshot.activeId) ? undoSnapshot.activeId : state.lists[0].id;
  editingId = null;
  hideToast();
  if (!store.save(state)) showToast('Could not save in this browser. Download a backup before closing.');
  render();
  announce('Restored.');
}

/* ---------- rendering ---------- */
function measure() {
  const tops = new Map();
  for (const li of content.querySelectorAll('.row')) tops.set(li.dataset.id, li.getBoundingClientRect().top);
  for (const li of listsEl.children) tops.set(li.dataset.id, li.getBoundingClientRect().top);
  return tops;
}
function playFlip(before) {
  for (const li of [...content.querySelectorAll('.row'), ...listsEl.children]) {
    const old = before.get(li.dataset.id);
    if (old == null || li.classList.contains('entering')) continue;
    const dy = old - li.getBoundingClientRect().top;
    if (Math.abs(dy) > 1) {
      li.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 280, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    }
  }
}

function rowEl(task, index, openTasks) {
  const li = el('li', 'row');
  li.dataset.id = task.id;
  if (task.done) li.dataset.done = '';
  const left = el('span', 'reveal left'); left.append(icon(task.done ? 'i-undo' : 'i-check'));
  const right = el('span', 'reveal right'); right.append(icon('i-trash'));
  const card = el('div', 'card');

  const label = el('label', 'check');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = task.done;
  box.dataset.fk = 'c:' + task.id;
  box.setAttribute('aria-label', (task.done ? 'Reopen: ' : 'Done: ') + task.text);
  label.append(box);
  card.append(label);

  if (task.done) {
    const text = el('div', 'text'); text.append(el('span', 't', task.text));
    const remove = el('button', 'row-x'); remove.type = 'button'; remove.dataset.fk = 'x:' + task.id;
    remove.setAttribute('aria-label', 'Delete: ' + task.text); remove.append(icon('i-trash'));
    card.append(text, remove);
  } else if (editingId === task.id) {
    card.classList.add('editing');
    const area = el('textarea', 'edit-text');
    area.value = task.text; area.maxLength = 2000; area.rows = 1; area.dataset.fk = 'e:' + task.id;
    area.setAttribute('aria-label', 'Edit thought'); area.setAttribute('enterkeyhint', 'done');
    const tools = el('div', 'edit-tools');
    const tool = (cls, name, text, key, disabled) => {
      const b = el('button', cls); b.type = 'button'; b.dataset.fk = key + ':' + task.id; b.disabled = !!disabled;
      b.append(icon(name), el('span', '', text)); return b;
    };
    tools.append(
      tool('tool-up', 'i-up', 'Up', 'u', index === 0),
      tool('tool-down', 'i-down', 'Down', 'd', index === openTasks.length - 1),
      tool('tool-delete', 'i-trash', 'Delete', 'r'),
    );
    const save = el('button', 'tool-save', 'Save'); save.type = 'button';
    tools.append(save);
    card.append(area, tools);
  } else {
    const text = el('button', 'text'); text.type = 'button'; text.dataset.fk = 't:' + task.id;
    text.setAttribute('aria-label', 'Edit: ' + task.text);
    text.append(el('span', 't', task.text));
    const handle = el('button', 'handle'); handle.type = 'button'; handle.dataset.fk = 'h:' + task.id;
    handle.setAttribute('aria-label', `Reorder: ${task.text}. Use the up and down arrow keys.`);
    handle.append(icon('i-grip'));
    card.append(text, handle);
  }
  li.append(left, right, card);
  if (enteringId === task.id) li.classList.add('entering');
  return li;
}

function renderList() {
  const list = current();
  const openTasks = list.tasks.filter(t => !t.done);
  const doneTasks = list.tasks.filter(t => t.done);
  if (editingId && !openTasks.some(t => t.id === editingId)) editingId = null;

  $('title').textContent = list.name;
  $('count').textContent = summary(list) + (doneTasks.length && openTasks.length ? ` · ${doneTasks.length} done` : '');
  document.title = `${list.name} · Quiet List`;
  document.documentElement.style.setProperty('--h', HUES[list.color] ?? HUES.lavender);

  openEl.replaceChildren(...openTasks.map((t, i) => rowEl(t, i, openTasks)));
  openEl.hidden = !openTasks.length;
  doneEl.replaceChildren(...doneTasks.map(t => rowEl(t)));

  $('empty').hidden = openTasks.length > 0;
  $('empty-title').textContent = list.tasks.length ? 'All clear' : 'Nothing here yet';
  $('empty-text').textContent = list.tasks.length
    ? 'Everything on this list is done.'
    : 'Type a thought above. On a phone you can also pull the list down.';

  $('done-wrap').hidden = !doneTasks.length;
  $('done-toggle').textContent = `${doneTasks.length} done`;
  $('done-toggle').setAttribute('aria-expanded', String(doneOpen));
  doneEl.hidden = !doneOpen;
  $('clear-done').hidden = !doneOpen;

  const pager = $('pager');
  pager.replaceChildren();
  if (state.lists.length > 1 && state.lists.length <= 8) {
    for (const other of state.lists) {
      const dot = el('button'); dot.type = 'button'; dot.dataset.id = other.id; dot.dataset.fk = 'p:' + other.id;
      dot.setAttribute('aria-label', other.name);
      if (other.id === list.id) dot.setAttribute('aria-current', 'true');
      pager.append(dot);
    }
  }
  for (const area of content.querySelectorAll('.edit-text')) autosize(area);
}

function renderHome() {
  listsEl.replaceChildren(...state.lists.map(list => {
    const li = el('li', 'tile hue');
    li.dataset.id = list.id;
    li.style.setProperty('--h', HUES[list.color] ?? HUES.lavender);
    if (list.id === activeId) li.setAttribute('aria-current', 'true');
    const open = el('button', 'tile-open'); open.type = 'button'; open.dataset.fk = 'l:' + list.id;
    open.append(el('span', 'tile-name', list.name), el('span', 'tile-count', summary(list)));
    const handle = el('button', 'handle'); handle.type = 'button'; handle.dataset.fk = 'lh:' + list.id;
    handle.setAttribute('aria-label', `Reorder list: ${list.name}. Use the up and down arrow keys.`);
    handle.append(icon('i-grip'));
    li.append(open, handle);
    return li;
  }));
}

function render({ flip = true, focus = null } = {}) {
  const key = focus ?? document.activeElement?.dataset?.fk;
  const before = flip && !calm.matches ? measure() : null;
  renderHome();
  renderList();
  if (before) playFlip(before);
  enteringId = null;
  if (key) document.querySelector(`[data-fk="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}

function autosize(area) {
  if (CSS.supports('field-sizing', 'content')) return;
  area.style.height = 'auto';
  area.style.height = area.scrollHeight + 'px';
}

/* ---------- navigation ---------- */
function applyView() {
  app.dataset.view = view;
  home.inert = !wide.matches && view !== 'home';
  listPane.inert = !wide.matches && view !== 'list';
}
function setHash(hash, replace) {
  try {
    if (location.hash === '#' + hash) return;
    if (replace) location.replace('#' + hash); else location.hash = hash;
  } catch { /* sandboxed frames may refuse; the view has already changed */ }
}
function showHome({ focus = true } = {}) {
  view = 'home';
  editingId = null;
  applyView();
  render({ flip: false });
  setHash('lists');
  if (focus && !wide.matches) document.querySelector(`[data-fk="l:${CSS.escape(activeId)}"]`)?.focus();
}
function openList(listId, { replace = false, direction = 0, focus = false } = {}) {
  if (!state.lists.some(l => l.id === listId)) return;
  const changed = listId !== activeId;
  activeId = listId;
  view = 'list';
  editingId = null;
  savePrefs();
  applyView();
  render({ flip: false });
  if (changed) scroller.scrollTop = 0;
  if (changed && direction && !calm.matches) {
    content.classList.remove('swap-next', 'swap-prev');
    void content.offsetWidth;
    content.classList.add(direction > 0 ? 'swap-next' : 'swap-prev');
  }
  setHash('list-' + listId, replace);
  if (focus) $('title').focus({ preventScroll: true });
}
function stepList(direction) {
  const i = state.lists.findIndex(l => l.id === activeId);
  const next = state.lists[i + direction];
  if (!next) return false;
  openList(next.id, { replace: true, direction });
  announce(next.name);
  return true;
}
function route() {
  const hash = location.hash.slice(1);
  if (hash === 'lists') { if (view !== 'home') showHome({ focus: false }); return; }
  const listId = hash.startsWith('list-') ? hash.slice(5) : null;
  if (listId && state.lists.some(l => l.id === listId)) {
    if (view !== 'list' || listId !== activeId) openList(listId, { replace: true });
  }
}

/* ---------- item actions ---------- */
let usingKeyboard = false;
addEventListener('keydown', () => { usingKeyboard = true; }, true);
addEventListener('pointerdown', () => { usingKeyboard = false; }, true);

function collapse(li) {
  if (calm.matches || !li.isConnected) return Promise.resolve();
  li.style.overflow = 'hidden';
  const animation = li.animate(
    [{ height: li.offsetHeight + 'px', opacity: 1, marginBottom: '0px' }, { height: '0px', opacity: 0, marginBottom: '-8px' }],
    { duration: 200, easing: 'ease-in', fill: 'forwards' },
  );
  return Promise.race([animation.finished.catch(() => {}), wait(260)]);
}

async function setDone(taskId, done, li, { swiped = false } = {}) {
  const list = current();
  const task = list.tasks.find(t => t.id === taskId);
  if (!task || !mutate(() => updateTask(list, taskId, { done }))) { render(); return; }
  announce((done ? 'Done: ' : 'Reopened: ') + task.text);
  const cleared = done && !list.tasks.some(t => !t.done);
  if (done) {
    buzz(12);
    if (!calm.matches && li) {
      if (!swiped) { li.classList.add('completing'); await wait(340); }
      await collapse(li);
    }
  }
  render({ focus: done ? null : 'c:' + taskId });
  if (cleared) cheer();
  if (done) thoughtOrNext();
}
function thoughtOrNext() {
  // After a row disappears, keep keyboard users in the list instead of dropping focus on the page.
  // Touch and mouse users are left alone: moving focus there would pop a keyboard or a focus ring.
  if (usingKeyboard && document.activeElement === document.body) (openEl.querySelector('.check input') || thought).focus({ preventScroll: true });
}

async function removeTask(taskId, li) {
  const list = current();
  if (!mutate(() => deleteTask(list, taskId), { toast: 'Deleted', undo: true })) return;
  if (editingId === taskId) editingId = null;
  if (li) await collapse(li);
  render();
  thoughtOrNext();
}

function shiftTask(taskId, direction, focusKey) {
  const list = current();
  const open = list.tasks.filter(t => !t.done);
  const from = open.findIndex(t => t.id === taskId);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= open.length) return;
  const beforeId = direction < 0 ? open[to].id : open[to + 1]?.id ?? null;
  if (!mutate(() => moveTask(list, taskId, beforeId))) return;
  render({ focus: focusKey });
  announce(`Moved to ${to + 1} of ${open.length}.`);
}
function shiftList(listId, direction) {
  const from = state.lists.findIndex(l => l.id === listId);
  const to = from + direction;
  if (to < 0 || to >= state.lists.length) return;
  const beforeId = direction < 0 ? state.lists[to].id : state.lists[to + 1]?.id ?? null;
  if (!mutate(() => moveList(state, listId, beforeId))) return;
  render({ focus: 'lh:' + listId });
  announce(`Moved to ${to + 1} of ${state.lists.length}.`);
}

function cheer() {
  if (calm.matches) return;
  const empty = $('empty');
  empty.classList.remove('cheer');
  void empty.offsetWidth;
  empty.classList.add('cheer');
  buzz(24);
  for (let i = 0; i < 14; i++) {
    const bit = el('span', 'bit');
    const angle = (i / 14) * Math.PI * 2 + Math.random() * 0.4;
    const reach = 60 + Math.random() * 60;
    bit.style.setProperty('--bx', `${Math.cos(angle) * reach}px`);
    bit.style.setProperty('--by', `${Math.sin(angle) * reach - 30}px`);
    bit.style.setProperty('--br', `${Math.random() * 360}deg`);
    bit.style.setProperty('--bh', String((i * 47) % 360));
    empty.append(bit);
    setTimeout(() => bit.remove(), 900);
  }
}

/* ---------- editing in place ---------- */
function startEdit(taskId) {
  editingId = taskId;
  render({ flip: false, focus: 'e:' + taskId });
  const area = content.querySelector('.edit-text');
  if (area) { area.setSelectionRange(area.value.length, area.value.length); autosize(area); }
}
// Stores what is typed. Returns false when the box was emptied (the caller decides what that means).
function commitEditText() {
  const area = content.querySelector('.edit-text');
  const list = current();
  const task = list.tasks.find(t => t.id === editingId);
  if (!area || !task) return true;
  const text = area.value.trim();
  if (!text) return false;
  if (text !== task.text) mutate(() => updateTask(list, task.id, { text }));
  return true;
}
function finishEdit({ save = true, refocus = true } = {}) {
  const taskId = editingId;
  if (!taskId) return;
  if (save && !commitEditText()) { removeTask(taskId, content.querySelector(`.row[data-id="${CSS.escape(taskId)}"]`)); return; }
  editingId = null;
  // Swap just this row so a tap that caused the blur still lands on its target.
  const li = content.querySelector(`.row[data-id="${CSS.escape(taskId)}"]`);
  const open = current().tasks.filter(t => !t.done);
  const index = open.findIndex(t => t.id === taskId);
  if (li && index >= 0) li.replaceWith(rowEl(open[index], index, open)); else render({ flip: false });
  renderHome();
  if (refocus) document.querySelector(`[data-fk="t:${CSS.escape(taskId)}"]`)?.focus({ preventScroll: true });
}

/* ---------- touch: swipe, hold-to-drag, drag by grip ---------- */
function suppressClick(node) {
  const stop = event => { event.stopPropagation(); event.preventDefault(); };
  node.addEventListener('click', stop, { capture: true, once: true });
  setTimeout(() => node.removeEventListener('click', stop, { capture: true }), 350);
}

function startDrag(li, pointer, { scrollBox, onDrop }) {
  const ol = li.parentElement;
  const items = [...ol.children];
  const from = items.indexOf(li);
  const scroll0 = scrollBox.scrollTop;
  const rects = items.map(node => { const r = node.getBoundingClientRect(); return { top: r.top + scroll0, height: r.height }; });
  const gap = items.length > 1 ? rects[1].top - (rects[0].top + rects[0].height) : 0;
  const span = rects[from].height + gap;
  const y0 = pointer.clientY;
  let y = y0, to = from, frame = 0;
  gesture = 'drag';
  li.classList.add('dragging'); ol.classList.add('sorting'); document.body.classList.add('is-dragging');
  buzz(8);

  const update = () => {
    const dy = (y - y0) + (scrollBox.scrollTop - scroll0);
    li.style.transform = `translateY(${dy}px) scale(1.02)`;
    const center = rects[from].top + rects[from].height / 2 + dy;
    let target = from;
    items.forEach((node, i) => {
      if (i === from) return;
      const middle = rects[i].top + rects[i].height / 2;
      let shift = 0;
      if (i < from && center < middle) { shift = span; target = Math.min(target, i); }
      if (i > from && center > middle) { shift = -span; target = Math.max(target, i); }
      node.style.transform = shift ? `translateY(${shift}px)` : '';
    });
    to = target;
  };
  const autoScroll = () => {
    const box = scrollBox.getBoundingClientRect();
    const edge = 64;
    let speed = 0;
    if (y < box.top + edge) speed = -(box.top + edge - y) / 4;
    else if (y > box.bottom - edge) speed = (y - (box.bottom - edge)) / 4;
    if (speed) { scrollBox.scrollTop += Math.max(-14, Math.min(14, speed)); update(); }
    frame = requestAnimationFrame(autoScroll);
  };
  const move = event => {
    if (event.pointerId !== pointer.pointerId) return;
    y = event.clientY;
    update();
    event.preventDefault();
  };
  const end = event => {
    if (event.pointerId !== pointer.pointerId) return;
    cancelAnimationFrame(frame);
    removeEventListener('pointermove', move); removeEventListener('pointerup', end); removeEventListener('pointercancel', end);
    ol.classList.remove('sorting'); document.body.classList.remove('is-dragging');
    gesture = null;
    suppressClick(li);
    if (event.type === 'pointerup' && to !== from) {
      const rest = items.filter(node => node !== li);
      onDrop(li.dataset.id, rest[to]?.dataset.id ?? null);
    } else {
      li.classList.remove('dragging');
      for (const node of items) node.style.transform = '';
    }
  };
  addEventListener('pointermove', move, { passive: false });
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);
  frame = requestAnimationFrame(autoScroll);
  update();
}

function watchItems(container, { scrollBox, itemSelector, onDrop, swipe }) {
  container.addEventListener('pointerdown', event => {
    if (event.button || gesture) return;
    const li = event.target.closest(itemSelector);
    if (!li || li.querySelector('.editing')) return;
    const isDone = 'done' in li.dataset;
    const handle = event.target.closest('.handle');
    if (handle) {
      event.preventDefault();
      handle.focus({ preventScroll: true });
      startDrag(li, event, { scrollBox, onDrop });
      return;
    }
    const card = li.querySelector('.card');
    const x0 = event.clientX, y0 = event.clientY;
    let mode = null, dx = 0, armed = false, lastY = y0;

    const detach = () => {
      clearTimeout(hold);
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', cancel);
    };
    // Press and hold with a finger or pen lifts the row for reordering.
    const hold = event.pointerType !== 'mouse' && !isDone ? setTimeout(() => {
      if (mode || gesture) return;
      detach();
      startDrag(li, { pointerId: event.pointerId, clientY: lastY }, { scrollBox, onDrop });
    }, 420) : 0;

    const move = ev => {
      if (ev.pointerId !== event.pointerId) return;
      dx = ev.clientX - x0; lastY = ev.clientY;
      const dy = ev.clientY - y0;
      if (!mode) {
        if (Math.hypot(dx, dy) < 8) return;
        clearTimeout(hold);
        if (swipe && card && !gesture && Math.abs(dx) > Math.abs(dy) * 1.3) {
          mode = 'swipe'; gesture = 'swipe';
          card.classList.remove('spring');
          try { card.setPointerCapture(event.pointerId); } catch { /* pointer already gone */ }
        } else { detach(); return; }
      }
      ev.preventDefault();
      li.dataset.swipe = dx > 0 ? 'complete' : 'delete';
      card.style.transform = `translateX(${dx}px)`;
      const now = Math.abs(dx) > Math.min(96, li.offsetWidth * 0.3);
      if (now !== armed) { armed = now; li.toggleAttribute('data-armed', armed); if (armed) buzz(6); }
    };
    const settle = () => {
      card.classList.add('spring');
      card.style.transform = '';
      li.removeAttribute('data-armed');
      setTimeout(() => { if (!card.style.transform) delete li.dataset.swipe; }, 320);
    };
    const up = async ev => {
      if (ev.pointerId !== event.pointerId) return;
      detach();
      if (mode !== 'swipe') return;
      gesture = null;
      suppressClick(li);
      if (!armed) { settle(); return; }
      const action = dx > 0 ? 'complete' : 'delete';
      if (!calm.matches) {
        card.classList.add('fling');
        card.style.transform = `translateX(${dx > 0 ? 110 : -110}%)`;
        await wait(190);
      }
      swipe(li, action);
    };
    const cancel = ev => {
      if (ev.pointerId !== event.pointerId) return;
      detach();
      if (mode === 'swipe') { gesture = null; settle(); }
    };
    addEventListener('pointermove', move, { passive: false });
    addEventListener('pointerup', up);
    addEventListener('pointercancel', cancel);
  });
}

watchItems(content, {
  scrollBox: scroller,
  itemSelector: '.row',
  onDrop: (taskId, beforeId) => { mutate(() => moveTask(current(), taskId, beforeId)); render(); },
  swipe: (li, action) => {
    const taskId = li.dataset.id;
    if (action === 'delete') removeTask(taskId, li);
    else setDone(taskId, !('done' in li.dataset), li, { swiped: true });
  },
});
watchItems(listsEl, {
  scrollBox: $('home-scroll'),
  itemSelector: '.tile',
  onDrop: (listId, beforeId) => { mutate(() => moveList(state, listId, beforeId)); render(); },
  swipe: null,
});

// Once a gesture owns the touch, stop the page from scrolling underneath it.
document.addEventListener('touchmove', event => { if (gesture && event.cancelable) event.preventDefault(); }, { passive: false });
content.addEventListener('contextmenu', event => { if (event.target.closest('.card') && !event.target.closest('textarea')) event.preventDefault(); });

/* ---------- touch: pull down to add ---------- */
let pull = null;
const PULL_AT = 58;
scroller.addEventListener('touchstart', event => {
  pull = event.touches.length === 1 && scroller.scrollTop <= 0 && !editingId && !gesture
    ? { x: event.touches[0].clientX, y: event.touches[0].clientY, active: false, distance: 0 } : null;
}, { passive: true });
scroller.addEventListener('touchmove', event => {
  if (!pull || (gesture && gesture !== 'pull')) return;
  const dx = event.touches[0].clientX - pull.x, dy = event.touches[0].clientY - pull.y;
  if (!pull.active) {
    if (dy > 10 && dy > Math.abs(dx) * 1.5 && scroller.scrollTop <= 0) { pull.active = true; gesture = 'pull'; content.classList.remove('settle'); }
    else if (dy < -4 || Math.abs(dx) > 12) { pull = null; return; }
    else return;
  }
  if (event.cancelable) event.preventDefault();
  pull.distance = Math.max(0, (dy - 10) * 0.55);
  content.style.transform = `translateY(${pull.distance}px)`;
  const armed = pull.distance >= PULL_AT;
  const hint = $('pull');
  hint.style.opacity = String(Math.min(1, pull.distance / PULL_AT));
  if (armed !== hint.classList.contains('armed')) {
    hint.classList.toggle('armed', armed);
    $('pull-text').textContent = armed ? 'Release to add' : 'Pull to add';
    if (armed) buzz(6);
  }
}, { passive: false });
const endPull = event => {
  if (!pull?.active) { pull = null; return; }
  const armed = event.type === 'touchend' && pull.distance >= PULL_AT;
  pull = null; gesture = null;
  content.classList.add('settle');
  content.style.transform = '';
  $('pull').style.opacity = '0';
  $('pull').classList.remove('armed');
  $('pull-text').textContent = 'Pull to add';
  if (armed) focusCapture();
};
scroller.addEventListener('touchend', endPull);
scroller.addEventListener('touchcancel', endPull);

/* ---------- touch: swipe the title bar to change list ---------- */
for (const zone of [$('list-bar'), $('pager')]) {
  zone.addEventListener('pointerdown', event => {
    if (event.button || wide.matches) return;
    const x0 = event.clientX, y0 = event.clientY;
    const up = ev => {
      if (ev.pointerId !== event.pointerId) return;
      removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (ev.type === 'pointerup' && Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        suppressClick(zone);
        if (stepList(dx < 0 ? 1 : -1)) buzz(6);
      }
    };
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  });
}

/* ---------- capture ---------- */
function focusCapture() {
  scroller.scrollTo({ top: 0, behavior: calm.matches ? 'auto' : 'smooth' });
  thought.focus({ preventScroll: true });
}
function syncCapture() { $('capture').classList.toggle('has-text', !!thought.value.trim()); }
thought.addEventListener('input', syncCapture);
$('capture').addEventListener('submit', event => {
  event.preventDefault();
  if (!thought.value.trim()) return;
  const list = current();
  let task;
  if (!mutate(() => { task = addTask(list, thought.value, { top: true }); })) return;
  enteringId = task.id;
  thought.value = '';
  syncCapture();
  render();
  scroller.scrollTop = 0;
  thought.focus({ preventScroll: true });
  buzz(8);
  announce('Added: ' + task.text);
});
// Pasting several lines drops each one in as its own thought.
thought.addEventListener('paste', event => {
  const lines = (event.clipboardData?.getData('text') ?? '').split(/\r?\n/)
    .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()).filter(Boolean).slice(0, 100);
  if (lines.length < 2) return;
  event.preventDefault();
  const list = current();
  const ok = mutate(() => {
    for (const line of [...lines].reverse()) addTask(list, line.slice(0, 2000), { top: true });
  }, { toast: `Added ${plural(lines.length, 'thought')}`, undo: true });
  if (ok) render();
});
thought.addEventListener('keydown', event => { if (event.key === 'Escape') thought.blur(); });
$('fab').addEventListener('click', focusCapture);

/* ---------- list pane events ---------- */
content.addEventListener('change', event => {
  const box = event.target.closest('.check input');
  if (!box) return;
  const li = box.closest('.row');
  if (editingId === li.dataset.id) editingId = null;
  setDone(li.dataset.id, box.checked, li);
});
content.addEventListener('click', event => {
  const li = event.target.closest('.row');
  if (!li) return;
  const taskId = li.dataset.id;
  if (event.target.closest('button.text')) startEdit(taskId);
  else if (event.target.closest('.row-x')) removeTask(taskId, li);
  else if (event.target.closest('.tool-save')) finishEdit();
  else if (event.target.closest('.tool-delete')) removeTask(taskId, li);
  else if (event.target.closest('.tool-up')) { if (commitEditText()) shiftTask(taskId, -1, 'u:' + taskId); }
  else if (event.target.closest('.tool-down')) { if (commitEditText()) shiftTask(taskId, 1, 'd:' + taskId); }
});
content.addEventListener('input', event => { if (event.target.matches('.edit-text')) autosize(event.target); });
content.addEventListener('keydown', event => {
  const li = event.target.closest('.row');
  if (!li) return;
  const taskId = li.dataset.id;
  const arrow = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
  if (event.target.matches('.edit-text')) {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); finishEdit(); }
    else if (event.key === 'Escape') { event.preventDefault(); finishEdit({ save: false }); }
    else if (arrow && event.altKey) { event.preventDefault(); if (commitEditText()) shiftTask(taskId, arrow, 'e:' + taskId); }
    return;
  }
  if (!arrow || 'done' in li.dataset) return;
  if (event.target.closest('.handle')) { event.preventDefault(); shiftTask(taskId, arrow, 'h:' + taskId); }
  else if (event.altKey && event.target.closest('button.text')) { event.preventDefault(); shiftTask(taskId, arrow, 't:' + taskId); }
});
// Leaving the row saves the edit. A press inside the row (e.g. on a tool button, which
// some browsers do not focus) must not count as leaving.
let pressedInsideEdit = false;
content.addEventListener('pointerdown', event => {
  pressedInsideEdit = !!event.target.closest('.card.editing');
  if (pressedInsideEdit) setTimeout(() => { pressedInsideEdit = false; }, 500);
}, true);
// The typed text is stored at once; the row itself is only swapped after the finger or mouse
// lifts, so the layout does not shift under a tap that is still in progress.
let pointerIsDown = false;
addEventListener('pointerdown', () => { pointerIsDown = true; }, true);
for (const type of ['pointerup', 'pointercancel']) addEventListener(type, () => { pointerIsDown = false; }, true);
content.addEventListener('focusout', event => {
  const card = event.target.closest('.card.editing');
  if (!card || !editingId || pressedInsideEdit || card.contains(event.relatedTarget)) return;
  if (!document.hasFocus()) return;           // switching apps or tabs keeps the edit open
  const taskId = editingId;
  const kept = commitEditText();
  const close = () => { if (editingId === taskId) finishEdit({ save: !kept, refocus: false }); };
  if (!pointerIsDown) { close(); return; }
  const lifted = () => {
    removeEventListener('pointerup', lifted); removeEventListener('pointercancel', lifted);
    setTimeout(close, 60);
  };
  addEventListener('pointerup', lifted);
  addEventListener('pointercancel', lifted);
});

$('done-toggle').addEventListener('click', () => { doneOpen = !doneOpen; savePrefs(); render({ flip: false }); });
$('clear-done').addEventListener('click', () => {
  const list = current();
  const count = list.tasks.filter(t => t.done).length;
  if (mutate(() => clearDone(list), { toast: `Cleared ${count} done`, undo: true })) { render(); thought.focus({ preventScroll: true }); }
});
$('back').addEventListener('click', () => showHome());
$('pager').addEventListener('click', event => {
  const dot = event.target.closest('button');
  if (!dot || dot.dataset.id === activeId) return;
  const from = state.lists.findIndex(l => l.id === activeId), to = state.lists.findIndex(l => l.id === dot.dataset.id);
  openList(dot.dataset.id, { replace: true, direction: to - from });
  document.querySelector(`[data-fk="p:${CSS.escape(activeId)}"]`)?.focus();
});

/* ---------- home events ---------- */
listsEl.addEventListener('click', event => {
  const open = event.target.closest('.tile-open');
  if (open) openList(open.closest('.tile').dataset.id, { focus: !wide.matches });
});
listsEl.addEventListener('keydown', event => {
  const handle = event.target.closest('.handle');
  const arrow = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
  if (handle && arrow) { event.preventDefault(); shiftList(handle.closest('.tile').dataset.id, arrow); }
});

/* ---------- list dialog (new, rename, recolour, delete) ---------- */
const listDialog = $('list-dialog');
let listDialogMode = 'new';
$('swatches').replaceChildren(...COLORS.map(color => {
  const label = el('label', 'swatch hue');
  label.style.setProperty('--h', HUES[color]);
  const radio = el('input'); radio.type = 'radio'; radio.name = 'color'; radio.value = color; radio.id = 'color-' + color;
  radio.setAttribute('aria-label', color[0].toUpperCase() + color.slice(1));
  label.append(radio);
  return label;
}));
function openListDialog(mode) {
  listDialogMode = mode;
  const list = current();
  $('list-dialog-title').textContent = mode === 'new' ? 'New list' : 'List options';
  $('list-name').value = mode === 'new' ? '' : list.name;
  const color = mode === 'new' ? COLORS.find(c => !state.lists.some(l => l.color === c)) ?? COLORS[state.lists.length % COLORS.length] : list.color;
  $('color-' + color).checked = true;
  $('list-error').textContent = '';
  $('list-confirm').hidden = true;
  $('list-delete').hidden = mode === 'new';
  $('list-delete').disabled = state.lists.length === 1;
  $('list-save').textContent = mode === 'new' ? 'Create' : 'Save';
  listDialog.showModal();
  $('list-name').focus();
  if (mode !== 'new') $('list-name').select();
}
$('new-list').addEventListener('click', () => openListDialog('new'));
$('list-more').addEventListener('click', () => openListDialog('edit'));
$('list-cancel').addEventListener('click', () => listDialog.close());
$('list-form').addEventListener('submit', event => {
  event.preventDefault();
  const name = $('list-name').value;
  const color = listDialog.querySelector('input[name="color"]:checked')?.value ?? COLORS[0];
  try {
    if (listDialogMode === 'new') {
      const list = createList(state, name, color);
      store.save(state);
      listDialog.close();
      openList(list.id, { focus: true });
      focusCapture();
    } else {
      updateList(state, activeId, { name, color });
      store.save(state);
      listDialog.close();
      render({ flip: false });
    }
  } catch (error) {
    $('list-error').textContent = error.message;
    $('list-name').focus();
  }
});
$('list-delete').addEventListener('click', () => {
  const list = current();
  $('list-confirm-text').textContent = `Delete “${list.name}”${list.tasks.length ? ` and its ${plural(list.tasks.length, 'item')}` : ''}?`;
  $('list-confirm').hidden = false;
  $('list-confirm-no').focus();
});
$('list-confirm-no').addEventListener('click', () => { $('list-confirm').hidden = true; $('list-delete').focus(); });
$('list-confirm-yes').addEventListener('click', () => {
  const list = current();
  const index = state.lists.indexOf(list);
  if (!mutate(() => deleteList(state, list.id), { toast: `Deleted “${list.name}”`, undo: true })) return;
  listDialog.close();
  activeId = state.lists[Math.min(index, state.lists.length - 1)].id;
  savePrefs();
  if (wide.matches) openList(activeId, { replace: true }); else showHome();
  render({ flip: false });
});

/* ---------- backup dialog ---------- */
const settingsDialog = $('settings-dialog');
let pendingReplace = null;
const settingsStatus = message => { $('settings-status').textContent = message; };
$('open-settings').addEventListener('click', () => {
  $('settings-confirm').hidden = true;
  settingsStatus(storage.volatile ? 'This browser is blocking storage here, so lists will be gone when the page closes.' : '');
  settingsDialog.showModal();
});
$('settings-close').addEventListener('click', () => settingsDialog.close());
$('export').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
  const link = el('a'); link.href = url; link.download = 'quiet-list-backup.json';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  settingsStatus('Backup file requested. If nothing downloads here, use “Copy backup as text”.');
});
$('copy-backup').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(JSON.stringify(state, null, 2)); settingsStatus('Backup copied. Paste it somewhere safe.'); }
  catch { settingsStatus('This browser would not allow copying. Use the download instead.'); }
});
function askReplace(message, next) {
  pendingReplace = next;
  $('settings-confirm-text').textContent = message;
  $('settings-confirm').hidden = false;
  $('settings-confirm-no').focus();
}
$('import').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async () => {
  const file = $('file').files[0];
  if (!file) return;
  try {
    if (file.size > 5_000_000) throw Error('Choose a backup smaller than 5 MB.');
    const incoming = validate(JSON.parse(await file.text()));
    askReplace(`Replace everything in this browser with this backup (${plural(incoming.lists.length, 'list')})?`, incoming);
  } catch (error) {
    settingsStatus(error instanceof SyntaxError ? 'That file is not a Quiet List backup.' : error.message);
  } finally { $('file').value = ''; }
});
$('reset').addEventListener('click', () => askReplace('Replace everything in this browser with the sample lists?', sample()));
$('settings-confirm-no').addEventListener('click', () => { pendingReplace = null; $('settings-confirm').hidden = true; });
$('settings-confirm-yes').addEventListener('click', () => {
  if (!pendingReplace) return;
  const incoming = pendingReplace;
  pendingReplace = null;
  mutate(() => { state = incoming; activeId = state.lists[0].id; }, { toast: 'Lists replaced', undo: true });
  settingsDialog.close();
  savePrefs();
  render({ flip: false });
});

/* ---------- toast + keyboard ---------- */
$('toast-undo').addEventListener('click', undo);
document.addEventListener('keydown', event => {
  if (document.querySelector('dialog[open]')) return;
  const typing = event.target.matches?.('input:not([type="checkbox"]), textarea');
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
    if (undoSnapshot && !(typing && event.target.value)) { event.preventDefault(); undo(); }
    return;
  }
  if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'n' || event.key === '/') {
    event.preventDefault();
    if (view !== 'list') openList(activeId);
    focusCapture();
  } else if (event.key === '[') stepList(-1);
  else if (event.key === ']') stepList(1);
});

/* ---------- start ---------- */
store.watch(incoming => {
  if (editingId) return;                       // do not pull the rug from under an open edit
  state = incoming;
  if (!state.lists.some(l => l.id === activeId)) activeId = state.lists[0].id;
  render({ flip: false });
});
addEventListener('hashchange', route);
wide.addEventListener('change', applyView);

applyView();
render({ flip: false });
if (location.hash) route(); else setHash('list-' + activeId, true);
if (loaded.problem) showToast('Saved lists could not be read. Showing samples; the old data was set aside, not erased.');
