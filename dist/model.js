// Quiet List data model. Pure functions over a plain JSON document: no DOM, no storage.
//
// Every exported mutation is shaped like one call a future owner-scoped API / MCP tool
// would make (add_item, update_item, move_item, …). Ids are client-generated UUIDs so
// retries are idempotent, ordering is expressed relative to a neighbour ("before X")
// rather than by index, and every record carries a `rev` counter for optimistic
// concurrency. Nothing here stores or shows a date.

export const STORAGE_KEY = 'quiet-list-v1'; // storage slot name; schema version lives in the document
export const SCHEMA_VERSION = 2;
export const COLORS = ['lavender', 'sage', 'peach', 'sky', 'rose', 'teal'];
export const LIMITS = { lists: 100, tasks: 10000, name: 80, text: 2000 };

const id = () => crypto.randomUUID();
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// Callers may supply their own id (a UUID made on the device) so a retried request cannot duplicate.
function freshId(state, given) {
  if (given == null) return id();
  if (typeof given !== 'string' || !ID_PATTERN.test(given)) throw Error('Invalid id.');
  if (hasId(state, given)) throw Error('That id is already in use.');
  return given;
}
export function hasId(state, anyId) {
  return state.lists.some(l => l.id === anyId || l.tasks.some(t => t.id === anyId));
}
const isRev = n => Number.isInteger(n) && n >= 1;

const newList = (name, color, listId = id()) => ({ id: listId, name, color, rev: 1, tasks: [] });

export function initial() {
  return {
    version: SCHEMA_VERSION,
    lists: [
      newList('Everything on my mind', 'lavender'),
      newList('Home & me', 'sage'),
      newList('Ideas for later', 'peach'),
    ],
  };
}

// What a brand-new account starts with: one empty list.
export function starter() {
  return { version: SCHEMA_VERSION, lists: [newList('Brain dump', 'lavender')] };
}

// Invented demo content. Nothing here describes a real person.
export function sample() {
  const state = { version: SCHEMA_VERSION, lists: [] };
  const fill = (name, color, open, done = []) => {
    const list = createList(state, name, color);
    for (const text of open) addTask(list, text);
    for (const text of done) addTask(list, text).done = true;
  };
  fill('Brain dump', 'lavender', [
    'Find the charger for the old camera',
    'Label the spice jars',
    'Ask about a bike tune-up',
    'Return the library books',
    'Look up how sourdough starters work',
  ], ['Water the fern']);
  fill('Weekend', 'peach', [
    'Tomatoes from the market',
    'Fix the squeaky door hinge',
    'Pick a trail for Sunday',
  ]);
  fill('Someday', 'teal', [
    'Learn three chords on the ukulele',
    'Try the noodle place by the station',
    'Build a birdhouse',
  ]);
  fill('Gift ideas', 'rose', []);
  return state;
}

// Validates a stored or imported document and upgrades version 1 in place.
// Returns the same object so callers can keep their reference.
export function validate(data) {
  if (!data || (data.version !== 1 && data.version !== SCHEMA_VERSION) || !Array.isArray(data.lists)
    || !data.lists.length || data.lists.length > LIMITS.lists) {
    throw Error('This is not a supported Quiet List backup.');
  }
  const ids = new Set();
  for (const list of data.lists) {
    if (!list || typeof list.id !== 'string' || !list.id || ids.has(list.id) || typeof list.name !== 'string'
      || !list.name.trim() || list.name.length > LIMITS.name || !Array.isArray(list.tasks)
      || list.tasks.length > LIMITS.tasks) {
      throw Error('Invalid list in backup.');
    }
    ids.add(list.id);
    if (!COLORS.includes(list.color)) list.color = COLORS[0];
    if (!isRev(list.rev)) list.rev = 1;
    for (const task of list.tasks) {
      if (!task || typeof task.id !== 'string' || !task.id || ids.has(task.id) || typeof task.text !== 'string'
        || !task.text.trim() || task.text.length > LIMITS.text || typeof task.done !== 'boolean') {
        throw Error('Invalid task in backup.');
      }
      ids.add(task.id);
      if (!isRev(task.rev)) task.rev = 1;
    }
  }
  // Optional extras. Anything malformed in them is dropped rather than refusing the whole document.
  for (const list of data.lists) if ('fresh' in list && list.fresh !== false) delete list.fresh;
  if ('trash' in data) data.trash = cleanTrash(data.trash);
  if ('stats' in data) data.stats = { cleared: clearedOf(data) };
  data.version = SCHEMA_VERSION;
  return data;
}

// ---- recently deleted, and the tally of cleared lists ----
// Deleted tasks and lists wait here for TRASH_DAYS before they are dropped for good. The day number
// is housekeeping only; it is never shown, and lists and tasks themselves still carry no dates.
export const TRASH_DAYS = 30;
export const TRASH_MAX = 200;
const DAY = 86400000;
const okText = (value, max) => typeof value === 'string' && !!value.trim() && value.length <= max;
const okTask = task => !!task && typeof task.id === 'string' && !!task.id && okText(task.text, LIMITS.text) && typeof task.done === 'boolean';
function cleanTrash(trash) {
  if (!Array.isArray(trash)) return [];
  const seen = new Set();
  return trash.filter(entry => {
    if (!entry || typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id) || seen.has(entry.id) || !Number.isInteger(entry.at)) return false;
    seen.add(entry.id);
    if (entry.kind === 'task') return typeof entry.listId === 'string' && okText(entry.listName, LIMITS.name) && okTask(entry.task);
    if (entry.kind === 'list') {
      const list = entry.list;
      return !!list && typeof list.id === 'string' && !!list.id && okText(list.name, LIMITS.name) && Array.isArray(list.tasks)
        && list.tasks.length <= LIMITS.tasks && list.tasks.every(okTask);
    }
    return false;
  }).slice(0, TRASH_MAX);
}
export const trashOf = state => (Array.isArray(state.trash) ? state.trash : []);
export const clearedOf = state => {
  const n = state.stats?.cleared;
  return Number.isInteger(n) && n >= 0 ? Math.min(n, 1_000_000) : 0;
};
function toTrash(state, entry, now) {
  const today = Math.floor(now / DAY);
  // The entry id comes from the deleted thing's own id, so the device and the server agree on it.
  const record = { ...entry, at: today };
  state.trash = [record, ...trashOf(state).filter(e => e.id !== record.id && today - e.at <= TRASH_DAYS)].slice(0, TRASH_MAX);
}
const plainTask = task => ({ id: task.id, text: task.text, done: task.done });

function cleanName(name) {
  name = String(name ?? '').trim();
  if (!name || name.length > LIMITS.name) throw Error(`Give your list a name, up to ${LIMITS.name} characters.`);
  return name;
}

function cleanText(text) {
  text = String(text ?? '').trim();
  if (!text || text.length > LIMITS.text) throw Error('Write a thought, up to 2,000 characters.');
  return text;
}

function findList(state, listId) {
  const list = state.lists.find(l => l.id === listId);
  if (!list) throw Error('List not found.');
  return list;
}

function findTask(list, taskId) {
  const task = list.tasks.find(t => t.id === taskId);
  if (!task) throw Error('Task not found.');
  return task;
}

// Moves `item` so it sits directly before the record with id `beforeId`, or last when null.
function placeBefore(array, item, beforeId, missing) {
  if (beforeId === item.id) return;
  if (beforeId != null && !array.some(x => x.id === beforeId)) throw Error(missing);
  array.splice(array.indexOf(item), 1);
  const at = beforeId == null ? array.length : array.findIndex(x => x.id === beforeId);
  array.splice(at, 0, item);
}

export function createList(state, name, color = COLORS[0], listId = null) {
  name = cleanName(name);
  if (state.lists.length >= LIMITS.lists) throw Error(`This prototype supports ${LIMITS.lists} lists.`);
  const list = newList(name, COLORS.includes(color) ? color : COLORS[0], freshId(state, listId));
  state.lists.push(list);
  return list;
}

export function updateList(state, listId, patch) {
  const list = findList(state, listId);
  const name = 'name' in patch ? cleanName(patch.name) : list.name;
  if ('color' in patch && !COLORS.includes(patch.color)) throw Error('Pick one of the list colours.');
  list.name = name;
  if ('color' in patch) list.color = patch.color;
  list.rev += 1;
  return list;
}

export function deleteList(state, listId) {
  const list = findList(state, listId);
  if (state.lists.length === 1) throw Error('Keep at least one list.');
  state.lists.splice(state.lists.indexOf(list), 1);
  return list;
}

export function moveList(state, listId, beforeId = null) {
  const list = findList(state, listId);
  placeBefore(state.lists, list, beforeId, 'List not found.');
  return list;
}

export function addTask(list, text, { top = false, id: taskId = null, state = null } = {}) {
  text = cleanText(text);
  if (list.tasks.length >= LIMITS.tasks) throw Error('This list is full.');
  const task = { id: state ? freshId(state, taskId) : id(), text, done: false, rev: 1 };
  if (top) list.tasks.unshift(task); else list.tasks.push(task);
  return task;
}

export function updateTask(list, taskId, patch) {
  const task = findTask(list, taskId);
  const text = 'text' in patch ? cleanText(patch.text) : task.text;
  task.text = text;
  if ('done' in patch) task.done = !!patch.done;
  task.rev += 1;
  return task;
}

export function deleteTask(list, taskId) {
  const task = findTask(list, taskId);
  list.tasks.splice(list.tasks.indexOf(task), 1);
  return task;
}

export function moveTask(list, taskId, beforeId = null) {
  const task = findTask(list, taskId);
  placeBefore(list.tasks, task, beforeId, 'Task not found.');
  return task;
}

export function clearDone(list) {
  const before = list.tasks.length;
  list.tasks = list.tasks.filter(t => !t.done);
  return before - list.tasks.length;
}

// ---- changes as data ----
// One plain object per change. The app applies these locally and queues them for the server;
// the server applies the same objects to the signed-in owner's lists. Unknown fields are ignored,
// unknown types are refused.
const has = (op, key) => Object.prototype.hasOwnProperty.call(op, key);
function patchOf(op, rules) {
  const patch = {};
  for (const [key, type] of Object.entries(rules)) {
    if (!has(op, key)) continue;
    if (typeof op[key] !== type) throw Error('Invalid change.');
    patch[key] = op[key];
  }
  if (!Object.keys(patch).length) throw Error('Nothing to change.');
  return patch;
}

export function applyOp(state, op, now = Date.now()) {
  if (!op || typeof op !== 'object' || typeof op.type !== 'string') throw Error('Invalid change.');
  const list = () => findList(state, op.listId);
  const before = () => (op.beforeId == null ? null : op.beforeId);
  switch (op.type) {
    case 'add_list': {
      if (typeof op.id === 'string' && state.lists.some(l => l.id === op.id)) return state;   // already applied
      const made = createList(state, op.name, op.color, op.id);
      // Optional position. If the neighbour has gone meanwhile, the new list simply stays last.
      if (op.beforeId != null && state.lists.some(l => l.id === op.beforeId)) placeBefore(state.lists, made, op.beforeId, 'List not found.');
      return state;
    }
    case 'update_list': updateList(state, op.listId, patchOf(op, { name: 'string', color: 'string' })); return state;
    case 'delete_list': {
      const gone = deleteList(state, op.listId);
      toTrash(state, { id: `l-${gone.id}`.slice(0, 64), kind: 'list', list: { id: gone.id, name: gone.name, color: gone.color, tasks: gone.tasks.map(plainTask) } }, now);
      return state;
    }
    case 'move_list': moveList(state, op.listId, before()); return state;
    case 'add_item': {
      const target = list();
      if (typeof op.id === 'string' && target.tasks.some(t => t.id === op.id)) return state;  // already applied
      const made = addTask(target, op.text, { top: op.top === true, id: op.id, state });
      if (op.beforeId != null && target.tasks.some(t => t.id === op.beforeId)) placeBefore(target.tasks, made, op.beforeId, 'Task not found.');
      delete target.fresh;                 // something new to finish: clearing this list can earn again
      return state;
    }
    case 'update_item': updateTask(list(), op.itemId, patchOf(op, { text: 'string', done: 'boolean' })); return state;
    case 'delete_item': {
      const from = list();
      const gone = deleteTask(from, op.itemId);
      toTrash(state, { id: `t-${gone.id}`.slice(0, 64), kind: 'task', listId: from.id, listName: from.name, task: plainTask(gone) }, now);
      return state;
    }
    case 'transfer_item': {
      const from = list();
      const to = findList(state, op.toListId);
      if (from === to) return state;
      if (to.tasks.length >= LIMITS.tasks) throw Error('That list is full.');
      const moving = deleteTask(from, op.itemId);
      moving.rev += 1;
      to.tasks.unshift(moving);
      delete to.fresh;
      return state;
    }
    case 'move_item': moveTask(list(), op.itemId, before()); return state;
    case 'clear_done': {
      const from = list();
      for (const task of from.tasks.filter(t => t.done).reverse()) {
        toTrash(state, { id: `t-${task.id}`.slice(0, 64), kind: 'task', listId: from.id, listName: from.name, task: plainTask(task) }, now);
      }
      clearDone(from);
      return state;
    }
    case 'restore_trash': {
      const entry = trashOf(state).find(e => e.id === op.trashId);
      if (!entry) return state;                                                               // already restored or expired
      if (entry.kind === 'task') {
        const home = state.lists.find(l => l.id === entry.listId) ?? state.lists[0];
        if (home.tasks.length >= LIMITS.tasks) throw Error('That list is full.');
        home.tasks.unshift({ id: hasId(state, entry.task.id) ? id() : entry.task.id, text: entry.task.text.trim(), done: entry.task.done, rev: 1 });
        if (!entry.task.done) delete home.fresh;
      } else {
        if (state.lists.length >= LIMITS.lists) throw Error(`This prototype supports ${LIMITS.lists} lists.`);
        const back = newList(entry.list.name.trim(), COLORS.includes(entry.list.color) ? entry.list.color : COLORS[0], hasId(state, entry.list.id) ? id() : entry.list.id);
        state.lists.push(back);
        for (const task of entry.list.tasks) back.tasks.push({ id: hasId(state, task.id) ? id() : task.id, text: task.text.trim(), done: task.done, rev: 1 });
      }
      state.trash = trashOf(state).filter(e => e.id !== entry.id);
      return state;
    }
    case 'empty_trash': state.trash = []; return state;
    // Counts a cleared list, once per "fill": the list must have tasks, all done, and something
    // must have been added since it last counted. Anything else is quietly ignored.
    case 'award_clear': {
      const target = list();
      if (target.fresh === false || !target.tasks.length || target.tasks.some(t => !t.done)) return state;
      state.stats = { cleared: clearedOf(state) + 1 };
      target.fresh = false;
      return state;
    }
    case 'import_lists': {
      // Adds whole lists (used to copy a browser's local lists into an account). Never overwrites.
      const incoming = validate({ version: SCHEMA_VERSION, lists: structuredClone(op.lists) }).lists;
      for (const item of incoming) {
        if (state.lists.length >= LIMITS.lists) throw Error(`This prototype supports ${LIMITS.lists} lists.`);
        if (state.lists.some(l => l.id === item.id)) continue;                                  // already applied
        const copy = newList(item.name.trim(), item.color, hasId(state, item.id) ? id() : item.id);
        state.lists.push(copy);
        for (const task of item.tasks) {
          copy.tasks.push({ id: hasId(state, task.id) ? id() : task.id, text: task.text.trim(), done: task.done, rev: 1 });
        }
      }
      return state;
    }
    case 'replace_all': {
      const doc = validate(structuredClone(op.doc));
      state.version = SCHEMA_VERSION;
      state.lists = doc.lists;
      if ('trash' in doc) state.trash = doc.trash;
      if ('stats' in doc) state.stats = doc.stats;
      return state;
    }
    default: throw Error('Unknown change.');
  }
}
