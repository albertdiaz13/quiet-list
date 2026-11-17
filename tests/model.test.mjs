import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initial, sample, validate, createList, updateList, deleteList, moveList,
  addTask, updateTask, deleteTask, moveTask, clearDone, SCHEMA_VERSION,
} from '../dist/model.js';

const texts = list => list.tasks.map(t => t.text);

// ---- the five tests the prototype shipped with, unchanged in what they assert ----
test('empty spaces and stable schema', () => {
  const s = initial();
  assert.equal(s.lists.length, 3);
  assert.equal(validate(s), s);
  assert.ok(s.lists.every(l => l.tasks.length === 0));
});
test('create, read, edit, complete and reopen task', () => {
  const s = initial();
  const l = createList(s, ' Work ');
  const t = addTask(l, ' Test a tiny idea ');
  assert.equal(t.text, 'Test a tiny idea');
  updateTask(l, t.id, { text: 'Try one thing', done: true });
  assert.equal(t.text, 'Try one thing');
  assert.equal(t.done, true);
  updateTask(l, t.id, { done: false });
  assert.equal(t.done, false);
  assert.deepEqual(validate(JSON.parse(JSON.stringify(s))), s);
});
test('blank and oversized inputs rejected without mutation', () => {
  const s = initial(), l = s.lists[0];
  assert.throws(() => createList(s, ' '));
  assert.throws(() => addTask(l, ' '));
  assert.throws(() => addTask(l, 'a'.repeat(2001)));
  assert.equal(l.tasks.length, 0);
  const t = addTask(l, 'Keep me');
  assert.throws(() => updateTask(l, t.id, { text: '' }));
  assert.equal(t.text, 'Keep me');
});
test('backup validates structure and rejects duplicate IDs', () => {
  assert.throws(() => validate({ version: 1, lists: [] }));
  const s = initial();
  addTask(s.lists[0], 'Hello');
  s.lists.push(structuredClone(s.lists[0]));
  assert.throws(() => validate(s));
});
test('text is retained literally, not interpreted as HTML', () => {
  const s = initial();
  const t = addTask(s.lists[0], '<img src=x onerror=alert(1)>');
  assert.equal(t.text, '<img src=x onerror=alert(1)>');
  assert.equal(validate(s), s);
});

// ---- new behaviour ----
test('version 1 backups upgrade in place', () => {
  const v1 = { version: 1, lists: [{ id: 'a', name: 'Old', color: 'lavender', tasks: [{ id: 'b', text: 'Kept', done: true }] }] };
  const s = validate(v1);
  assert.equal(s.version, SCHEMA_VERSION);
  assert.equal(s.lists[0].rev, 1);
  assert.deepEqual(s.lists[0].tasks[0], { id: 'b', text: 'Kept', done: true, rev: 1 });
});
test('validate rejects malformed records and repairs cosmetic fields', () => {
  const base = () => ({ version: 2, lists: [{ id: 'a', name: 'L', color: 'neon', rev: -3, tasks: [] }] });
  const fixed = validate(base());
  assert.equal(fixed.lists[0].color, 'lavender');
  assert.equal(fixed.lists[0].rev, 1);
  for (const bad of [null, 'x', { version: 3, lists: [] }, { version: 2, lists: [null] },
    { version: 2, lists: [{ id: '', name: 'L', tasks: [] }] },
    { version: 2, lists: [{ id: 'a', name: 'L', tasks: [null] }] },
    { version: 2, lists: [{ id: 'a', name: 'L', tasks: [{ id: 'b', text: 'x', done: 'yes' }] }] },
    { version: 2, lists: [{ id: 'a', name: 'L', tasks: [{ id: 'a', text: 'x', done: false }] }] }]) {
    assert.throws(() => validate(bad));
  }
});
test('new thoughts can land on top; revisions count edits', () => {
  const s = initial(), l = s.lists[0];
  addTask(l, 'first');
  const t = addTask(l, 'second', { top: true });
  assert.deepEqual(texts(l), ['second', 'first']);
  assert.equal(t.rev, 1);
  updateTask(l, t.id, { done: true });
  updateTask(l, t.id, { text: 'second!' });
  assert.equal(t.rev, 3);
});
test('reorder relative to a neighbour, or to the end', () => {
  const s = initial(), l = s.lists[0];
  const [a, b, c] = ['a', 'b', 'c'].map(x => addTask(l, x));
  moveTask(l, c.id, a.id); assert.deepEqual(texts(l), ['c', 'a', 'b']);
  moveTask(l, c.id, null); assert.deepEqual(texts(l), ['a', 'b', 'c']);
  moveTask(l, a.id, c.id); assert.deepEqual(texts(l), ['b', 'a', 'c']);
  moveTask(l, a.id, a.id); assert.deepEqual(texts(l), ['b', 'a', 'c']);
  assert.throws(() => moveTask(l, a.id, 'nope'));
  assert.throws(() => moveTask(l, 'nope', a.id));
  assert.deepEqual(texts(l), ['b', 'a', 'c']);
  assert.equal(b.rev, 1);
});
test('delete and clear done', () => {
  const s = initial(), l = s.lists[0];
  const a = addTask(l, 'a'), b = addTask(l, 'b'), c = addTask(l, 'c');
  updateTask(l, a.id, { done: true }); updateTask(l, c.id, { done: true });
  assert.equal(deleteTask(l, c.id), c);
  assert.throws(() => deleteTask(l, c.id));
  assert.equal(clearDone(l), 1);
  assert.deepEqual(texts(l), ['b']);
  assert.equal(b.done, false);
});
test('lists: rename, recolour, reorder, delete, never zero', () => {
  const s = initial();
  const [x, y, z] = s.lists;
  updateList(s, x.id, { name: '  Renamed ', color: 'teal' });
  assert.equal(x.name, 'Renamed'); assert.equal(x.color, 'teal'); assert.equal(x.rev, 2);
  assert.throws(() => updateList(s, x.id, { name: ' ' }));
  assert.throws(() => updateList(s, x.id, { name: 'ok', color: 'neon' }));
  assert.equal(x.name, 'Renamed');
  moveList(s, z.id, x.id);
  assert.deepEqual(s.lists.map(l => l.id), [z.id, x.id, y.id]);
  deleteList(s, y.id); deleteList(s, z.id);
  assert.throws(() => deleteList(s, x.id));
  assert.throws(() => deleteList(s, 'nope'));
  assert.equal(s.lists.length, 1);
  assert.equal(createList(s, 'New', 'neon').color, 'lavender');
});
test('sample data is valid, undated and includes an empty list', () => {
  const s = sample();
  assert.equal(validate(s), s);
  assert.ok(s.lists.some(l => l.tasks.length === 0));
  assert.ok(s.lists.some(l => l.tasks.some(t => t.done)));
  const keys = new Set(s.lists.flatMap(l => [...Object.keys(l), ...l.tasks.flatMap(t => Object.keys(t))]));
  assert.deepEqual([...keys].sort(), ['color', 'done', 'id', 'name', 'rev', 'tasks', 'text']);
});

// ---- insert at a position, move between lists, recently deleted, cleared-list tally ----
import { applyOp, trashOf, clearedOf, TRASH_DAYS } from '../dist/model.js';
const DAY = 86400000;
const ids = n => Array.from({ length: n }, () => crypto.randomUUID());

test('insert a task or a list at a chosen place; a vanished neighbour is not fatal', () => {
  const s = initial(), l = s.lists[0];
  const [a, b, c, d] = ids(4);
  applyOp(s, { type: 'add_item', listId: l.id, id: a, text: 'a' });
  applyOp(s, { type: 'add_item', listId: l.id, id: b, text: 'b' });
  applyOp(s, { type: 'add_item', listId: l.id, id: c, text: 'between', beforeId: b });
  assert.deepEqual(texts(l), ['a', 'between', 'b']);
  applyOp(s, { type: 'add_item', listId: l.id, id: d, text: 'orphan', beforeId: 'gone' });
  assert.deepEqual(texts(l), ['a', 'between', 'b', 'orphan']);
  applyOp(s, { type: 'add_item', listId: l.id, id: c, text: 'again', beforeId: a });   // same id re-sent
  assert.equal(l.tasks.length, 4);
  const [x] = ids(1);
  applyOp(s, { type: 'add_list', id: x, name: 'Squeezed in', color: 'sky', beforeId: s.lists[1].id });
  assert.deepEqual(s.lists.map(q => q.name), ['Everything on my mind', 'Squeezed in', 'Home & me', 'Ideas for later']);
  assert.equal(validate(s), s);
});

test('move a task to another list', () => {
  const s = initial(), [from, to] = s.lists;
  const [a] = ids(1);
  applyOp(s, { type: 'add_item', listId: from.id, id: a, text: 'travels' });
  applyOp(s, { type: 'add_item', listId: to.id, id: crypto.randomUUID(), text: 'resident' });
  applyOp(s, { type: 'transfer_item', listId: from.id, itemId: a, toListId: to.id });
  assert.deepEqual(texts(from), []);
  assert.deepEqual(texts(to), ['travels', 'resident']);
  assert.throws(() => applyOp(s, { type: 'transfer_item', listId: from.id, itemId: a, toListId: to.id }));
  assert.throws(() => applyOp(s, { type: 'transfer_item', listId: to.id, itemId: a, toListId: 'nope' }));
  assert.deepEqual(texts(to), ['travels', 'resident']);
});

test('deleted tasks and lists wait in Recently deleted, can be restored, and expire', () => {
  const s = initial(), l = s.lists[0], now = 400 * DAY;
  const [a, b, c] = ids(3);
  for (const [i, t] of [[a, 'one'], [b, 'two'], [c, 'three']]) applyOp(s, { type: 'add_item', listId: l.id, id: i, text: t }, now);
  applyOp(s, { type: 'delete_item', listId: l.id, itemId: a }, now);
  assert.deepEqual(trashOf(s).map(e => [e.kind, e.task.text, e.listName]), [['task', 'one', 'Everything on my mind']]);
  applyOp(s, { type: 'update_item', listId: l.id, itemId: b, done: true }, now);
  applyOp(s, { type: 'clear_done', listId: l.id }, now + DAY);
  assert.deepEqual(trashOf(s).map(e => e.task.text), ['two', 'one']);
  // restore a task: back in its list, gone from the bin; restoring twice is harmless
  const entry = trashOf(s)[1];
  applyOp(s, { type: 'restore_trash', trashId: entry.id }, now + DAY);
  applyOp(s, { type: 'restore_trash', trashId: entry.id }, now + DAY);
  assert.deepEqual(texts(l), ['one', 'three']);
  assert.equal(trashOf(s).length, 1);
  // a whole list goes in with its tasks and comes back with them
  applyOp(s, { type: 'delete_list', listId: l.id }, now + 2 * DAY);
  assert.equal(s.lists.length, 2);
  const binned = trashOf(s)[0];
  assert.deepEqual([binned.kind, binned.list.name, binned.list.tasks.length], ['list', 'Everything on my mind', 2]);
  applyOp(s, { type: 'restore_trash', trashId: binned.id }, now + 2 * DAY);
  assert.deepEqual(texts(s.lists.at(-1)), ['one', 'three']);
  // a task whose list no longer exists is restored into the first list
  applyOp(s, { type: 'delete_list', listId: s.lists.at(-1).id }, now + 3 * DAY);
  applyOp(s, { type: 'restore_trash', trashId: trashOf(s).find(e => e.kind === 'task').id }, now + 3 * DAY);
  assert.deepEqual(texts(s.lists[0]), ['two']);
  // entries older than the limit are dropped the next time something is deleted
  const [z] = ids(1);
  applyOp(s, { type: 'add_item', listId: s.lists[0].id, id: z, text: 'late' }, now);
  applyOp(s, { type: 'delete_item', listId: s.lists[0].id, itemId: z }, now + (TRASH_DAYS + 10) * DAY);
  assert.deepEqual(trashOf(s).map(e => e.kind === 'task' ? e.task.text : e.list.name), ['late']);
  applyOp(s, { type: 'empty_trash' });
  assert.deepEqual(trashOf(s), []);
  assert.equal(validate(JSON.parse(JSON.stringify(s))).trash.length, 0);
});

test('a malformed bin or tally in a backup is repaired, not fatal', () => {
  const s = initial();
  s.trash = [null, { id: 'ok-1', kind: 'task', at: 5, listId: 'x', listName: 'L', task: { id: 't', text: 'keep', done: false } },
    { id: 'ok-1', kind: 'task', at: 5, listId: 'x', listName: 'L', task: { id: 't', text: 'duplicate id', done: false } },
    { id: 'bad', kind: 'task', at: 'yesterday', listId: 'x', listName: 'L', task: { id: 't', text: 'x', done: false } },
    { id: 'bad2', kind: 'list', at: 1, list: { id: 'q', name: '', tasks: [] } }, { id: 'bad3', kind: 'mystery', at: 1 }];
  s.stats = { cleared: -4 };
  validate(s);
  assert.deepEqual(s.trash.map(e => e.task.text), ['keep']);
  assert.equal(clearedOf(s), 0);
  s.stats = { cleared: 7.5 }; assert.equal(clearedOf(s), 0);
  s.stats = { cleared: 12 }; assert.equal(validate(s).stats.cleared, 12);
});

test('clearing a list counts once per fill, and only when it is really clear', () => {
  const s = initial(), l = s.lists[0];
  const [a, b] = ids(2);
  const award = () => applyOp(s, { type: 'award_clear', listId: l.id });
  award(); assert.equal(clearedOf(s), 0, 'an empty list earns nothing');
  applyOp(s, { type: 'add_item', listId: l.id, id: a, text: 'a' });
  award(); assert.equal(clearedOf(s), 0, 'open tasks: nothing');
  applyOp(s, { type: 'update_item', listId: l.id, itemId: a, done: true });
  award(); assert.equal(clearedOf(s), 1);
  award(); assert.equal(clearedOf(s), 1, 'the same clear is not counted twice');
  applyOp(s, { type: 'update_item', listId: l.id, itemId: a, done: false });
  applyOp(s, { type: 'update_item', listId: l.id, itemId: a, done: true });
  award(); assert.equal(clearedOf(s), 1, 'un-ticking and re-ticking does not farm it');
  applyOp(s, { type: 'add_item', listId: l.id, id: b, text: 'b' });
  applyOp(s, { type: 'update_item', listId: l.id, itemId: b, done: true });
  award(); assert.equal(clearedOf(s), 2, 'a new task makes the next clear count');
  assert.equal(validate(JSON.parse(JSON.stringify(s))).stats.cleared, 2);
});
