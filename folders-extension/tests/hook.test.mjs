import vm from 'node:vm';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const posted = [];
const window = { location: { origin: 'https://mothershipcompanion.com' }, postMessage: (m) => posted.push(m) };
const ctx = vm.createContext({ window, console });
vm.runInContext(fs.readFileSync(new URL('../src/hook.js', import.meta.url), 'utf8'), ctx);

const doc = (path, data, exists = true) => ({ id: path.split('/').pop(), ref: { path }, data: () => data, exists: () => exists });
const charsRef = { type: 'collection', path: 'users/u1/characters' };
const sessionsRef = { type: 'collection', path: 'sessions' };
const snap = { docs: [doc('users/u1/characters/a', { id: 'a', name: 'Ripley', characterClass: 'Teamster', strength: 30, notes: 'secret' }),
                      doc('users/u1/characters/b', { id: 'b', name: 'Ash', characterClass: 'Android', characterClassOverride: 'Science Officer', creationComplete: false })] };

// Module namespace objects are frozen; mimic that.
const calls = [];
const mod = Object.freeze({
  getDocs: async (ref) => (calls.push('getDocs'), ref === charsRef ? snap : { docs: [] }),
  getDoc: async () => doc('users/u1/characters/c', { name: 'Parker' }),
  onSnapshot: (ref, next) => { calls.push('onSnapshot'); next(doc('users/u1/characters/a', null, false)); return () => {}; },
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
assert.equal(result, snap, 'app gets the original snapshot back');
await fs2.getDocs(sessionsRef);
await fs2.getDoc({ path: 'users/u1/characters/c' });
fs2.onSnapshot({ path: 'users/u1/characters/a' }, () => calls.push('appNext'));
await fs2.setDoc({ path: 'users/u1/characters/d' }, { id: 'd', name: 'Lambert', characterClass: 'Scientist' });
await fs2.updateDoc({ path: 'users/u1/characters/d' }, { name: 'Lambert II' });
await fs2.deleteDoc({ path: 'users/u1/characters/d' });
await fs2.setDoc({ path: 'users/u1/ships/x' }, { name: 'Nostromo' });
await new Promise((r) => setTimeout(r, 10));

const msgs = JSON.parse(JSON.stringify(posted.map(({ source, ...m }) => (assert.equal(source, "msc-folders-hook"), m))));

assert.deepEqual(msgs[0], { type: 'hook-ready' });
assert.deepEqual(msgs.find((m) => m.type === 'replace'), { type: 'replace', uid: 'u1', characters: [
  { id: 'a', name: 'Ripley', characterClass: 'Teamster', creationComplete: true },
  { id: 'b', name: 'Ash', characterClass: 'Science Officer', creationComplete: false }] });
assert.ok(!JSON.stringify(msgs).includes('secret'), 'no full sheets leaked');
assert.ok(!JSON.stringify(msgs).includes('Nostromo'), 'non-character docs ignored');
assert.deepEqual(calls, ['getDocs', 'getDocs', 'onSnapshot', 'appNext', 'setDoc', 'updateDoc', 'deleteDoc', 'setDoc']);
assert.equal(msgs.filter((m) => m.type === 'delete').length, 2);
console.log('hook tests passed');
