// Tests for the Claude extraction client.
//
// No key and no network: fetch is injected. What matters here is that the
// client never invents a release, never marks one as shipped, and fails in a
// way that tells you which of the several possible things went wrong.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateKey, pickModel, chunkThread, sanitise, usable,
  extractReleases, listModels, ClaudeError, API_VERSION
} from './claude.js';

const okRes = (body) => ({ ok: true, json: async () => body });
const errRes = (status, message) => ({ ok: false, status, json: async () => ({ error: { message } }) });
const models = okRes({ data: [{ id: 'claude-haiku-4-5' }, { id: 'claude-sonnet-4-5' }] });
const oneRelease = okRes({
  content: [{ type: 'tool_use', name: 'record_releases', input: { releases: [
    { version: 'v1.3.2', build: '189', env: 'California', changes: 'things',
      sourceUrl: '\\\\fs04\\src', artifactUrl: '\\\\fs04\\out', buildDate: '2026-09-25', notes: 'SDK 26' }
  ] } }]
});

const fakeFetch = (routes) => async (url, opts) => {
  const hit = url.includes('/v1/models') ? routes.models : routes.messages;
  if (typeof hit === 'function') return hit(url, opts);
  return hit;
};

test('a key that is not an Anthropic key is refused before any request', async () => {
  assert.equal(validateKey('').ok, false);
  assert.equal(validateKey('sk-proj-openai-style').ok, false);
  assert.equal(validateKey('sk-ant-api03-xyz').ok, true);

  let called = false;
  await assert.rejects(
    () => extractReleases('wrong', 'text', { fetchImpl: async () => { called = true; } }),
    ClaudeError);
  assert.equal(called, false, 'a bad key must not spend a request to find out');
});

test('the model is discovered, not hard-coded', async () => {
  let askedModels = false;
  const f = fakeFetch({
    models: (url, opts) => { askedModels = true;
      assert.equal(opts.headers['anthropic-version'], API_VERSION);
      assert.equal(opts.headers['x-api-key'], 'sk-ant-test');
      return models; },
    messages: oneRelease
  });
  const res = await extractReleases('sk-ant-test', 'text', { fetchImpl: f });
  assert.equal(askedModels, true);
  assert.equal(res.model, 'claude-haiku-4-5');
});

test('the browser opt-in header is sent, because the API will not answer without it', async () => {
  let header = '';
  const f = fakeFetch({
    models: (url, opts) => { header = opts.headers['anthropic-dangerous-direct-browser-access']; return models; },
    messages: oneRelease
  });
  await extractReleases('sk-ant-test', 'text', { fetchImpl: f });
  assert.equal(header, 'true');
});

test('extraction is forced through the tool, so the answer is data not prose', async () => {
  let body = null;
  const f = fakeFetch({ models, messages: (url, opts) => { body = JSON.parse(opts.body); return oneRelease; } });
  await extractReleases('sk-ant-test', 'text', { fetchImpl: f });
  assert.equal(body.tool_choice.type, 'tool');
  assert.equal(body.tool_choice.name, 'record_releases');
  assert.equal(body.tools.length, 1);
});

test('a release comes back with every field and nothing marked as shipped', async () => {
  const f = fakeFetch({ models, messages: oneRelease });
  const { releases } = await extractReleases('sk-ant-test', 'text', { fetchImpl: f });
  assert.equal(releases.length, 1);
  assert.equal(releases[0].version, 'v1.3.2');
  assert.equal(releases[0].artifactUrl, '\\\\fs04\\out');
  assert.equal(releases[0].production, false);
  assert.equal(releases[0].prodDate, '');
});

test('production is dropped even if the model returns it', () => {
  // The model is told not to decide this. The code also does not let it.
  const s = sanitise({ version: 'v1', production: true, prodDate: '2026-01-01' });
  assert.equal(s.production, false);
  assert.equal(s.prodDate, '');
});

test('a non-date in buildDate is dropped rather than stored', () => {
  assert.equal(sanitise({ buildDate: 'last Tuesday' }).buildDate, '');
  assert.equal(sanitise({ buildDate: '2026-09-25' }).buildDate, '2026-09-25');
});

test('non-string output is coerced rather than trusted', () => {
  const s = sanitise({ version: 42, changes: null, env: { nested: true } });
  assert.equal(s.version, '');
  assert.equal(s.changes, '');
  assert.equal(s.env, '');
});

test('a release with nothing to identify it is not usable', () => {
  assert.equal(usable({ version: '', build: '' }), false);
  assert.equal(usable({ version: 'v1', build: '' }), true);
  assert.equal(usable({ version: '', build: '189' }), true);
});

test('a long thread is split on message boundaries, never mid-announcement', () => {
  const msg = (n) => `\nFrom: someone\nSent: ${n}\n\nBUILD DETAILS\nRelease: v1 (${n})\n${'x'.repeat(5000)}`;
  const thread = Array.from({ length: 30 }, (_, i) => msg(i)).join('');
  const chunks = chunkThread(thread, { maxChars: 20000, maxChunks: 20 });
  assert.ok(chunks.length > 1);
  for (const c of chunks.slice(1)) {
    assert.match(c.trimStart(), /^(_{5,}\s*)?From:/, 'each chunk begins at a message boundary');
  }
});

test('chunking is bounded, so a huge paste cannot spend unbounded money', () => {
  const huge = 'x'.repeat(5_000_000);
  assert.ok(chunkThread(huge, { maxChars: 1000, maxChunks: 4 }).length <= 4);
});

test('short text is one chunk and one request', async () => {
  let calls = 0;
  const f = fakeFetch({ models, messages: () => { calls++; return oneRelease; } });
  const res = await extractReleases('sk-ant-test', 'short', { fetchImpl: f });
  assert.equal(calls, 1);
  assert.equal(res.calls, 1);
});

test('each failure mode gets its own message', async () => {
  for (const [status, detail, kind, re] of [
    [401, 'invalid x-api-key', 'auth', /rejected/i],
    [429, 'rate limit', 'rate', /Rate limited/i],
    [400, 'Your credit balance is too low', 'billing', /billed separately/i],
    [500, 'oops', 'server', /having trouble/i]
  ]) {
    const f = fakeFetch({ models: errRes(status, detail), messages: errRes(status, detail) });
    await assert.rejects(() => listModels('sk-ant-test', { fetchImpl: f }), (err) => {
      assert.equal(err.kind, kind, `status ${status}`);
      assert.match(err.message, re);
      return true;
    });
  }
});

test('an auth failure stops immediately instead of retrying every chunk', async () => {
  let messageCalls = 0;
  const f = fakeFetch({
    models,
    messages: () => { messageCalls++; return errRes(401, 'invalid x-api-key'); }
  });
  const long = Array.from({ length: 10 }, (_, i) => `\nFrom: x\nSent: ${i}\n` + 'y'.repeat(30000)).join('');
  await assert.rejects(() => extractReleases('sk-ant-test', long, { fetchImpl: f }), ClaudeError);
  assert.equal(messageCalls, 1, 'the same key will fail identically on every chunk');
});

test('one failed chunk still returns what the others found', async () => {
  let n = 0;
  const f = fakeFetch({
    models,
    messages: () => { n++; return n === 1 ? errRes(500, 'blip') : oneRelease; }
  });
  const long = Array.from({ length: 4 }, (_, i) => `\nFrom: x\nSent: ${i}\n` + 'y'.repeat(30000)).join('');
  const res = await extractReleases('sk-ant-test', long, { fetchImpl: f });
  assert.ok(res.releases.length > 0, 'half a backfill beats none');
  assert.equal(res.failures.length, 1);
});

test('a reply with no tool_use yields nothing rather than guessing', async () => {
  const f = fakeFetch({ models, messages: okRes({ content: [{ type: 'text', text: 'Sure! Here are the releases...' }] }) });
  const res = await extractReleases('sk-ant-test', 'text', { fetchImpl: f });
  assert.deepEqual(res.releases, []);
});

test('model preference favours the cheap tier for what is an extraction job', () => {
  assert.equal(pickModel([{ id: 'claude-opus-5' }, { id: 'claude-haiku-4-5' }]), 'claude-haiku-4-5');
  assert.equal(pickModel([{ id: 'claude-opus-5' }, { id: 'claude-sonnet-4-5' }]), 'claude-sonnet-4-5');
  assert.equal(pickModel([{ id: 'claude-opus-5' }]), 'claude-opus-5', 'a restricted key still works');
  assert.equal(pickModel([]), '');
});
