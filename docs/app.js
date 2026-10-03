// Command Deck — web client.
//
// No build step: this is an ES module the browser loads directly, with the
// Firebase SDK pulled from Google's CDN. Drop the folder on GitHub Pages
// and it runs.
//
// Data lives at users/{uid}/items and users/{uid}/categories, with exactly
// the field names the iOS app writes — see SCHEMA below. Dates are stored
// as strings rather than Firestore Timestamps so both clients and the JSON
// backup format all agree without timezone conversion.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signOut, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js';
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, writeBatch, getDocs
} from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js';

import { firebaseConfig } from './firebase-config.js';
import {
  BUCKETS, CAT_PALETTE, nextColor, uid, esc,
  todayIso, fmtDate, dueState,
  normaliseItem, boardOrder, nextOrder, liftedOrder,
  matchesFilter, visibleItems
} from './lib.js';
import {
  createVaultConfig, unlockVault, encryptJson, decryptJson,
  blankEntry, normaliseEntry, entryBody, entryOrder,
  validateEntry, validatePassphrase, vaultSearch,
  nextEntryOrder, planReorder,
  buildEncryptedExport, buildPlainExport, parseVaultExport, readVaultExport,
  blankGroup, normaliseGroup, groupBody, groupOrder, groupById, validateGroup,
  countByGroup, filterByGroup, sectionsByGroup, entryGroupId,
  GROUP_PALETTE, UNGROUPED,
  genPassword, passwordStrength, maskSecret, hasSmartPunctuation,
  WrongPassphraseError, VAULT_VERSION
} from './vault.js';

/* ------------------------------------------------------------------ *
 * SCHEMA — keep in lockstep with the Swift side (FirestoreItem.swift)
 *
 *   users/{uid}/items/{itemId}
 *     title      string
 *     bucket     'now' | 'waiting' | 'later'
 *     done       bool
 *     doneAt     string (ISO 8601) | null
 *     waitingOn  string
 *     due        string ('yyyy-MM-dd', '' when unset)
 *     subs       [{ id: string, text: string, done: bool }]
 *     catId      string ('' when uncategorized)
 *     urgent     bool
 *     order      number
 *     createdAt  string (ISO 8601)
 *
 *   users/{uid}/categories/{categoryId}
 *     name       string
 *     color      string ('#RRGGBB')
 *     createdAt  string (ISO 8601)
 * ------------------------------------------------------------------ */

/* ---------- tiny helpers ---------- */

const $ = (id) => document.getElementById(id);

// uid / esc / date helpers / ordering / filtering all live in lib.js so they
// can be unit-tested without a DOM or a network. See docs/lib.test.js.

function toast(msg, good) {
  const t = document.createElement('div');
  t.className = 'toast' + (good ? ' good' : '');
  t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 2400);
}

let confirmResolver = null;
function askConfirm(msg, title) {
  $('confirm-title').textContent = title || 'Please confirm';
  $('confirm-msg').textContent = msg;
  $('confirm-ov').classList.add('show');
  return new Promise((res) => { confirmResolver = res; });
}
function settleConfirm(v) {
  $('confirm-ov').classList.remove('show');
  if (confirmResolver) { confirmResolver(v); confirmResolver = null; }
}

/* ---------- theme ---------- */

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  document.querySelectorAll('#theme-tog button')
    .forEach((b) => b.classList.toggle('on', b.dataset.themeSet === t));
  try { localStorage.setItem('cd-theme', t); } catch (_) {}
}
try { applyTheme(localStorage.getItem('cd-theme') || 'dark'); } catch (_) { applyTheme('dark'); }

/* ---------- boot ---------- */

if (firebaseConfig.apiKey.startsWith('PASTE_')) {
  $('boot-msg').innerHTML =
    'Firebase isn\'t configured yet.<br>Open <code>firebase-config.js</code> and paste your project\'s web config.';
  $('boot').querySelector('.spinner')?.remove();
  throw new Error('firebase-config.js still has placeholder values');
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Persistent cache means the board still opens (and accepts edits) offline;
// queued writes flush when the connection returns.
let db;
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
  });
} catch (_) {
  db = getFirestore(app);
}

/* ---------- state ---------- */

const state = {
  user: null,
  items: [],
  cats: [],
  catFilter: '',
  expanded: {},
  collapsed: { __done__: true },
  pending: false,
  fromCache: false
};

let unsubItems = null;
let unsubCats = null;

// The vault's own slice of state. `key` is a non-extractable CryptoKey and
// lives nowhere else — not localStorage, not sessionStorage, not a cookie.
// Closing the tab loses it, which is the point.
const vault = {
  config: null,     // the vaultMeta/config document, or null before first run
  key: null,        // CryptoKey while unlocked, null while locked
  entries: [],      // decrypted, in memory only
  groups: [],       // decrypted, in memory only
  revealed: {},     // entryId -> true while its password is on screen
  query: '',
  groupFilter: '',  // '' = all, UNGROUPED, or a group id
  configError: null, // set when the config could not be READ, which is not
                     // the same as the vault not existing
  editingId: null,  // null means "new entry"
  unsub: null,
  unsubGroups: null,
  gen: 0,           // guards against an out-of-order async snapshot render
  idleTimer: null,
  clipTimer: null
};

const AUTOLOCK_MS = 10 * 60 * 1000;
const CLIPBOARD_CLEAR_MS = 25 * 1000;

const itemsCol = () => collection(db, 'users', state.user.uid, 'items');
const catsCol  = () => collection(db, 'users', state.user.uid, 'categories');
const itemRef  = (id) => doc(db, 'users', state.user.uid, 'items', id);
const catRef   = (id) => doc(db, 'users', state.user.uid, 'categories', id);
const vaultCol = () => collection(db, 'users', state.user.uid, 'vault');
const vaultRef = (id) => doc(db, 'users', state.user.uid, 'vault', id);
const vaultCfgRef = () => doc(db, 'users', state.user.uid, 'vaultMeta', 'config');
const groupsCol = () => collection(db, 'users', state.user.uid, 'vaultGroups');
const groupRef = (id) => doc(db, 'users', state.user.uid, 'vaultGroups', id);
const catOf    = (id) => state.cats.find((c) => c.id === id) || null;

/* ---------- auth ---------- */

$('signin-btn').addEventListener('click', async () => {
  $('gate-error').textContent = '';
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    // Popups are blocked in some in-app browsers; fall back to redirect.
    if (err?.code === 'auth/popup-blocked' || err?.code === 'auth/operation-not-supported-in-this-environment') {
      try { await signInWithRedirect(auth, provider); return; } catch (_) {}
    }
    if (err?.code === 'auth/popup-closed-by-user' || err?.code === 'auth/cancelled-popup-request') return;
    $('gate-error').textContent = err?.code === 'auth/unauthorized-domain'
      ? 'This domain isn\'t authorised in Firebase. Add it under Authentication → Settings → Authorized domains.'
      : `Sign-in failed: ${err?.message || err}`;
  }
});

$('signout-btn').addEventListener('click', async () => {
  $('menu-ov').classList.remove('show');
  await signOut(auth);
});

getRedirectResult(auth).catch(() => {});

onAuthStateChanged(auth, (user) => {
  state.user = user;

  if (unsubItems) { unsubItems(); unsubItems = null; }
  if (unsubCats) { unsubCats(); unsubCats = null; }

  $('boot').classList.add('hidden');

  // Signing out must drop the key, not just hide the UI — another account
  // signing in on this tab would otherwise inherit a live vault session.
  lockVault();
  vault.config = null;

  if (!user) {
    state.items = []; state.cats = [];
    $('app').classList.add('hidden');
    $('gate').classList.remove('hidden');
    return;
  }

  $('gate').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('who').textContent = user.email || user.displayName || user.uid;

  subscribe();
  loadVaultConfig();
  setView('board');
});

/* ---------- live data ---------- */

function subscribe() {
  unsubItems = onSnapshot(itemsCol(), (snap) => {
    state.items = snap.docs.map((d) => normaliseItem(d.id, d.data()));
    state.pending = snap.metadata.hasPendingWrites;
    state.fromCache = snap.metadata.fromCache;
    render();
  }, (err) => {
    toast('Could not read your board — check the Firestore rules');
    console.error(err);
  });

  unsubCats = onSnapshot(catsCol(), (snap) => {
    state.cats = snap.docs
      .map((d) => ({ id: d.id, name: d.data().name || '', color: d.data().color || CAT_PALETTE[0],
                     createdAt: d.data().createdAt || '' }))
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    render();
  }, (err) => console.error(err));
}

/* ---------- writes ---------- */

// Firestore's offline cache means these resolve locally and sync later, so
// we deliberately don't await them in the UI path — the snapshot listener
// re-renders either way.

function capture() {
  const inp = $('cap-input');
  const title = inp.value.trim();
  if (!title) return;

  const id = uid();
  const item = {
    title, bucket: 'later', done: false, doneAt: null, waitingOn: '', due: '',
    subs: [], catId: state.catFilter && state.catFilter !== '__uncat__' ? state.catFilter : '',
    urgent: false, order: nextOrder(state.items, 'later'), createdAt: new Date().toISOString()
  };
  inp.value = '';
  setDoc(itemRef(id), item).catch(reportWrite);
}

const patch = (id, fields) => updateDoc(itemRef(id), fields).catch(reportWrite);

function reportWrite(err) {
  console.error(err);
  toast(err?.code === 'permission-denied'
    ? 'Write denied — check your Firestore rules'
    : 'Could not save that change');
}

function toggleDone(id) {
  const it = state.items.find((i) => i.id === id); if (!it) return;
  patch(id, { done: !it.done, doneAt: !it.done ? new Date().toISOString() : null });
}

function toggleUrgent(id) {
  const it = state.items.find((i) => i.id === id); if (!it) return;
  const fields = { urgent: !it.urgent };
  // Marking urgent lifts it to the top of its bucket once — same rule as the
  // iOS and Android clients.
  if (!it.urgent) fields.order = liftedOrder(state.items, it);
  patch(id, fields);
}

function moveItem(id, bucket) {
  const it = state.items.find((i) => i.id === id); if (!it || it.bucket === bucket) return;
  patch(id, { bucket, order: nextOrder(state.items, bucket), waitingOn: bucket === 'waiting' ? it.waitingOn : '' });
}

async function delItem(id) {
  const it = state.items.find((i) => i.id === id); if (!it) return;
  const n = it.subs.length;
  const ok = await askConfirm(
    `Delete “${it.title}”?` + (n ? ` Its ${n} sub-task${n > 1 ? 's' : ''} go too.` : ''),
    'Delete item?');
  if (!ok) return;
  deleteDoc(itemRef(id)).catch(reportWrite);
}

function addSub(id, text) {
  const it = state.items.find((i) => i.id === id);
  if (!it || !text.trim()) return;
  patch(id, { subs: [...it.subs, { id: uid('s'), text: text.trim(), done: false }] });
}
function toggleSub(id, sid) {
  const it = state.items.find((i) => i.id === id); if (!it) return;
  patch(id, { subs: it.subs.map((s) => s.id === sid ? { ...s, done: !s.done } : s) });
}
function delSub(id, sid) {
  const it = state.items.find((i) => i.id === id); if (!it) return;
  patch(id, { subs: it.subs.filter((s) => s.id !== sid) });
}

/* categories */

function addCat(name) {
  name = (name || '').trim();
  if (!name) return null;
  if (state.cats.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    toast('That category already exists');
    return null;
  }
  const color = nextColor(state.cats.map((c) => c.color));
  const id = uid('c');
  setDoc(catRef(id), { name, color, createdAt: new Date().toISOString() }).catch(reportWrite);
  return id;
}
function renameCat(id, name) {
  name = (name || '').trim(); if (!name) return;
  if (state.cats.some((c) => c.id !== id && c.name.toLowerCase() === name.toLowerCase())) {
    toast('Another category has that name'); return;
  }
  updateDoc(catRef(id), { name }).catch(reportWrite);
}
const recolorCat = (id, color) => updateDoc(catRef(id), { color }).catch(reportWrite);

async function delCat(id) {
  const c = catOf(id); if (!c) return;
  const affected = state.items.filter((i) => i.catId === id);
  const ok = await askConfirm(
    `Delete category “${c.name}”?` + (affected.length
      ? ` ${affected.length} item${affected.length > 1 ? 's' : ''} will become uncategorized (not deleted).` : ''),
    'Delete category?');
  if (!ok) return;

  const batch = writeBatch(db);
  affected.forEach((i) => batch.update(itemRef(i.id), { catId: '' }));
  batch.delete(catRef(id));
  if (state.catFilter === id) state.catFilter = '';
  batch.commit().catch(reportWrite);
}

/* reorder */

function reorder(sourceId, targetId, after) {
  const src = state.items.find((i) => i.id === sourceId);
  const tgt = state.items.find((i) => i.id === targetId);
  if (!src || !tgt) return;

  const bucket = tgt.bucket;
  const ordered = state.items
    .filter((i) => !i.done && i.bucket === bucket && i.id !== sourceId)
    .sort(boardOrder);

  const idx = ordered.findIndex((i) => i.id === targetId);
  ordered.splice(idx < 0 ? ordered.length : (after ? idx + 1 : idx), 0, src);

  const batch = writeBatch(db);
  ordered.forEach((i, n) => {
    if (i.id === sourceId && src.bucket !== bucket) {
      batch.update(itemRef(i.id), { order: n, bucket, waitingOn: bucket === 'waiting' ? i.waitingOn : '' });
    } else if (i.order !== n) {
      batch.update(itemRef(i.id), { order: n });
    }
  });
  batch.commit().catch(reportWrite);
}

/* ---------- render ---------- */

function itemHtml(it, num) {
  const isOpen = !!state.expanded[it.id];
  const doneSubs = it.subs.filter((s) => s.done).length;

  const moveBtns = BUCKETS.filter((b) => b.key !== it.bucket)
    .map((b) => `<button class="move-btn" data-move="${it.id}" data-to="${b.key}">→ ${b.label}</button>`)
    .join('');

  const cat = it.catId ? catOf(it.catId) : null;
  const catChip = cat
    ? `<span class="cat-tag" style="color:${cat.color}"><span class="cat-tag-dot" style="background:${cat.color}"></span>${esc(cat.name)}</span>` : '';
  const waitChip = (it.bucket === 'waiting' && it.waitingOn)
    ? `<span class="waiting-on">waiting on ${esc(it.waitingOn)}</span>` : '';
  const dueChip = it.due
    ? `<span class="date-chip ${it.done ? '' : dueState(it.due)}">📅 ${fmtDate(it.due)}</span>` : '';
  const subToggle = it.subs.length
    ? `<span class="sub-toggle" data-subtoggle="${it.id}">☑ ${doneSubs}/${it.subs.length}${isOpen ? ' ▲' : ' ▼'}</span>`
    : `<span class="sub-toggle" data-subtoggle="${it.id}">+ details${isOpen ? ' ▲' : ''}</span>`;

  const catPills = state.cats.length
    ? state.cats.map((c) => {
        const on = it.catId === c.id;
        const style = on
          ? `background:${c.color};border-color:${c.color};color:#0F1216;`
          : `border-color:${c.color};color:${c.color};`;
        return `<button class="cat-pick" data-catpick="${it.id}|${c.id}" style="${style}"><span class="cat-pick-dot" style="background:${on ? '#0F1216' : c.color}"></span>${esc(c.name)}</button>`;
      }).join('') + (it.catId ? `<button class="cat-pick cat-pick-clear" data-catpick="${it.id}|">clear</button>` : '')
    : '<span class="cat-pick-none">No categories yet — add some with ⚙ Edit above</span>';

  const drawer = isOpen ? `
    <div class="item-edit">
      <label>📅 <input type="date" data-due="${it.id}" value="${it.due || ''}"></label>
      ${it.bucket === 'waiting'
        ? `<label>waiting on <input type="text" data-waiting="${it.id}" value="${esc(it.waitingOn)}" placeholder="name"></label>` : ''}
    </div>
    <div class="cat-pick-row">${catPills}</div>
    <div class="subs">
      ${it.subs.map((s) => `
        <div class="sub ${s.done ? 'done' : ''}">
          <button class="sub-check ${s.done ? 'done' : ''}" data-subcheck="${it.id}|${s.id}"></button>
          <span class="sub-text">${esc(s.text)}</span>
          <button class="sub-del" data-subdel="${it.id}|${s.id}">✕</button>
        </div>`).join('')}
      <div class="sub-add"><input type="text" data-subadd="${it.id}" placeholder="Add a sub-task… (Enter)"></div>
    </div>` : '';

  return `
    <div class="item ${it.done ? 'done' : ''} ${it.urgent && !it.done ? 'urgent' : ''} b-accent-${it.bucket}"
         data-item="${it.id}" draggable="true" data-drag="${it.id}">
      <div class="item-main">
        <span class="item-num">${num ?? ''}</span>
        <span class="drag-handle" title="Drag to reorder">⠿</span>
        <button class="item-check ${it.done ? 'done' : ''}" data-check="${it.id}" title="Mark done"></button>
        <div class="item-body">
          <div class="item-title" data-title="${it.id}">${esc(it.title)}</div>
          <div class="item-meta">${catChip}${waitChip}${dueChip}${subToggle}</div>
        </div>
        <div class="item-actions">
          <button class="urgent-btn ${it.urgent ? 'on' : ''}" data-urgent="${it.id}"><span class="urgent-dot"></span>${it.urgent ? 'Urgent' : ''}</button>
          ${moveBtns}
          <button class="del-btn" data-del="${it.id}" title="Delete">✕</button>
        </div>
      </div>
      ${drawer}
    </div>`;
}

function renderCatBar() {
  const active = state.items.filter((i) => !i.done);
  const chips = state.cats.map((c) => {
    const n = active.filter((i) => i.catId === c.id).length;
    const on = state.catFilter === c.id;
    const style = on ? `background:${c.color};border-color:${c.color};color:#0F1216;`
                     : `border-color:${c.color};color:${c.color};`;
    return `<button class="cat-chip" data-catfilter="${c.id}" style="${style}">
      <span class="cat-chip-dot" style="background:${on ? '#0F1216' : c.color}"></span>${esc(c.name)}
      <span class="cat-chip-n">${n}</span></button>`;
  }).join('');

  const uncat = active.filter((i) => !i.catId).length;
  const allOn = !state.catFilter;

  $('cat-bar').innerHTML = `
    <button class="cat-chip" data-catfilter="" style="${allOn ? 'background:var(--ink);border-color:var(--ink);color:var(--bg);' : ''}">All <span class="cat-chip-n">${active.length}</span></button>
    ${chips}
    ${(state.catFilter === '__uncat__' || uncat) ? `<button class="cat-chip" data-catfilter="__uncat__" style="${state.catFilter === '__uncat__' ? 'background:var(--ink-3);border-color:var(--ink-3);color:var(--bg);' : ''}">Uncategorized <span class="cat-chip-n">${uncat}</span></button>` : ''}
    <button class="cat-manage-btn" id="cat-manage-open">⚙ Edit</button>`;

  $('cat-bar').querySelectorAll('[data-catfilter]').forEach((b) =>
    b.addEventListener('click', () => {
      const v = b.dataset.catfilter;
      state.catFilter = state.catFilter === v ? '' : v;
      render();
    }));
  $('cat-manage-open').addEventListener('click', openCatModal);
}

function render() {
  if (!state.user) return;

  const hr = new Date().getHours();
  const greet = hr < 12 ? 'Good morning' : (hr < 17 ? 'Good afternoon' : 'Good evening');
  const name = (state.user.displayName || '').split(' ')[0];
  $('greeting').textContent = greet + (name ? `, ${name}` : '');
  $('today-line').textContent = new Date().toLocaleDateString(undefined,
    { weekday: 'long', day: 'numeric', month: 'long' });

  const dot = $('sync-dot');
  dot.className = 'sync-dot' + (state.pending ? ' saving' : (state.fromCache ? ' offline' : ''));
  dot.title = state.pending ? 'Saving…' : (state.fromCache ? 'Offline — changes queued' : 'Synced');

  renderCatBar();

  const active = state.items.filter((i) => !i.done && matchesFilter(i, state.catFilter));
  const done = state.items.filter((i) => i.done && matchesFilter(i, state.catFilter));

  const bx = $('buckets');
  bx.innerHTML = BUCKETS.map((b) => {
    const list = visibleItems(state.items, b.key, state.catFilter);
    const body = list.length
      ? list.map((it, idx) => itemHtml(it, idx + 1)).join('')
      : `<div class="bucket-empty">${b.empty}</div>`;
    const col = !!state.collapsed[b.key];
    return `
      <div class="bucket b-${b.key} ${col ? 'collapsed' : ''}">
        <div class="bucket-head" data-collapse="${b.key}">
          <span class="bucket-chevron">▾</span><span class="bucket-dot"></span>
          <span class="bucket-title">${b.label}</span>
          <span class="bucket-count">${list.length}</span>
        </div>
        <div class="bucket-list" data-bucket="${b.key}">${body}</div>
      </div>`;
  }).join('');

  if (done.length) {
    done.sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || ''));
    const col = state.collapsed.__done__ !== false;
    bx.innerHTML += `
      <div class="bucket b-done ${col ? 'collapsed' : ''}">
        <div class="bucket-head" data-collapse="__done__">
          <span class="bucket-chevron">▾</span><span class="bucket-dot"></span>
          <span class="bucket-title">Done</span>
          <span class="bucket-count">${done.length}</span>
        </div>
        <div class="bucket-list">${done.slice(0, 50).map((it, i) => itemHtml(it, i + 1)).join('')}</div>
      </div>`;
  }

  bx.querySelectorAll('[data-collapse]').forEach((h) =>
    h.addEventListener('click', (e) => {
      if (e.target.closest('.item')) return;
      const k = h.dataset.collapse;
      const cur = k === '__done__' ? state.collapsed.__done__ !== false : !!state.collapsed[k];
      state.collapsed[k] = !cur;
      render();
    }));

  wireItems(bx);

  const open = state.items.filter((i) => !i.done);
  $('footer').textContent =
    `${open.length} open · ${open.filter((i) => i.bucket === 'now').length} now · ` +
    `${open.filter((i) => i.bucket === 'waiting').length} waiting`;
}

/* ---------- item wiring ---------- */

let dragId = null;

function wireItems(scope) {
  const on = (sel, ev, fn) => scope.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, () => fn(el)));

  on('[data-check]', 'click', (b) => toggleDone(b.dataset.check));
  on('[data-urgent]', 'click', (b) => toggleUrgent(b.dataset.urgent));
  on('[data-del]', 'click', (b) => delItem(b.dataset.del));
  on('[data-move]', 'click', (b) => moveItem(b.dataset.move, b.dataset.to));
  on('[data-subtoggle]', 'click', (b) => {
    const id = b.dataset.subtoggle;
    state.expanded[id] = !state.expanded[id];
    render();
  });
  on('[data-subcheck]', 'click', (b) => { const [i, s] = b.dataset.subcheck.split('|'); toggleSub(i, s); });
  on('[data-subdel]', 'click', (b) => { const [i, s] = b.dataset.subdel.split('|'); delSub(i, s); });
  on('[data-catpick]', 'click', (b) => {
    const [i, c] = b.dataset.catpick.split('|');
    patch(i, { catId: c || '' });
  });

  scope.querySelectorAll('[data-subadd]').forEach((inp) =>
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addSub(inp.dataset.subadd, inp.value); }
    }));

  scope.querySelectorAll('[data-due]').forEach((inp) =>
    inp.addEventListener('change', () => patch(inp.dataset.due, { due: inp.value || '' })));

  scope.querySelectorAll('[data-waiting]').forEach((inp) => {
    let t;
    inp.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => patch(inp.dataset.waiting, { waitingOn: inp.value }), 400);
    });
  });

  // inline title edit
  scope.querySelectorAll('[data-title]').forEach((el) =>
    el.addEventListener('dblclick', () => {
      const id = el.dataset.title;
      const it = state.items.find((x) => x.id === id); if (!it) return;
      const inp = document.createElement('input');
      inp.className = 'item-title-input';
      inp.value = it.title;
      el.replaceWith(inp);
      inp.focus();
      inp.setSelectionRange(inp.value.length, inp.value.length);
      const commit = () => { const v = inp.value.trim(); if (v && v !== it.title) patch(id, { title: v }); render(); };
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') render();
      });
      inp.addEventListener('blur', commit);
    }));

  // drag to reorder
  scope.querySelectorAll('[data-drag]').forEach((el) => {
    el.addEventListener('dragstart', (e) => {
      dragId = el.dataset.drag;
      el.classList.add('dragging');
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); } catch (_) {}
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      scope.querySelectorAll('.drop-above,.drop-below').forEach((x) => x.classList.remove('drop-above', 'drop-below'));
      dragId = null;
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragId || el.dataset.drag === dragId) return;
      const r = el.getBoundingClientRect();
      const after = (e.clientY - r.top) > r.height / 2;
      el.classList.toggle('drop-below', after);
      el.classList.toggle('drop-above', !after);
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-above', 'drop-below'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const targetId = el.dataset.drag;
      if (!dragId || dragId === targetId) return;
      const r = el.getBoundingClientRect();
      reorder(dragId, targetId, (e.clientY - r.top) > r.height / 2);
    });
  });
  scope.querySelectorAll('.bucket-list').forEach((l) =>
    l.addEventListener('dragover', (e) => { if (dragId) e.preventDefault(); }));
}

/* ---------- category manager ---------- */

function openCatModal() {
  $('cat-ov').classList.add('show');
  $('cat-new').value = '';
  renderCatManage();
  setTimeout(() => $('cat-new').focus(), 40);
}

function renderCatManage() {
  const list = $('cat-manage-list');
  if (!state.cats.length) {
    list.innerHTML = '<div class="cat-manage-empty">No categories yet. Add your first above.</div>';
    return;
  }
  list.innerHTML = state.cats.map((c) => {
    const n = state.items.filter((i) => i.catId === c.id).length;
    const sw = CAT_PALETTE.map((col) =>
      `<button class="cat-sw ${c.color === col ? 'on' : ''}" data-recolor="${c.id}|${col}" style="background:${col}" title="${col}"></button>`).join('');
    return `
      <div class="cat-manage-row">
        <input type="text" class="cat-rename" data-rename="${c.id}" value="${esc(c.name)}">
        <span class="cat-manage-n">${n} item${n === 1 ? '' : 's'}</span>
        <button class="cat-del" data-catdel="${c.id}" title="Delete category">✕</button>
        <div class="cat-sw-row">${sw}</div>
      </div>`;
  }).join('');

  list.querySelectorAll('[data-rename]').forEach((inp) => {
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
    inp.addEventListener('blur', () => renameCat(inp.dataset.rename, inp.value));
  });
  list.querySelectorAll('[data-recolor]').forEach((b) =>
    b.addEventListener('click', () => {
      const [id, col] = b.dataset.recolor.split('|');
      recolorCat(id, col);
    }));
  list.querySelectorAll('[data-catdel]').forEach((b) =>
    b.addEventListener('click', () => delCat(b.dataset.catdel)));
}

/* ---------- backup ---------- */

function exportData() {
  const payload = {
    app: 'command-deck',
    version: 3,
    exportedAt: new Date().toISOString(),
    items: state.items.map((i) => ({
      id: i.id, title: i.title, bucket: i.bucket, done: i.done, waitingOn: i.waitingOn,
      due: i.due, subs: i.subs, catId: i.catId, urgent: i.urgent, order: i.order,
      createdAt: i.createdAt, doneAt: i.doneAt
    })),
    ref: [],
    cats: state.cats.map((c) => ({ id: c.id, name: c.name, color: c.color })),
    theme: document.documentElement.getAttribute('data-theme')
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const n = new Date(); const p = (v) => String(v).padStart(2, '0');
  const a = document.createElement('a');
  a.href = url;
  a.download = `command-deck-backup-${n.getFullYear()}${p(n.getMonth() + 1)}${p(n.getDate())}-${p(n.getHours())}${p(n.getMinutes())}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Backup downloaded', true);
}

async function handleImport(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;

  let data;
  try { data = JSON.parse(await file.text()); }
  catch { toast('Not a valid backup file'); return; }

  if (!data || !Array.isArray(data.items)) { toast('That doesn\'t look like a Command Deck backup'); return; }

  const ok = await askConfirm(
    `Replace everything with this backup? ${data.items.length} items` +
    (data.cats ? `, ${data.cats.length} categories` : '') +
    '. This affects every device signed into this account.',
    'Restore backup?');
  if (!ok) return;

  $('menu-ov').classList.remove('show');

  try {
    // Wipe, then write, in chunks — Firestore caps a batch at 500 writes.
    const [oldItems, oldCats] = await Promise.all([getDocs(itemsCol()), getDocs(catsCol())]);
    const ops = [];
    oldItems.forEach((d) => ops.push((b) => b.delete(d.ref)));
    oldCats.forEach((d) => ops.push((b) => b.delete(d.ref)));

    (data.cats || []).forEach((c) => ops.push((b) => b.set(catRef(c.id || uid('c')), {
      name: c.name || '', color: c.color || CAT_PALETTE[0], createdAt: new Date().toISOString()
    })));

    data.items.forEach((raw, idx) => ops.push((b) => b.set(itemRef(raw.id || uid()), {
      title: raw.title || '',
      bucket: ['now', 'waiting', 'later'].includes(raw.bucket) ? raw.bucket : 'later',
      done: !!raw.done,
      doneAt: raw.doneAt || null,
      waitingOn: raw.waitingOn || '',
      due: raw.due || '',
      subs: Array.isArray(raw.subs) ? raw.subs : [],
      catId: raw.catId || '',
      urgent: !!raw.urgent,
      order: typeof raw.order === 'number' ? raw.order : idx,
      createdAt: raw.createdAt || new Date().toISOString()
    })));

    for (let i = 0; i < ops.length; i += 450) {
      const batch = writeBatch(db);
      ops.slice(i, i + 450).forEach((op) => op(batch));
      await batch.commit();
    }
    toast('Backup restored', true);
  } catch (err) {
    console.error(err);
    toast('Restore failed — see the console');
  }
}

/* ================================================================== *
 * VAULT
 *
 * Firestore is treated as hostile storage here. Every byte of an entry is
 * encrypted in this tab before it is written, and the key that decrypts it
 * is derived from a passphrase that is never transmitted or persisted.
 * See docs/vault.js for the reasoning and docs/vault.test.js for the proof.
 * ================================================================== */

/* ---------- view switching ---------- */

let currentView = 'board';

function setView(v) {
  currentView = v;
  $('board-view').classList.toggle('hidden', v !== 'board');
  $('vault-view').classList.toggle('hidden', v !== 'vault');
  document.querySelectorAll('#view-tog button')
    .forEach((b) => b.classList.toggle('on', b.dataset.view === v));

  if (v === 'vault') { renderVault(); focusVault(); }
  else $('cap-input').focus();
}

function focusVault() {
  if (!vault.config) $('vs-pass').focus();
  else if (!vault.key) $('vl-pass').focus();
  else $('v-search').focus();
}

/* ---------- config load ---------- */

// Read once per sign-in. The config document is not secret — it is a salt,
// an iteration count and a verifier blob — so there is nothing lost by
// fetching it before the passphrase is known.
async function loadVaultConfig() {
  vault.configError = null;
  try {
    const snap = await getDoc(vaultCfgRef());
    vault.config = snap.exists() ? snap.data() : null;
  } catch (err) {
    console.error(err);
    // Crucially NOT `config = null`. "I could not read it" and "it does not
    // exist" look identical to the UI, and treating the first as the second
    // puts the setup screen in front of someone who already has a vault —
    // one click from overwriting its salt and orphaning every entry.
    vault.config = null;
    vault.configError = err?.message || String(err);
  }
  renderVault();
}

/* ---------- setup ---------- */

function setupReady() {
  const pass = $('vs-pass').value;
  const ok = validatePassphrase(pass, $('vs-pass2').value).ok && $('vs-ack').checked;
  $('vs-create').disabled = !ok;
}

function paintMeter(meterId, noteId, pw) {
  const { score, label, bits } = passwordStrength(pw);
  $(meterId).dataset.score = pw ? String(score) : '0';
  if (noteId) {
    $(noteId).textContent = pw
      ? `${label} — about ${bits} bits of entropy`
      : 'A phrase of four or five unrelated words beats a short cryptic one.';
  }
}

// macOS and iOS replace ' with ’ and - with – as you type, and the result is
// indistinguishable on screen. The vault now opens with either, but it is
// still worth saying out loud: the character on screen is not the one on the
// key you pressed, and anything that copies the passphrase elsewhere — a
// password manager, a note — will carry the substituted version.
function paintSmartWarning(inputId, noteId) {
  const warn = hasSmartPunctuation($(inputId).value);
  const el = $(noteId);
  if (!el) return;
  el.classList.toggle('hidden', !warn);
  el.textContent = warn
    ? 'Your keyboard replaced a quote or hyphen with a typographic one (’ or –). '
      + 'The vault accepts either spelling, but you can turn the substitution off in '
      + 'System Settings → Keyboard → Text Input → Edit.'
    : '';
}

async function createVault() {
  const pass = $('vs-pass').value;
  const check = validatePassphrase(pass, $('vs-pass2').value);
  if (!check.ok) { $('vs-error').textContent = check.error; return; }
  if (!$('vs-ack').checked) { $('vs-error').textContent = 'Please confirm you understand the recovery warning.'; return; }

  $('vs-error').textContent = '';
  $('vs-create').disabled = true;
  $('vs-create').textContent = 'Deriving key…';   // 310k rounds is a visible pause

  try {
    // Re-read immediately before writing. Creating a second vault would
    // replace the salt and verifier, and every existing entry — still sitting
    // in Firestore, still encrypted under the old key — would become
    // permanently unreadable. The window is small (a stale read, a second tab,
    // another machine mid-setup) but the damage is total, so it is checked.
    const existing = await getDoc(vaultCfgRef());
    if (existing.exists()) {
      vault.config = existing.data();
      $('vs-error').textContent =
        'A vault already exists on this account — unlock it with its passphrase instead. '
        + 'Creating a new one here would make the entries you already have unreadable.';
      renderVault();
      return;
    }

    const { key, config } = await createVaultConfig(pass);
    await setDoc(vaultCfgRef(), config);
    vault.config = config;
    vault.key = key;
    clearPassphraseInputs();
    startAutolock();
    subscribeVault();
    renderVault();
    toast('Vault created', true);
  } catch (err) {
    console.error(err);
    $('vs-error').textContent = `Could not create the vault: ${err?.message || err}`;
  } finally {
    $('vs-create').textContent = 'Create vault';
    setupReady();
  }
}

/* ---------- unlock / lock ---------- */

async function doUnlock() {
  const pass = $('vl-pass').value;
  if (!pass) { $('vl-error').textContent = 'Enter your passphrase.'; return; }

  $('vl-error').textContent = '';
  $('vl-unlock').disabled = true;
  $('vl-unlock').textContent = 'Deriving key…';

  try {
    const { key, norm } = await unlockVault(pass, vault.config);
    vault.key = key;

    // Vaults created before normalization was pinned have to guess the
    // byte-form each time. Record the one that worked so the next unlock is
    // a single derivation. The key is unchanged, so nothing is re-encrypted.
    if (!vault.config.norm && norm) {
      updateDoc(vaultCfgRef(), { norm })
        .then(() => { vault.config = { ...vault.config, norm }; })
        .catch((e) => console.warn('Could not record the passphrase encoding:', e));
    }

    clearPassphraseInputs();
    startAutolock();
    subscribeVault();
    renderVault();
    $('v-search').focus();
  } catch (err) {
    vault.key = null;
    $('vl-error').textContent = err instanceof WrongPassphraseError
      ? 'That passphrase does not unlock this vault.'
      : `Unlock failed: ${err?.message || err}`;
    $('vl-pass').select();
  } finally {
    $('vl-unlock').disabled = false;
    $('vl-unlock').textContent = 'Unlock';
  }
}

function lockVault(reason) {
  vault.key = null;
  vault.entries = [];
  vault.groups = [];
  vault.revealed = {};
  vault.query = '';
  vault.groupFilter = '';
  vault.editingId = null;
  vault.gen++;                      // orphan any snapshot decryption in flight
  if (vault.unsub) { vault.unsub(); vault.unsub = null; }
  if (vault.unsubGroups) { vault.unsubGroups(); vault.unsubGroups = null; }
  if (vault.idleTimer) { clearTimeout(vault.idleTimer); vault.idleTimer = null; }
  $('entry-ov').classList.remove('show');
  $('group-ov').classList.remove('show');
  if (passResolver) settlePassphrase(null);
  $('v-group-bar').innerHTML = '';     // group names are secrets too
  $('v-search').value = '';
  clearPassphraseInputs();
  $('vl-lede').textContent = reason || 'Enter your master passphrase to decrypt.';
  // Always, not just when the vault is the visible tab — locking while the
  // board is on screen must still empty the vault's markup.
  renderVault();
}

// Passphrases are read out of the DOM and then removed from it. The string
// itself still exists until the engine collects it — JavaScript gives no way
// to wipe memory — but it should not be sitting in an input anyone can
// un-hide, and it must never reach a form autofill heuristic.
function clearPassphraseInputs() {
  ['vs-pass', 'vs-pass2', 'vl-pass'].forEach((id) => { if ($(id)) $(id).value = ''; });
  ['vs-pass-eye', 'vl-pass-eye'].forEach((id) => hideSecretInput(id));
  if ($('vs-ack')) $('vs-ack').checked = false;
  paintMeter('vs-meter', 'vs-meter-note', '');
  setupReady();
}

function startAutolock() {
  if (vault.idleTimer) clearTimeout(vault.idleTimer);
  vault.idleTimer = setTimeout(() => lockVault('Locked after 10 minutes of inactivity.'), AUTOLOCK_MS);
}
const touchVault = () => { if (vault.key) startAutolock(); };

/* ---------- live data ---------- */

function subscribeVault() {
  if (vault.unsub) vault.unsub();
  const myGen = ++vault.gen;

  vault.unsub = onSnapshot(vaultCol(), async (snap) => {
    const key = vault.key;
    if (!key) return;

    // Decryption is async and a second snapshot can land mid-flight, so the
    // result is discarded unless it is still the newest one.
    const decrypted = await Promise.all(snap.docs.map(async (d) => {
      try {
        const body = await decryptJson(key, d.data().data, { aad: d.id });
        return normaliseEntry(d.id, body, d.data());
      } catch (_) {
        // One unreadable document must not blank the whole list.
        return normaliseEntry(d.id, { title: '⚠︎ Unreadable entry' }, d.data());
      }
    }));

    if (myGen !== vault.gen || !vault.key) return;
    vault.entries = decrypted.sort(entryOrder);
    if (currentView === 'vault') renderVault();
  }, (err) => {
    console.error(err);
    toast('Could not read the vault — check the Firestore rules');
  });

  vault.unsubGroups = onSnapshot(groupsCol(), async (snap) => {
    const key = vault.key;
    if (!key) return;

    const decrypted = await Promise.all(snap.docs.map(async (d) => {
      try {
        const body = await decryptJson(key, d.data().data, { aad: d.id });
        return normaliseGroup(d.id, body, d.data());
      } catch (_) {
        return normaliseGroup(d.id, { name: '⚠︎ Unreadable group' }, d.data());
      }
    }));

    if (myGen !== vault.gen || !vault.key) return;
    vault.groups = decrypted.sort(groupOrder);
    if (currentView === 'vault') renderVault();
  }, (err) => console.error(err));
}

/* ---------- writes ---------- */

async function saveEntry() {
  if (!vault.key) return;

  const entry = {
    title: $('e-title').value.trim(),
    username: $('e-username').value.trim(),
    password: $('e-password').value,
    url: $('e-url').value.trim(),
    notes: $('e-notes').value,
    groupId: $('e-group').value || ''
  };

  const check = validateEntry(entry);
  if (!check.ok) { $('e-error').textContent = check.error; return; }
  $('e-error').textContent = '';

  const id = vault.editingId || uid('v');
  const now = new Date().toISOString();
  const existing = vault.entries.find((e) => e.id === id);

  // A new entry goes to the bottom of its group. An edited one keeps the
  // position it was dragged to, even when the edit moved it to another group —
  // re-sorting under someone mid-edit is never what they wanted.
  const order = existing
    ? (existing.groupId === entry.groupId ? existing.order : nextEntryOrder(vault.entries, vault.groups, entry.groupId))
    : nextEntryOrder(vault.entries, vault.groups, entry.groupId);

  try {
    const data = await encryptJson(vault.key, entryBody(entry), { aad: id });
    await setDoc(vaultRef(id), {
      v: VAULT_VERSION,
      data,
      order,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    });
    closeEntry();
    toast(vault.editingId ? 'Saved' : 'Added to vault', true);
  } catch (err) {
    console.error(err);
    $('e-error').textContent = `Could not save: ${err?.message || err}`;
  }
}

async function deleteEntry(id) {
  const e = vault.entries.find((x) => x.id === id);
  const ok = await askConfirm(
    `"${e?.title || 'This entry'}" will be deleted from every device. There is no undo.`,
    'Delete credential?'
  );
  if (!ok) return;
  try {
    await deleteDoc(vaultRef(id));
    delete vault.revealed[id];
    closeEntry();
    toast('Deleted', true);
  } catch (err) { console.error(err); toast('Delete failed'); }
}

/* ---------- groups ---------- */

async function addGroup(name, { color } = {}) {
  if (!vault.key) return null;
  const group = { ...blankGroup(vault.groups.length), name: (name || '').trim() };
  if (color) group.color = color;

  const check = validateGroup(group, vault.groups);
  if (!check.ok) return { error: check.error };

  const id = uid('g');
  try {
    const data = await encryptJson(vault.key, groupBody(group), { aad: id });
    await setDoc(groupRef(id), { v: VAULT_VERSION, data, createdAt: new Date().toISOString() });
    return { id };
  } catch (err) {
    console.error(err);
    return { error: `Could not create the group: ${err?.message || err}` };
  }
}

async function saveGroup(id, fields) {
  if (!vault.key) return { error: 'The vault is locked.' };
  const current = groupById(vault.groups, id);
  if (!current) return { error: 'That group no longer exists.' };

  const next = { ...current, ...fields };
  const check = validateGroup(next, vault.groups, id);
  if (!check.ok) return check;

  try {
    const data = await encryptJson(vault.key, groupBody(next), { aad: id });
    await updateDoc(groupRef(id), { data, updatedAt: new Date().toISOString() });
    return { ok: true };
  } catch (err) {
    console.error(err);
    return { error: `Could not save: ${err?.message || err}` };
  }
}

async function delGroup(id) {
  const g = groupById(vault.groups, id);
  const members = vault.entries.filter((e) => entryGroupId(e, vault.groups) === id);

  const ok = await askConfirm(
    members.length
      ? `"${g?.name || 'This group'}" will be deleted. Its ${members.length} credential${members.length === 1 ? '' : 's'} `
        + 'will stay in the vault, just ungrouped.'
      : `"${g?.name || 'This group'}" will be deleted.`,
    'Delete group?'
  );
  if (!ok) return;

  try {
    // Clear the members FIRST. If this is interrupted, the worst outcome is a
    // group that still exists with its entries intact — recoverable. Deleting
    // the group first would leave entries pointing at nothing, which is the
    // state entryGroupId has to defend against.
    for (const e of members) {
      const body = entryBody({ ...e, groupId: '' });
      const data = await encryptJson(vault.key, body, { aad: e.id });
      await updateDoc(vaultRef(e.id), {
        data,
        order: nextEntryOrder(vault.entries, vault.groups, ''),
        updatedAt: new Date().toISOString()
      });
    }
    await deleteDoc(groupRef(id));
    if (vault.groupFilter === id) vault.groupFilter = '';
    toast('Group deleted — its credentials were kept', true);
  } catch (err) {
    console.error(err);
    toast('Could not delete the group');
  }
}

/* ---------- drag to position ---------- *
 *
 * Only one write per drag touches the ciphertext: the dragged entry, and only
 * when the drop crossed into another group. Every other affected row gets a
 * plain integer written to it, because `order` lives outside the encrypted
 * blob. Dragging a credential down a list of thirteen VMs should not mean
 * thirteen AES operations and thirteen full-document rewrites.
 */

let vDragId = null;

async function applyReorder(sourceId, targetId, after) {
  const plan = planReorder(vault.entries, vault.groups, sourceId, targetId, after);
  if (!plan || !plan.positions.length) return;

  try {
    const src = vault.entries.find((e) => e.id === sourceId);

    // The group change first and on its own: it is the only write that can
    // fail in an interesting way, and doing it before the cheap ones means a
    // failure leaves positions untouched rather than half-applied.
    if (plan.movedToGroup !== null && src) {
      const body = entryBody({ ...src, groupId: plan.movedToGroup });
      const data = await encryptJson(vault.key, body, { aad: sourceId });
      await updateDoc(vaultRef(sourceId), { data, updatedAt: new Date().toISOString() });
    }

    const batch = writeBatch(db);
    plan.positions.forEach(({ id, order }) => batch.update(vaultRef(id), { order }));
    await batch.commit();
  } catch (err) {
    console.error(err);
    toast('Could not save the new order');
  }
}

function wireRowDrag(row) {
  const id = row.dataset.id;

  row.addEventListener('dragstart', (e) => {
    vDragId = id;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox refuses to start a drag unless something is set.
    try { e.dataTransfer.setData('text/plain', id); } catch (_) {}
  });

  row.addEventListener('dragend', () => {
    vDragId = null;
    row.classList.remove('dragging');
    document.querySelectorAll('.v-row.over-top, .v-row.over-bottom')
      .forEach((r) => r.classList.remove('over-top', 'over-bottom'));
  });

  row.addEventListener('dragover', (e) => {
    if (!vDragId || vDragId === id) return;
    e.preventDefault();
    const box = row.getBoundingClientRect();
    const below = e.clientY > box.top + box.height / 2;
    row.classList.toggle('over-bottom', below);
    row.classList.toggle('over-top', !below);
  });

  row.addEventListener('dragleave', () => row.classList.remove('over-top', 'over-bottom'));

  row.addEventListener('drop', (e) => {
    e.preventDefault();
    const after = row.classList.contains('over-bottom');
    row.classList.remove('over-top', 'over-bottom');
    if (!vDragId || vDragId === id) return;
    touchVault();
    applyReorder(vDragId, id, after);
    vDragId = null;
  });
}

// Dropping on a section's header moves the entry into that group, at the top.
// Without this an empty group could never receive anything by drag.
function wireSectionDrop(head, groupId) {
  head.addEventListener('dragover', (e) => {
    if (!vDragId) return;
    e.preventDefault();
    head.classList.add('over');
  });
  head.addEventListener('dragleave', () => head.classList.remove('over'));
  head.addEventListener('drop', async (e) => {
    e.preventDefault();
    head.classList.remove('over');
    if (!vDragId) return;
    const src = vault.entries.find((x) => x.id === vDragId);
    const dragId = vDragId;
    vDragId = null;
    if (!src || entryGroupId(src, vault.groups) === groupId) return;
    touchVault();

    try {
      const body = entryBody({ ...src, groupId });
      const data = await encryptJson(vault.key, body, { aad: dragId });
      await updateDoc(vaultRef(dragId), {
        data,
        order: nextEntryOrder(vault.entries, vault.groups, groupId),
        updatedAt: new Date().toISOString()
      });
    } catch (err) { console.error(err); toast('Could not move the entry'); }
  });
}

/* ---------- export and restore ---------- */

function downloadFile(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  // Revoking frees the blob, which for a plaintext export is a copy of every
  // credential sitting in memory. Not a real defence — the file is on disk by
  // now — but there is no reason to keep it around either.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = () => new Date().toISOString().slice(0, 10);

async function exportEncrypted() {
  if (!vault.key) return;
  try {
    const [gSnap, eSnap] = await Promise.all([getDocs(groupsCol()), getDocs(vaultCol())]);
    const file = buildEncryptedExport(
      vault.config,
      gSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      eSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
    );
    downloadFile(`command-deck-vault-${stamp()}.json`, JSON.stringify(file, null, 2));
    toast('Encrypted backup downloaded', true);
  } catch (err) {
    console.error(err);
    toast('Could not build the backup');
  }
}

async function exportPlaintext() {
  if (!vault.key) return;

  const ok = await askConfirm(
    `This writes all ${vault.entries.length} of your credentials to a file in readable form. `
    + 'Spotlight will index it, Time Machine will copy it, and any cloud sync watching your '
    + 'Downloads folder will upload it. Use it to move into a password manager, then delete it.',
    'Export in plain text?'
  );
  if (!ok) return;

  // The passphrase again, even though the vault is open. An unlocked vault on
  // an unattended screen should not be two clicks from a complete dump.
  const pass = await askPassphrase(
    'Re-enter your master passphrase to export in plain text.'
  );
  if (pass === null) return;

  try {
    await unlockVault(pass, vault.config);
  } catch (_) {
    toast('That passphrase is wrong — nothing was exported');
    return;
  }

  downloadFile(
    `command-deck-vault-PLAINTEXT-${stamp()}.json`,
    JSON.stringify(buildPlainExport(vault.entries, vault.groups), null, 2)
  );
  toast('Plaintext export downloaded — delete it when you are done', true);
}

async function restoreVault(file) {
  if (!vault.key) return;
  const parsed = parseVaultExport(await file.text());
  if (!parsed.ok) { toast(parsed.error); return; }

  const pass = await askPassphrase(
    'Enter the master passphrase that backup was written with. '
    + 'It may not be your current one.'
  );
  if (pass === null) return;

  let opened;
  try {
    opened = await readVaultExport(parsed.data, pass);
  } catch (err) {
    toast(err instanceof WrongPassphraseError
      ? 'That passphrase does not open the backup'
      : `Could not read the backup: ${err?.message || err}`);
    return;
  }

  const ok = await askConfirm(
    `${opened.entries.length} credential${opened.entries.length === 1 ? '' : 's'} and `
    + `${opened.groups.length} group${opened.groups.length === 1 ? '' : 's'} will be added, `
    + 're-encrypted under your current passphrase. Anything already in the vault with the same '
    + 'id is overwritten; everything else is left alone.'
    + (opened.skipped.length ? ` ${opened.skipped.length} entries could not be decrypted and will be skipped.` : ''),
    'Restore from backup?'
  );
  if (!ok) return;

  try {
    // Re-encrypted under the CURRENT key, one at a time rather than batched,
    // because each needs its own encrypt call anyway and a partial restore of
    // readable entries beats an all-or-nothing failure.
    for (const g of opened.groups) {
      const data = await encryptJson(vault.key, groupBody(g), { aad: g.id });
      await setDoc(groupRef(g.id), { v: VAULT_VERSION, data, createdAt: g.createdAt || new Date().toISOString() });
    }
    for (const e of opened.entries) {
      const data = await encryptJson(vault.key, entryBody(e), { aad: e.id });
      await setDoc(vaultRef(e.id), {
        v: VAULT_VERSION, data, order: e.order || 0,
        createdAt: e.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }
    toast(`Restored ${opened.entries.length} credentials`, true);
  } catch (err) {
    console.error(err);
    toast('Restore failed partway — check the console');
  }
}

/* ---------- a passphrase prompt that is not window.prompt ---------- */
//
// window.prompt shows the typed text, and some browsers keep its history.
// This is a masked field in the app's own confirm sheet.

let passResolver = null;
function askPassphrase(message) {
  $('pp-msg').textContent = message;
  $('pp-input').value = '';
  $('pp-ov').classList.add('show');
  setTimeout(() => $('pp-input').focus(), 30);
  return new Promise((res) => { passResolver = res; });
}
function settlePassphrase(value) {
  $('pp-ov').classList.remove('show');
  const input = $('pp-input');
  const v = value === null ? null : input.value;
  input.value = '';
  if (passResolver) { passResolver(v); passResolver = null; }
}

/* ---------- clipboard ---------- */

// A password sitting in the clipboard is a password one accidental paste
// away from a chat window, so it is taken back out again.
async function copySecret(text, label) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    toast('This browser blocked the clipboard — reveal and copy by hand');
    return;
  }
  toast(`${label} copied — clears in ${CLIPBOARD_CLEAR_MS / 1000}s`, true);

  if (vault.clipTimer) clearTimeout(vault.clipTimer);
  vault.clipTimer = setTimeout(async () => {
    try {
      // Prefer to clear only if our value is still there. Most browsers deny
      // clipboard reads, in which case the secret wins over the convenience
      // of whatever was copied since.
      let stillOurs = true;
      try { stillOurs = (await navigator.clipboard.readText()) === text; } catch (_) {}
      if (stillOurs) await navigator.clipboard.writeText('');
    } catch (_) {}
  }, CLIPBOARD_CLEAR_MS);
}

/* ---------- reveal toggles ---------- */

function hideSecretInput(eyeId) {
  const btn = $(eyeId);
  if (!btn) return;
  const input = $(eyeId.replace(/-eye$/, ''));
  if (!input) return;
  input.type = 'password';
  input.classList.remove('shown');
  btn.textContent = 'show';
}

function wireEye(eyeId) {
  const btn = $(eyeId);
  const input = $(eyeId.replace(/-eye$/, ''));
  btn.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    input.classList.toggle('shown', show);
    btn.textContent = show ? 'hide' : 'show';
    input.focus();
  });
}

/* ---------- render ---------- */

function renderVault() {
  const hasConfig = !!vault.config;
  const unlocked = !!vault.key;
  const broken = !!vault.configError && !hasConfig;

  $('vault-error').classList.toggle('hidden', !broken);
  $('vault-setup').classList.toggle('hidden', hasConfig || broken);
  $('vault-lock').classList.toggle('hidden', !hasConfig || unlocked);
  $('vault-main').classList.toggle('hidden', !unlocked);

  if (broken) $('ve-detail').textContent = vault.configError;

  // The vault follows the Google account, so a vault that "won't open" is
  // very often the wrong account rather than the wrong passphrase. Saying
  // which one is signed in costs a line and answers that before it is asked.
  // Backup and export need the key, so they are hidden while locked rather
  // than offered and then refused.
  ['v-export-enc', 'v-export-plain', 'v-restore'].forEach((id) => {
    if ($(id)) $(id).classList.toggle('hidden', !unlocked);
  });

  const who = state.user?.email || state.user?.displayName || '';
  ['vs-who', 'vl-who'].forEach((id) => { if ($(id)) $(id).textContent = who ? `Signed in as ${who}` : ''; });

  if (!unlocked) {
    // Hiding the list is not enough. Decrypted values left in the document
    // are still there for devtools, an extension, or a DOM-scraping bug to
    // read, so once the key is gone the markup goes with it.
    $('v-list').innerHTML = '';
    $('v-autolock-note').textContent = '';
    return;
  }

  const matched = vaultSearch(vault.entries, vault.query);
  const shown = filterByGroup(matched, vault.groups, vault.groupFilter);

  $('v-autolock-note').textContent = vault.entries.length
    ? `${vault.entries.length} credential${vault.entries.length === 1 ? '' : 's'} · encrypted in this browser · locks itself after 10 minutes idle`
    : '';

  renderGroupBar(matched);

  if (!shown.length) {
    $('v-list').innerHTML = `<div class="v-empty">${
      vault.entries.length
        ? (vault.query || vault.groupFilter ? 'Nothing matches.' : 'Nothing here yet.')
        : 'Nothing here yet.<br>Everything you add is encrypted before it leaves this browser.'
    }</div>`;
    wireVaultRows();
    return;
  }

  // Sections only when looking at everything. Once a filter or a search has
  // narrowed things down, headers are noise — the question has been answered.
  const grouped = !vault.groupFilter && !vault.query && vault.groups.length;
  $('v-list').innerHTML = grouped
    ? sectionsByGroup(shown, vault.groups).map((sec) => `
        <div class="v-section">
          <div class="v-section-head" data-drop-group="${sec.group ? esc(sec.group.id) : '__none__'}">
            <span class="v-dot" style="background:${sec.group ? esc(sec.group.color) : 'var(--ink-3)'}"></span>
            <span class="v-section-name">${sec.group ? esc(sec.group.name) : 'Ungrouped'}</span>
            <span class="v-section-count">${sec.entries.length}</span>
          </div>
          ${sec.entries.length ? sec.entries.map(rowHtml).join('') : '<div class="v-section-empty">No credentials in this group yet.</div>'}
        </div>`).join('')
    : shown.map(rowHtml).join('');

  wireVaultRows();
}

function renderGroupBar(entriesInScope) {
  const bar = $('v-group-bar');
  if (!vault.groups.length) {
    bar.innerHTML = `<button class="group-chip ghost" data-group-manage>+ Group</button>`;
  } else {
    const counts = countByGroup(entriesInScope, vault.groups);
    const chip = (id, label, color, n) => `
      <button class="group-chip${vault.groupFilter === id ? ' on' : ''}" data-group="${esc(id)}">
        ${color ? `<span class="v-dot" style="background:${esc(color)}"></span>` : ''}
        ${esc(label)}${n === undefined ? '' : `<span class="group-chip-n">${n}</span>`}
      </button>`;

    bar.innerHTML =
      chip('', 'All', '', entriesInScope.length)
      + [...vault.groups].sort(groupOrder).map((g) => chip(g.id, g.name, g.color, counts[g.id] || 0)).join('')
      + (counts[UNGROUPED] ? chip(UNGROUPED, 'Ungrouped', '', counts[UNGROUPED]) : '')
      + `<button class="group-chip ghost" data-group-manage>Manage</button>`;
  }

  bar.querySelectorAll('[data-group]').forEach((b) => b.addEventListener('click', () => {
    touchVault();
    vault.groupFilter = b.dataset.group;
    renderVault();
  }));
  bar.querySelector('[data-group-manage]')?.addEventListener('click', () => {
    touchVault();
    openGroupManager();
  });
}

function rowHtml(e) {
    const revealed = !!vault.revealed[e.id];
    // Dragging is only meaningful against the full list. In a filtered or
    // searched view the rows next to each other are not the rows the position
    // is relative to, so dropping between them would mean something the person
    // did not intend.
    const draggable = (!vault.query && !vault.groupFilter) ? 'true' : 'false';
    const initial = esc((e.title || '?').trim().charAt(0).toUpperCase() || '?');
    const sub = e.username || e.url || '—';
    return `
      <div class="v-row${revealed ? ' revealed' : ''}" data-id="${esc(e.id)}" draggable="${draggable}">
        <div class="v-grip" aria-hidden="true">${draggable === 'true' ? '⠿' : ''}</div>
        <div class="v-badge">${initial}</div>
        <div class="v-main">
          <div class="v-name">${esc(e.title)}</div>
          <div class="v-user">${esc(sub)}</div>
          <div class="v-secret">${revealed ? esc(e.password || '(no password saved)') : esc(maskSecret(e.password))}</div>
        </div>
        <div class="v-acts">
          <button class="v-act" data-act="reveal">${revealed ? 'hide' : 'show'}</button>
          <button class="v-act" data-act="copy">copy</button>
          <button class="v-act" data-act="edit">edit</button>
        </div>
      </div>`;
}

function wireVaultRows() {
  $('v-list').querySelectorAll('.v-row[draggable="true"]').forEach(wireRowDrag);
  $('v-list').querySelectorAll('.v-section-head[data-drop-group]')
    .forEach((h) => wireSectionDrop(h, h.dataset.dropGroup === '__none__' ? '' : h.dataset.dropGroup));

  $('v-list').querySelectorAll('.v-row').forEach((row) => {
    const id = row.dataset.id;
    row.querySelectorAll('.v-act').forEach((btn) => btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      touchVault();
      const e = vault.entries.find((x) => x.id === id);
      if (!e) return;
      if (btn.dataset.act === 'reveal') {
        if (vault.revealed[id]) delete vault.revealed[id]; else vault.revealed[id] = true;
        renderVault();
      } else if (btn.dataset.act === 'copy') {
        if (!e.password) { toast('No password saved on this entry'); return; }
        copySecret(e.password, 'Password');
      } else {
        openEntry(id);
      }
    }));
  });
}

/* ---------- group picker and manager ---------- */

function fillGroupSelect(selected) {
  const sel = $('e-group');
  sel.innerHTML = '<option value="">Ungrouped</option>'
    + [...vault.groups].sort(groupOrder)
        .map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
  // A groupId pointing at a deleted group would otherwise silently select
  // "Ungrouped" and quietly rewrite the entry on the next save.
  sel.value = selected && vault.groups.some((g) => g.id === selected) ? selected : '';
}

function showInlineGroup(show) {
  $('e-group-new-row').classList.toggle('hidden', !show);
  $('e-group-new').classList.toggle('hidden', show);
  if (show) { $('e-group-name').value = ''; $('e-group-name').focus(); }
}

async function createGroupInline() {
  const name = $('e-group-name').value;
  const res = await addGroup(name);
  if (!res) return;
  if (res.error) { $('e-error').textContent = res.error; return; }

  $('e-error').textContent = '';
  showInlineGroup(false);
  // The snapshot that carries the new group is in flight, so seed the select
  // with it now rather than leaving the field blank for a beat.
  fillGroupSelect(res.id);
  const pending = res.id;
  setTimeout(() => { if ($('entry-ov').classList.contains('show')) fillGroupSelect(pending); }, 400);
}

function openGroupManager() {
  $('g-error').textContent = '';
  $('g-new').value = '';
  renderGroupManager();
  $('group-ov').classList.add('show');
  $('g-new').focus();
}

function renderGroupManager() {
  const counts = countByGroup(vault.entries, vault.groups);
  const list = $('g-manage-list');

  list.innerHTML = vault.groups.length
    ? [...vault.groups].sort(groupOrder).map((g) => `
        <div class="cat-manage-row" data-gid="${esc(g.id)}">
          <input type="text" class="g-name" value="${esc(g.name)}" maxlength="60" aria-label="Group name">
          <span class="g-count">${counts[g.id] || 0}</span>
          <button class="g-del" aria-label="Delete group">✕</button>
          <div class="cat-sw-row">
            ${GROUP_PALETTE.map((c) => `<button class="cat-sw${c.toLowerCase() === (g.color || '').toLowerCase() ? ' on' : ''}" style="background:${c}" data-color="${c}" aria-label="Colour ${c}"></button>`).join('')}
          </div>
        </div>`).join('')
    : '<div class="v-empty">No groups yet. Add one above.</div>';

  list.querySelectorAll('.cat-manage-row').forEach((row) => {
    const id = row.dataset.gid;

    const nameInput = row.querySelector('.g-name');
    nameInput.addEventListener('change', async () => {
      const res = await saveGroup(id, { name: nameInput.value });
      if (res?.error) {
        $('g-error').textContent = res.error;
        nameInput.value = groupById(vault.groups, id)?.name || '';
      } else {
        $('g-error').textContent = '';
      }
    });

    row.querySelectorAll('.cat-sw').forEach((sw) => sw.addEventListener('click', async () => {
      const res = await saveGroup(id, { color: sw.dataset.color });
      if (res?.error) $('g-error').textContent = res.error;
    }));

    row.querySelector('.g-del').addEventListener('click', async () => {
      await delGroup(id);
      renderGroupManager();
      renderVault();
    });
  });
}

/* ---------- entry editor ---------- */

function openEntry(id) {
  const e = id ? vault.entries.find((x) => x.id === id) : null;
  const src = e || blankEntry();
  vault.editingId = e ? id : null;

  $('entry-title').textContent = e ? 'Edit credential' : 'New credential';
  $('e-title').value = src.title || '';
  $('e-username').value = src.username || '';
  $('e-password').value = src.password || '';
  $('e-url').value = src.url || '';
  $('e-notes').value = src.notes || '';
  $('e-error').textContent = '';
  showInlineGroup(false);
  // A new credential created while a group is filtered lands in that group —
  // that is almost always what was meant.
  fillGroupSelect(e ? src.groupId : (vault.groupFilter && vault.groupFilter !== UNGROUPED ? vault.groupFilter : ''));
  $('e-delete').classList.toggle('hidden', !e);
  hideSecretInput('e-password-eye');
  paintMeter('e-meter', null, src.password || '');

  $('entry-ov').classList.add('show');
  $('e-title').focus();
}

function closeEntry() {
  $('entry-ov').classList.remove('show');
  vault.editingId = null;
  // Don't leave a password in a hidden input waiting to be re-revealed.
  ['e-title', 'e-username', 'e-password', 'e-url', 'e-notes', 'e-group-name'].forEach((id) => { $(id).value = ''; });
  showInlineGroup(false);
  hideSecretInput('e-password-eye');
  paintMeter('e-meter', null, '');
}

/* ---------- vault wiring ---------- */

document.querySelectorAll('#view-tog button').forEach((b) =>
  b.addEventListener('click', () => setView(b.dataset.view)));

['vs-pass-eye', 'vl-pass-eye', 'e-password-eye'].forEach(wireEye);

$('vs-pass').addEventListener('input', () => {
  paintMeter('vs-meter', 'vs-meter-note', $('vs-pass').value);
  paintSmartWarning('vs-pass', 'vs-smart');
  setupReady();
});
$('vl-pass').addEventListener('input', () => paintSmartWarning('vl-pass', 'vl-smart'));
$('vs-pass2').addEventListener('input', setupReady);
$('vs-ack').addEventListener('change', setupReady);
$('vs-create').addEventListener('click', createVault);
$('vs-pass2').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('vs-create').disabled) createVault(); });

$('vl-unlock').addEventListener('click', doUnlock);
$('vl-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doUnlock(); } });

$('v-search').addEventListener('input', () => { vault.query = $('v-search').value; touchVault(); renderVault(); });
$('v-new').addEventListener('click', () => { touchVault(); openEntry(null); });
$('v-lock-now').addEventListener('click', () => lockVault('Locked.'));

$('entry-x').addEventListener('click', closeEntry);
$('e-cancel').addEventListener('click', closeEntry);
$('e-save').addEventListener('click', () => { touchVault(); saveEntry(); });
$('e-delete').addEventListener('click', () => { if (vault.editingId) deleteEntry(vault.editingId); });
$('e-password').addEventListener('input', () => paintMeter('e-meter', null, $('e-password').value));
$('entry-ov').addEventListener('click', (e) => { if (e.target.id === 'entry-ov') closeEntry(); });

$('e-group-new').addEventListener('click', () => { touchVault(); showInlineGroup(true); });
$('e-group-cancel').addEventListener('click', () => showInlineGroup(false));
$('e-group-save').addEventListener('click', createGroupInline);
$('e-group-name').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); createGroupInline(); }
  if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); showInlineGroup(false); }
});

$('v-export-enc').addEventListener('click', () => { $('menu-ov').classList.remove('show'); exportEncrypted(); });
$('v-export-plain').addEventListener('click', () => { $('menu-ov').classList.remove('show'); exportPlaintext(); });
$('v-restore').addEventListener('click', () => { $('menu-ov').classList.remove('show'); $('v-restore-file').click(); });
$('v-restore-file').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (f) restoreVault(f);
});

wireEye('pp-input-eye');
$('pp-ok').addEventListener('click', () => settlePassphrase(true));
$('pp-cancel').addEventListener('click', () => settlePassphrase(null));
$('pp-ov').addEventListener('click', (e) => { if (e.target.id === 'pp-ov') settlePassphrase(null); });
$('pp-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); settlePassphrase(true); }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); settlePassphrase(null); }
});

$('group-x').addEventListener('click', () => $('group-ov').classList.remove('show'));
$('group-ov').addEventListener('click', (e) => { if (e.target.id === 'group-ov') $('group-ov').classList.remove('show'); });
$('g-new-btn').addEventListener('click', async () => {
  const res = await addGroup($('g-new').value);
  if (res?.error) { $('g-error').textContent = res.error; return; }
  $('g-error').textContent = '';
  $('g-new').value = '';
  $('g-new').focus();
  setTimeout(renderGroupManager, 300);
});
$('g-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('g-new-btn').click(); } });

$('e-gen-len').addEventListener('input', () => { $('e-gen-len-label').textContent = $('e-gen-len').value; });
$('e-gen').addEventListener('click', () => {
  touchVault();
  const pw = genPassword({
    length: Number($('e-gen-len').value) || 20,
    symbols: $('e-gen-sym').checked
  });
  const input = $('e-password');
  input.value = pw;
  input.type = 'text';
  input.classList.add('shown');
  $('e-password-eye').textContent = 'hide';
  paintMeter('e-meter', null, pw);
});

// Any deliberate interaction inside the vault postpones the auto-lock.
// Scrolling and mouse movement deliberately do not — leaving the vault open
// under a moving cursor should still lock it.
['keydown', 'pointerdown'].forEach((ev) =>
  $('vault-view').addEventListener(ev, touchVault, true));

/* ---------- wiring ---------- */

$('cap-add').addEventListener('click', () => { capture(); $('cap-input').focus(); });
$('cap-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); capture(); } });

document.querySelectorAll('#theme-tog button').forEach((b) =>
  b.addEventListener('click', () => applyTheme(b.dataset.themeSet)));

$('menu-btn').addEventListener('click', () => $('menu-ov').classList.add('show'));
$('menu-x').addEventListener('click', () => $('menu-ov').classList.remove('show'));
$('cat-x').addEventListener('click', () => $('cat-ov').classList.remove('show'));

$('export-btn').addEventListener('click', exportData);
$('import-btn').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', handleImport);

$('cat-new-btn').addEventListener('click', () => {
  const inp = $('cat-new');
  if (addCat(inp.value)) { inp.value = ''; inp.focus(); }
});
$('cat-new').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('cat-new-btn').click(); }
});

$('confirm-ok').addEventListener('click', () => settleConfirm(true));
$('confirm-cancel').addEventListener('click', () => settleConfirm(false));

// Click the dimmed backdrop to close whichever sheet is open.
['menu-ov', 'cat-ov'].forEach((id) =>
  $(id).addEventListener('click', (e) => { if (e.target.id === id) $(id).classList.remove('show'); }));
$('confirm-ov').addEventListener('click', (e) => { if (e.target.id === 'confirm-ov') settleConfirm(false); });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    settleConfirm(false);
    $('menu-ov').classList.remove('show');
    $('cat-ov').classList.remove('show');
    if ($('entry-ov').classList.contains('show')) closeEntry();
    $('group-ov').classList.remove('show');
  }
  if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    e.preventDefault();
    (currentView === 'vault' && vault.key ? $('v-search') : $('cap-input')).focus();
  }
  // Cmd/Ctrl-L locks the vault from anywhere, the way a screen lock should be
  // reachable without hunting for a button.
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l' && vault.key) {
    e.preventDefault();
    lockVault('Locked.');
    setView('vault');
  }
});

// Re-render at midnight so "today" / "tomorrow" labels stay honest.
setInterval(() => { if (state.user) render(); }, 60_000);
