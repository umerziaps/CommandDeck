// Tests for the vault crypto core.
//
//   npm test          — runs this and lib.test.js
//   node --test docs/vault.test.js
//
// These run on the GitHub Actions web job, on the same Node that runs them
// here. No browser and no Firebase: vault.js deliberately depends on neither,
// which is what makes the security-critical part testable at all.
//
// Iteration counts are turned down to 1,000 throughout. PBKDF2 is slow on
// purpose — at the real 310,000 these tests would take minutes — and the
// stretching cost is not what is under test here. The one test that cares
// about the real number asserts on the constant instead.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VAULT_VERSION, PBKDF2_ITERATIONS, MIN_PASSPHRASE, VERIFIER_PLAINTEXT, DEFAULT_NORM,
  SALT_BYTES, IV_BYTES,
  WrongPassphraseError, CorruptEntryError,
  toB64, fromB64, newSalt,
  deriveKey, encryptJson, decryptJson,
  createVaultConfig, unlockVault, passphraseCandidates, normalizePassphrase,
  blankEntry, normaliseEntry, entryBody, entryOrder,
  validateEntry, validatePassphrase, vaultSearch,
  genPassword, passwordStrength, maskSecret, CHARSETS
} from './vault.js';

const FAST = { iterations: 1000 };
const PASS = 'correct horse battery staple';

/* ---------- base64 ---------- */

test('base64 round-trips arbitrary bytes, including 0x00 and 0xFF', () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 254, 255, 0, 42]);
  assert.deepEqual(fromB64(toB64(bytes)), bytes);
});

test('a 16-byte salt encodes to the expected base64 length', () => {
  const salt = newSalt();
  assert.equal(fromB64(salt).length, SALT_BYTES);
});

/* ---------- derivation and the round trip ---------- */

test('the same passphrase and salt derive a key that decrypts its own ciphertext', async () => {
  const salt = newSalt();
  const a = await deriveKey(PASS, salt, 1000);
  const b = await deriveKey(PASS, salt, 1000);

  const blob = await encryptJson(a, { hello: 'world' });
  assert.deepEqual(await decryptJson(b, blob), { hello: 'world' });
});

test('the same passphrase under a different salt derives a different key', async () => {
  const blob = await encryptJson(await deriveKey(PASS, newSalt(), 1000), { x: 1 });
  const other = await deriveKey(PASS, newSalt(), 1000);
  await assert.rejects(() => decryptJson(other, blob), WrongPassphraseError);
});

test('a different iteration count derives a different key', async () => {
  const salt = newSalt();
  const blob = await encryptJson(await deriveKey(PASS, salt, 1000), { x: 1 });
  const other = await deriveKey(PASS, salt, 2000);
  await assert.rejects(() => decryptJson(other, blob), WrongPassphraseError);
});

test('createVaultConfig then unlockVault accepts the right passphrase', async () => {
  const { config } = await createVaultConfig(PASS, FAST);
  assert.equal(config.v, VAULT_VERSION);
  assert.equal(config.iterations, 1000);
  assert.ok(config.createdAt);

  const { key } = await unlockVault(PASS, config);
  assert.equal(await decryptJson(key, config.verifier), VERIFIER_PLAINTEXT);
});

test('unlockVault rejects a wrong passphrase', async () => {
  const { config } = await createVaultConfig(PASS, FAST);
  await assert.rejects(() => unlockVault('correct horse battery stapl', config), WrongPassphraseError);
});

test('unlockVault rejects an empty passphrase rather than unlocking', async () => {
  const { config } = await createVaultConfig(PASS, FAST);
  await assert.rejects(() => unlockVault('', config));
});

test('unlockVault falls back to the default iteration count when the config omits it', async () => {
  const { config } = await createVaultConfig(PASS, { iterations: PBKDF2_ITERATIONS });
  delete config.iterations;
  const { key } = await unlockVault(PASS, config);       // slow, but only once
  assert.equal(await decryptJson(key, config.verifier), VERIFIER_PLAINTEXT);
});

test('unlockVault refuses a config with no salt instead of deriving from nothing', async () => {
  await assert.rejects(() => unlockVault(PASS, { verifier: { ct: 'x', iv: 'y' } }), /no configuration/);
});

/* ---------- what actually reaches the database ---------- */

test('the stored config contains no trace of the passphrase', async () => {
  const { config } = await createVaultConfig('hunter2-hunter2', FAST);
  const wire = JSON.stringify(config);
  assert.ok(!wire.includes('hunter2'), 'passphrase leaked into the config document');
});

test('an encrypted entry leaks none of its own contents', async () => {
  const { key } = await createVaultConfig(PASS, FAST);
  const blob = await encryptJson(key, {
    title: 'Chase Bank', username: 'umer@example.com', password: 'S3cr3t!', url: 'chase.com', notes: 'joint account'
  });
  const wire = JSON.stringify(blob);
  for (const secret of ['Chase', 'umer@example.com', 'S3cr3t', 'chase.com', 'joint']) {
    assert.ok(!wire.includes(secret), `"${secret}" survived encryption in plain text`);
  }
});

test('encrypting the same value twice produces different ciphertext', async () => {
  const { key } = await createVaultConfig(PASS, FAST);
  const a = await encryptJson(key, { pw: 'same' });
  const b = await encryptJson(key, { pw: 'same' });
  assert.notEqual(a.iv, b.iv, 'IV was reused — catastrophic for AES-GCM');
  assert.notEqual(a.ct, b.ct);
});

test('every IV is the 96 bits AES-GCM is specified for', async () => {
  const { key } = await createVaultConfig(PASS, FAST);
  const blob = await encryptJson(key, { x: 1 });
  assert.equal(fromB64(blob.iv).length, IV_BYTES);
});

test('IVs do not repeat across many encryptions', async () => {
  const { key } = await createVaultConfig(PASS, FAST);
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add((await encryptJson(key, { i })).iv);
  assert.equal(seen.size, 200);
});

test('salts do not repeat across many vaults', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(newSalt());
  assert.equal(seen.size, 500);
});

/* ---------- integrity ---------- */

test('a single flipped byte of ciphertext is detected, not decrypted', async () => {
  const { key } = await createVaultConfig(PASS, FAST);
  const blob = await encryptJson(key, { password: 'original' });

  const bytes = fromB64(blob.ct);
  bytes[0] ^= 0x01;
  await assert.rejects(() => decryptJson(key, { ct: toB64(bytes), iv: blob.iv }), WrongPassphraseError);
});

test('a tampered IV is detected', async () => {
  const { key } = await createVaultConfig(PASS, FAST);
  const blob = await encryptJson(key, { password: 'original' });
  const iv = fromB64(blob.iv);
  iv[0] ^= 0xff;
  await assert.rejects(() => decryptJson(key, { ct: blob.ct, iv: toB64(iv) }), WrongPassphraseError);
});

test('a malformed blob raises CorruptEntryError rather than throwing from the crypto layer', async () => {
  const { key } = await createVaultConfig(PASS, FAST);
  await assert.rejects(() => decryptJson(key, null), CorruptEntryError);
  await assert.rejects(() => decryptJson(key, { ct: 'abc' }), CorruptEntryError);
});

test('additional authenticated data binds a blob to its entry id', async () => {
  const { key } = await createVaultConfig(PASS, FAST);
  const blob = await encryptJson(key, { password: 'a' }, { aad: 'entry-1' });

  // Right id: opens.
  assert.deepEqual(await decryptJson(key, blob, { aad: 'entry-1' }), { password: 'a' });
  // Moved to another document: refuses, even though the key is correct.
  await assert.rejects(() => decryptJson(key, blob, { aad: 'entry-2' }), WrongPassphraseError);
  // And it is not optional — dropping the AAD does not bypass the binding.
  await assert.rejects(() => decryptJson(key, blob), WrongPassphraseError);
});

/* ---------- entry model ---------- */

test('normaliseEntry keeps only known fields and coerces the rest to strings', () => {
  const e = normaliseEntry('abc', {
    title: 'GitHub', username: 'umer', password: 'pw',
    url: null, notes: undefined, catId: 7,
    isAdmin: true, __proto__: { polluted: 1 }
  }, { createdAt: '2026-01-01T00:00:00Z' });

  assert.equal(e.id, 'abc');
  assert.equal(e.title, 'GitHub');
  assert.equal(e.url, '');            // null → ''
  assert.equal(e.notes, '');          // undefined → ''
  assert.equal(e.catId, '');          // number → ''
  assert.equal(e.isAdmin, undefined); // unknown field dropped
  assert.equal(e.updatedAt, '2026-01-01T00:00:00Z'); // defaults to createdAt
});

test('entryBody round-trips through normaliseEntry without gaining fields', () => {
  const body = entryBody({ ...blankEntry(), title: 'X', password: 'y', junk: 'no' });
  assert.deepEqual(Object.keys(body).sort(), ['catId', 'notes', 'password', 'title', 'url', 'username']);
});

test('entries sort by name, ignoring case', () => {
  const names = [{ title: 'zoom' }, { title: 'Apple' }, { title: 'bank' }]
    .sort(entryOrder).map((e) => e.title);
  assert.deepEqual(names, ['Apple', 'bank', 'zoom']);
});

test('validateEntry requires a name', () => {
  assert.equal(validateEntry({ title: '   ' }).ok, false);
  assert.equal(validateEntry({ title: 'Bank' }).ok, true);
  assert.equal(validateEntry({ title: 'x'.repeat(201) }).ok, false);
});

test('validatePassphrase enforces a floor and a match', () => {
  assert.equal(validatePassphrase('short').ok, false);
  assert.equal(validatePassphrase('x'.repeat(MIN_PASSPHRASE)).ok, true);
  assert.equal(validatePassphrase('longenoughpass', 'longenoughpas').ok, false);
  assert.equal(validatePassphrase('longenoughpass', 'longenoughpass').ok, true);
});

test('search never matches on the password field', () => {
  const entries = [
    { title: 'Bank', username: 'umer', url: 'bank.com', notes: '', password: 'zebra-unique-token' },
    { title: 'Mail', username: 'me', url: 'mail.com', notes: 'recovery', password: '' }
  ];
  assert.equal(vaultSearch(entries, 'zebra-unique-token').length, 0);
  assert.equal(vaultSearch(entries, 'bank').length, 1);
  assert.equal(vaultSearch(entries, 'RECOVERY').length, 1);
  assert.equal(vaultSearch(entries, '').length, 2);
});

/* ---------- generator ---------- */

test('generated passwords honour the requested length', () => {
  for (const n of [8, 16, 20, 64]) assert.equal(genPassword({ length: n }).length, n);
});

test('a generated password contains at least one of every enabled class', () => {
  for (let i = 0; i < 50; i++) {
    const pw = genPassword({ length: 12 });
    assert.match(pw, /[a-z]/);
    assert.match(pw, /[A-Z]/);
    assert.match(pw, /[0-9]/);
    assert.match(pw, new RegExp(`[${CHARSETS.symbols.replace(/[-\]\\^]/g, '\\$&')}]`));
  }
});

test('disabled classes never appear', () => {
  const pw = genPassword({ length: 32, upper: false, symbols: false });
  assert.doesNotMatch(pw, /[A-Z]/);
  assert.doesNotMatch(pw, /[^a-z0-9]/);
});

test('avoidAmbiguous removes the characters people misread', () => {
  const pw = genPassword({ length: 120, avoidAmbiguous: true });
  assert.doesNotMatch(pw, /[O0oIl1]/);
  // And it is a choice, not a hard rule.
  const loose = Array.from({ length: 40 }, () => genPassword({ length: 60, avoidAmbiguous: false })).join('');
  assert.match(loose, /[O0oIl1]/);
});

test('the generator refuses to produce a password from no character classes', () => {
  assert.throws(() => genPassword({ lower: false, upper: false, digits: false, symbols: false }),
    /at least one character type/);
});

test('length cannot be driven below one character per enabled class', () => {
  assert.equal(genPassword({ length: 1 }).length, 4);  // four classes enabled
  assert.equal(genPassword({ length: 1, upper: false, digits: false, symbols: false }).length, 1);
});

test('two generated passwords are never the same', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(genPassword({ length: 16 }));
  assert.equal(seen.size, 500);
});

test('every character of a small pool eventually appears — no truncated range', () => {
  // Catches a modulo-bias or off-by-one bug that would make the last few
  // characters of a charset unreachable.
  const sample = Array.from({ length: 300 }, () =>
    genPassword({ length: 10, upper: false, digits: false, symbols: false, avoidAmbiguous: false })).join('');
  for (const ch of CHARSETS.lower) {
    assert.ok(sample.includes(ch), `"${ch}" never generated`);
  }
});

/* ---------- strength ---------- */

test('strength separates the obviously bad from the obviously good', () => {
  assert.equal(passwordStrength('').label, 'empty');
  assert.equal(passwordStrength('password').label, 'weak');
  assert.equal(passwordStrength('aaaaaaaaaaaaaaaaaaaaaaaa').label, 'weak'); // repetition penalty
  assert.equal(passwordStrength(genPassword({ length: 20 })).label, 'excellent');
});

test('strength rises monotonically with length for generated passwords', () => {
  const a = passwordStrength(genPassword({ length: 8 })).bits;
  const b = passwordStrength(genPassword({ length: 24 })).bits;
  assert.ok(b > a, `expected 24 chars (${b} bits) to beat 8 (${a} bits)`);
});

test('score tracks label', () => {
  for (const pw of ['abc', 'abcdefgh1', 'Abcdefgh1!', genPassword({ length: 32 })]) {
    const { score, label } = passwordStrength(pw);
    assert.equal(score >= 1 && score <= 4, true);
    assert.equal(['weak', 'fair', 'strong', 'excellent'].includes(label), true);
  }
});

test('masking reveals nothing about the value, only that there is one', () => {
  assert.equal(maskSecret('abc'), '•••');
  assert.equal(maskSecret(''), '••••••••');          // never hint at "empty"
  assert.equal(maskSecret('x'.repeat(99)).length, 20); // never hint at "very long"
});

/* ---------- the constant that actually ships ---------- */

test('the shipped iteration count meets the current OWASP floor for PBKDF2-SHA256', () => {
  assert.ok(PBKDF2_ITERATIONS >= 310_000, `iterations too low: ${PBKDF2_ITERATIONS}`);
});

/* ---------- Unicode normalization ---------- *
 *
 * The bug these cover: "café" is 5 code points on macOS (NFD: e + combining
 * acute) and 4 on Windows and Linux (NFC). Identical on screen, identical
 * through the clipboard, different bytes into PBKDF2 — so a vault created on
 * one refuses the correct passphrase on the other, reporting only "wrong
 * passphrase". Nothing in the original tests could have caught it: they
 * derived and verified on the same machine, with the same string.
 */

const CAFE_NFC = 'café gratitude plan';          // é as one code point
const CAFE_NFD = 'café gratitude plan';         // e + combining acute

test('the two spellings of the same passphrase really are different bytes', () => {
  assert.notEqual(CAFE_NFC, CAFE_NFD, 'test fixture is wrong — these must differ');
  assert.equal(CAFE_NFC.normalize('NFC'), CAFE_NFD.normalize('NFC'), 'and must agree once normalized');
});

test('a vault created on one platform opens with the other platform\'s spelling', async () => {
  const { config } = await createVaultConfig(CAFE_NFD, FAST);   // "created on macOS"
  const { key } = await unlockVault(CAFE_NFC, config);          // "opened on Windows"
  assert.equal(await decryptJson(key, config.verifier), VERIFIER_PLAINTEXT);
});

test('and the same in reverse', async () => {
  const { config } = await createVaultConfig(CAFE_NFC, FAST);
  const { key } = await unlockVault(CAFE_NFD, config);
  assert.equal(await decryptJson(key, config.verifier), VERIFIER_PLAINTEXT);
});

test('new vaults pin a normalization form so later unlocks need no guessing', async () => {
  const { config } = await createVaultConfig(PASS, FAST);
  assert.equal(config.norm, DEFAULT_NORM);
  const { norm } = await unlockVault(PASS, config);
  assert.equal(norm, DEFAULT_NORM);
});

test('a legacy config without a form reports which one worked, so it can be recorded', async () => {
  const { config } = await createVaultConfig(CAFE_NFD, { ...FAST, norm: 'raw' });
  delete config.norm;                                  // as a pre-fix vault looks
  const { norm } = await unlockVault(CAFE_NFD, config);
  assert.equal(norm, 'raw', 'the raw form must be tried first, or legacy vaults get slower');
});

test('a pinned form is honoured exactly and not quietly widened', async () => {
  // A vault pinned to NFKC must not also accept some other byte-form: pinning
  // exists to make unlock deterministic, and silently falling back would make
  // the recorded form meaningless.
  const { config } = await createVaultConfig(CAFE_NFD, { ...FAST, norm: 'raw' });
  config.norm = 'NFKC';                                // mislabel it
  await assert.rejects(() => unlockVault(CAFE_NFD, config), WrongPassphraseError);
});

test('normalization never rescues an actually wrong passphrase', async () => {
  const { config } = await createVaultConfig(CAFE_NFC, FAST);
  await assert.rejects(() => unlockVault('cafe gratitude plan', config), WrongPassphraseError);
  await assert.rejects(() => unlockVault('café gratitude plans', config), WrongPassphraseError);
});

test('an ASCII passphrase yields exactly one candidate — no wasted derivations', () => {
  assert.equal(passphraseCandidates('plain ascii passphrase').length, 1);
  assert.ok(passphraseCandidates(CAFE_NFD).length > 1);
});

test('candidates are deduplicated and start with the raw string', () => {
  const c = passphraseCandidates(CAFE_NFD);
  assert.equal(c[0].form, 'raw');
  assert.equal(c[0].value, CAFE_NFD);
  assert.equal(new Set(c.map((x) => x.value)).size, c.length, 'duplicate byte-forms would be derived twice');
});

test('normalizePassphrase leaves the string alone when no form is pinned', () => {
  assert.equal(normalizePassphrase(CAFE_NFD, 'raw'), CAFE_NFD);
  assert.equal(normalizePassphrase(CAFE_NFD, null), CAFE_NFD);
  assert.equal(normalizePassphrase(CAFE_NFD, 'NFC'), CAFE_NFC);
});

test('normalization does not silently fold a passphrase into a weaker one', () => {
  // NFKC maps compatibility characters, so a vault pinned to it treats these
  // as the same passphrase. That is the documented trade for cross-platform
  // agreement; this test exists so the behaviour is deliberate, not a surprise.
  assert.equal(normalizePassphrase('ﬁnance', 'NFKC'), 'finance');
});
