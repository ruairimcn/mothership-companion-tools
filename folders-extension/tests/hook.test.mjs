// Unit test for src/hook.js against a fake Firestore SDK.
// Run with: node tests/hook.test.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const posted = [];
// The app's local cache, as shared_preferences stores it (JSON inside a JSON string).
const storage = {
  'flutter.CharacterPool': JSON.stringify(JSON.stringify({ l1: { id: 'l1', name: 'Local Larry', characterClass: 'Marine', mode: 'x', notes: 'secret' } })),
  'flutter.MapCubit': JSON.stringify('{}'),
};
const window = {
  location: { origin: 'https://mothershipcompanion.com' },
  postMessage: (m) => posted.push(m),
  localStorage: { getItem: (k) => storage[k] ?? null },
};
const timers = [];
const ctx = vm.createContext({ window, console, setTimeout: (fn) => timers.push(fn), setInterval: () => 0 });
vm.runInContext(fs.readFileSync(new URL('../src/hook.js', import.meta.url), 'utf8'), ctx);
timers.forEach((fn) => fn()); // the initial local-cache report

const doc = (path, data, exists = true) => ({ id: path.split('/').pop(), ref: { path }, data: () => data, exists: () => exists });
const ref = (path, type = 'document') => ({ type, path });
const charsRef = ref('users/u1/characters', 'collection');
const shipsRef = ref('users/u1/ships', 'collection');
const mapsRef = ref('users/u1/maps', 'collection');

const SNAPS = new Map([
  [charsRef, { docs: [
    doc('users/u1/characters/a', { id: 'a', name: 'Ripley', characterClass: 'Teamster', strength: 30, notes: 'secret' }),
    doc('users/u1/characters/b', { id: 'b', name: 'Ash', characterClass: 'Android', characterClassOverride: 'Science Officer', creationComplete: false }),
  ] }],
  [shipsRef, { docs: [
    doc('users/u1/ships/s1', { id: 's1', shipIdentifier: 'Nostromo', make: 'Lockmart', model: 'CM-88B', hullMax: 40, cargo: { secret: 1 } }),
    doc('users/u1/ships/s2', { id: 's2', shipIdentifier: '', make: 'Weyland', model: 'Hauler', classString: 'Freighter', hullMax: 10 }),
  ] }],
  [mapsRef, { docs: [doc('users/u1/maps/m1', { id: 'm1', title: 'Prospero\'s Dream', module: 'A Pound of Flesh', rooms: { r: 1 } })] }],
]);

// Module namespace objects are frozen; mimic that.
const calls = [];
const mod = Object.freeze({
  getDocs: async (r) => (calls.push('getDocs'), SNAPS.get(r) || { docs: [] }),
  getDoc: async () => doc('users/u1/characters/c', { name: 'Parker', mode: 'x' }),
  onSnapshot: (r, next) => { calls.push('onSnapshot'); next(doc('users/u1/characters/a', null, false)); return () => {}; },
  setDoc: async () => calls.push('setDoc'),
  updateDoc: async () => calls.push('updateDoc'),
  deleteDoc: async () => calls.push('deleteDoc'),
  collection: () => 'untouched',
});
window.firebase_firestore = mod;
const fs2 = window.firebase_firestore;
assert.notEqual(fs2, mod, 'wrapped copy installed');
assert.equal(fs2.collection(), 'untouched', 'other functions pass through');

const result = await fs2.getDocs(charsRef);
assert.equal(result, SNAPS.get(charsRef), 'app gets the original snapshot back');
await fs2.getDocs(shipsRef);
await fs2.getDocs(mapsRef);
await fs2.getDocs(ref('sessions', 'collection'));
await fs2.getDoc(ref('users/u1/characters/c'));
fs2.onSnapshot(ref('users/u1/characters/a'), () => calls.push('appNext'));
await fs2.setDoc(ref('users/u1/characters/d'), { id: 'd', name: 'Lambert', characterClass: 'Scientist', mode: 'x' });
await fs2.setDoc(ref('users/u1/characters/d'), { notes: 'partial merge' }, { merge: true });
await fs2.updateDoc(ref('users/u1/maps/m1'), { title: 'Dream II' });
await fs2.updateDoc(ref('users/u1/ships/s1'), { hullCurrent: 3 });
await fs2.deleteDoc(ref('users/u1/ships/s2'));
await fs2.setDoc(ref('users/u1/tokens/x'), { name: 'Token' });
await new Promise((r) => setTimeout(r, 10));

const msgs = JSON.parse(JSON.stringify(posted.map(({ source, ...m }) => (assert.equal(source, 'msc-folders-hook'), m))));
const byType = (type, kind) => msgs.filter((m) => m.type === type && m.kind === kind);

assert.deepEqual(msgs.filter((m) => m.type === 'local'), [
  { type: 'local', kind: 'characters', items: [{ id: 'l1', name: 'Local Larry', subtitle: 'Marine', draft: false }] },
  { type: 'local', kind: 'ships', items: [] },
  { type: 'local', kind: 'maps', items: [] }]);
assert.deepEqual(msgs.find((m) => m.type === 'hook-ready'), { type: 'hook-ready' });
assert.deepEqual(byType('replace', 'characters')[0].items, [
  { id: 'a', name: 'Ripley', subtitle: 'Teamster', draft: false },
  { id: 'b', name: 'Ash', subtitle: 'Science Officer', draft: true }]);
assert.deepEqual(byType('replace', 'ships')[0].items, [
  { id: 's1', name: 'Nostromo', subtitle: 'Lockmart CM-88B', draft: false },
  { id: 's2', name: 'Weyland Hauler', subtitle: 'Freighter', draft: false }]);
assert.deepEqual(byType('replace', 'maps')[0].items, [
  { id: 'm1', name: 'Prospero\'s Dream', subtitle: 'A Pound of Flesh', draft: false }]);
assert.deepEqual(byType('upsert', 'characters').map((m) => m.items[0].name), ['Parker', 'Lambert'], 'partial merges skipped');
assert.deepEqual(byType('rename', 'maps'), [{ type: 'rename', uid: 'u1', kind: 'maps', id: 'm1', name: 'Dream II' }]);
assert.equal(byType('rename', 'ships').length, 0, 'updates without a name are ignored');
assert.deepEqual(byType('delete', 'ships'), [{ type: 'delete', uid: 'u1', kind: 'ships', ids: ['s2'] }]);
assert.deepEqual(byType('delete', 'characters'), [{ type: 'delete', uid: 'u1', kind: 'characters', ids: ['a'] }]);
assert.ok(!JSON.stringify(msgs).includes('secret'), 'no full records leaked');
assert.ok(!JSON.stringify(msgs).includes('Token'), 'other collections ignored');
assert.deepEqual(calls, ['getDocs', 'getDocs', 'getDocs', 'getDocs', 'onSnapshot', 'appNext', 'setDoc', 'setDoc', 'updateDoc', 'updateDoc', 'deleteDoc', 'setDoc']);
console.log('hook tests passed');
