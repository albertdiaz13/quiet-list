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
const isRev = n => Number.isInteger(n) && n >= 1;

const newList = (name, color) => ({ id: id(), name, color, rev: 1, tasks: [] });

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
  data.version = SCHEMA_VERSION;
  return data;
}

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

export function createList(state, name, color = COLORS[0]) {
  name = cleanName(name);
  if (state.lists.length >= LIMITS.lists) throw Error(`This prototype supports ${LIMITS.lists} lists.`);
  const list = newList(name, COLORS.includes(color) ? color : COLORS[0]);
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

export function addTask(list, text, { top = false } = {}) {
  text = cleanText(text);
  if (list.tasks.length >= LIMITS.tasks) throw Error('This list is full.');
  const task = { id: id(), text, done: false, rev: 1 };
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
