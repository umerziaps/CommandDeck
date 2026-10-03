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

import {
  getStorage, ref as storageRef, uploadBytesResumable,
  getDownloadURL, deleteObject
} from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-storage.js';

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
  nextEntryOrder, planReorder, isNote, entrySecret, DEFAULT_KIND,
  buildEncryptedExport, buildPlainExport, parseVaultExport, readVaultExport,
  blankGroup, normaliseGroup, groupBody, groupOrder, groupById, validateGroup,
  countByGroup, filterByGroup, sectionsByGroup, entryGroupId,
  GROUP_PALETTE, UNGROUPED,
  genPassword, passwordStrength, maskSecret, hasSmartPunctuation,
  WrongPassphraseError, VAULT_VERSION
} from './vault.js';
import {
  blankEvent, normaliseEvent, eventBody, eventOrder, validateEvent,
  filterEvents, groupByMonth, monthlyDensity, countByProject,
  blankProject, normaliseProject, validateProject, projectOrder, projectById,
  attachmentPath, validateAttachment, normaliseAttachment, formatBytes,
  attachmentKind, monthLabel, dayLabel, todayDay, isDayString,
  RANGES, PROJECT_PALETTE, UNASSIGNED, MAX_ATTACHMENTS_PER_EVENT
} from './timeline.js';
import {
  PLATFORMS, platformLabel, blankApp, normaliseApp, appBody, validateApp, appOrder, appById,
  blankRelease, normaliseRelease, releaseBody, validateRelease, releaseLabel, releaseOrder,
  filterReleases, environments, appSummary, locationKind, isOpenable, shortLocation,
  parseBuildEmail, dedupeReleases, APP_PALETTE
} from './releases.js';
import { readEmlFile } from './eml.js';
import {
  validateKey as validateApiKey, listModels, pickModel, extractReleases,
  usable as usableRelease, ClaudeError
} from './claude.js';

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

// Created lazily. A project with no Cloud Storage bucket provisioned throws
// here, and that must not stop the board and the vault from loading — the
// timeline degrades to events without attachments instead.
let storage = null;
let storageError = null;
function getStore() {
  if (storage || storageError) return storage;
  try { storage = getStorage(app); } catch (err) {
    storageError = err?.message || String(err);
    console.warn('Cloud Storage unavailable:', storageError);
  }
  return storage;
}

/* ---------- state ---------- */

const state = {
  user: null,
  items: [],
  cats: [],
  catFilter: '',
  events: [],
  projects: [],
  tlRange: '6m',
  tlProject: '',
  tlQuery: '',
  tlEditingId: null,
  tlDraftAtts: [],      // attachments staged in the open editor
  apps: [],
  releases: [],
  rlApp: '',
  rlEnv: '',
  rlProdOnly: false,
  rlQuery: '',
  rlEditingId: null,
  impParsed: [],
  impFile: null,        // { name, bytes, text } once an .eml is read
  apEditingId: null,
  apColor: APP_PALETTE[0],
  apFile: null,
  apiKey: null,         // decrypted, in memory only, while the vault is open
  apiKeyPresent: false, // whether one is stored, known without unlocking
  expanded: {},
  collapsed: { __done__: true },
  pending: false,
  fromCache: false
};

let unsubItems = null;
let unsubCats = null;
let unsubEvents = null;
let unsubProjects = null;
let unsubApps = null;
let unsubReleases = null;

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
const integrationsRef = () => doc(db, 'users', state.user.uid, 'vaultMeta', 'integrations');
const appsCol = () => collection(db, 'users', state.user.uid, 'apps');
const appRef = (id) => doc(db, 'users', state.user.uid, 'apps', id);
const releasesCol = () => collection(db, 'users', state.user.uid, 'releases');
const releaseRef = (id) => doc(db, 'users', state.user.uid, 'releases', id);

const eventsCol = () => collection(db, 'users', state.user.uid, 'events');
const eventRef = (id) => doc(db, 'users', state.user.uid, 'events', id);
const projectsCol = () => collection(db, 'users', state.user.uid, 'projects');
const projectRef = (id) => doc(db, 'users', state.user.uid, 'projects', id);

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
  if (unsubEvents) { unsubEvents(); unsubEvents = null; }
  if (unsubProjects) { unsubProjects(); unsubProjects = null; }
  if (unsubApps) { unsubApps(); unsubApps = null; }
  if (unsubReleases) { unsubReleases(); unsubReleases = null; }

  $('boot').classList.add('hidden');

  // Signing out must drop the key, not just hide the UI — another account
  // signing in on this tab would otherwise inherit a live vault session.
  lockVault();
  vault.config = null;

  if (!user) {
    state.items = []; state.cats = []; state.events = []; state.projects = [];
    state.apps = []; state.releases = [];
    $('app').classList.add('hidden');
    $('gate').classList.remove('hidden');
    return;
  }

  $('gate').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('who').textContent = user.email || user.displayName || user.uid;

  subscribe();
  loadVaultConfig();
  loadApiKey();
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

  unsubEvents = onSnapshot(eventsCol(), (snap) => {
    state.events = snap.docs.map((d) => normaliseEvent(d.id, d.data()));
    if (currentView === 'timeline') renderTimeline();
  }, (err) => {
    console.error(err);
    toast('Could not read the timeline — check the Firestore rules');
  });

  unsubProjects = onSnapshot(projectsCol(), (snap) => {
    state.projects = snap.docs.map((d) => normaliseProject(d.id, d.data())).sort(projectOrder);
    if (currentView === 'timeline') renderTimeline();
  }, (err) => console.error(err));

  unsubApps = onSnapshot(appsCol(), (snap) => {
    state.apps = snap.docs.map((d) => normaliseApp(d.id, d.data())).sort(appOrder);
    if (currentView === 'releases') renderReleases();
  }, (err) => console.error(err));

  unsubReleases = onSnapshot(releasesCol(), (snap) => {
    state.releases = snap.docs.map((d) => normaliseRelease(d.id, d.data()));
    if (currentView === 'releases') renderReleases();
  }, (err) => {
    console.error(err);
    toast('Could not read releases — check the Firestore rules');
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
  $('timeline-view').classList.toggle('hidden', v !== 'timeline');
  $('releases-view').classList.toggle('hidden', v !== 'releases');
  document.querySelectorAll('#view-tog button')
    .forEach((b) => b.classList.toggle('on', b.dataset.view === v));

  if (v === 'vault') { renderVault(); focusVault(); }
  else if (v === 'timeline') { renderTimeline(); $('tl-search').focus(); }
  else if (v === 'releases') { renderReleases(); $('rl-search').focus(); }
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
    loadApiKey();
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
  state.apiKey = null;        // decrypted only while the vault is open
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

  const kind = currentKind();
  const entry = kind === 'note'
    // A note carries no credential fields at all. Leaving stale values behind
    // from a login that was switched to a note would quietly keep a password
    // in the vault under an entry whose UI no longer shows one.
    ? {
        title: $('e-title').value.trim(),
        username: '', password: '', url: '',
        notes: $('e-body').value,
        groupId: $('e-group').value || '',
        kind: 'note'
      }
    : {
        title: $('e-title').value.trim(),
        username: $('e-username').value.trim(),
        password: $('e-password').value,
        url: $('e-url').value.trim(),
        notes: $('e-notes').value,
        groupId: $('e-group').value || '',
        kind: 'login'
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

  // Counted by kind: calling a recovery-codes note a "credential" is the kind
  // of small lie that makes someone doubt the rest of the labelling.
  const notes = vault.entries.filter(isNote).length;
  const logins = vault.entries.length - notes;
  const parts = [];
  if (logins) parts.push(`${logins} credential${logins === 1 ? '' : 's'}`);
  if (notes) parts.push(`${notes} note${notes === 1 ? '' : 's'}`);
  $('v-autolock-note').textContent = parts.length
    ? `${parts.join(' · ')} · encrypted in this browser · locks itself after 10 minutes idle`
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
    const note = isNote(e);
    const secret = entrySecret(e);

    const badge = note
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>'
      : esc((e.title || '?').trim().charAt(0).toUpperCase() || '?');

    // A note's subtitle must describe it without quoting it — the body is the
    // secret, so a preview of the first line would defeat hiding it.
    const lines = secret ? secret.split('\n').length : 0;
    const sub = note
      ? `Secure note · ${secret.length} characters${lines > 1 ? `, ${lines} lines` : ''}`
      : (e.username || e.url || '—');
    return `
      <div class="v-row${revealed ? ' revealed' : ''}" data-id="${esc(e.id)}" draggable="${draggable}">
        <div class="v-grip" aria-hidden="true">${draggable === 'true' ? '⠿' : ''}</div>
        <div class="v-badge${note ? ' note' : ''}">${badge}</div>
        <div class="v-main">
          <div class="v-name">${esc(e.title)}</div>
          <div class="v-user">${esc(sub)}</div>
          <div class="v-secret${note ? ' body' : ''}">${
            revealed
              ? esc(secret || (note ? '(empty)' : '(no password saved)'))
              : esc(maskSecret(secret))
          }</div>
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
        const secret = entrySecret(e);
        if (!secret) { toast(isNote(e) ? 'This note is empty' : 'No password saved on this entry'); return; }
        copySecret(secret, isNote(e) ? 'Note' : 'Password');
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

function setEntryKind(kind) {
  const note = kind === 'note';
  document.querySelectorAll('#e-kind-tog button')
    .forEach((b) => b.classList.toggle('on', b.dataset.kind === kind));
  $('e-login-fields').classList.toggle('hidden', note);
  $('e-note-fields').classList.toggle('hidden', !note);
  $('entry-title').textContent = vault.editingId
    ? (note ? 'Edit note' : 'Edit credential')
    : (note ? 'New secure note' : 'New credential');
}

const currentKind = () =>
  document.querySelector('#e-kind-tog button.on')?.dataset.kind || DEFAULT_KIND;

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
  $('e-body').value = isNote(src) ? (src.notes || '') : '';
  setEntryKind(src.kind || DEFAULT_KIND);
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
  ['e-title', 'e-username', 'e-password', 'e-url', 'e-notes', 'e-body', 'e-group-name']
    .forEach((id) => { $(id).value = ''; });
  setEntryKind(DEFAULT_KIND);
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

document.querySelectorAll('#e-kind-tog button').forEach((b) =>
  b.addEventListener('click', () => { touchVault(); setEntryKind(b.dataset.kind); $('e-error').textContent = ''; }));

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
    if ($('ev-ov').classList.contains('show')) closeEvent();
    if ($('rl-ov').classList.contains('show')) closeRelease();
    ['imp-ov', 'apps-ov', 'key-ov'].forEach((id) => $(id).classList.remove('show'));
    $('group-ov').classList.remove('show');
  }
  if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    e.preventDefault();
    const target = currentView === 'releases' ? $('rl-search')
      : currentView === 'timeline' ? $('tl-search')
      : (currentView === 'vault' && vault.key ? $('v-search') : $('cap-input'));
    target.focus();
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

/* ================================================================== *
 * TIMELINE
 *
 * A record of what happened at work and when, so that six months later the
 * shape of a period can be seen rather than reconstructed. Plaintext by
 * choice — see docs/timeline.js for what that costs.
 * ================================================================== */

/* ---------- render ---------- */

function renderTimeline() {
  const today = todayDay();
  const inRange = filterEvents(state.events, {
    rangeKey: state.tlRange, projectId: '', query: state.tlQuery, today
  });
  const shown = filterEvents(state.events, {
    rangeKey: state.tlRange, projectId: state.tlProject, query: state.tlQuery, today
  });

  renderRangeTog();
  renderProjectBar(inRange);
  renderStrip(shown, today);

  if (!shown.length) {
    $('tl-list').innerHTML = `<div class="tl-empty">${
      state.events.length
        ? 'Nothing in this window.<br>Widen the range, or clear the filters.'
        : 'No events yet.<br>Record what happened — a spec handed over, a release published, an incident — and it will still make sense in a year.'
    }</div>`;
    return;
  }

  $('tl-list').innerHTML = groupByMonth(shown).map((m) => `
    <section class="tl-month">
      <div class="tl-month-head">
        <span class="tl-month-name">${esc(m.label)}</span>
        <span class="tl-month-n">${m.events.length} event${m.events.length === 1 ? '' : 's'}</span>
      </div>
      ${m.events.map(eventHtml).join('')}
    </section>`).join('');

  $('tl-list').querySelectorAll('.tl-body').forEach((el) =>
    el.addEventListener('click', (e) => {
      if (e.target.closest('.att-chip')) return;   // the chip opens the file
      openEvent(el.dataset.id);
    }));

  $('tl-list').querySelectorAll('.att-chip').forEach((chip) =>
    chip.addEventListener('click', (e) => { e.stopPropagation(); openAttachment(chip.dataset.path, chip.dataset.name); }));
}

function renderRangeTog() {
  const bar = $('tl-range');
  if (bar.childElementCount !== RANGES.length) {
    bar.innerHTML = RANGES.map((r) =>
      `<button data-range="${r.key}">${esc(r.key === 'all' ? 'All' : r.key)}</button>`).join('');
    bar.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      state.tlRange = b.dataset.range;
      renderTimeline();
    }));
  }
  bar.querySelectorAll('button').forEach((b) =>
    b.classList.toggle('on', b.dataset.range === state.tlRange));
}

function renderProjectBar(scope) {
  const bar = $('tl-proj-bar');
  if (!state.projects.length) { bar.innerHTML = ''; return; }

  const counts = countByProject(scope, state.projects);
  const chip = (id, label, color, n) => `
    <button class="group-chip${state.tlProject === id ? ' on' : ''}" data-proj="${esc(id)}">
      ${color ? `<span class="v-dot" style="background:${esc(color)}"></span>` : ''}
      ${esc(label)}<span class="group-chip-n">${n}</span>
    </button>`;

  bar.innerHTML = chip('', 'All', '', scope.length)
    + state.projects.map((p) => chip(p.id, p.name, p.color, counts[p.id] || 0)).join('')
    + (counts[UNASSIGNED] ? chip(UNASSIGNED, 'Unassigned', '', counts[UNASSIGNED]) : '');

  bar.querySelectorAll('[data-proj]').forEach((b) => b.addEventListener('click', () => {
    state.tlProject = b.dataset.proj;
    renderTimeline();
  }));
}

/**
 * The density strip.
 *
 * One series, so no legend — the caption says what is plotted. No value on
 * every bar either: the peak is called out in the subtitle and every single
 * count is readable in the month headings below, which is the table view this
 * chart is allowed to lean on. Hovering gives the rest.
 */
function renderStrip(shown, today) {
  const bars = monthlyDensity(shown, { rangeKey: state.tlRange, today });
  const strip = $('tl-strip');
  const axis = $('tl-axis');

  if (!bars.length) {
    strip.innerHTML = '';
    axis.innerHTML = '';
    $('tl-chart-sub').textContent = '';
    $('tl-chart-fig').classList.add('hidden');
    return;
  }
  $('tl-chart-fig').classList.remove('hidden');

  const max = Math.max(...bars.map((b) => b.count), 1);
  const total = bars.reduce((n, b) => n + b.count, 0);
  // Name the peak month only when there IS one. With three months tied at 2,
  // "peak 2 in May" points at a month no busier than two others and reads as
  // a finding rather than a tie.
  const peakMonths = bars.filter((b) => b.count === max && max > 0);
  $('tl-chart-sub').textContent = total
    ? `${total} total · ${peakMonths.length === 1 ? `peak ${max} in ${peakMonths[0].label}` : `peak ${max} a month`}`
    : 'nothing in this window';

  // The hit target is the whole column, not the bar — a one-event month is a
  // 3px mark and nobody should have to land on it.
  strip.innerHTML = bars.map((b) => `
    <div class="tl-slot${b.count ? '' : ' zero'}" data-month="${esc(b.month)}"
         tabindex="0" role="listitem"
         aria-label="${esc(b.label)}: ${b.count} event${b.count === 1 ? '' : 's'}">
      <span class="tl-tip">${esc(b.label)} · ${b.count} event${b.count === 1 ? '' : 's'}</span>
      <div class="bar" style="height:${b.count ? Math.max(6, Math.round((b.count / max) * 100)) : 0}%"></div>
    </div>`).join('');

  // Thin the labels so they never collide: roughly eight, always including the
  // newest month. The year is kept on January and on the oldest label — a
  // 13-month strip otherwise shows "Oct" at both ends and says nothing about
  // which is which.
  const step = Math.max(1, Math.ceil(bars.length / 8));
  axis.innerHTML = bars.map((b, i) => {
    if ((bars.length - 1 - i) % step !== 0) return '<span></span>';
    const [, m] = b.month.split('-');
    const keepYear = m === '01' || i === 0 || i === bars.length - 1;
    return `<span>${esc(keepYear ? b.label.replace(' 20', " '") : b.label.replace(/ \d{4}$/, ''))}</span>`;
  }).join('');

  strip.querySelectorAll('.tl-slot').forEach((slot) => {
    const jump = () => {
      const head = [...$('tl-list').querySelectorAll('.tl-month-name')]
        .find((h) => h.textContent === monthLabel(slot.dataset.month));
      head?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      strip.querySelectorAll('.tl-slot').forEach((s) => s.classList.toggle('cur', s === slot));
    };
    slot.addEventListener('click', jump);
    slot.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(); } });
  });
}

function eventHtml(e) {
  const proj = projectById(state.projects, e.projectId);
  const atts = e.attachments || [];
  return `
    <article class="tl-event">
      <div class="tl-spine">
        <span class="tl-day">${esc(dayLabel(e.date))}</span>
        <span class="tl-node" style="background:${esc(proj ? proj.color : 'var(--ink-3)')}"></span>
        <span class="tl-rail"></span>
      </div>
      <div class="tl-body" data-id="${esc(e.id)}">
        <div class="tl-title">${esc(e.title)}</div>
        ${proj ? `<div class="tl-proj">${esc(proj.name)}</div>` : ''}
        ${e.body ? `<div class="tl-text">${esc(e.body)}</div>` : ''}
        ${atts.length ? `<div class="tl-atts">${atts.map(attChipHtml).join('')}</div>` : ''}
      </div>
    </article>`;
}

const ATT_GLYPH = {
  image: '<circle cx="12" cy="12" r="9"/><path d="M5 17l4-4 3 3 3-3 4 4"/>',
  pdf:   '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v5h5"/>',
  email: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3.5 7.5 12 13l8.5-5.5"/>',
  doc:   '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v5h5"/><path d="M10 13h6M10 17h4"/>',
  sheet: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16M10 4v16"/>',
  slides:'<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M12 17v3"/>',
  archive:'<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M10 4v6l2-1.5 2 1.5V4"/>',
  file:  '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v5h5"/>'
};

function attChipHtml(a) {
  return `
    <button class="att-chip" data-path="${esc(a.path)}" data-name="${esc(a.name)}" title="${esc(a.name)}">
      <svg class="att-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${ATT_GLYPH[attachmentKind(a)] || ATT_GLYPH.file}</svg>
      <span class="n">${esc(a.name)}</span>
      <span class="sz">${esc(formatBytes(a.size))}</span>
    </button>`;
}

/* ---------- attachments ---------- */

async function openAttachment(path, name) {
  const store = getStore();
  if (!store) { toast('Cloud Storage is not set up on this project'); return; }
  try {
    // Minted on demand rather than stored. A Firebase download URL carries a
    // token that works forever once issued; keeping one in a plaintext
    // Firestore document would be a permanent readable handle to the file.
    const url = await getDownloadURL(storageRef(store, path));
    window.open(url, '_blank', 'noopener');
  } catch (err) {
    console.error(err);
    toast(`Could not open ${name}`);
  }
}

function renderDraftAttachments() {
  const list = $('ev-att-list');
  list.innerHTML = state.tlDraftAtts.map((a, i) => `
    <div class="att-row" data-i="${i}">
      <span class="n">${esc(a.name)}</span>
      ${a.uploading
        ? `<span class="prog"><span style="width:${a.progress || 0}%"></span></span>`
        : `<span class="sz">${esc(formatBytes(a.size))}</span>`}
      <button class="x" aria-label="Remove ${esc(a.name)}" ${a.uploading ? 'disabled' : ''}>✕</button>
    </div>`).join('');

  list.querySelectorAll('.att-row .x').forEach((b) =>
    b.addEventListener('click', () => removeDraftAttachment(Number(b.closest('.att-row').dataset.i))));
}

async function addFiles(files) {
  const store = getStore();
  if (!store) {
    $('ev-att-warn').textContent =
      'Cloud Storage is not provisioned on this Firebase project, so attachments cannot be uploaded. '
      + 'Firebase console → Storage → Get started. The event itself will still save.';
    return;
  }
  if (!state.tlEditingId) state.tlEditingId = uid('ev');   // need an id to file under
  $('ev-att-warn').textContent = '';

  for (const file of files) {
    const check = validateAttachment(file, state.tlDraftAtts);
    if (!check.ok) { $('ev-att-warn').textContent = check.error; continue; }

    const id = uid('a');
    const path = attachmentPath(state.user.uid, state.tlEditingId, id, file.name);
    const draft = { id, name: file.name, size: file.size, type: file.type, path, uploading: true, progress: 0 };
    state.tlDraftAtts.push(draft);
    renderDraftAttachments();

    try {
      const task = uploadBytesResumable(storageRef(store, path), file,
        { contentType: file.type || 'application/octet-stream' });
      await new Promise((res, rej) => {
        task.on('state_changed',
          (snap) => {
            draft.progress = Math.round((snap.bytesTransferred / Math.max(1, snap.totalBytes)) * 100);
            renderDraftAttachments();
          }, rej, res);
      });
      draft.uploading = false;
      draft.uploadedAt = new Date().toISOString();
    } catch (err) {
      console.error(err);
      state.tlDraftAtts = state.tlDraftAtts.filter((a) => a.id !== id);
      $('ev-att-warn').textContent =
        `${file.name} did not upload: ${err?.code === 'storage/unauthorized'
          ? 'the Storage rules rejected it — publish storage.rules.'
          : (err?.message || err)}`;
    }
    renderDraftAttachments();
  }
}

async function removeDraftAttachment(i) {
  const a = state.tlDraftAtts[i];
  if (!a) return;
  state.tlDraftAtts.splice(i, 1);
  renderDraftAttachments();
  // Delete the object too. Dropping only the reference would leave the file in
  // the bucket forever, counting against the quota and still downloadable by
  // anyone who knows the path.
  const store = getStore();
  if (store && a.path) {
    try { await deleteObject(storageRef(store, a.path)); }
    catch (err) { if (err?.code !== 'storage/object-not-found') console.warn('Orphaned object:', a.path, err); }
  }
}

/* ---------- editor ---------- */

function openEvent(id) {
  const ev = id ? state.events.find((e) => e.id === id) : null;
  const src = ev || blankEvent();
  state.tlEditingId = ev ? id : null;
  state.tlDraftAtts = (src.attachments || []).map((a) => ({ ...a }));

  $('ev-heading').textContent = ev ? 'Edit event' : 'New event';
  $('ev-date').value = isDayString(src.date) ? src.date : todayDay();
  $('ev-title').value = src.title || '';
  $('ev-body').value = src.body || '';
  $('ev-error').textContent = '';
  $('ev-att-warn').textContent = '';
  $('ev-delete').classList.toggle('hidden', !ev);
  showInlineProject(false);
  fillProjectSelect(ev ? src.projectId : (state.tlProject && state.tlProject !== UNASSIGNED ? state.tlProject : ''));
  renderDraftAttachments();

  $('ev-ov').classList.add('show');
  $('ev-title').focus();
}

function closeEvent() {
  $('ev-ov').classList.remove('show');
  state.tlEditingId = null;
  state.tlDraftAtts = [];
  ['ev-title', 'ev-body', 'ev-project-name'].forEach((id) => { $(id).value = ''; });
  $('ev-att-list').innerHTML = '';
  showInlineProject(false);
}

async function saveEvent() {
  const event = {
    title: $('ev-title').value.trim(),
    date: $('ev-date').value,
    body: $('ev-body').value,
    projectId: $('ev-project').value || '',
    attachments: state.tlDraftAtts.filter((a) => !a.uploading).map(normaliseAttachment).filter(Boolean)
  };

  const check = validateEvent(event);
  if (!check.ok) { $('ev-error').textContent = check.error; return; }
  if (state.tlDraftAtts.some((a) => a.uploading)) {
    $('ev-error').textContent = 'Wait for the uploads to finish.';
    return;
  }

  const id = state.tlEditingId || uid('ev');
  const now = new Date().toISOString();
  const existing = state.events.find((e) => e.id === id);

  try {
    await setDoc(eventRef(id), {
      ...eventBody(event),
      createdAt: existing?.createdAt || now,
      updatedAt: now
    });
    closeEvent();
    toast(existing ? 'Event saved' : 'Event recorded', true);
  } catch (err) {
    console.error(err);
    $('ev-error').textContent = `Could not save: ${err?.message || err}`;
  }
}

async function deleteEvent(id) {
  const ev = state.events.find((e) => e.id === id);
  const n = ev?.attachments?.length || 0;
  const ok = await askConfirm(
    `"${ev?.title || 'This event'}" will be deleted`
    + (n ? `, along with ${n} attachment${n === 1 ? '' : 's'}.` : '.')
    + ' There is no undo.',
    'Delete event?'
  );
  if (!ok) return;

  try {
    // Files first. A failed document delete leaves an event with dead
    // attachments, which is visible and fixable; the reverse leaves files in
    // the bucket that nothing references and nobody will ever find.
    const store = getStore();
    if (store) {
      for (const a of ev?.attachments || []) {
        try { await deleteObject(storageRef(store, a.path)); }
        catch (err) { if (err?.code !== 'storage/object-not-found') console.warn('Orphaned object:', a.path, err); }
      }
    }
    await deleteDoc(eventRef(id));
    closeEvent();
    toast('Event deleted', true);
  } catch (err) { console.error(err); toast('Could not delete the event'); }
}

/* ---------- projects ---------- */

function fillProjectSelect(selected) {
  const sel = $('ev-project');
  sel.innerHTML = '<option value="">Unassigned</option>'
    + state.projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  sel.value = selected && state.projects.some((p) => p.id === selected) ? selected : '';
}

function showInlineProject(show) {
  $('ev-project-new-row').classList.toggle('hidden', !show);
  if (show) { $('ev-project-name').value = ''; $('ev-project-name').focus(); }
}

async function createProjectInline() {
  const name = $('ev-project-name').value;
  const project = { ...blankProject(state.projects.length), name: name.trim() };
  const check = validateProject(project, state.projects);
  if (!check.ok) { $('ev-error').textContent = check.error; return; }

  const id = uid('p');
  try {
    await setDoc(projectRef(id), { ...project, createdAt: new Date().toISOString() });
    $('ev-error').textContent = '';
    showInlineProject(false);
    fillProjectSelect(id);
    setTimeout(() => { if ($('ev-ov').classList.contains('show')) fillProjectSelect(id); }, 400);
  } catch (err) {
    console.error(err);
    $('ev-error').textContent = `Could not create the project: ${err?.message || err}`;
  }
}

/* ---------- timeline wiring ---------- */

$('tl-new').addEventListener('click', () => openEvent(null));
$('tl-search').addEventListener('input', () => { state.tlQuery = $('tl-search').value; renderTimeline(); });

$('ev-x').addEventListener('click', closeEvent);
$('ev-cancel').addEventListener('click', closeEvent);
$('ev-save').addEventListener('click', saveEvent);
$('ev-delete').addEventListener('click', () => { if (state.tlEditingId) deleteEvent(state.tlEditingId); });
$('ev-ov').addEventListener('click', (e) => { if (e.target.id === 'ev-ov') closeEvent(); });

$('ev-project-new').addEventListener('click', () => showInlineProject(true));
$('ev-project-cancel').addEventListener('click', () => showInlineProject(false));
$('ev-project-save').addEventListener('click', createProjectInline);
$('ev-project-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); createProjectInline(); }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); showInlineProject(false); }
});

$('ev-attach').addEventListener('click', () => $('ev-files').click());
$('ev-files').addEventListener('change', (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (files.length) addFiles(files);
});

const drop = $('ev-drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => {
  e.preventDefault(); drop.classList.add('over');
}));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) addFiles(files);
});

/* ================================================================== *
 * RELEASES
 *
 * What shipped, which version, built for which environment, and whether it
 * reached production. See docs/releases.js for the model and the build-email
 * parser that fills it without retyping.
 * ================================================================== */

function renderReleases() {
  renderAppBar();
  renderEnvSelect();

  const shown = filterReleases(state.releases, {
    appId: state.rlApp, env: state.rlEnv, prodOnly: state.rlProdOnly, query: state.rlQuery
  }).sort(releaseOrder);

  renderSummary();

  if (!shown.length) {
    $('rl-list').innerHTML = `<div class="tl-empty">${
      state.releases.length
        ? 'Nothing matches those filters.'
        : 'No releases recorded.<br>Paste a build email to backfill a whole thread at once.'
    }</div>`;
    return;
  }

  // Grouped by app when looking at everything; a flat run when one app is
  // selected, because then the question is the sequence, not the grouping.
  if (!state.rlApp && state.apps.length > 1) {
    const byApp = new Map();
    for (const r of shown) {
      if (!byApp.has(r.appId)) byApp.set(r.appId, []);
      byApp.get(r.appId).push(r);
    }
    $('rl-list').innerHTML = [...byApp.entries()].map(([appId, rs]) => {
      const app = appById(state.apps, appId);
      return `
        <section class="rl-group">
          <div class="tl-month-head">
            <span class="v-dot" style="background:${esc(app ? app.color : 'var(--ink-3)')}"></span>
            <span class="tl-month-name">${esc(app ? app.name : 'Unknown app')}</span>
            <span class="tl-month-n">${rs.length} build${rs.length === 1 ? '' : 's'}</span>
          </div>
          ${rs.map(releaseHtml).join('')}
        </section>`;
    }).join('');
  } else {
    $('rl-list').innerHTML = shown.map(releaseHtml).join('');
  }

  $('rl-list').querySelectorAll('.rl-card').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('.loc')) return;
    openRelease(el.dataset.id);
  }));
  $('rl-list').querySelectorAll('.loc').forEach((el) => el.addEventListener('click', (e) => {
    e.stopPropagation();
    const v = el.dataset.value;
    if (isOpenable(v)) window.open(v, '_blank', 'noopener');
    else copyPlain(v, 'Path');
  }));
}

function releaseHtml(r) {
  const app = appById(state.apps, r.appId);
  const loc = (label, value) => {
    if (!value) return '';
    const kind = locationKind(value);
    // A UNC path is offered as "copy", not as a link. An anchor to \\fs04 from
    // an https page is a control that silently does nothing.
    return `
      <button class="loc" data-value="${esc(value)}" title="${esc(value)}">
        <span class="loc-k">${esc(label)}</span>
        <span class="loc-v">${esc(shortLocation(value))}</span>
        <span class="loc-a">${kind === 'url' ? 'open' : 'copy'}</span>
      </button>`;
  };

  return `
    <article class="rl-card" data-id="${esc(r.id)}">
      <div class="rl-head">
        <span class="rl-ver">${esc(releaseLabel(r))}</span>
        ${r.env ? `<span class="rl-env-chip">${esc(r.env)}</span>` : ''}
        ${r.production
          ? `<span class="rl-prod">Production · ${esc(r.prodDate)}</span>`
          : '<span class="rl-notprod">not in production</span>'}
        <span class="rl-date">${esc(r.buildDate)}</span>
      </div>
      ${!state.rlApp && state.apps.length <= 1 && app ? `<div class="tl-proj">${esc(app.name)}</div>` : ''}
      ${r.changes ? `<div class="rl-changes">${esc(r.changes)}</div>` : ''}
      ${(r.sourceUrl || r.artifactUrl) ? `<div class="rl-locs">${loc('source', r.sourceUrl)}${loc('artifact', r.artifactUrl)}</div>` : ''}
      ${r.notes ? `<div class="rl-notes">${esc(r.notes)}</div>` : ''}
    </article>`;
}

function renderSummary() {
  const box = $('rl-summary');
  const apps = state.rlApp ? state.apps.filter((a) => a.id === state.rlApp) : state.apps;
  if (!apps.length) { box.innerHTML = ''; return; }

  box.innerHTML = apps.map((a) => {
    const s = appSummary(state.releases, a.id);
    if (!s.total) return '';
    return `
      <div class="rl-stat">
        <div class="rl-stat-app"><span class="v-dot" style="background:${esc(a.color)}"></span>${esc(a.name)}
          <span class="rl-plat-tag">${esc(platformLabel(a.platform))}</span></div>
        <div class="rl-stat-row">
          <span><span class="k">latest</span> ${esc(s.latest ? releaseLabel(s.latest) : '—')}</span>
          <span><span class="k">in production</span> ${s.production ? `${esc(releaseLabel(s.production))} · ${esc(s.production.prodDate)}` : 'none'}</span>
          <span><span class="k">built since</span> ${s.sinceProduction}</span>
        </div>
      </div>`;
  }).join('');
}

function renderAppBar() {
  const bar = $('rl-app-bar');
  if (!state.apps.length) { bar.innerHTML = ''; return; }
  const chip = (id, label, color, n) => `
    <button class="group-chip${state.rlApp === id ? ' on' : ''}" data-app="${esc(id)}">
      ${color ? `<span class="v-dot" style="background:${esc(color)}"></span>` : ''}
      ${esc(label)}<span class="group-chip-n">${n}</span>
    </button>`;
  bar.innerHTML = chip('', 'All', '', state.releases.length)
    + state.apps.map((a) => chip(a.id, a.name, a.color, state.releases.filter((r) => r.appId === a.id).length)).join('');
  bar.querySelectorAll('[data-app]').forEach((b) => b.addEventListener('click', () => {
    state.rlApp = b.dataset.app;
    renderReleases();
  }));
}

function renderEnvSelect() {
  const sel = $('rl-env');
  const envs = environments(state.releases);
  const want = `<option value="">All environments</option>${envs.map((e) => `<option>${esc(e)}</option>`).join('')}`;
  if (sel.innerHTML !== want) sel.innerHTML = want;
  sel.value = state.rlEnv;
  $('rl-env-list').innerHTML = envs.map((e) => `<option value="${esc(e)}">`).join('');
}

async function copyPlain(text, label) {
  try { await navigator.clipboard.writeText(text); toast(`${label} copied`, true); }
  catch (_) { toast('This browser blocked the clipboard'); }
}

/* ---------- editor ---------- */

function fillAppSelect(selectId, selected) {
  const sel = $(selectId);
  sel.innerHTML = state.apps.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')
    || '<option value="">No apps yet</option>';
  if (selected && state.apps.some((a) => a.id === selected)) sel.value = selected;
}

function openRelease(id) {
  const r = id ? state.releases.find((x) => x.id === id) : null;
  const src = r || blankRelease(state.rlApp || state.apps[0]?.id || '', todayDay());
  state.rlEditingId = r ? id : null;

  $('rl-heading').textContent = r ? `Edit ${releaseLabel(r)}` : 'New release';
  fillAppSelect('rl-app', src.appId);
  $('rl-date').value = isDayString(src.buildDate) ? src.buildDate : todayDay();
  $('rl-version').value = src.version || '';
  $('rl-build').value = src.build || '';
  $('rl-envf').value = src.env || '';
  $('rl-changes').value = src.changes || '';
  $('rl-source').value = src.sourceUrl || '';
  $('rl-artifact').value = src.artifactUrl || '';
  $('rl-notes').value = src.notes || '';
  $('rl-production').checked = !!src.production;
  $('rl-prod-date').value = src.prodDate || '';
  syncProdDate();
  $('rl-error').textContent = '';
  $('rl-delete').classList.toggle('hidden', !r);
  renderEnvSelect();

  $('rl-ov').classList.add('show');
  $('rl-version').focus();
}

// Ticking "pushed to production" has to ask when. A flag with no date cannot
// answer the question the flag exists for.
function syncProdDate() {
  const on = $('rl-production').checked;
  $('rl-prod-date').classList.toggle('hidden', !on);
  if (on && !$('rl-prod-date').value) $('rl-prod-date').value = todayDay();
}

function closeRelease() {
  $('rl-ov').classList.remove('show');
  state.rlEditingId = null;
  ['rl-version', 'rl-build', 'rl-envf', 'rl-changes', 'rl-source', 'rl-artifact', 'rl-notes']
    .forEach((id) => { $(id).value = ''; });
  $('rl-production').checked = false;
}

async function saveRelease() {
  const r = {
    appId: $('rl-app').value || '',
    version: $('rl-version').value.trim(),
    build: $('rl-build').value.trim(),
    env: $('rl-envf').value.trim(),
    changes: $('rl-changes').value,
    sourceUrl: $('rl-source').value.trim(),
    artifactUrl: $('rl-artifact').value.trim(),
    buildDate: $('rl-date').value,
    production: $('rl-production').checked,
    prodDate: $('rl-prod-date').value,
    notes: $('rl-notes').value
  };

  const check = validateRelease(r);
  if (!check.ok) { $('rl-error').textContent = check.error; return; }

  const id = state.rlEditingId || uid('rl');
  const now = new Date().toISOString();
  const existing = state.releases.find((x) => x.id === id);
  try {
    await setDoc(releaseRef(id), {
      ...releaseBody(r),
      createdAt: existing?.createdAt || now,
      updatedAt: now
    });
    closeRelease();
    toast(existing ? 'Release saved' : 'Release recorded', true);
  } catch (err) {
    console.error(err);
    $('rl-error').textContent = `Could not save: ${err?.message || err}`;
  }
}

async function deleteRelease(id) {
  const r = state.releases.find((x) => x.id === id);
  const ok = await askConfirm(`${releaseLabel(r || {})} will be deleted. There is no undo.`, 'Delete release?');
  if (!ok) return;
  try { await deleteDoc(releaseRef(id)); closeRelease(); toast('Deleted', true); }
  catch (err) { console.error(err); toast('Could not delete'); }
}

/* ---------- apps ---------- */

/* ---------- the Claude API key ---------- *
 *
 * Encrypted under the vault passphrase and kept beside the vault's own config.
 * Never in the repository: this one is public, and a key committed to a public
 * repo is a key in a scraper's hands within minutes.
 */

async function loadApiKey() {
  state.apiKeyPresent = false;
  state.apiKey = null;
  if (!state.user) return;
  try {
    const snap = await getDoc(integrationsRef());
    state.apiKeyPresent = snap.exists() && !!snap.data()?.data?.ct;
    if (state.apiKeyPresent && vault.key) {
      const body = await decryptJson(vault.key, snap.data().data, { aad: 'integrations' });
      state.apiKey = typeof body?.anthropicKey === 'string' ? body.anthropicKey : null;
    }
  } catch (err) { console.warn('Could not read the stored API key:', err); }
}

async function saveApiKey(key) {
  if (!vault.key) return { error: 'Unlock the vault first — the key is stored encrypted with it.' };
  const check = validateApiKey(key);
  if (!check.ok) return { error: check.error };
  try {
    const data = await encryptJson(vault.key, { anthropicKey: key.trim() }, { aad: 'integrations' });
    await setDoc(integrationsRef(), { v: VAULT_VERSION, data, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    state.apiKey = key.trim();
    state.apiKeyPresent = true;
    return { ok: true };
  } catch (err) {
    console.error(err);
    return { error: `Could not save: ${err?.message || err}` };
  }
}

function openKeySheet() {
  $('menu-ov').classList.remove('show');
  $('key-input').value = '';
  $('key-error').textContent = '';
  hideSecretInput('key-input-eye');
  $('key-state').textContent = !vault.key
    ? 'The vault is locked. Unlock it to store or change the key.'
    : state.apiKeyPresent ? 'A key is stored. Saving replaces it.' : 'No key stored yet.';
  $('key-remove').classList.toggle('hidden', !state.apiKeyPresent);
  $('key-ov').classList.add('show');
  setTimeout(() => $('key-input').focus(), 30);
}

async function testApiKey() {
  const key = $('key-input').value.trim() || state.apiKey;
  const check = validateApiKey(key || '');
  if (!check.ok) { $('key-error').textContent = check.error; return; }
  $('key-error').textContent = '';
  $('key-state').textContent = 'Checking…';
  try {
    const models = await listModels(key);
    $('key-state').textContent = `Working — ${models.length} models available, extraction would use ${pickModel(models)}.`;
  } catch (err) {
    $('key-state').textContent = '';
    $('key-error').textContent = err?.message || String(err);
  }
}

/* ---------- import a build thread ---------- */

function openImport(appId) {
  resetImport();
  fillAppSelect('imp-app', appId || state.rlApp || state.apps[0]?.id || '');
  $('imp-ov').classList.add('show');
}

function resetImport() {
  state.impParsed = [];
  state.impFile = null;
  $('imp-text').value = '';
  $('imp-status').textContent = '';
  $('imp-error').textContent = '';
  $('imp-preview').innerHTML = '';
  $('imp-ai').classList.add('hidden');
  $('imp-save').disabled = true;
  $('imp-file-row').classList.add('hidden');
}

async function takeEmlFile(file, { nameId = 'imp-file-name', sizeId = 'imp-file-size', rowId = 'imp-file-row', errId = 'imp-error' } = {}) {
  if (!file) return null;
  if (file.size > 25 * 1024 * 1024) {
    $(errId).textContent = `${file.name} is ${formatBytes(file.size)} — too large to read in the browser.`;
    return null;
  }
  try {
    const res = await readEmlFile(file);
    if (!res.ok) { $(errId).textContent = res.error || 'That file could not be read.'; return null; }
    $(nameId).textContent = res.subject || file.name;
    $(sizeId).textContent = formatBytes(file.size);
    $(rowId).classList.remove('hidden');
    $(errId).textContent = '';
    return { name: file.name, bytes: file.size, text: res.text, subject: res.subject };
  } catch (err) {
    console.error(err);
    $(errId).textContent = `Could not read that file: ${err?.message || err}`;
    return null;
  }
}

function importSource() {
  return (state.impFile?.text || '').trim() || $('imp-text').value.trim();
}

/**
 * The template parser first, because it is free and instant for the format it
 * knows. Claude only when that finds nothing — which is exactly the case the
 * regex was never going to cover.
 */
async function readImport() {
  const appId = $('imp-app').value;
  if (!appId) { $('imp-error').textContent = 'Create an app first — a release has to belong to one.'; return; }

  const text = importSource();
  if (!text) { $('imp-error').textContent = 'Attach the .eml file, or paste the email text.'; return; }

  $('imp-error').textContent = '';
  $('imp-ai').classList.add('hidden');
  $('imp-status').textContent = 'Reading…';

  let parsed = [];
  let usedClaude = false;
  const template = parseBuildEmail(text, { defaultDate: todayDay() });
  if (template.ok && template.releases.length) {
    parsed = template.releases;
  } else {
    if (!state.apiKey) {
      $('imp-status').textContent = '';
      $('imp-error').textContent = state.apiKeyPresent && !vault.key
        ? 'The built-in parser did not recognise this format. Unlock the vault so the Claude key can be used.'
        : 'The built-in parser did not recognise this format. Add a Claude API key (⋯ menu) and it will read it instead.';
      return;
    }
    try {
      usedClaude = true;
      const res = await extractReleases(state.apiKey, text, {
        onProgress: ({ done, total }) => { $('imp-status').textContent = `Reading with Claude… ${done}/${total}`; }
      });
      parsed = res.releases.filter(usableRelease);
      $('imp-ai').textContent = `Read by ${res.model} in ${res.calls} request${res.calls === 1 ? '' : 's'}. Check the dates and versions before importing — a model reads an unfamiliar format well, not perfectly.`;
      $('imp-ai').classList.remove('hidden');
      if (res.failures?.length) {
        $('imp-error').textContent = `${res.failures.length} part(s) of the thread failed: ${res.failures[0]}`;
      }
    } catch (err) {
      $('imp-status').textContent = '';
      $('imp-error').textContent = err instanceof ClaudeError ? err.message : `Extraction failed: ${err?.message || err}`;
      return;
    }
  }

  if (!parsed.length) {
    $('imp-status').textContent = '';
    $('imp-error').textContent = 'No builds found in that email.';
    return;
  }

  const { fresh, skipped } = dedupeReleases(parsed, state.releases, appId);
  state.impParsed = fresh.map((r) => ({ ...blankRelease(appId, todayDay()), ...r, appId }));
  $('imp-save').disabled = !fresh.length;
  $('imp-status').textContent =
    `${parsed.length} found${usedClaude ? ' by Claude' : ''} · ${fresh.length} new${skipped ? ` · ${skipped} already recorded` : ''}`;

  $('imp-preview').innerHTML = fresh.length
    ? fresh.map((r) => `
        <div class="imp-row">
          <span class="imp-ver">${esc(releaseLabel(r))}</span>
          <span class="imp-env">${esc(r.env || '—')}</span>
          <span class="imp-date">${esc(r.buildDate || 'no date')}</span>
          <span class="imp-chg">${esc((r.changes || '').split('\n')[0].slice(0, 60))}</span>
        </div>`).join('')
    : '<div class="imp-row quiet">Everything in that email is already recorded.</div>';
}

async function runImport() {
  if (!state.impParsed.length) return;
  $('imp-save').disabled = true;
  const now = new Date().toISOString();
  let done = 0;
  try {
    for (let i = 0; i < state.impParsed.length; i += 400) {
      const batch = writeBatch(db);
      for (const r of state.impParsed.slice(i, i + 400)) {
        batch.set(releaseRef(uid('rl')), { ...releaseBody(r), createdAt: now, updatedAt: now });
        done++;
      }
      await batch.commit();
    }
    $('imp-ov').classList.remove('show');
    toast(`Imported ${done} release${done === 1 ? '' : 's'}`, true);
  } catch (err) {
    console.error(err);
    $('imp-error').textContent = `Import failed after ${done}: ${err?.message || err}`;
    $('imp-save').disabled = false;
  }
}

/* ---------- apps, with somewhere to live ---------- */

function openApps() {
  showAppsList();
  $('apps-ov').classList.add('show');
}

function showAppsList() {
  $('apps-heading').textContent = 'Apps';
  $('apps-list-pane').classList.remove('hidden');
  $('apps-edit-pane').classList.add('hidden');
  state.apEditingId = null;
  state.apFile = null;

  $('apps-list').innerHTML = state.apps.length
    ? state.apps.map((a) => {
        const n = state.releases.filter((r) => r.appId === a.id).length;
        return `
          <button class="app-row" data-id="${esc(a.id)}">
            <span class="v-dot" style="background:${esc(a.color)}"></span>
            <span class="app-name">${esc(a.name)}</span>
            <span class="rl-plat-tag">${esc(platformLabel(a.platform))}</span>
            <span class="app-n">${n} release${n === 1 ? '' : 's'}</span>
          </button>`;
      }).join('')
    : '<div class="tl-empty">No apps yet. Add one, and attach its build thread to fill it.</div>';

  $('apps-list').querySelectorAll('.app-row').forEach((b) =>
    b.addEventListener('click', () => showAppEditor(b.dataset.id)));
}

function showAppEditor(id) {
  const a = id ? appById(state.apps, id) : null;
  const src = a || blankApp(state.apps.length);
  state.apEditingId = a ? id : null;
  state.apColor = src.color;
  state.apFile = null;

  $('apps-heading').textContent = a ? `Edit ${a.name}` : 'New app';
  $('apps-list-pane').classList.add('hidden');
  $('apps-edit-pane').classList.remove('hidden');

  $('ap-name').value = src.name || '';
  $('ap-platform').innerHTML = PLATFORMS.map((p) => `<option value="${p.key}">${esc(p.label)}</option>`).join('');
  $('ap-platform').value = src.platform;
  $('ap-repo').value = src.repoUrl || '';
  $('ap-artifact').value = src.artifactUrl || '';
  $('ap-notes').value = src.notes || '';
  $('ap-error').textContent = '';
  $('ap-delete').classList.toggle('hidden', !a);
  // Attaching the thread belongs to creating the app: that is the moment the
  // history exists and nobody wants to go and find it again later.
  $('ap-thread').classList.toggle('hidden', !!a);
  $('ap-file-row').classList.add('hidden');
  renderAppColors();
  $('ap-name').focus();
}

function renderAppColors() {
  $('ap-colors').innerHTML = APP_PALETTE.map((c) =>
    `<button class="cat-sw${c.toLowerCase() === state.apColor.toLowerCase() ? ' on' : ''}" style="background:${c}" data-color="${c}" aria-label="Colour ${c}"></button>`).join('');
  $('ap-colors').querySelectorAll('.cat-sw').forEach((b) => b.addEventListener('click', () => {
    state.apColor = b.dataset.color;
    renderAppColors();
  }));
}

async function saveApp() {
  const app = {
    name: $('ap-name').value.trim(),
    platform: $('ap-platform').value,
    repoUrl: $('ap-repo').value.trim(),
    artifactUrl: $('ap-artifact').value.trim(),
    notes: $('ap-notes').value,
    color: state.apColor
  };
  const check = validateApp(app, state.apps, state.apEditingId);
  if (!check.ok) { $('ap-error').textContent = check.error; return; }

  const id = state.apEditingId || uid('app');
  const existing = appById(state.apps, id);
  try {
    await setDoc(appRef(id), { ...appBody(app), createdAt: existing?.createdAt || new Date().toISOString() });
    const thread = state.apFile;
    showAppsList();
    toast(existing ? 'App saved' : 'App created', true);
    // Straight into the import with the thread already loaded, rather than
    // making someone find it again in another sheet.
    if (!existing && thread) {
      $('apps-ov').classList.remove('show');
      openImport(id);
      state.impFile = thread;
      $('imp-file-name').textContent = thread.subject || thread.name;
      $('imp-file-size').textContent = formatBytes(thread.bytes);
      $('imp-file-row').classList.remove('hidden');
      readImport();
    }
  } catch (err) {
    console.error(err);
    $('ap-error').textContent = `Could not save: ${err?.message || err}`;
  }
}

async function deleteApp(id) {
  const a = appById(state.apps, id);
  const mine = state.releases.filter((r) => r.appId === id);
  const ok = await askConfirm(
    mine.length
      ? `"${a?.name || 'This app'}" and its ${mine.length} release${mine.length === 1 ? '' : 's'} will be deleted. There is no undo.`
      : `"${a?.name || 'This app'}" will be deleted.`,
    'Delete app?'
  );
  if (!ok) return;

  try {
    // Releases first. A release whose app is gone renders as "Unknown app" and
    // cannot be filtered to — orphans here are worse than a failed delete.
    for (let i = 0; i < mine.length; i += 400) {
      const batch = writeBatch(db);
      mine.slice(i, i + 400).forEach((r) => batch.delete(releaseRef(r.id)));
      await batch.commit();
    }
    await deleteDoc(appRef(id));
    if (state.rlApp === id) state.rlApp = '';
    showAppsList();
    toast('App deleted', true);
  } catch (err) { console.error(err); toast('Could not delete the app'); }
}

/* ---------- releases wiring ---------- */

$('rl-new').addEventListener('click', () => openRelease(null));
$('rl-search').addEventListener('input', () => { state.rlQuery = $('rl-search').value; renderReleases(); });
$('rl-env').addEventListener('change', () => { state.rlEnv = $('rl-env').value; renderReleases(); });
$('rl-prod-only').addEventListener('change', () => { state.rlProdOnly = $('rl-prod-only').checked; renderReleases(); });

$('rl-x').addEventListener('click', closeRelease);
$('rl-cancel').addEventListener('click', closeRelease);
$('rl-save').addEventListener('click', saveRelease);
$('rl-delete').addEventListener('click', () => { if (state.rlEditingId) deleteRelease(state.rlEditingId); });
$('rl-ov').addEventListener('click', (e) => { if (e.target.id === 'rl-ov') closeRelease(); });
$('rl-production').addEventListener('change', syncProdDate);

// "New" in the release editor now opens the apps sheet rather than a second,
// half-featured app form hidden inside this one.
$('rl-app-new').addEventListener('click', () => { closeRelease(); openApps(); showAppEditor(null); });

$('rl-import').addEventListener('click', () => openImport());
$('rl-apps').addEventListener('click', openApps);
$('imp-x').addEventListener('click', () => $('imp-ov').classList.remove('show'));
$('imp-cancel').addEventListener('click', () => $('imp-ov').classList.remove('show'));
$('imp-ov').addEventListener('click', (e) => { if (e.target.id === 'imp-ov') $('imp-ov').classList.remove('show'); });
$('imp-parse').addEventListener('click', readImport);
$('imp-save').addEventListener('click', runImport);
$('imp-text').addEventListener('input', () => { $('imp-save').disabled = true; $('imp-status').textContent = ''; });

$('imp-pick').addEventListener('click', () => $('imp-file').click());
$('imp-file').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (f) { state.impFile = await takeEmlFile(f); $('imp-save').disabled = true; }
});
$('imp-file-clear').addEventListener('click', () => {
  state.impFile = null;
  $('imp-file-row').classList.add('hidden');
  $('imp-save').disabled = true;
});
['dragenter', 'dragover'].forEach((t) => $('imp-drop').addEventListener(t, (e) => {
  e.preventDefault(); $('imp-drop').classList.add('over');
}));
['dragleave', 'drop'].forEach((t) => $('imp-drop').addEventListener(t, () => $('imp-drop').classList.remove('over')));
$('imp-drop').addEventListener('drop', async (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) { state.impFile = await takeEmlFile(f); $('imp-save').disabled = true; }
});

/* apps */
$('apps-x').addEventListener('click', () => $('apps-ov').classList.remove('show'));
$('apps-ov').addEventListener('click', (e) => { if (e.target.id === 'apps-ov') $('apps-ov').classList.remove('show'); });
$('apps-add').addEventListener('click', () => showAppEditor(null));
$('ap-cancel').addEventListener('click', showAppsList);
$('ap-save').addEventListener('click', saveApp);
$('ap-delete').addEventListener('click', () => { if (state.apEditingId) deleteApp(state.apEditingId); });
$('ap-pick').addEventListener('click', () => $('ap-file').click());
$('ap-file').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (f) state.apFile = await takeEmlFile(f,
    { nameId: 'ap-file-name', sizeId: 'ap-file-size', rowId: 'ap-file-row', errId: 'ap-error' });
});
$('ap-file-clear').addEventListener('click', () => {
  state.apFile = null;
  $('ap-file-row').classList.add('hidden');
});
['dragenter', 'dragover'].forEach((t) => $('ap-drop').addEventListener(t, (e) => {
  e.preventDefault(); $('ap-drop').classList.add('over');
}));
['dragleave', 'drop'].forEach((t) => $('ap-drop').addEventListener(t, () => $('ap-drop').classList.remove('over')));
$('ap-drop').addEventListener('drop', async (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) state.apFile = await takeEmlFile(f,
    { nameId: 'ap-file-name', sizeId: 'ap-file-size', rowId: 'ap-file-row', errId: 'ap-error' });
});

/* the API key */
$('menu-key').addEventListener('click', openKeySheet);
$('key-x').addEventListener('click', () => $('key-ov').classList.remove('show'));
$('key-ov').addEventListener('click', (e) => { if (e.target.id === 'key-ov') $('key-ov').classList.remove('show'); });
wireEye('key-input-eye');
$('key-test').addEventListener('click', testApiKey);
$('key-save').addEventListener('click', async () => {
  const res = await saveApiKey($('key-input').value);
  if (res.error) { $('key-error').textContent = res.error; return; }
  $('key-input').value = '';
  $('key-ov').classList.remove('show');
  toast('API key saved', true);
});
$('key-remove').addEventListener('click', async () => {
  const ok = await askConfirm('The stored Claude API key will be deleted.', 'Remove the key?');
  if (!ok) return;
  try {
    await deleteDoc(integrationsRef());
    state.apiKey = null;
    state.apiKeyPresent = false;
    $('key-ov').classList.remove('show');
    toast('Key removed', true);
  } catch (err) { console.error(err); $('key-error').textContent = 'Could not remove it.'; }
});
