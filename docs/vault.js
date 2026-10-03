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

/* ---------- what the keyboard did to the passphrase ---------- *
 *
 * PBKDF2 consumes bytes, not characters, and the same passphrase typed by the
 * same person can be different bytes on different machines. Two ways:
 *
 *   Normalization. "café" is five code points on macOS, which stores it
 *   decomposed (e + combining acute), and four on Windows and Linux, which
 *   compose it.
 *
 *   Substitution. The operating system silently replaces straight quotes with
 *   typographic ones and hyphens with dashes as you type: ' becomes ’, -
 *   becomes –. On by default on macOS and iOS, off on Windows and Linux.
 *
 * In both cases the passphrase looks identical on screen, survives the
 * clipboard unchanged, and derives a different key. The only symptom the user
 * ever sees is "wrong passphrase" on one machine and not the other — which is
 * exactly how this was found.
 *
 * New vaults canonicalize both and record the form, so there is nothing to
 * guess. Older vaults have no recorded form, so unlock tries each candidate
 * until one authenticates and reports which worked, so the caller can write it
 * back. The key never changes, so nothing is re-encrypted.
 *
 * Folding ’ onto ' costs a sliver of entropy — it merges a handful of
 * visually identical pairs. Set against a vault that cannot be opened on half
 * your devices, that is a trade worth making, and it is made deliberately.
 * Case is NOT folded: that would throw away real entropy from the one secret
 * protecting everything else.
 */
export const DEFAULT_NORM = 'NFKC+plain';
const NORM_FORMS = ['NFC', 'NFD', 'NFKC', 'NFKD'];

const SMART = [
  [/[‘’‚‛′]/g, "'"],   // ‘ ’ ‚ ‛ ′
  [/[“”„‟″]/g, '"'],   // “ ” „ ‟ ″
  [/[‐-―−]/g, '-'],              // ‐ ‑ ‒ – — ― −
  [/…/g, '...'],                           // …
  [/ /g, ' ']                              // no-break space
];

// A /g regex carries lastIndex across .test() calls, so testing with the same
// objects used for .replace() would return a different answer every other
// call. Non-global copies, built once, keep it stateless.
const SMART_TEST = SMART.map(([re]) => new RegExp(re.source));
export const hasSmartPunctuation = (s) => SMART_TEST.some((re) => re.test(s || ''));

export function plainPunctuation(s) {
  let out = s;
  for (const [re, to] of SMART) out = out.replace(re, to);
  return out;
}

// A form is a normalization name, optionally suffixed "+plain" to mean the
// typographic substitutions are undone first. 'raw' means the string as typed.
export function normalizePassphrase(pass, form) {
  if (!form || form === 'raw') return pass;
  const [norm, ...flags] = String(form).split('+');
  let out = flags.includes('plain') ? plainPunctuation(pass) : pass;
  if (norm && norm !== 'raw') out = out.normalize(norm);
  return out;
}

// Distinct byte-forms worth trying, raw first — that is what vaults predating
// this used, and trying it first keeps their unlock a single derivation.
// Duplicates are dropped, so a plain ASCII passphrase yields exactly one
// candidate and costs exactly one PBKDF2 run.
export function passphraseCandidates(pass) {
  const forms = ['raw'];
  for (const n of NORM_FORMS) forms.push(n);
  forms.push('raw+plain');
  for (const n of NORM_FORMS) forms.push(`${n}+plain`);

  const out = [];
  for (const form of forms) {
    let value;
    try { value = normalizePassphrase(pass, form); } catch (_) { continue; }
    if (!out.some((c) => c.value === value)) out.push({ form, value });
  }
  return out;
}

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

export async function createVaultConfig(passphrase, { iterations = PBKDF2_ITERATIONS, provider, now, norm = DEFAULT_NORM } = {}) {
  const salt = newSalt(provider);
  const key = await deriveKey(normalizePassphrase(passphrase, norm), salt, iterations, provider);
  const verifier = await encryptJson(key, VERIFIER_PLAINTEXT, { provider });
  return {
    key,
    norm,
    config: {
      v: VAULT_VERSION,
      salt,
      iterations,
      norm,
      verifier,
      createdAt: now || new Date().toISOString()
    }
  };
}

// Returns { key, norm }. `norm` is the byte-form that actually authenticated:
// when the config did not record one, the caller should write it back so the
// next unlock does one derivation instead of up to five.
//
// Throws WrongPassphraseError when no candidate authenticates. There is no
// partial unlock and no "close enough".
export async function unlockVault(passphrase, config, { provider } = {}) {
  if (!config?.salt) throw new Error('This vault has no configuration document.');
  const iterations = typeof config.iterations === 'number' && config.iterations > 0
    ? config.iterations : PBKDF2_ITERATIONS;

  const candidates = config.norm
    ? [{ form: config.norm, value: normalizePassphrase(passphrase, config.norm) }]
    : passphraseCandidates(passphrase);

  for (const { form, value } of candidates) {
    const key = await deriveKey(value, config.salt, iterations, provider);
    try {
      const probe = await decryptJson(key, config.verifier, { provider });
      if (probe === VERIFIER_PLAINTEXT) return { key, norm: form };
    } catch (err) {
      if (!(err instanceof WrongPassphraseError)) throw err;
    }
  }
  throw new WrongPassphraseError();
}

/* ---------- entries ---------- */

// `groupId` replaced an unused `catId` placeholder. Nothing was ever written
// into it, so there is no migration: an older entry decrypts, the unknown key
// is dropped by normaliseEntry, and groupId defaults to '' — ungrouped.
export const ENTRY_FIELDS = ['title', 'username', 'password', 'url', 'notes', 'groupId'];

export function blankEntry() {
  return { title: '', username: '', password: '', url: '', notes: '', groupId: '' };
}

// Narrows whatever came back from decryption to exactly the known fields, so
// a future format with extra keys cannot smuggle anything into the UI.
export function normaliseEntry(id, body, meta = {}) {
  const out = { id };
  for (const f of ENTRY_FIELDS) out[f] = typeof body?.[f] === 'string' ? body[f] : '';
  out.createdAt = typeof meta.createdAt === 'string' ? meta.createdAt : '';
  out.updatedAt = typeof meta.updatedAt === 'string' ? meta.updatedAt : out.createdAt;

  // `order` sits OUTSIDE the ciphertext, on the document itself.
  //
  // It is a hand-chosen position, so it leaks nothing a reader does not
  // already have: they can see how many entries exist, and the order of a
  // list says nothing about what is in it. In exchange, dragging a row
  // rewrites a plain integer on each affected document instead of
  // re-encrypting every one of them. groupId stays encrypted, because the
  // group a credential belongs to IS information about the credential.
  out.order = typeof meta.order === 'number' && Number.isFinite(meta.order) ? meta.order : 0;
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
// Hand-ordered first, then alphabetical. Every entry starts at order 0, so a
// vault nobody has dragged is in exactly the alphabetical order it was before
// positioning existed — the feature costs nothing until it is used.
export const entryOrder = (a, b) =>
  ((a.order || 0) - (b.order || 0))
  || (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' })
  || (a.createdAt || '').localeCompare(b.createdAt || '');

/**
 * Where a new entry lands.
 *
 * In a group nobody has arranged by hand, every entry sits at 0 and the list
 * is alphabetical — so a new one gets 0 too and slots in by name. Handing it
 * the next position instead would quietly convert the group to insertion
 * order the moment a second credential was added, which is not an order
 * anyone chose and not one that helps you find anything.
 *
 * Once a group HAS been arranged, a new entry goes to the bottom of it, where
 * it will not disturb an order someone deliberately set.
 */
export function nextEntryOrder(entries, groups, groupId) {
  const peers = entries.filter((e) => entryGroupId(e, groups) === (groupId || ''));
  const arranged = peers.some((e) => (e.order || 0) !== 0);
  if (!arranged) return 0;
  return Math.max(...peers.map((e) => e.order || 0)) + 1;
}

/**
 * Works out the new positions after dragging `sourceId` onto `targetId`.
 *
 * Returns only the entries whose stored position actually changes, so a drag
 * that moves one row by one place writes two documents rather than all of
 * them. The dragged entry's `groupId` comes back separately when the drop
 * crossed into another group — that one needs re-encrypting, the rest do not.
 */
export function planReorder(entries, groups, sourceId, targetId, after = false) {
  const src = entries.find((e) => e.id === sourceId);
  if (!src || sourceId === targetId) return null;

  const tgt = targetId ? entries.find((e) => e.id === targetId) : null;
  const destGroup = tgt ? entryGroupId(tgt, groups) : (targetId === null ? '' : null);
  if (destGroup === null) return null;

  const ordered = entries
    .filter((e) => entryGroupId(e, groups) === destGroup && e.id !== sourceId)
    .sort(entryOrder);

  const idx = tgt ? ordered.findIndex((e) => e.id === targetId) : -1;
  ordered.splice(idx < 0 ? ordered.length : (after ? idx + 1 : idx), 0, src);

  const moved = entryGroupId(src, groups) !== destGroup;
  const positions = [];
  ordered.forEach((e, n) => {
    if ((e.order || 0) !== n) positions.push({ id: e.id, order: n });
    else if (e.id === sourceId && moved) positions.push({ id: e.id, order: n });
  });

  return { positions, movedToGroup: moved ? destGroup : null, sourceId };
}

// Searches decrypted entries in memory. Deliberately never touches
// `password` — typing a fragment of one password should not reveal which
// entry it belongs to.
export function vaultSearch(entries, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) =>
    ['title', 'username', 'url', 'notes'].some((f) => (e[f] || '').toLowerCase().includes(q)));
}

/* ---------- groups ---------- *
 *
 * A group is a folder: "Ocufii staging VMs", "AWS", "personal". Entries carry
 * a groupId; the group's own name and colour live in their own documents.
 *
 * Those names are encrypted exactly like entries are. It would have been far
 * less code to reuse the board's plaintext categories, and the result would
 * have been a database that cannot show you a password but will happily tell
 * anyone who reads it that you keep credentials for "Ocufii production
 * database". The group name is often the most sensitive string in the record:
 * it says what the credential is FOR. Encrypting the secret and publishing the
 * label would be security theatre.
 *
 * Deleting a group never deletes its entries. They fall back to ungrouped,
 * because losing a credential to a mis-click on a folder is not a trade
 * anyone would accept.
 */

export const GROUP_FIELDS = ['name', 'color'];

// Distinguishable in both themes and at the 10px dot used in the filter bar.
export const GROUP_PALETTE = [
  '#5EE6C5', '#7C89F0', '#F0B45E', '#FF6B54',
  '#58C4F0', '#C98BF0', '#8FD35A', '#F07EA8'
];

export const UNGROUPED = '__ungrouped__';

export function blankGroup(existingCount = 0) {
  return { name: '', color: GROUP_PALETTE[existingCount % GROUP_PALETTE.length] };
}

export function normaliseGroup(id, body, meta = {}) {
  const name = typeof body?.name === 'string' ? body.name : '';
  let color = typeof body?.color === 'string' ? body.color : '';
  if (!/^#[0-9A-Fa-f]{6}$/.test(color)) color = GROUP_PALETTE[0];
  return {
    id,
    name,
    color,
    createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : ''
  };
}

export function groupBody(group) {
  const out = {};
  for (const f of GROUP_FIELDS) out[f] = typeof group?.[f] === 'string' ? group[f] : '';
  return out;
}

export function validateGroup(group, existing = [], selfId = null) {
  const name = (group?.name || '').trim();
  if (!name) return { ok: false, error: 'Give the group a name.' };
  if (name.length > 60) return { ok: false, error: 'That name is too long (60 characters max).' };
  const clash = existing.some((g) =>
    g.id !== selfId && (g.name || '').trim().toLowerCase() === name.toLowerCase());
  if (clash) return { ok: false, error: 'You already have a group with that name.' };
  return { ok: true };
}

// Oldest first, so the order groups were created in is the order they appear.
// Alphabetical would reshuffle the whole list the moment one is renamed.
export const groupOrder = (a, b) =>
  (a.createdAt || '').localeCompare(b.createdAt || '')
  || (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });

export const groupById = (groups, id) => groups.find((g) => g.id === id) || null;

// An entry whose groupId points at a group that no longer exists reads as
// ungrouped rather than vanishing. Deleting a group rewrites its entries, but
// a failed write, a half-synced device or a stale cache can leave a dangling
// id, and silently hiding credentials would be the worst possible response.
export function entryGroupId(entry, groups) {
  const id = entry?.groupId || '';
  return id && groups.some((g) => g.id === id) ? id : '';
}

export function countByGroup(entries, groups) {
  const counts = { [UNGROUPED]: 0 };
  for (const g of groups) counts[g.id] = 0;
  for (const e of entries) {
    const id = entryGroupId(e, groups) || UNGROUPED;
    counts[id] = (counts[id] || 0) + 1;
  }
  return counts;
}

export function filterByGroup(entries, groups, groupFilter) {
  if (!groupFilter) return entries;
  if (groupFilter === UNGROUPED) return entries.filter((e) => !entryGroupId(e, groups));
  return entries.filter((e) => entryGroupId(e, groups) === groupFilter);
}

// Buckets entries into sections in group order, with ungrouped last. Empty
// groups are kept so a group you just made does not look like it failed.
export function sectionsByGroup(entries, groups) {
  const ordered = [...groups].sort(groupOrder);
  const sections = ordered.map((g) => ({ group: g, entries: [] }));
  const index = new Map(sections.map((s) => [s.group.id, s]));
  const loose = { group: null, entries: [] };

  for (const e of entries) {
    const id = entryGroupId(e, groups);
    (index.get(id) || loose).entries.push(e);
  }
  for (const s of sections) s.entries.sort(entryOrder);
  loose.entries.sort(entryOrder);

  return loose.entries.length ? [...sections, loose] : sections;
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

/* ---------- export and restore ---------- *
 *
 * Two shapes, because they answer different questions.
 *
 *   ENCRYPTED — the documents exactly as Firestore holds them, plus the salt
 *   and iteration count needed to derive the key again. Safe in a Downloads
 *   folder, a Time Machine snapshot, a Drive sync, an email to yourself. Worth
 *   nothing to anyone without the passphrase, including you, which is the
 *   whole point and also the whole risk.
 *
 *   PLAINTEXT — every credential, readable. The only form that gets you into
 *   1Password or Bitwarden, and the only form that is dangerous the moment it
 *   touches disk: Spotlight indexes it, Time Machine copies it, cloud sync
 *   uploads it, and nothing about a .json file in Downloads says "this is
 *   every password I own".
 *
 * So plaintext is not a convenience here. The UI makes you re-enter the master
 * passphrase for it even when the vault is already open: a vault left unlocked
 * on a shared screen should not be one click from a complete dump.
 */

export const EXPORT_FORMAT = 'command-deck-vault';
export const EXPORT_VERSION = 1;

export function buildEncryptedExport(config, groupDocs, entryDocs, { now } = {}) {
  if (!config?.salt || !config?.verifier) throw new Error('This vault has no configuration to export.');
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    encrypted: true,
    exportedAt: now || new Date().toISOString(),
    // Not secrets: the salt and the round count are public inputs to PBKDF2.
    // They are here because without them the ciphertext below is undecryptable
    // even with the right passphrase.
    kdf: {
      salt: config.salt,
      iterations: config.iterations || PBKDF2_ITERATIONS,
      norm: config.norm || null
    },
    verifier: config.verifier,
    groups: groupDocs.map((g) => ({ id: g.id, data: g.data, createdAt: g.createdAt || '' })),
    entries: entryDocs.map((e) => ({
      id: e.id, data: e.data, createdAt: e.createdAt || '',
      updatedAt: e.updatedAt || '', order: typeof e.order === 'number' ? e.order : 0
    }))
  };
}

export function buildPlainExport(entries, groups, { now } = {}) {
  const name = (id) => groupById(groups, id)?.name || '';
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    encrypted: false,
    // Stated in the file itself, so that a copy found later on a disk explains
    // what it is without anyone having to open and read every field.
    warning: 'PLAINTEXT. Every credential below is readable. Delete this file once you have used it.',
    exportedAt: now || new Date().toISOString(),
    groups: [...groups].sort(groupOrder).map((g) => ({ name: g.name, color: g.color })),
    entries: [...entries].sort(entryOrder).map((e) => ({
      title: e.title, username: e.username, password: e.password,
      url: e.url, notes: e.notes, group: name(entryGroupId(e, groups)),
      createdAt: e.createdAt
    }))
  };
}

/** Parses a backup file and refuses anything that is not one. */
export function parseVaultExport(text) {
  let data;
  try { data = JSON.parse(text); } catch (_) {
    return { ok: false, error: 'That file is not valid JSON.' };
  }
  if (data?.format !== EXPORT_FORMAT) {
    return { ok: false, error: 'That is not a Command Deck vault backup.' };
  }
  if (typeof data.version !== 'number' || data.version > EXPORT_VERSION) {
    return { ok: false, error: `That backup was written by a newer version (v${data.version}).` };
  }
  if (!data.encrypted) {
    return {
      ok: false,
      error: 'That is a plaintext export, not a backup. Restoring from it would put unencrypted '
           + 'credentials through the vault; add them by hand instead.'
    };
  }
  if (!data.kdf?.salt || !data.verifier?.ct) {
    return { ok: false, error: 'That backup is missing the key material needed to read it.' };
  }
  if (!Array.isArray(data.entries)) {
    return { ok: false, error: 'That backup has no entries in it.' };
  }
  return { ok: true, data };
}

/**
 * Opens a backup with the passphrase it was written under.
 *
 * Deliberately NOT a Firestore restore. The decrypted entries come back so the
 * caller can re-encrypt them under the CURRENT vault's key. Writing the
 * backup's ciphertext straight back would mean importing its salt too — and
 * then the vault's existing entries, encrypted under the old key, would all
 * become unreadable. A restore must never cost you the entries you already had.
 */
export async function readVaultExport(data, passphrase, { provider } = {}) {
  const cfg = { salt: data.kdf.salt, iterations: data.kdf.iterations, norm: data.kdf.norm, verifier: data.verifier };
  const { key } = await unlockVault(passphrase, cfg, { provider });   // throws WrongPassphraseError

  const groups = [];
  for (const g of data.groups || []) {
    try { groups.push(normaliseGroup(g.id, await decryptJson(key, g.data, { aad: g.id, provider }), g)); }
    catch (_) { /* a damaged group must not sink the whole restore */ }
  }

  const entries = [];
  const skipped = [];
  for (const e of data.entries) {
    try { entries.push(normaliseEntry(e.id, await decryptJson(key, e.data, { aad: e.id, provider }), e)); }
    catch (_) { skipped.push(e.id); }
  }

  return { groups, entries, skipped };
}
