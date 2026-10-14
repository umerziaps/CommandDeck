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

/* ---------- team visibility board ----------
 *
 * These are the rules that decide whether the migration can run at all. The
 * client can be right about every field and still get "Missing or insufficient
 * permissions" if the rules disagree about one of them, which is exactly what
 * happened the first time vaultGroups shipped.
 */

const project = (over = {}) => ({
  name: 'Ocufii 2.0', color: '#5EE6C5', createdAt: '2026-10-01T00:00:00Z', ...over
});
const boardProject = (over = {}) => project({
  client: 'Internal', status: 'active', summary: 'Off AWS onto our own stack.', order: 0, ...over
});
const component = (over = {}) => ({
  projectId: 'p1', name: 'Ocufii iOS', platform: 'ios', repoUrl: '', artifactUrl: '',
  notes: '', color: '#7C89F0', order: 0, createdAt: '2026-10-01T00:00:00Z', ...over
});
const spec = (over = {}) => ({
  projectId: 'p1', componentId: '', title: 'SDS Draft Specification',
  html: '<h1>Spec</h1><p>Body.</p>', text: '# Spec\nBody.', outline: ['Spec'],
  wordCount: 2, sourceName: 'spec.docx', version: 1, createdAt: '2026-10-01T00:00:00Z', ...over
});
const release = (over = {}) => ({
  appId: 'a1', version: 'v1.0', build: '1', env: 'Sqa', changes: '', sourceUrl: '',
  artifactUrl: '', buildDate: '2026-10-01', production: false, prodDate: '', notes: '',
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...over
});

test('a project written by the OLD timeline code is still accepted', async () => {
  // This is the compatibility that matters: the board added four fields and
  // the timeline writes none of them.
  await assertSucceeds(setDoc(doc(db(ME), `users/${ME}/projects/old`), project()));
});

test('a project written by the board, with all its fields, is accepted', async () => {
  await assertSucceeds(setDoc(doc(db(ME), `users/${ME}/projects/p1`), boardProject()));
});

test('a project with a status nobody defined is refused', async () => {
  await assertFails(setDoc(doc(db(ME), `users/${ME}/projects/bad1`), boardProject({ status: 'on fire' })));
  await assertFails(setDoc(doc(db(ME), `users/${ME}/projects/bad2`), boardProject({ order: 'first' })));
  await assertFails(setDoc(doc(db(ME), `users/${ME}/projects/bad3`), boardProject({ summary: 'x'.repeat(301) })));
});

test('a component writes exactly as the app and the migration build it', async () => {
  await assertSucceeds(setDoc(doc(db(ME), `users/${ME}/components/c1`), component()));
  await assertSucceeds(setDoc(doc(db(ME), `users/${ME}/components/c2`), component({ platform: 'portal' })));
});

test('a component without a project, or on a platform that does not exist, is refused', async () => {
  await assertFails(setDoc(doc(db(ME), `users/${ME}/components/x1`), component({ projectId: '' })));
  await assertFails(setDoc(doc(db(ME), `users/${ME}/components/x2`), component({ platform: 'watchos' })));
  await assertFails(setDoc(doc(db(ME), `users/${ME}/components/x3`), component({ color: 'blue' })));
  await assertFails(setDoc(doc(db(ME), `users/${ME}/components/x4`), component({ order: 'top' })));
});

test('a spec version writes, and an unnumbered one does not', async () => {
  await assertSucceeds(setDoc(doc(db(ME), `users/${ME}/specs/s1`), spec()));
  await assertSucceeds(setDoc(doc(db(ME), `users/${ME}/specs/s2`), spec({ componentId: 'c1', version: 2 })));
  await assertFails(setDoc(doc(db(ME), `users/${ME}/specs/x1`), spec({ version: 0 })));
  await assertFails(setDoc(doc(db(ME), `users/${ME}/specs/x2`), spec({ version: 1.5 })));
  await assertFails(setDoc(doc(db(ME), `users/${ME}/specs/x3`), spec({ html: '' })));
  await assertFails(setDoc(doc(db(ME), `users/${ME}/specs/x4`), spec({ projectId: '' })));
  await assertFails(setDoc(doc(db(ME), `users/${ME}/specs/x5`), spec({ outline: 'Spec' })));
});

test('a spec larger than the client would ever upload is refused by the rules too', async () => {
  await assertFails(setDoc(doc(db(ME), `users/${ME}/specs/huge`), spec({ html: 'x'.repeat(400_001) })));
});

test('the migration update — adding componentId to an existing release — is allowed', async () => {
  await assertSucceeds(setDoc(doc(db(ME), `users/${ME}/releases/r1`), release()));
  await assertSucceeds(updateDoc(doc(db(ME), `users/${ME}/releases/r1`), { componentId: 'c1' }));
});

test('a planned release may have no build date, and a recorded one may not', async () => {
  await assertSucceeds(setDoc(doc(db(ME), `users/${ME}/releases/r2`), release({
    planned: true, targetDate: '2026-12-01', status: 'building', blocker: '', buildDate: ''
  })));
  await assertFails(setDoc(doc(db(ME), `users/${ME}/releases/r3`), release({ buildDate: '' })));
  await assertFails(setDoc(doc(db(ME), `users/${ME}/releases/r4`), release({
    planned: true, targetDate: 'december', buildDate: ''
  })));
  await assertFails(setDoc(doc(db(ME), `users/${ME}/releases/r5`), release({
    planned: true, targetDate: '2026-12-01', status: 'nearly', buildDate: ''
  })));
});

test('nobody else can read my specs — they are the client\'s unreleased requirements', async () => {
  await assertSucceeds(setDoc(doc(db(ME), `users/${ME}/specs/mine`), spec()));
  await assertFails(getDoc(doc(db(THEM), `users/${ME}/specs/mine`)));
  await assertFails(getDoc(doc(anon(), `users/${ME}/specs/mine`)));
  await assertFails(setDoc(doc(db(THEM), `users/${ME}/components/theirs`), component()));
  await assertFails(getDoc(doc(anon(), `users/${ME}/components/c1`)));
});
