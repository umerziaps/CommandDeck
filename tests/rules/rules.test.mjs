// Runs the real firestore.rules against the real rules engine in the Firestore
// emulator. Everything else in this project tests the client; this tests the
// half of the system the client cannot reach, which is where a "Missing or
// insufficient permissions" comes from.
import { readFileSync } from 'node:fs';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initializeTestEnvironment, assertSucceeds, assertFails
} from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, getDoc, deleteDoc } from 'firebase/firestore';

// Two directories up from tests/rules/ is the repo root.
const RULES = new URL('../../firestore.rules', import.meta.url).pathname;
const ME = 'user-me';
const THEM = 'user-them';

const env = await initializeTestEnvironment({
  projectId: 'commanddeck-rules-test',
  firestore: { rules: readFileSync(RULES, 'utf8'), host: '127.0.0.1', port: 8080 }
});

const db = (uid) => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();

const blob = { ct: 'Y2lwaGVydGV4dA==', iv: 'aXZpdml2aXZpdml2' };
const group = (over = {}) => ({ v: 1, data: blob, createdAt: '2026-10-02T00:00:00Z', ...over });
const entry = (over = {}) => ({ v: 1, data: blob, createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', ...over });
const config = (over = {}) => ({
  v: 1, salt: 'c2FsdHNhbHRzYWx0c2E=', iterations: 310000, norm: 'NFKC+plain',
  verifier: blob, createdAt: '2026-10-02T00:00:00Z', ...over
});

test.after(() => env.cleanup());

/* ---------- the reported failure ---------- */

test('a group can be created exactly as the app writes it', async () => {
  await assertSucceeds(setDoc(doc(db(ME), `users/${ME}/vaultGroups/g1`), group()));
});

test('a group without updatedAt is accepted — this is how every group is born', async () => {
  const g = group();
  assert.equal('updatedAt' in g, false);
  await assertSucceeds(setDoc(doc(db(ME), `users/${ME}/vaultGroups/g2`), g));
});

test('a group gains updatedAt when renamed, and that is still accepted', async () => {
  await assertSucceeds(setDoc(doc(db(ME), `users/${ME}/vaultGroups/g3`), group()));
  await assertSucceeds(updateDoc(doc(db(ME), `users/${ME}/vaultGroups/g3`),
    { data: blob, updatedAt: '2026-10-03T00:00:00Z' }));
});

/* ---------- the ciphertext-only guarantee ---------- */

test('a group with a plaintext name is refused', async () => {
  await assertFails(setDoc(doc(db(ME), `users/${ME}/vaultGroups/bad`),
    { v: 1, name: 'Ocufii staging VMs', color: '#5EE6C5', createdAt: '2026-10-02T00:00:00Z' }));
});

test('an entry with a plaintext password is refused', async () => {
  await assertFails(setDoc(doc(db(ME), `users/${ME}/vault/bad`),
    { v: 1, data: blob, password: 'hunter2', createdAt: 'x', updatedAt: 'x' }));
});

test('a sealed blob missing its ciphertext or IV is refused', async () => {
  await assertFails(setDoc(doc(db(ME), `users/${ME}/vault/b1`), entry({ data: { ct: 'x' } })));
  await assertFails(setDoc(doc(db(ME), `users/${ME}/vault/b2`), entry({ data: { iv: 'x' } })));
  await assertFails(setDoc(doc(db(ME), `users/${ME}/vault/b3`), entry({ data: { ct: '', iv: 'x' } })));
  await assertFails(setDoc(doc(db(ME), `users/${ME}/vault/b4`),
    entry({ data: { ct: 'x', iv: 'y', hint: 'the dog' } })));
});

test('the vault config must carry a real salt and a serious iteration count', async () => {
  await assertSucceeds(setDoc(doc(db(ME), `users/${ME}/vaultMeta/config`), config()));
  await assertFails(setDoc(doc(db(ME), `users/${ME}/vaultMeta/config`), config({ iterations: 1000 })));
  await assertFails(setDoc(doc(db(ME), `users/${ME}/vaultMeta/config`), config({ salt: 'short' })));
});

/* ---------- ownership ---------- */

test('nobody else can read or write my vault, groups included', async () => {
  await assertSucceeds(setDoc(doc(db(ME), `users/${ME}/vaultGroups/mine`), group()));
  await assertFails(getDoc(doc(db(THEM), `users/${ME}/vaultGroups/mine`)));
  await assertFails(setDoc(doc(db(THEM), `users/${ME}/vaultGroups/theirs`), group()));
  await assertFails(deleteDoc(doc(db(THEM), `users/${ME}/vaultGroups/mine`)));
  await assertFails(getDoc(doc(db(THEM), `users/${ME}/vault/anything`)));
  await assertFails(getDoc(doc(db(THEM), `users/${ME}/vaultMeta/config`)));
});

test('signed out gets nothing at all', async () => {
  await assertFails(getDoc(doc(anon(), `users/${ME}/vaultGroups/mine`)));
  await assertFails(setDoc(doc(anon(), `users/${ME}/vaultGroups/x`), group()));
  await assertFails(getDoc(doc(anon(), `users/${ME}/vaultMeta/config`)));
});

test('an unknown collection under my own user is still denied', async () => {
  await assertFails(setDoc(doc(db(ME), `users/${ME}/vaultBackups/x`), { anything: true }));
});

/* ---------- the board is unaffected ---------- */

test('board items and categories still write', async () => {
  await assertSucceeds(setDoc(doc(db(ME), `users/${ME}/items/i1`), {
    title: 'ship it', bucket: 'now', done: false, urgent: false, order: 0, subs: []
  }));
  await assertSucceeds(setDoc(doc(db(ME), `users/${ME}/categories/c1`), {
    name: 'Work', color: '#5EE6C5', createdAt: 'x'
  }));
  await assertFails(setDoc(doc(db(ME), `users/${ME}/items/i2`), {
    title: 'bad bucket', bucket: 'someday', done: false, urgent: false, order: 0, subs: []
  }));
});
