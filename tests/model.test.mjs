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
