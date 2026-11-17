import { COLORS, STORAGE_KEY, applyOp, validate, sample } from './model.js';
import { createLocalStore, safeStorage } from './store.js';
import { createAccountSync, api } from './sync.js';
import { createSound } from './sound.js';

const $ = id => document.getElementById(id);
// Stored colour keys are unchanged; each now shows as a gemstone.
const HUES = { lavender: 292, sage: 158, peach: 62, sky: 258, rose: 12, teal: 200 };
const GEMS = { lavender: 'Amethyst', sage: 'Emerald', peach: 'Amber', sky: 'Sapphire', rose: 'Ruby', teal: 'Lagoon' };
const hueOf = list => HUES[list.color] ?? HUES.lavender;
const UI_KEY = 'quiet-list-ui';
const SVG = 'http://www.w3.org/2000/svg';

const storage = safeStorage();
const store = createLocalStore(storage);
const calm = matchMedia('(prefers-reduced-motion: reduce)');
const wide = matchMedia('(min-width: 900px)');

const loaded = store.load();
let state = loaded.state;
// Account mode: lists come from the server (with an on-device copy). Local mode: this browser only.
let account = null;            // { username } while signed in
let server = null;             // { signupOpen, mcpUrl } once a server has answered
const sync = createAccountSync({ storage, onChange: adoptRemote, onStatus: renderSyncLine });
const resumed = sync.resume();
if (resumed) { account = { username: resumed }; state = sync.current(); }
let prefs = {};
try { prefs = JSON.parse(storage.getItem(UI_KEY)) || {}; } catch { prefs = {}; }
// Per-device preferences: sound is on unless switched off; dark is the default look.
const sound = createSound({ enabled: prefs.sound !== false });
const phoneIsLight = matchMedia('(prefers-color-scheme: light)');
function applyTheme() {
  const choice = ['dark', 'light', 'auto'].includes(prefs.theme) ? prefs.theme : 'dark';
  document.documentElement.dataset.theme = choice === 'auto' ? (phoneIsLight.matches ? 'light' : 'dark') : choice;
}
applyTheme();
// Sheets size themselves to the part of the screen that is actually visible (the keyboard shrinks it).
function syncViewport() {
  const view = window.visualViewport;
  document.documentElement.style.setProperty('--vv-h', `${view ? view.height : innerHeight}px`);
  document.documentElement.style.setProperty('--vv-top', `${view ? view.offsetTop : 0}px`);
}
syncViewport();
addEventListener('resize', syncViewport);
window.visualViewport?.addEventListener('resize', syncViewport);
window.visualViewport?.addEventListener('scroll', syncViewport);

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
function countText(list) {
  const open = list.tasks.filter(t => !t.done).length, done = list.tasks.length - open;
  return summary(list) + (done && open ? ` · ${done} done` : '');
}
function emptyWords(list) {
  return list.tasks.length
    ? ['All clear', 'Everything on this list is done.']
    : ['Nothing here yet', 'Type a thought above. On a phone you can also pull the list down.'];
}
function summary(list) {
  const open = list.tasks.filter(t => !t.done).length;
  if (open) return `${open} open`;
  return list.tasks.length ? 'All clear' : 'Empty';
}
function savePrefs() {
  try { storage.setItem(UI_KEY, JSON.stringify({ ...prefs, activeId, doneOpen })); } catch { /* preference only */ }
}

/* ---------- saving, undo, toast ---------- */
function snapshot() { return { state: structuredClone(state), activeId, mark: account ? sync.mark() : 0 }; }

// Applies one or more changes, saves them, and optionally offers Undo.
// Returns false if the model refused; with { throws: true } the refusal is thrown instead.
function act(ops, { toast: message, undo: offerUndo = false, throws = false } = {}) {
  ops = [].concat(ops);
  const before = offerUndo ? snapshot() : null;
  const applied = [];
  let failure = null;
  for (const op of ops) {
    try { applyOp(state, op); applied.push(op); } catch (error) { failure = error; break; }
  }
  let saved = true;
  if (applied.length) { if (account) sync.record(applied); else saved = store.save(state); }
  if (failure) { if (throws) throw failure; announce(failure.message); return false; }
  if (!saved) showToast('Could not save in this browser. Download a backup before closing.');
  else if (message) showToast(message, before);
  return true;
}
function showToast(message, before = null) {
  $('toast-text').textContent = message;
  $('toast-undo').hidden = !before;
  undoSnapshot = before;
  sync.hold(!!before);
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
  sync.hold(false);
  // Keep keyboard focus in the app without popping a phone keyboard open.
  if (hadFocus) (view === 'list' ? $('title') : $('new-list')).focus({ preventScroll: true });
}
function undo() {
  if (!undoSnapshot) return;
  const wanted = undoSnapshot.activeId;
  let saved = true;
  if (account) { sync.rewind(undoSnapshot.mark); state = sync.current(); }
  else { state = undoSnapshot.state; saved = store.save(state); }
  activeId = state.lists.some(l => l.id === wanted) ? wanted : state.lists[0].id;
  editingId = null;
  hideToast();
  sound.play('undo');
  if (!saved) showToast('Could not save in this browser. Download a backup before closing.');
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
  $('count').textContent = countText(list);
  document.title = `${list.name} · Quiet List`;
  document.documentElement.style.setProperty('--h', hueOf(list));
  paintBrowserChrome();

  openEl.replaceChildren(...openTasks.map((t, i) => rowEl(t, i, openTasks)));
  openEl.hidden = !openTasks.length;
  doneEl.replaceChildren(...doneTasks.map(t => rowEl(t)));

  $('empty').hidden = openTasks.length > 0;
  [$('empty-title').textContent, $('empty-text').textContent] = emptyWords(list);

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
    const li = el('li', 'tile-row hue');
    li.dataset.id = list.id;
    li.style.setProperty('--h', hueOf(list));
    if (list.id === activeId) li.setAttribute('aria-current', 'true');
    const left = el('span', 'reveal left'); left.append(icon('i-plus'));
    const right = el('span', 'reveal right'); right.append(icon('i-trash'));
    const tile = el('div', 'tile');
    const open = el('button', 'tile-open'); open.type = 'button'; open.dataset.fk = 'l:' + list.id;
    open.append(el('span', 'tile-name', list.name), el('span', 'tile-count', summary(list)));
    const handle = el('button', 'handle'); handle.type = 'button'; handle.dataset.fk = 'lh:' + list.id;
    handle.setAttribute('aria-label', `Reorder list: ${list.name}. Use the up and down arrow keys.`);
    handle.append(icon('i-grip'));
    tile.append(open, handle);
    li.append(left, right, tile);
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

// Tints the phone's status bar / browser toolbar to match the open list.
const themeMeta = document.querySelector('meta[name="theme-color"]');
const paint = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
function paintBrowserChrome() {
  if (!themeMeta || !paint) return;
  try {
    paint.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    paint.fillRect(0, 0, 1, 1);
    const [r, g, b] = paint.getImageData(0, 0, 1, 1).data;
    themeMeta.content = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  } catch { /* cosmetic only */ }
}
phoneIsLight.addEventListener('change', () => { applyTheme(); paintBrowserChrome(); });

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
function openList(listId, { replace = false, focus = false } = {}) {
  if (!state.lists.some(l => l.id === listId)) return;
  const changed = listId !== activeId;
  activeId = listId;
  view = 'list';
  editingId = null;
  savePrefs();
  applyView();
  render({ flip: false });
  if (changed) scroller.scrollTop = 0;
  setHash('list-' + listId, replace);
  if (focus) $('title').focus({ preventScroll: true });
}
function stepList(direction) {
  const next = state.lists[state.lists.findIndex(l => l.id === activeId) + direction];
  if (!next || navBusy) return false;
  slideToList(next, direction);
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
  if (!task || !act({ type: 'update_item', listId: list.id, itemId: taskId, done })) { render(); return; }
  announce((done ? 'Done: ' : 'Reopened: ') + task.text);
  const cleared = done && !list.tasks.some(t => !t.done);
  sound.play(cleared ? 'clear' : done ? 'done' : 'undone');
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
  if (!act({ type: 'delete_item', listId: list.id, itemId: taskId }, { toast: 'Deleted', undo: true })) return;
  sound.play('delete');
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
  if (!act({ type: 'move_item', listId: list.id, itemId: taskId, beforeId })) return;
  sound.play('tick');
  render({ focus: focusKey });
  announce(`Moved to ${to + 1} of ${open.length}.`);
}
function shiftList(listId, direction) {
  const from = state.lists.findIndex(l => l.id === listId);
  const to = from + direction;
  if (to < 0 || to >= state.lists.length) return;
  const beforeId = direction < 0 ? state.lists[to].id : state.lists[to + 1]?.id ?? null;
  if (!act({ type: 'move_list', listId, beforeId })) return;
  sound.play('tick');
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
  if (text !== task.text) act({ type: 'update_item', listId: list.id, itemId: task.id, text });
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
  buzz(8); sound.play('lift');

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
    sound.play('drop');
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

function watchItems(container, { scrollBox, itemSelector, onDrop, swipe, cardSelector = '.card', fling = true }) {
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
    const card = li.querySelector(cardSelector);
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
      if (now !== armed) { armed = now; li.toggleAttribute('data-armed', armed); if (armed) { buzz(6); sound.play('tick'); } }
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
      if (!fling) { settle(); swipe(li, action); return; }     // the item stays; the action opens something
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
  onDrop: (taskId, beforeId) => { act({ type: 'move_item', listId: current().id, itemId: taskId, beforeId }); render(); },
  swipe: (li, action) => {
    const taskId = li.dataset.id;
    if (action === 'delete') removeTask(taskId, li);
    else setDone(taskId, !('done' in li.dataset), li, { swiped: true });
  },
});
watchItems(listsEl, {
  scrollBox: $('home-scroll'),
  itemSelector: '.tile-row',
  cardSelector: '.tile',
  fling: false,
  onDrop: (listId, beforeId) => { act({ type: 'move_list', listId, beforeId }); render(); },
  // Right: add to this list without opening it. Left: delete the whole list, after asking.
  swipe: (li, action) => { if (action === 'delete') askDeleteList(li.dataset.id); else openQuickAdd(li.dataset.id); },
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
    if (armed) { buzz(6); sound.play('tick'); }
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
  if (armed) { sound.play('pop'); focusCapture(); }
};
scroller.addEventListener('touchend', endPull);
scroller.addEventListener('touchcancel', endPull);

/* ---------- touch: swipe sideways between lists ----------
   How this stays out of the way of the other gestures:
   - a touch that starts on a task belongs to that task (done / delete / hold-to-drag), never to this;
   - each touch commits to one axis in its first 10px, so a vertical drag can only scroll or pull-to-add;
   - touches that start within 24px of the screen edge are left to the phone's own back gesture. */
let navBusy = false;

// A stand-in for the neighbouring list, in its own colour, that travels in beside the open one.
function ghostPane(list) {
  const pane = el('section', 'pane ghost hue nav-drag');
  pane.style.setProperty('--h', hueOf(list));
  pane.setAttribute('aria-hidden', 'true');
  pane.inert = true;
  const open = list.tasks.filter(t => !t.done), doneCount = list.tasks.length - open.length;
  const bar = el('header', 'bar');
  const back = el('span', 'icon-btn'); back.append(icon('i-back'));
  const titles = el('div', 'bar-title'); titles.append(el('div', 'title', list.name), el('p', 'count', countText(list)));
  const more = el('span', 'icon-btn'); more.append(icon('i-more'));
  bar.append(back, titles, more);
  const dots = el('nav', 'pager');
  if (state.lists.length > 1 && state.lists.length <= 8) {
    for (const other of state.lists) { const dot = el('span'); if (other.id === list.id) dot.setAttribute('aria-current', 'true'); dots.append(dot); }
  }
  const scroll = el('div', 'scroll');
  const capture = el('div', 'capture'); const plus = icon('i-plus'); plus.classList.add('capture-plus');
  capture.append(plus, el('span', 'mock', 'Add a thought'));
  const rows = el('ol', 'rows'); rows.append(...open.slice(0, 14).map((task, i) => rowEl(task, i, open)));
  scroll.append(capture, rows);
  if (!open.length) {
    const [title, text] = emptyWords(list);
    const empty = el('div', 'empty'); const art = el('div', 'empty-art'); art.append(icon('i-mark'));
    empty.append(art, el('h2', '', title), el('p', '', text));
    scroll.append(empty);
  }
  if (doneCount) { const head = el('div', 'done-head'); head.append(el('span', 'done-mock', `${doneCount} done`)); scroll.append(head); }
  pane.append(bar, dots, scroll);
  return pane;
}
function landOnList(target, direction, ghost) {
  openList(target.id, { replace: true });
  listPane.classList.remove('nav-settle');
  listPane.classList.add('nav-drag');
  listPane.style.transform = '';
  void listPane.offsetWidth;
  requestAnimationFrame(() => { listPane.classList.remove('nav-drag'); ghost?.remove(); navBusy = false; if (gesture === 'nav') gesture = null; });
  announce(target.name);
}
// Finishes a switch: both panes glide the rest of the way, then the real list takes over.
function settleNav(target, direction, ghost) {
  navBusy = true;
  gesture = 'nav';
  sound.play('nav', { index: state.lists.indexOf(target), direction });
  buzz(6);
  if (calm.matches || !ghost) { landOnList(target, direction, ghost); return; }
  const width = listPane.offsetWidth;
  for (const pane of [listPane, ghost]) { pane.classList.remove('nav-drag'); pane.classList.add('nav-settle'); }
  void listPane.offsetWidth;
  listPane.style.transform = `translateX(${-direction * width}px)`;
  ghost.style.transform = 'translateX(0px)';
  setTimeout(() => landOnList(target, direction, ghost), 350);
}
function cancelNav(direction, ghost) {
  const width = listPane.offsetWidth;
  for (const pane of [listPane, ghost]) { pane?.classList.remove('nav-drag'); pane?.classList.add('nav-settle'); }
  void listPane.offsetWidth;
  listPane.style.transform = '';
  if (ghost) ghost.style.transform = `translateX(${direction * width}px)`;
  setTimeout(() => { ghost?.remove(); listPane.classList.remove('nav-settle'); if (gesture === 'nav') gesture = null; }, calm.matches ? 0 : 350);
}
// Used by the dots, the [ and ] keys, and anything else that is not a drag.
function slideToList(target, direction) {
  if (navBusy || target.id === activeId) return;
  if (wide.matches || calm.matches || view !== 'list') {
    sound.play('nav', { index: state.lists.indexOf(target), direction });
    openList(target.id, { replace: true });
    announce(target.name);
    return;
  }
  const ghost = ghostPane(target);
  ghost.style.transform = `translateX(${direction * listPane.offsetWidth}px)`;
  app.append(ghost);
  listPane.classList.add('nav-drag');
  void ghost.offsetWidth;
  settleNav(target, direction, ghost);
}

listPane.addEventListener('pointerdown', event => {
  if (event.button || event.pointerType === 'mouse' || wide.matches || view !== 'list' || gesture || navBusy) return;
  if (event.target.closest('.row')) return;                                   // tasks keep their own swipes
  if (event.target === document.activeElement && event.target.matches('input, textarea')) return;   // moving the text cursor
  const x0 = event.clientX, y0 = event.clientY, width = listPane.offsetWidth;
  if (x0 < 24 || x0 > width - 24) return;                                     // the phone's own edge gestures
  let mode = null, dx = 0, ghost = null, ghostDirection = 0, lastX = x0, lastTime = event.timeStamp, speed = 0;
  const neighbour = direction => state.lists[state.lists.findIndex(l => l.id === activeId) + direction];
  const detach = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
  const move = ev => {
    if (ev.pointerId !== event.pointerId) return;
    dx = ev.clientX - x0;
    const dy = ev.clientY - y0;
    if (!mode) {
      if (Math.hypot(dx, dy) < 10) return;
      if (gesture || Math.abs(dx) < Math.abs(dy) * 1.4) { detach(); return; }   // vertical: scrolling or pull-to-add owns it
      mode = 'nav'; gesture = 'nav';
      listPane.classList.add('nav-drag');
    }
    ev.preventDefault();
    if (ev.timeStamp > lastTime) { speed = (ev.clientX - lastX) / (ev.timeStamp - lastTime); lastX = ev.clientX; lastTime = ev.timeStamp; }
    const direction = dx < 0 ? 1 : -1;
    const target = neighbour(direction);
    if (direction !== ghostDirection) {
      ghost?.remove();
      ghost = target ? ghostPane(target) : null;
      if (ghost) app.append(ghost);
      ghostDirection = direction;
    }
    const shown = target ? dx : dx * 0.2;                                     // nothing that way: resist
    listPane.style.transform = `translateX(${shown}px)`;
    if (ghost) ghost.style.transform = `translateX(${shown + direction * width}px)`;
  };
  const up = ev => {
    if (ev.pointerId !== event.pointerId) return;
    detach();
    if (mode !== 'nav') return;
    suppressClick(listPane);
    const direction = dx < 0 ? 1 : -1;
    const target = neighbour(direction);
    const flicked = Math.abs(speed) > 0.45 && Math.sign(speed) === Math.sign(dx);
    if (ev.type === 'pointerup' && target && (Math.abs(dx) > width * 0.3 || flicked)) settleNav(target, direction, ghost);
    else cancelNav(direction, ghost);
  };
  addEventListener('pointermove', move, { passive: false });
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
});

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
  const id = crypto.randomUUID();
  if (!act({ type: 'add_item', listId: list.id, id, text: thought.value, top: true })) return;
  const task = list.tasks.find(t => t.id === id);
  enteringId = id;
  thought.value = '';
  syncCapture();
  render();
  scroller.scrollTop = 0;
  thought.focus({ preventScroll: true });
  buzz(8); sound.play('add');
  announce('Added: ' + task.text);
});
// Pasting several lines drops each one in as its own thought.
thought.addEventListener('paste', event => {
  const lines = (event.clipboardData?.getData('text') ?? '').split(/\r?\n/)
    .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()).filter(Boolean).slice(0, 100);
  if (lines.length < 2) return;
  event.preventDefault();
  const list = current();
  const ops = [...lines].reverse().map(line => ({ type: 'add_item', listId: list.id, id: crypto.randomUUID(), text: line.slice(0, 2000), top: true }));
  const ok = act(ops, { toast: `Added ${plural(lines.length, 'thought')}`, undo: true });
  if (ok) { sound.play('add'); render(); }
});
thought.addEventListener('keydown', event => { if (event.key === 'Escape') thought.blur(); });
$('fab').addEventListener('click', () => { sound.play('pop'); focusCapture(); });

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

$('done-toggle').addEventListener('click', () => { doneOpen = !doneOpen; sound.play('tick'); savePrefs(); render({ flip: false }); });
$('clear-done').addEventListener('click', () => {
  const list = current();
  const count = list.tasks.filter(t => t.done).length;
  if (act({ type: 'clear_done', listId: list.id }, { toast: `Cleared ${count} done`, undo: true })) { sound.play('delete'); render(); thought.focus({ preventScroll: true }); }
});
$('back').addEventListener('click', () => { sound.play('back'); showHome(); });
$('pager').addEventListener('click', event => {
  const dot = event.target.closest('button');
  if (!dot || dot.dataset.id === activeId) return;
  const from = state.lists.findIndex(l => l.id === activeId), to = state.lists.findIndex(l => l.id === dot.dataset.id);
  slideToList(state.lists[to], Math.sign(to - from));
});

/* ---------- home events ---------- */
listsEl.addEventListener('click', event => {
  const open = event.target.closest('.tile-open');
  if (open) { sound.play('open'); openList(open.closest('.tile-row').dataset.id, { focus: !wide.matches }); }
});
listsEl.addEventListener('keydown', event => {
  const row = event.target.closest('.tile-row');
  if (!row) return;
  const arrow = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
  if (event.target.closest('.handle') && arrow) { event.preventDefault(); shiftList(row.dataset.id, arrow); }
  // Keyboard equivalents of the two swipes.
  else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); askDeleteList(row.dataset.id); }
  else if (event.key === '+' || event.key === '=') { event.preventDefault(); openQuickAdd(row.dataset.id); }
});

/* ---------- sheets ---------- */
function openSheet(dialog) {
  if (dialog.open) return;
  syncViewport();
  dialog.showModal();
  sound.play('pop');
}
// Tapping the dimmed area outside a sheet closes it, like pressing Escape.
for (const dialog of document.querySelectorAll('dialog.sheet')) {
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
}

/* ---------- deleting a whole list (swipe left on the Lists screen, or Delete on the keyboard) ---------- */
const confirmDialog = $('confirm-dialog');
let pendingDeleteId = null;
function askDeleteList(listId) {
  const list = state.lists.find(l => l.id === listId);
  if (!list) return;
  if (state.lists.length === 1) {
    sound.play('nope');
    showToast('This is your only list, so it stays. Make another one first.');
    return;
  }
  const open = list.tasks.filter(t => !t.done).length, done = list.tasks.length - open;
  pendingDeleteId = listId;
  $('confirm-title').textContent = `Delete “${list.name}”?`;
  $('confirm-text').textContent = list.tasks.length
    ? `This deletes the list and the ${plural(list.tasks.length, 'task')} in it (${open} open, ${done} done). Your other lists are not affected. You can undo for a few seconds afterwards.`
    : 'This list is empty. Your other lists are not affected.';
  openSheet(confirmDialog);
  $('confirm-no').focus();
}
function deleteListNow(listId) {
  const list = state.lists.find(l => l.id === listId);
  if (!list) return false;
  const index = state.lists.indexOf(list);
  if (!act({ type: 'delete_list', listId }, { toast: `Deleted “${list.name}”`, undo: true })) return false;
  sound.play('delete');
  if (activeId === listId) {
    activeId = state.lists[Math.min(index, state.lists.length - 1)].id;
    savePrefs();
    if (view === 'list') { if (wide.matches) openList(activeId, { replace: true }); else showHome(); }
  }
  render();
  return true;
}
$('confirm-no').addEventListener('click', () => confirmDialog.close());
$('confirm-yes').addEventListener('click', () => { confirmDialog.close(); if (pendingDeleteId) deleteListNow(pendingDeleteId); });
confirmDialog.addEventListener('close', () => { pendingDeleteId = null; });

/* ---------- quick add (swipe right on the Lists screen, or + on the keyboard) ---------- */
const quickDialog = $('quick-dialog');
let quickListId = null, quickCount = 0;
function openQuickAdd(listId) {
  const list = state.lists.find(l => l.id === listId);
  if (!list) return;
  quickListId = listId; quickCount = 0;
  quickDialog.style.setProperty('--h', hueOf(list));
  $('quick-title').textContent = `Add to ${list.name}`;
  $('quick-text').value = '';
  $('quick-status').textContent = 'Press Enter to add, and keep going.';
  openSheet(quickDialog);
  $('quick-text').focus();
}
$('quick-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = $('quick-text');
  if (!input.value.trim() || !state.lists.some(l => l.id === quickListId)) { input.focus(); return; }
  try {
    act({ type: 'add_item', listId: quickListId, id: crypto.randomUUID(), text: input.value, top: true }, { throws: true });
    quickCount += 1;
    input.value = '';
    $('quick-status').textContent = `Added ${plural(quickCount, 'thought')}. Keep going, or tap Done.`;
    sound.play('add'); buzz(8);
    render({ flip: false, focus: 'none' });
  } catch (error) { $('quick-status').textContent = error.message; sound.play('nope'); }
  input.focus();
});
$('quick-done').addEventListener('click', () => quickDialog.close());
$('quick-close-x').addEventListener('click', () => quickDialog.close());

/* ---------- list dialog (new, rename, recolour, delete) ---------- */
const listDialog = $('list-dialog');
let listDialogMode = 'new';
$('swatches').replaceChildren(...COLORS.map(color => {
  const label = el('label', 'swatch hue');
  label.style.setProperty('--h', HUES[color]);
  const radio = el('input'); radio.type = 'radio'; radio.name = 'color'; radio.value = color; radio.id = 'color-' + color;
  radio.setAttribute('aria-label', GEMS[color]);
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
  openSheet(listDialog);
  $('list-name').focus();
  if (mode !== 'new') $('list-name').select();
}
$('new-list').addEventListener('click', () => openListDialog('new'));
$('list-more').addEventListener('click', () => openListDialog('edit'));
$('list-cancel').addEventListener('click', () => listDialog.close());
$('list-cancel-x').addEventListener('click', () => listDialog.close());
$('list-form').addEventListener('submit', event => {
  event.preventDefault();
  const name = $('list-name').value;
  const color = listDialog.querySelector('input[name="color"]:checked')?.value ?? COLORS[0];
  try {
    if (listDialogMode === 'new') {
      const id = crypto.randomUUID();
      act({ type: 'add_list', id, name, color }, { throws: true });
      listDialog.close();
      sound.play('add');
      openList(id, { focus: true });
      focusCapture();
    } else {
      act({ type: 'update_list', listId: activeId, name, color }, { throws: true });
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
  $('list-confirm-text').textContent = list.tasks.length
    ? `Delete “${list.name}” and the ${plural(list.tasks.length, 'task')} in it? You can undo for a few seconds afterwards.`
    : `Delete “${list.name}”? It is empty.`;
  $('list-confirm').hidden = false;
  $('list-confirm-no').focus();
  $('list-confirm').scrollIntoView({ block: 'nearest' });
});
$('list-confirm-no').addEventListener('click', () => { $('list-confirm').hidden = true; $('list-delete').focus(); });
$('list-confirm-yes').addEventListener('click', () => { listDialog.close(); deleteListNow(activeId); });

/* ---------- backup dialog ---------- */
const settingsDialog = $('settings-dialog');
let pendingReplace = null;
const settingsStatus = message => { $('settings-status').textContent = message; };
$('open-settings').addEventListener('click', () => {
  $('settings-confirm').hidden = true;
  $('sound-toggle').setAttribute('aria-checked', String(sound.enabled));
  $('theme-' + (['light', 'auto'].includes(prefs.theme) ? prefs.theme : 'dark')).checked = true;
  renderAccount();
  // Ask the server again each time this screen opens, so a setting changed on the server
  // (such as sign-up being switched on) shows without reloading the app.
  if (!STANDALONE) refreshServerInfo().then(changed => { if (changed && settingsDialog.open) renderAccount(); });
  settingsStatus(storage.volatile ? 'This browser is blocking storage here, so lists will be gone when the page closes.' : '');
  openSheet(settingsDialog);
  $('settings-body').scrollTop = 0;
});
$('settings-close').addEventListener('click', () => settingsDialog.close());
$('settings-close-x').addEventListener('click', () => settingsDialog.close());
$('sound-toggle').addEventListener('click', () => {
  const next = !sound.enabled;
  sound.setEnabled(next);
  prefs.sound = next;
  savePrefs();
  $('sound-toggle').setAttribute('aria-checked', String(next));
  settingsStatus(next ? 'Sound effects are on.' : 'Sound effects are off.');
  if (next) sound.play('done');                 // a taste of what was just switched on
});
$('theme-choice').addEventListener('change', event => {
  prefs.theme = event.target.value;
  savePrefs();
  applyTheme();
  paintBrowserChrome();
});
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
  if (!act({ type: 'replace_all', doc: incoming }, { toast: 'Lists replaced', undo: true })) return;
  activeId = state.lists[0].id;
  settingsDialog.close();
  savePrefs();
  render({ flip: false });
});

/* ---------- account: sign in, sync status, moving local lists, assistants ---------- */
let signingUp = false;
let remoteWaiting = 0;

// The server copy changed (another device, an assistant, or our own change was confirmed).
function adoptRemote() {
  if (!account) return;
  clearTimeout(remoteWaiting);
  if (editingId || gesture || pointerIsDown) { remoteWaiting = setTimeout(adoptRemote, 700); return; }
  state = sync.current();
  if (!state.lists.some(l => l.id === activeId)) activeId = state.lists[0].id;
  render();
}
function renderSyncLine(status = {}) {
  const line = $('sync-line'), action = $('sync-action');
  let text = 'Saved in this browser only.', button = '';
  if (account) {
    const waiting = status.pending ?? sync.pending();
    if (status.signedOut ?? sync.isSignedOut()) { text = 'Signed out. Changes are kept on this device.'; button = 'Sign in again'; }
    else if (status.online === false) text = waiting ? `Offline. ${plural(waiting, 'change')} waiting to sync.` : 'Offline. Showing the last synced lists.';
    else text = waiting ? 'Syncing…' : `Synced to your account (${account.username}).`;
  } else if (server) button = 'Sign in to sync';
  else text = 'Saved in this browser only. No account, no sync.';
  line.textContent = text;
  action.textContent = button;
  action.hidden = !button;
  $('account-sync').textContent = account ? text.replace(/ \(.*\)\.$/, '.') : '';
}
$('sync-action').addEventListener('click', () => $('open-settings').click());

function localListsExist() {
  try { return !!storage.getItem(STORAGE_KEY); } catch { return false; }
}
function renderAccount() {
  $('account-none').hidden = !!server || !!account;
  const needsLogin = !!server && (!account || sync.isSignedOut());
  $('login-form').hidden = !needsLogin;
  $('account-in').hidden = !account || sync.isSignedOut();
  $('signup-toggle').hidden = !server?.signupOpen || !!account;
  $('setup-row').hidden = !signingUp;
  $('login-submit').textContent = signingUp ? 'Create account' : 'Sign in';
  $('signup-toggle').textContent = signingUp ? 'I already have an account' : 'Create an account';
  $('login-password').autocomplete = signingUp ? 'new-password' : 'current-password';
  $('storage-note').textContent = account
    ? 'A backup file holds everything in your account at this moment. Restoring replaces the lists in your account on every device.'
    : 'Your lists live in this browser on this device. Clearing site data removes them, so keep a backup.';
  if (!account) return;
  $('account-name').textContent = account.username;
  $('mcp-url').textContent = server?.mcpUrl ?? '';
  $('migrate-open').hidden = !localListsExist() || !$('migrate').hidden;
  renderSyncLine();
  loadConnections();
}
async function loadConnections() {
  const box = $('connections');
  try {
    const result = await api('GET', '/api/connections');
    if (!result.ok) return;
    const items = result.data.connections.map(connection => {
      const li = el('li');
      const label = el('span', '', connection.name);
      label.append(el('small', '', `${connection.canWrite ? 'Can read, add, edit and complete' : 'Can read only'} · returns to ${connection.site}`));
      const remove = el('button', 'quiet-btn', 'Disconnect'); remove.type = 'button';
      remove.setAttribute('aria-label', `Disconnect ${connection.name}`);
      remove.addEventListener('click', async () => {
        await api('DELETE', '/api/connections/' + encodeURIComponent(connection.id));
        settingsStatus(`${connection.name} was disconnected.`);
        loadConnections();
      });
      li.append(label, remove);
      return li;
    });
    if (!items.length) items.push(el('li', 'note', 'No assistant is connected.'));
    box.replaceChildren(...items);
  } catch { /* offline: leave the list as it was */ }
}

async function enterAccount(username, { offerMove = true } = {}) {
  account = { username };
  editingId = null;
  const ready = await sync.begin(username);
  if (!ready) {                                  // could not load the account copy; stay on local lists
    account = null; sync.stop();
    renderSyncLine();
    return false;
  }
  state = sync.current();
  if (!state.lists.some(l => l.id === activeId)) activeId = state.lists[0].id;
  render({ flip: false });
  renderSyncLine();
  if (offerMove && localListsExist() && !prefs.moveAsked?.includes(username)) offerLocalMove();
  return true;
}
function leaveAccount() {
  sync.stop({ forget: true });                   // removes the account copy from this device; local lists were never touched
  account = null;
  editingId = null;
  state = store.load().state;
  activeId = state.lists[0].id;
  hideToast();
  render({ flip: false });
  renderSyncLine();
}
function offerLocalMove() {
  const local = store.load();
  if (local.problem) return;
  const tasks = local.state.lists.reduce((n, l) => n + l.tasks.length, 0);
  $('migrate-text').textContent = `This browser has ${plural(local.state.lists.length, 'list')} with ${plural(tasks, 'item')} saved from before you signed in. Copy them into your account? They are added beside what is already there, and the originals stay in this browser.`;
  $('migrate').hidden = false;
  $('migrate-open').hidden = true;
  if (!settingsDialog.open) { renderAccount(); openSheet(settingsDialog); }
  $('migrate').scrollIntoView({ block: 'nearest' });
  $('migrate-yes').focus();
}
function rememberMoveAsked() {
  prefs.moveAsked = [...new Set([...(prefs.moveAsked ?? []), account.username])];
  savePrefs();
  $('migrate').hidden = true;
  $('migrate-open').hidden = !localListsExist();
}
$('migrate-open').addEventListener('click', offerLocalMove);
$('migrate-no').addEventListener('click', rememberMoveAsked);
$('migrate-yes').addEventListener('click', () => {
  const local = store.load();
  if (local.problem) { settingsStatus('The lists in this browser could not be read, so nothing was copied.'); return; }
  const copied = act({ type: 'import_lists', lists: local.state.lists });
  rememberMoveAsked();
  if (copied) { render(); settingsStatus('Copied. The originals are still in this browser and return when you sign out.'); }
});

$('signup-toggle').addEventListener('click', () => { signingUp = !signingUp; $('login-error').textContent = ''; renderAccount(); });
$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const error = $('login-error');
  error.textContent = '';
  $('login-submit').disabled = true;
  try {
    const body = { username: $('login-name').value, password: $('login-password').value };
    if (signingUp) body.setupCode = $('login-setup').value;
    const result = await api('POST', signingUp ? '/api/signup' : '/api/login', body);
    if (!result.ok) { error.textContent = result.data?.error ?? 'That did not work. Try again.'; return; }
    if (account && account.username !== result.data.user.username) sync.stop({ forget: true });
    $('login-password').value = ''; $('login-setup').value = '';
    signingUp = false;
    if (!(await enterAccount(result.data.user.username))) { error.textContent = 'Signed in, but your lists could not be loaded. Check the connection and try again.'; return; }
    renderAccount();
    settingsStatus('Signed in. Your lists now sync.');
    sound.play('done');
  } catch {
    error.textContent = 'Could not reach the server. Check the connection and try again.';
  } finally { $('login-submit').disabled = false; }
});
$('logout').addEventListener('click', async () => {
  await sync.flush();
  if (sync.pending()) { settingsStatus(`${plural(sync.pending(), 'change')} have not reached your account yet. Reconnect, then sign out, or they would be lost.`); return; }
  try { await api('POST', '/api/logout'); } catch { /* offline: the device copy is still removed below */ }
  leaveAccount();
  renderAccount();
  settingsStatus('Signed out. This device no longer holds your account lists.');
});
$('copy-mcp').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('mcp-url').textContent); settingsStatus('Connector address copied.'); }
  catch { settingsStatus('Copy was blocked. Select the address and copy it by hand.'); }
});

async function refreshServerInfo() {
  try {
    const result = await api('GET', '/api/session');
    if (!result.ok || !result.data || !('user' in result.data)) return false;
    const changed = !server || server.signupOpen !== !!result.data.signupOpen || server.mcpUrl !== result.data.mcpUrl;
    server = { signupOpen: !!result.data.signupOpen, mcpUrl: result.data.mcpUrl };
    return changed;
  } catch { return false; }
}

// Ask the server who we are. A copy without a server (a plain file host, the preview) stays local.
async function checkSession() {
  try {
    const result = await api('GET', '/api/session');
    if (!result.ok || !result.data || !('user' in result.data)) return;
    server = { signupOpen: !!result.data.signupOpen, mcpUrl: result.data.mcpUrl };
    const user = result.data.user;
    if (user && account?.username === user.username) sync.pull();          // already running from the device copy
    else if (user) { if (account) sync.stop({ forget: true }); await enterAccount(user.username); }
    else if (account) sync.markSignedOut();      // keep showing the device copy; ask to sign in again
  } catch {
    if (account) renderSyncLine({ online: false });
  }
  renderSyncLine();
}

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
  if (account || editingId) return;            // local mode only; do not pull the rug from under an open edit
  state = incoming;
  if (!state.lists.some(l => l.id === activeId)) activeId = state.lists[0].id;
  render({ flip: false });
});
addEventListener('hashchange', route);
wide.addEventListener('change', applyView);

applyView();
render({ flip: false });
renderSyncLine();
const STANDALONE = false;      // the single-file preview build flips this: no server, no offline shell
if (account) sync.begin(account.username);   // start from the device copy at once, even with no connection
if (!STANDALONE) checkSession();
if (!STANDALONE && 'serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline shell is optional */ });
}
if (location.hash) route(); else setHash('list-' + activeId, true);
if (loaded.problem) showToast('Saved lists could not be read. Showing samples; the old data was set aside, not erased.');
