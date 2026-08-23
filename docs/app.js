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
  collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot, writeBatch, getDocs
} from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js';

import { firebaseConfig } from './firebase-config.js';
import {
  BUCKETS, CAT_PALETTE, nextColor, uid, esc,
  todayIso, fmtDate, dueState,
  normaliseItem, boardOrder, nextOrder, liftedOrder,
  matchesFilter, visibleItems
} from './lib.js';

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

const itemsCol = () => collection(db, 'users', state.user.uid, 'items');
const catsCol  = () => collection(db, 'users', state.user.uid, 'categories');
const itemRef  = (id) => doc(db, 'users', state.user.uid, 'items', id);
const catRef   = (id) => doc(db, 'users', state.user.uid, 'categories', id);
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
  $('cap-input').focus();
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
  }
  if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    e.preventDefault();
    $('cap-input').focus();
  }
});

// Re-render at midnight so "today" / "tomorrow" labels stay honest.
setInterval(() => { if (state.user) render(); }, 60_000);
