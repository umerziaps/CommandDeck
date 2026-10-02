// Command Deck — credentials vault: crypto core.
//
// WHY THIS FILE EXISTS
// --------------------
// Google sign-in decides *who may read a document*. It says nothing about
// *what is inside it*. If passwords went into Firestore as plain text, then
// every one of these would be enough to read them:
//
//   · the Firebase console, which you are permanently signed in to
//   · a stolen laptop with a live Google session in the browser
//   · anyone who gets into the GCP project
//   · any script that manages to execute on this origin — the Firebase SDK
//     is already holding a valid token, so XSS reads the whole collection
//   · one careless edit to firestore.rules
//
// So the database never sees plain text. A master passphrase is stretched
// with PBKDF2-SHA256 into an AES-GCM key that exists only in this tab's
// memory; Firestore stores ciphertext, a random IV and the salt. An attacker
// holding a full database dump holds noise.
//
// The cost is real and there is no way to avoid it: lose the passphrase and
// the vault is unrecoverable. A reset would mean the server could decrypt,
// which is the entire thing we are buying our way out of.
//
// Everything here is pure — no DOM, no Firebase, no globals beyond WebCrypto,
// which is injectable so docs/vault.test.js can run it under `node --test`.

/* ------------------------------------------------------------------ *
 * SCHEMA
 *
 *   users/{uid}/vaultMeta/config
 *     v           number   format version (1)
 *     salt        string   base64, 16 random bytes, per-user, never secret
 *     iterations  number   PBKDF2 rounds actually used for this vault
 *     verifier    { ct, iv }  encryption of VERIFIER_PLAINTEXT under the key
 *     createdAt   string   ISO 8601
 *
 *   users/{uid}/vault/{entryId}
 *     v           number   format version (1)
 *     data        { ct, iv }  encrypted JSON: the whole entry body
 *     createdAt   string   ISO 8601
 *     updatedAt   string   ISO 8601
 *
 * Note what is NOT stored in the clear: not the title, not the site, not the
 * username. The document body is one opaque blob. Timestamps leak that an
 * entry exists and when it changed, and that is all they leak.
 * ------------------------------------------------------------------ */

export const VAULT_VERSION = 1;

// 310,000 is Bitwarden's and OWASP's current PBKDF2-SHA256 floor. It costs
// roughly a quarter-second on a laptop, which is paid once per unlock and is
// meant to be felt — that same cost is multiplied by every guess an attacker
// makes. Stored per-vault so the number can be raised later without
// stranding vaults created under the old one.
export const PBKDF2_ITERATIONS = 310_000;

export const SALT_BYTES = 16;
export const IV_BYTES = 12;          // 96 bits: the size AES-GCM is specified for
export const MIN_PASSPHRASE = 10;

// Decrypting this successfully proves the derived key is right. The GCM
// authentication tag does the actual work — a wrong key makes decryption
// throw rather than return garbage — so this is a cheap, data-free probe.
export const VERIFIER_PLAINTEXT = 'command-deck-vault-v1';

export class WrongPassphraseError extends Error {
  constructor() { super('That passphrase does not unlock this vault.'); this.name = 'WrongPassphraseError'; }
}
export class CorruptEntryError extends Error {
  constructor(id) {
    super(`Entry ${id || ''} could not be decrypted — it may have been damaged in transit.`.trim());
    this.name = 'CorruptEntryError';
  }
}

/* ---------- plumbing ---------- */

const enc = new TextEncoder();
const dec = new TextDecoder();

// Defaults to the platform's WebCrypto: window.crypto in a browser,
// globalThis.crypto in Node 19+. Injectable so tests can pin it.
const defaultCrypto = () => {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error('WebCrypto unavailable — the vault needs a secure context (https or localhost).');
  return c;
};

export function toB64(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

export function fromB64(str) {
  const s = atob(String(str));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomBytes(n, provider) {
  const c = provider || defaultCrypto();
  const b = new Uint8Array(n);
  c.getRandomValues(b);
  return b;
}

export const newSalt = (provider) => toB64(randomBytes(SALT_BYTES, provider));

/* ---------- key derivation ---------- */

export async function deriveKey(passphrase, saltB64, iterations = PBKDF2_ITERATIONS, provider) {
  const c = provider || defaultCrypto();
  if (typeof passphrase !== 'string' || passphrase.length === 0) throw new Error('Passphrase required');

  const material = await c.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);

  // extractable:false — the raw key bytes cannot be read back out of the
  // CryptoKey, so a script that gets a reference to it still cannot
  // exfiltrate something reusable offline.
  return c.subtle.deriveKey(
    { name: 'PBKDF2', salt: fromB64(saltB64), iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/* ---------- encrypt / decrypt ---------- */

// `aad` is additional authenticated data: not encrypted, but covered by the
// authentication tag. Passing the entry's document id binds the ciphertext to
// that id, so moving a blob from one document to another makes it fail to
// decrypt instead of silently appearing under the wrong entry.
export async function encryptJson(key, obj, { aad = '', provider } = {}) {
  const c = provider || defaultCrypto();
  const iv = randomBytes(IV_BYTES, c);
  const params = { name: 'AES-GCM', iv };
  if (aad) params.additionalData = enc.encode(aad);
  const ct = await c.subtle.encrypt(params, key, enc.encode(JSON.stringify(obj)));
  return { ct: toB64(ct), iv: toB64(iv) };
}

export async function decryptJson(key, blob, { aad = '', provider } = {}) {
  const c = provider || defaultCrypto();
  if (!blob || typeof blob.ct !== 'string' || typeof blob.iv !== 'string') throw new CorruptEntryError();
  const params = { name: 'AES-GCM', iv: fromB64(blob.iv) };
  if (aad) params.additionalData = enc.encode(aad);
  let plain;
  try {
    plain = await c.subtle.decrypt(params, key, fromB64(blob.ct));
  } catch (_) {
    // Wrong key, tampered ciphertext and mismatched AAD are indistinguishable
    // here by design — GCM reports only "not authentic".
    throw new WrongPassphraseError();
  }
  try { return JSON.parse(dec.decode(plain)); } catch (_) { throw new CorruptEntryError(); }
}

/* ---------- vault setup / unlock ---------- */

export async function createVaultConfig(passphrase, { iterations = PBKDF2_ITERATIONS, provider, now } = {}) {
  const salt = newSalt(provider);
  const key = await deriveKey(passphrase, salt, iterations, provider);
  const verifier = await encryptJson(key, VERIFIER_PLAINTEXT, { provider });
  return {
    key,
    config: {
      v: VAULT_VERSION,
      salt,
      iterations,
      verifier,
      createdAt: now || new Date().toISOString()
    }
  };
}

// Throws WrongPassphraseError on a bad passphrase, which is the only signal
// the caller needs — no partial unlock, no "close enough".
export async function unlockVault(passphrase, config, { provider } = {}) {
  if (!config?.salt) throw new Error('This vault has no configuration document.');
  const iterations = typeof config.iterations === 'number' && config.iterations > 0
    ? config.iterations : PBKDF2_ITERATIONS;
  const key = await deriveKey(passphrase, config.salt, iterations, provider);
  const probe = await decryptJson(key, config.verifier, { provider });
  if (probe !== VERIFIER_PLAINTEXT) throw new WrongPassphraseError();
  return key;
}

/* ---------- entries ---------- */

export const ENTRY_FIELDS = ['title', 'username', 'password', 'url', 'notes', 'catId'];

export function blankEntry() {
  return { title: '', username: '', password: '', url: '', notes: '', catId: '' };
}

// Narrows whatever came back from decryption to exactly the known fields, so
// a future format with extra keys cannot smuggle anything into the UI.
export function normaliseEntry(id, body, meta = {}) {
  const out = { id };
  for (const f of ENTRY_FIELDS) out[f] = typeof body?.[f] === 'string' ? body[f] : '';
  out.createdAt = typeof meta.createdAt === 'string' ? meta.createdAt : '';
  out.updatedAt = typeof meta.updatedAt === 'string' ? meta.updatedAt : out.createdAt;
  return out;
}

export function entryBody(entry) {
  const out = {};
  for (const f of ENTRY_FIELDS) out[f] = typeof entry?.[f] === 'string' ? entry[f] : '';
  return out;
}

export function validateEntry(entry) {
  const title = (entry?.title || '').trim();
  if (!title) return { ok: false, error: 'A name is required — it is how you will find this later.' };
  if (title.length > 200) return { ok: false, error: 'That name is too long (200 characters max).' };
  if ((entry?.notes || '').length > 20000) return { ok: false, error: 'Notes are too long (20,000 characters max).' };
  return { ok: true };
}

export function validatePassphrase(pass, confirm) {
  if ((pass || '').length < MIN_PASSPHRASE) {
    return { ok: false, error: `Use at least ${MIN_PASSPHRASE} characters. This one key protects everything else.` };
  }
  if (confirm !== undefined && pass !== confirm) return { ok: false, error: 'The two passphrases do not match.' };
  return { ok: true };
}

// Alphabetical by name, case-insensitively — a vault is something you look
// things up in, not something you order by hand.
export const entryOrder = (a, b) =>
  (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' })
  || (a.createdAt || '').localeCompare(b.createdAt || '');

// Searches decrypted entries in memory. Deliberately never touches
// `password` — typing a fragment of one password should not reveal which
// entry it belongs to.
export function vaultSearch(entries, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) =>
    ['title', 'username', 'url', 'notes'].some((f) => (e[f] || '').toLowerCase().includes(q)));
}

/* ---------- password generator ---------- */

export const CHARSETS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!#$%&*+-=?@^_~'
};
const AMBIGUOUS = 'O0oIl1';

// Modulo on a random byte biases toward the low end of the range. Rejecting
// the tail of the byte space removes that bias; it matters here because the
// bias would be concentrated in the first characters of the alphabet.
function randomIndex(max, c) {
  const limit = Math.floor(256 / max) * max;
  for (;;) {
    const b = randomBytes(1, c)[0];
    if (b < limit) return b % max;
  }
}

export function genPassword(opts = {}, provider) {
  const {
    length = 20, lower = true, upper = true, digits = true,
    symbols = true, avoidAmbiguous = true
  } = opts;

  const c = provider || defaultCrypto();
  const classes = [];
  if (lower) classes.push(CHARSETS.lower);
  if (upper) classes.push(CHARSETS.upper);
  if (digits) classes.push(CHARSETS.digits);
  if (symbols) classes.push(CHARSETS.symbols);
  if (!classes.length) throw new Error('Pick at least one character type.');

  const strip = (s) => (avoidAmbiguous ? [...s].filter((ch) => !AMBIGUOUS.includes(ch)).join('') : s);
  const pools = classes.map(strip).filter((p) => p.length);
  const all = pools.join('');
  const n = Math.max(pools.length, Math.min(128, Math.floor(length) || 20));

  // One character guaranteed from each enabled class, then fill, then
  // shuffle — otherwise "must contain a digit" would always put the digit
  // in the same position.
  const out = pools.map((p) => p[randomIndex(p.length, c)]);
  while (out.length < n) out.push(all[randomIndex(all.length, c)]);
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1, c);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}

/* ---------- strength ---------- */

// An entropy estimate, not a verdict. It assumes the attacker knows which
// character classes were used and nothing else, which is the right
// assumption for generated passwords and far too generous for human ones —
// hence the repetition penalty, which is what catches "aaaaaaaaaaaa".
export function passwordStrength(pw) {
  const s = pw || '';
  if (!s) return { bits: 0, score: 0, label: 'empty' };

  let pool = 0;
  if (/[a-z]/.test(s)) pool += 26;
  if (/[A-Z]/.test(s)) pool += 26;
  if (/[0-9]/.test(s)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(s)) pool += 32;

  const unique = new Set(s).size;
  const variety = Math.min(1, unique / Math.min(s.length, 12));
  const bits = Math.round(s.length * Math.log2(pool || 1) * variety);

  const label = bits < 40 ? 'weak' : bits < 60 ? 'fair' : bits < 80 ? 'strong' : 'excellent';
  const score = bits < 40 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
  return { bits, score, label };
}

export const maskSecret = (s) => '•'.repeat(Math.min(20, (s || '').length || 8));
