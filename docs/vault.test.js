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
  plainPunctuation, hasSmartPunctuation,
  blankEntry, normaliseEntry, entryBody, entryOrder,
  blankGroup, normaliseGroup, groupBody, groupOrder, groupById, validateGroup,
  nextEntryOrder, planReorder, isNote, entrySecret, ENTRY_KINDS, DEFAULT_KIND,
  buildEncryptedExport, buildPlainExport, parseVaultExport, readVaultExport,
  EXPORT_FORMAT, EXPORT_VERSION,
  countByGroup, filterByGroup, sectionsByGroup, entryGroupId,
  GROUP_PALETTE, UNGROUPED,
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
    url: null, notes: undefined, groupId: 7,
    isAdmin: true, __proto__: { polluted: 1 }
  }, { createdAt: '2026-01-01T00:00:00Z' });

  assert.equal(e.id, 'abc');
  assert.equal(e.title, 'GitHub');
  assert.equal(e.url, '');            // null → ''
  assert.equal(e.notes, '');          // undefined → ''
  assert.equal(e.groupId, '');        // number → ''
  assert.equal(e.isAdmin, undefined); // unknown field dropped
  assert.equal(e.updatedAt, '2026-01-01T00:00:00Z'); // defaults to createdAt
});

test('entryBody round-trips through normaliseEntry without gaining fields', () => {
  const body = entryBody({ ...blankEntry(), title: 'X', password: 'y', junk: 'no' });
  assert.deepEqual(Object.keys(body).sort(), ['groupId', 'kind', 'notes', 'password', 'title', 'url', 'username']);
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

/* ---------- typographic substitution ---------- *
 *
 * The bug this covers, found in the field: a vault created on a machine with
 * smart quotes off would not open on a machine with them on. macOS and iOS
 * replace ' with ’ and - with – as you type. Same length on screen, same
 * characters to the eye, different bytes into PBKDF2. The passphrase was
 * pure ASCII on one machine and not on the other, and nothing in the UI
 * could have shown the difference.
 */

const STRAIGHT = "don't lose this-one";
const CURLY    = 'don’t lose this–one';   // ’ and en dash

test('the two spellings differ in bytes but not in length', () => {
  assert.notEqual(STRAIGHT, CURLY);
  assert.equal(STRAIGHT.length, CURLY.length, 'same length is what makes this invisible');
  assert.equal([...STRAIGHT].some((c) => c.codePointAt(0) > 127), false);
  assert.equal([...CURLY].some((c) => c.codePointAt(0) > 127), true);
});

test('a vault created with straight quotes opens when the keyboard substitutes', async () => {
  const { config } = await createVaultConfig(STRAIGHT, FAST);
  const { key } = await unlockVault(CURLY, config);
  assert.equal(await decryptJson(key, config.verifier), VERIFIER_PLAINTEXT);
});

test('and a vault created with substitution opens from a plain keyboard', async () => {
  const { config } = await createVaultConfig(CURLY, FAST);
  const { key } = await unlockVault(STRAIGHT, config);
  assert.equal(await decryptJson(key, config.verifier), VERIFIER_PLAINTEXT);
});

test('a legacy vault with no recorded form recovers from substitution too', async () => {
  // This is the case that actually happened: the vault predates the fix, so
  // there is no form to follow and unlock has to find it.
  const { config } = await createVaultConfig(STRAIGHT, { ...FAST, norm: 'raw' });
  delete config.norm;
  const { key, norm } = await unlockVault(CURLY, config);
  assert.equal(await decryptJson(key, config.verifier), VERIFIER_PLAINTEXT);
  assert.ok(norm.endsWith('+plain'), `expected a de-substituting form, got ${norm}`);
});

test('plainPunctuation covers the substitutions these keyboards actually make', () => {
  assert.equal(plainPunctuation('‘a’'), "'a'");
  assert.equal(plainPunctuation('“b”'), '"b"');
  assert.equal(plainPunctuation('c–d—e−f'), 'c-d-e-f');
  assert.equal(plainPunctuation('g h'), 'g h');
  assert.equal(plainPunctuation('plain ascii'), 'plain ascii');
});

test('hasSmartPunctuation is stateless across repeated calls', () => {
  // A /g regex advances lastIndex between .test() calls, which would make this
  // alternate true/false on identical input. Called many times to catch it.
  for (let i = 0; i < 10; i++) {
    assert.equal(hasSmartPunctuation(CURLY), true, `flipped on call ${i}`);
    assert.equal(hasSmartPunctuation(STRAIGHT), false, `flipped on call ${i}`);
  }
  assert.equal(hasSmartPunctuation(''), false);
  assert.equal(hasSmartPunctuation(null), false);
});

test('substitution handling never rescues a genuinely wrong passphrase', async () => {
  const { config } = await createVaultConfig(STRAIGHT, FAST);
  await assert.rejects(() => unlockVault('dont lose this-one', config), WrongPassphraseError);
  await assert.rejects(() => unlockVault("don't lose this one", config), WrongPassphraseError);
  await assert.rejects(() => unlockVault("DON'T LOSE THIS-ONE", config), WrongPassphraseError);
});

test('case is never folded — that would spend real entropy', async () => {
  const { config } = await createVaultConfig('Correct Horse Battery', FAST);
  await assert.rejects(() => unlockVault('correct horse battery', config), WrongPassphraseError);
});

test('a plain ASCII passphrase still costs exactly one derivation', () => {
  assert.equal(passphraseCandidates('plain ascii passphrase').length, 1);
});

test('the candidate list stays small enough that a failed unlock is not a hang', () => {
  // Every candidate is a full PBKDF2 run at 310k rounds, so this bounds the
  // worst-case wait on a wrong passphrase.
  assert.ok(passphraseCandidates(CURLY).length <= 4, passphraseCandidates(CURLY).map((c) => c.form).join(','));
});

/* ---------- groups ---------- *
 *
 * A group is a folder over entries: "Ocufii staging VMs", "AWS". Its name and
 * colour are encrypted like everything else, so these tests exercise the model
 * rather than the storage — the ciphertext assertions above already cover
 * what reaches the wire, and groups use the same blob shape.
 */

const G = (id, name, createdAt, color = '#5EE6C5') => ({ id, name, createdAt, color });
const E = (id, title, groupId = '') => ({ id, title, groupId, createdAt: '2026-01-01T00:00:00Z' });

test('a new entry is ungrouped', () => {
  assert.equal(blankEntry().groupId, '');
});

test('groupId survives the encrypt/decrypt round trip through the entry body', async () => {
  const { key } = await createVaultConfig(PASS, FAST);
  const blob = await encryptJson(key, entryBody({ ...blankEntry(), title: 'db1', groupId: 'g-vms' }), { aad: 'e1' });
  const back = normaliseEntry('e1', await decryptJson(key, blob, { aad: 'e1' }), {});
  assert.equal(back.groupId, 'g-vms');
});

test('an entry written before groups existed reads as ungrouped, not broken', () => {
  // Old bodies carried an unused catId. It must not survive, and its absence
  // must not leave groupId undefined — the UI compares it against '' .
  const e = normaliseEntry('e1', { title: 'old', catId: 'whatever' }, {});
  assert.equal(e.groupId, '');
  assert.equal(e.catId, undefined);
});

test('blankGroup walks the palette so two groups made in a row differ', () => {
  assert.equal(blankGroup(0).color, GROUP_PALETTE[0]);
  assert.equal(blankGroup(1).color, GROUP_PALETTE[1]);
  assert.equal(blankGroup(GROUP_PALETTE.length).color, GROUP_PALETTE[0], 'palette must wrap, not run off the end');
});

test('normaliseGroup rejects a malformed colour rather than writing it into a style attribute', () => {
  assert.equal(normaliseGroup('g1', { name: 'VMs', color: 'red; background:url(x)' }).color, GROUP_PALETTE[0]);
  assert.equal(normaliseGroup('g1', { name: 'VMs', color: '#A1B2C3' }).color, '#A1B2C3');
  assert.equal(normaliseGroup('g1', { name: 'VMs' }).color, GROUP_PALETTE[0]);
});

test('groupBody keeps only the two fields that belong in a group', () => {
  assert.deepEqual(Object.keys(groupBody({ name: 'A', color: '#111111', secret: 'no' })).sort(), ['color', 'name']);
});

test('validateGroup requires a name and refuses a duplicate', () => {
  const existing = [G('g1', 'AWS', '1'), G('g2', 'Ocufii VMs', '2')];
  assert.equal(validateGroup({ name: '  ' }, existing).ok, false);
  assert.equal(validateGroup({ name: 'Azure' }, existing).ok, true);
  assert.equal(validateGroup({ name: 'aws' }, existing).ok, false, 'duplicates differing only in case are still duplicates');
  assert.equal(validateGroup({ name: 'AWS' }, existing, 'g1').ok, true, 'renaming a group to its own name is not a clash');
  assert.equal(validateGroup({ name: 'x'.repeat(61) }, existing).ok, false);
});

test('groups keep creation order, so renaming one does not reshuffle the list', () => {
  const groups = [G('g2', 'Zulu', '2026-02-01'), G('g1', 'Alpha', '2026-01-01')];
  assert.deepEqual([...groups].sort(groupOrder).map((g) => g.id), ['g1', 'g2']);
});

test('an entry pointing at a deleted group reads as ungrouped instead of vanishing', () => {
  const groups = [G('g1', 'AWS', '1')];
  assert.equal(entryGroupId(E('e1', 'a', 'g1'), groups), 'g1');
  assert.equal(entryGroupId(E('e2', 'b', 'ghost'), groups), '', 'a dangling id must not hide the credential');
  assert.equal(entryGroupId(E('e3', 'c'), groups), '');
});

test('counts cover every group, the empty ones included', () => {
  const groups = [G('g1', 'AWS', '1'), G('g2', 'VMs', '2')];
  const counts = countByGroup([E('e1', 'a', 'g1'), E('e2', 'b', 'g1'), E('e3', 'c')], groups);
  assert.equal(counts.g1, 2);
  assert.equal(counts.g2, 0, 'a group you just made must not be missing from the bar');
  assert.equal(counts[UNGROUPED], 1);
});

test('a dangling group id is counted as ungrouped, not as its own phantom group', () => {
  const counts = countByGroup([E('e1', 'a', 'ghost')], [G('g1', 'AWS', '1')]);
  assert.equal(counts[UNGROUPED], 1);
  assert.equal(counts.ghost, undefined);
});

test('filtering by group, by ungrouped, and by nothing', () => {
  const groups = [G('g1', 'AWS', '1')];
  const entries = [E('e1', 'a', 'g1'), E('e2', 'b'), E('e3', 'c', 'ghost')];
  assert.deepEqual(filterByGroup(entries, groups, 'g1').map((e) => e.id), ['e1']);
  assert.deepEqual(filterByGroup(entries, groups, UNGROUPED).map((e) => e.id), ['e2', 'e3']);
  assert.equal(filterByGroup(entries, groups, '').length, 3);
});

test('sections appear in group order with ungrouped last', () => {
  const groups = [G('g2', 'VMs', '2026-02-01'), G('g1', 'AWS', '2026-01-01')];
  const secs = sectionsByGroup([E('e1', 'a', 'g1'), E('e2', 'b'), E('e3', 'c', 'g2')], groups);
  assert.deepEqual(secs.map((s) => s.group?.name ?? 'Ungrouped'), ['AWS', 'VMs', 'Ungrouped']);
  assert.deepEqual(secs.at(-1).entries.map((e) => e.id), ['e2']);
});

test('the ungrouped section is omitted when nothing is ungrouped', () => {
  const groups = [G('g1', 'AWS', '1')];
  const secs = sectionsByGroup([E('e1', 'a', 'g1')], groups);
  assert.equal(secs.length, 1);
  assert.equal(secs[0].group.id, 'g1');
});

test('empty groups still get a section, so a new group does not look like it failed', () => {
  const secs = sectionsByGroup([], [G('g1', 'AWS', '1')]);
  assert.equal(secs.length, 1);
  assert.deepEqual(secs[0].entries, []);
});

test('sections never lose or duplicate an entry', () => {
  const groups = [G('g1', 'AWS', '1'), G('g2', 'VMs', '2')];
  const entries = [E('e1', 'a', 'g1'), E('e2', 'b', 'g2'), E('e3', 'c'), E('e4', 'd', 'ghost')];
  const ids = sectionsByGroup(entries, groups).flatMap((s) => s.entries.map((e) => e.id)).sort();
  assert.deepEqual(ids, ['e1', 'e2', 'e3', 'e4']);
});

test('entries are sorted by name inside each section', () => {
  const groups = [G('g1', 'AWS', '1')];
  const secs = sectionsByGroup([E('e1', 'zoom', 'g1'), E('e2', 'Apple', 'g1')], groups);
  assert.deepEqual(secs[0].entries.map((e) => e.title), ['Apple', 'zoom']);
});

test('groupById returns null rather than undefined for a missing group', () => {
  assert.equal(groupById([G('g1', 'AWS', '1')], 'nope'), null);
  assert.equal(groupById([], 'g1'), null);
});

/* ---------- hand-chosen position ---------- */

const O = (id, title, order, groupId = '') =>
  ({ id, title, order, groupId, createdAt: '2026-01-01T00:00:00Z' });

test('order comes from the document, not the ciphertext', () => {
  assert.equal(normaliseEntry('e1', { title: 'a' }, { order: 7 }).order, 7);
  assert.equal(normaliseEntry('e1', { title: 'a' }, {}).order, 0, 'missing order must not be NaN');
  assert.equal(normaliseEntry('e1', { title: 'a' }, { order: 'x' }).order, 0);
  assert.equal(normaliseEntry('e1', { title: 'a' }, { order: Infinity }).order, 0);
});

test('a vault nobody has dragged is still alphabetical', () => {
  // Everything starts at order 0, so positioning costs nothing until used.
  const names = [O('1', 'zoom', 0), O('2', 'Apple', 0), O('3', 'bank', 0)]
    .sort(entryOrder).map((e) => e.title);
  assert.deepEqual(names, ['Apple', 'bank', 'zoom']);
});

test('once dragged, position beats the alphabet', () => {
  const names = [O('1', 'Apple', 2), O('2', 'bank', 0), O('3', 'zoom', 1)]
    .sort(entryOrder).map((e) => e.title);
  assert.deepEqual(names, ['bank', 'zoom', 'Apple']);
});

test('a new entry lands at the bottom of its own group, not the vault', () => {
  const entries = [O('1', 'a', 0, 'g1'), O('2', 'b', 1, 'g1'), O('3', 'c', 5, '')];
  const groups = [G('g1', 'VMs', '1')];
  assert.equal(nextEntryOrder(entries, groups, 'g1'), 2);
  assert.equal(nextEntryOrder(entries, groups, ''), 6);
  assert.equal(nextEntryOrder([], groups, 'g1'), 0);
});

test('dragging a row down rewrites only the rows that actually moved', () => {
  const groups = [];
  const entries = [O('a', 'a', 0), O('b', 'b', 1), O('c', 'c', 2), O('d', 'd', 3)];
  const plan = planReorder(entries, groups, 'a', 'c', true);   // a to just after c
  assert.deepEqual(plan.positions, [{ id: 'b', order: 0 }, { id: 'c', order: 1 }, { id: 'a', order: 2 }]);
  assert.equal(plan.positions.some((p) => p.id === 'd'), false, 'd never moved and must not be written');
  assert.equal(plan.movedToGroup, null);
});

test('dragging a row up puts it above the target', () => {
  const entries = [O('a', 'a', 0), O('b', 'b', 1), O('c', 'c', 2)];
  const plan = planReorder(entries, [], 'c', 'a', false);
  const final = [...entries].map((e) => {
    const moved = plan.positions.find((p) => p.id === e.id);
    return { id: e.id, order: moved ? moved.order : e.order };
  }).sort((x, y) => x.order - y.order).map((e) => e.id);
  assert.deepEqual(final, ['c', 'a', 'b']);
});

test('dropping into another group reports the move so only that row is re-encrypted', () => {
  const groups = [G('g1', 'AWS', '1'), G('g2', 'VMs', '2')];
  const entries = [O('a', 'a', 0, 'g1'), O('b', 'b', 0, 'g2'), O('c', 'c', 1, 'g2')];
  const plan = planReorder(entries, groups, 'a', 'c', false);
  assert.equal(plan.movedToGroup, 'g2');
  assert.equal(plan.sourceId, 'a');
  assert.deepEqual(plan.positions.map((p) => p.id).sort(), ['a', 'c']);
});

test('a drag within one group never reports a group change', () => {
  const groups = [G('g1', 'AWS', '1')];
  const entries = [O('a', 'a', 0, 'g1'), O('b', 'b', 1, 'g1')];
  assert.equal(planReorder(entries, groups, 'a', 'b', true).movedToGroup, null);
});

test('a drag that goes nowhere is refused rather than writing a no-op', () => {
  const entries = [O('a', 'a', 0), O('b', 'b', 1)];
  assert.equal(planReorder(entries, [], 'a', 'a', false), null);
  assert.equal(planReorder(entries, [], 'ghost', 'b', false), null);
  assert.equal(planReorder(entries, [], 'a', 'ghost', false), null);
});

test('reordering never loses an entry', () => {
  const entries = [O('a', 'a', 0), O('b', 'b', 1), O('c', 'c', 2), O('d', 'd', 3)];
  for (const [src, tgt, after] of [['a','d',true], ['d','a',false], ['b','c',true], ['c','b',false]]) {
    const plan = planReorder(entries, [], src, tgt, after);
    const positions = new Map(plan.positions.map((p) => [p.id, p.order]));
    const final = entries.map((e) => ({ id: e.id, order: positions.has(e.id) ? positions.get(e.id) : e.order }));
    assert.equal(new Set(final.map((e) => e.id)).size, 4, `${src}->${tgt} lost an entry`);
    assert.equal(new Set(final.map((e) => e.order)).size, 4, `${src}->${tgt} produced a duplicate position`);
  }
});

/* ---------- export and restore ---------- */

test('an encrypted export carries ciphertext and the inputs needed to open it', async () => {
  const { config, key } = await createVaultConfig(PASS, FAST);
  const blob = await encryptJson(key, entryBody({ ...blankEntry(), title: 'Chase Bank', password: 'S3cr3t!' }), { aad: 'e1' });
  const file = buildEncryptedExport(config, [], [{ id: 'e1', data: blob, createdAt: 'x', order: 0 }]);

  assert.equal(file.format, EXPORT_FORMAT);
  assert.equal(file.encrypted, true);
  assert.equal(file.kdf.salt, config.salt);
  assert.equal(file.kdf.iterations, config.iterations);

  const wire = JSON.stringify(file);
  assert.ok(!wire.includes('Chase Bank'), 'an encrypted export must not contain readable data');
  assert.ok(!wire.includes('S3cr3t'), 'an encrypted export must not contain readable data');
  assert.ok(!wire.includes(PASS), 'the passphrase must never be written to a file');
});

test('an encrypted export round-trips back to the original entries', async () => {
  const { config, key } = await createVaultConfig(PASS, FAST);
  const entry = { ...blankEntry(), title: 'db1', username: 'postgres', password: 'pw', groupId: 'g1' };
  const file = buildEncryptedExport(
    config,
    [{ id: 'g1', data: await encryptJson(key, groupBody({ name: 'VMs', color: '#5EE6C5' }), { aad: 'g1' }), createdAt: 'x' }],
    [{ id: 'e1', data: await encryptJson(key, entryBody(entry), { aad: 'e1' }), createdAt: 'x', order: 3 }]
  );

  const back = await readVaultExport(file, PASS);
  assert.equal(back.entries.length, 1);
  assert.equal(back.entries[0].title, 'db1');
  assert.equal(back.entries[0].password, 'pw');
  assert.equal(back.entries[0].groupId, 'g1');
  assert.equal(back.entries[0].order, 3, 'positions survive a backup');
  assert.equal(back.groups[0].name, 'VMs');
  assert.deepEqual(back.skipped, []);
});

test('a backup refuses to open with the wrong passphrase', async () => {
  const { config, key } = await createVaultConfig(PASS, FAST);
  const file = buildEncryptedExport(config, [], [
    { id: 'e1', data: await encryptJson(key, entryBody(blankEntry()), { aad: 'e1' }), createdAt: 'x', order: 0 }
  ]);
  await assert.rejects(() => readVaultExport(file, 'not the passphrase'), WrongPassphraseError);
});

test('one damaged entry is skipped rather than sinking the whole restore', async () => {
  const { config, key } = await createVaultConfig(PASS, FAST);
  const good = await encryptJson(key, entryBody({ ...blankEntry(), title: 'fine' }), { aad: 'e1' });
  const file = buildEncryptedExport(config, [], [
    { id: 'e1', data: good, createdAt: 'x', order: 0 },
    { id: 'e2', data: { ct: 'bm90IHJlYWw=', iv: 'bm90IHJlYWxpdg==' }, createdAt: 'x', order: 1 }
  ]);
  const back = await readVaultExport(file, PASS);
  assert.deepEqual(back.entries.map((e) => e.title), ['fine']);
  assert.deepEqual(back.skipped, ['e2']);
});

test('a plaintext export is readable, says so, and resolves group names', () => {
  const groups = [G('g1', 'Ocufii staging VMs', '1')];
  const entries = [{ ...blankEntry(), id: 'e1', title: 'db1', password: 'pw', groupId: 'g1', order: 0 }];
  const file = buildPlainExport(entries, groups);

  assert.equal(file.encrypted, false);
  assert.match(file.warning, /PLAINTEXT/);
  assert.equal(file.entries[0].password, 'pw');
  assert.equal(file.entries[0].group, 'Ocufii staging VMs', 'a group id would be useless in another tool');
});

test('a plaintext export names no group for an ungrouped entry rather than a dangling id', () => {
  const file = buildPlainExport([{ ...blankEntry(), id: 'e1', title: 'x', groupId: 'ghost' }], []);
  assert.equal(file.entries[0].group, '');
});

test('parse refuses anything that is not a backup', () => {
  assert.equal(parseVaultExport('not json').ok, false);
  assert.equal(parseVaultExport('{"format":"something-else"}').ok, false);
  assert.equal(parseVaultExport(JSON.stringify({ format: EXPORT_FORMAT, version: EXPORT_VERSION + 9 })).ok, false);
});

test('parse refuses a plaintext export, which is not a restore source', () => {
  const plain = buildPlainExport([], []);
  const res = parseVaultExport(JSON.stringify(plain));
  assert.equal(res.ok, false);
  assert.match(res.error, /plaintext/i);
});

test('parse refuses a backup stripped of its key material', () => {
  const broken = { format: EXPORT_FORMAT, version: 1, encrypted: true, entries: [] };
  assert.equal(parseVaultExport(JSON.stringify(broken)).ok, false);
});

test('parse accepts a real one', async () => {
  const { config, key } = await createVaultConfig(PASS, FAST);
  const file = buildEncryptedExport(config, [], [
    { id: 'e1', data: await encryptJson(key, entryBody(blankEntry()), { aad: 'e1' }), createdAt: 'x', order: 0 }
  ]);
  assert.equal(parseVaultExport(JSON.stringify(file)).ok, true);
});

test('exporting a vault with no config is refused rather than producing a useless file', () => {
  assert.throws(() => buildEncryptedExport(null, [], []), /no configuration/);
  assert.throws(() => buildEncryptedExport({ salt: 'x' }, [], []), /no configuration/);
});

test('a new entry in an untouched group keeps the list alphabetical', () => {
  // Caught by the browser tests: handing each new entry the next position
  // turned the vault into insertion order after the second credential.
  const groups = [G('g1', 'VMs', '1')];
  const untouched = [O('1', 'charlie', 0, 'g1'), O('2', 'alpha', 0, 'g1')];
  assert.equal(nextEntryOrder(untouched, groups, 'g1'), 0);

  const after = [...untouched, O('3', 'bravo', 0, 'g1')].sort(entryOrder).map((e) => e.title);
  assert.deepEqual(after, ['alpha', 'bravo', 'charlie']);
});

test('once a group is arranged by hand, new entries go to the bottom of it', () => {
  const groups = [G('g1', 'VMs', '1')];
  const arranged = [O('1', 'charlie', 0, 'g1'), O('2', 'alpha', 1, 'g1')];
  assert.equal(nextEntryOrder(arranged, groups, 'g1'), 2);
});

/* ---------- secure notes ---------- *
 *
 * A note is the same encrypted document as a login. What changes is which
 * field holds the secret, and every code path that touches a secret has to
 * agree about that — a disagreement would mean a note's body rendered in the
 * clear, or a password treated as prose and searched.
 */

const note = (over = {}) => ({ ...blankEntry(), kind: 'note', title: 'Recovery codes', notes: 'aaa-bbb\nccc-ddd', ...over });
const login = (over = {}) => ({ ...blankEntry(), title: 'Bank', username: 'me', password: 'pw', ...over });

test('a new entry is a login unless told otherwise', () => {
  assert.equal(blankEntry().kind, DEFAULT_KIND);
  assert.equal(DEFAULT_KIND, 'login');
});

test('the secret of an entry depends on what kind it is', () => {
  assert.equal(entrySecret(login()), 'pw');
  assert.equal(entrySecret(note()), 'aaa-bbb\nccc-ddd');
  assert.equal(entrySecret(note({ notes: '' })), '');
  assert.equal(entrySecret(null), '');
});

test('entries written before notes existed read as logins', () => {
  const e = normaliseEntry('e1', { title: 'old', password: 'pw' }, {});
  assert.equal(e.kind, 'login');
  assert.equal(entrySecret(e), 'pw');
});

test('an unrecognised kind falls back to login rather than rendering nothing', () => {
  // Hiding a credential because a string was not recognised is worse than
  // showing it in the wrong shape.
  const e = normaliseEntry('e1', { title: 'x', kind: 'something-new', password: 'pw' }, {});
  assert.equal(e.kind, 'login');
  assert.equal(ENTRY_KINDS.includes(e.kind), true);
});

test('kind survives the encrypt/decrypt round trip', async () => {
  const { key } = await createVaultConfig(PASS, FAST);
  const blob = await encryptJson(key, entryBody(note()), { aad: 'n1' });
  const back = normaliseEntry('n1', await decryptJson(key, blob, { aad: 'n1' }), {});
  assert.equal(back.kind, 'note');
  assert.equal(isNote(back), true);
  assert.equal(entrySecret(back), 'aaa-bbb\nccc-ddd');
});

test('a note body never reaches storage in plain text', async () => {
  const { key } = await createVaultConfig(PASS, FAST);
  const blob = await encryptJson(key, entryBody(note({ notes: 'ocufii-root-recovery-7781' })), { aad: 'n1' });
  assert.ok(!JSON.stringify(blob).includes('ocufii-root-recovery'));
  assert.ok(!JSON.stringify(blob).includes('Recovery codes'));
});

test('a note needs a body; a login does not need a password', () => {
  assert.equal(validateEntry(note({ notes: '   ' })).ok, false);
  assert.equal(validateEntry(note()).ok, true);
  // Plenty of logins are worth recording for the username alone.
  assert.equal(validateEntry(login({ password: '' })).ok, true);
});

test('a note still needs a name', () => {
  assert.equal(validateEntry(note({ title: '' })).ok, false);
});

test('search reads a note body but never a password', () => {
  const entries = [
    note({ title: 'Recovery codes', notes: 'zebra-unique-token' }),
    login({ title: 'Bank', password: 'llama-unique-token' })
  ];
  assert.equal(vaultSearch(entries, 'zebra-unique-token').length, 1, 'a note body is content and should be findable');
  assert.equal(vaultSearch(entries, 'llama-unique-token').length, 0, 'a password must never be searchable');
});

test('a plaintext export gives a note a body, not empty credential columns', () => {
  const file = buildPlainExport([note({ id: 'n1' }), login({ id: 'e1' })], []);
  const n = file.entries.find((e) => e.kind === 'note');
  const l = file.entries.find((e) => e.kind === 'login');

  assert.equal(n.body, 'aaa-bbb\nccc-ddd');
  assert.equal('password' in n, false, '"no password" would misread as a login with none set');
  assert.equal('username' in n, false);
  assert.equal(l.password, 'pw');
  assert.equal('body' in l, false);
});

test('a note round-trips through an encrypted backup', async () => {
  const { config, key } = await createVaultConfig(PASS, FAST);
  const file = buildEncryptedExport(config, [], [
    { id: 'n1', data: await encryptJson(key, entryBody(note()), { aad: 'n1' }), createdAt: 'x', order: 0 }
  ]);
  const back = await readVaultExport(file, PASS);
  assert.equal(back.entries[0].kind, 'note');
  assert.equal(entrySecret(back.entries[0]), 'aaa-bbb\nccc-ddd');
});

test('notes and logins sort and group together, with no special casing', () => {
  const groups = [G('g1', 'Ops', '1')];
  const entries = [
    note({ id: 'n1', title: 'zeta note', groupId: 'g1', order: 0 }),
    login({ id: 'e1', title: 'alpha login', groupId: 'g1', order: 0 })
  ];
  const secs = sectionsByGroup(entries, groups);
  assert.deepEqual(secs[0].entries.map((e) => e.title), ['alpha login', 'zeta note']);
});
