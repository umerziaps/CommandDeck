// Unit tests for the web client's pure logic.
//
// Run them with Node's built-in test runner — no npm install, no jest, no
// config file:
//
//     node --test docs/
//
// That's deliberate. The whole web app has zero dependencies, and adding a
// test framework just to check a dozen pure functions would be the biggest
// thing in the repo.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUCKET_KEYS, CAT_PALETTE, nextColor,
  esc, todayIso, fmtDate, dueState,
  normaliseItem, itemToDoc,
  boardOrder, nextOrder, liftedOrder,
  matchesFilter, visibleItems
} from './lib.js';

const TODAY = '2026-08-22';

const item = (over = {}) => normaliseItem(over.id ?? 'i_1', {
  title: 'A task',
  bucket: 'now',
  order: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  ...over
});

describe('the wire format', () => {

  test('an empty document loads as a sane Later item', () => {
    const it = normaliseItem('i_empty', {});
    assert.equal(it.title, '');
    assert.equal(it.bucket, 'later');
    assert.equal(it.done, false);
    assert.equal(it.due, '');
    assert.equal(it.order, 0);
    assert.deepEqual(it.subs, []);
  });

  test('an unknown bucket falls back to later instead of rendering nothing', () => {
    assert.equal(normaliseItem('i_1', { bucket: 'someday' }).bucket, 'later');
  });

  test('writes exactly the field names the iOS and Android clients read', () => {
    // If you rename any of these, rename them in Models/Item.swift and
    // model/Item.kt in the same commit.
    assert.deepEqual(Object.keys(itemToDoc(item())).sort(), [
      'bucket', 'catId', 'createdAt', 'doneAt', 'done',
      'due', 'order', 'subs', 'title', 'urgent', 'waitingOn'
    ].sort());
  });

  test('round trips without losing anything', () => {
    const original = item({
      id: 'i_abc',
      title: 'Cut over the broker',
      bucket: 'waiting',
      waitingOn: 'Yasir',
      due: '2026-09-14',
      catId: 'c_ocufii',
      urgent: true,
      order: 3,
      subs: [{ id: 's_1', text: 'Snapshot topics', done: true }]
    });
    assert.deepEqual(normaliseItem('i_abc', itemToDoc(original)), original);
  });

  test('a non-numeric order becomes 0 rather than NaN', () => {
    // NaN would poison every comparison in the sort and scramble the board.
    assert.equal(normaliseItem('i_1', { order: 'three' }).order, 0);
    assert.equal(normaliseItem('i_1', { order: null }).order, 0);
  });

  test('an absent due date is an empty string, never undefined', () => {
    assert.equal(normaliseItem('i_1', {}).due, '');
  });

  test('a non-array subs field does not crash the board', () => {
    assert.deepEqual(normaliseItem('i_1', { subs: 'nope' }).subs, []);
  });
});

describe('dates', () => {

  test('todayIso uses local time, not UTC', () => {
    // toISOString() would roll the date backwards for anyone east of UTC —
    // in Karachi that makes "today" render as "yesterday" before 5am.
    const d = new Date(2026, 7, 22, 2, 30); // 22 Aug, 02:30 local
    assert.equal(todayIso(d), '2026-08-22');
  });

  test('names the days around today', () => {
    assert.equal(fmtDate('2026-08-22', TODAY), 'today');
    assert.equal(fmtDate('2026-08-23', TODAY), 'tomorrow');
    assert.equal(fmtDate('2026-08-21', TODAY), 'yesterday');
  });

  test('counts down within the week and up in the past', () => {
    assert.equal(fmtDate('2026-08-25', TODAY), 'in 3d');
    assert.equal(fmtDate('2026-08-17', TODAY), '5d ago');
  });

  test('falls back to a calendar date beyond a week', () => {
    assert.equal(fmtDate('2026-09-14', TODAY), '14 Sep');
  });

  test('no date renders as nothing at all', () => {
    assert.equal(fmtDate('', TODAY), '');
    assert.equal(fmtDate(null, TODAY), '');
  });

  test('flags overdue and imminent due dates', () => {
    assert.equal(dueState('2026-08-21', TODAY), 'over');
    assert.equal(dueState('2026-08-22', TODAY), 'soon');
    assert.equal(dueState('2026-08-24', TODAY), 'soon');
    assert.equal(dueState('2026-09-30', TODAY), '');
    assert.equal(dueState('', TODAY), '');
  });
});

describe('ordering', () => {

  test('sorts by manual order first', () => {
    const list = [item({ id: 'c', order: 2 }), item({ id: 'a', order: 0 }), item({ id: 'b', order: 1 })];
    assert.deepEqual(list.sort(boardOrder).map((i) => i.id), ['a', 'b', 'c']);
  });

  test('breaks ties with the newest capture first', () => {
    const list = [
      item({ id: 'older', order: 0, createdAt: '2026-08-01T00:00:00.000Z' }),
      item({ id: 'newer', order: 0, createdAt: '2026-08-20T00:00:00.000Z' })
    ];
    assert.deepEqual(list.sort(boardOrder).map((i) => i.id), ['newer', 'older']);
  });

  test('does NOT float urgent items to the top on every render', () => {
    // The original artifact did, which made dragged items snap back.
    const list = [item({ id: 'urgent', order: 5, urgent: true }), item({ id: 'calm', order: 0 })];
    assert.deepEqual(list.sort(boardOrder).map((i) => i.id), ['calm', 'urgent']);
  });

  test('marking urgent lifts an item above everything in its bucket', () => {
    const all = [item({ id: 'a', order: 0 }), item({ id: 'b', order: 1 })];
    const lifted = liftedOrder(all, all[1]);
    assert.ok(lifted < 0, `expected ${lifted} to sort above 0`);
  });

  test('the lift only looks at the same bucket', () => {
    const all = [
      item({ id: 'now-1', bucket: 'now', order: 0 }),
      item({ id: 'later-1', bucket: 'later', order: -50 })
    ];
    assert.equal(liftedOrder(all, all[0]), -1);
  });

  test('new captures land at the bottom of the bucket', () => {
    const all = [item({ id: 'a', bucket: 'later', order: 0 }), item({ id: 'b', bucket: 'later', order: 1 })];
    assert.equal(nextOrder(all, 'later'), 2);
    assert.equal(nextOrder([], 'later'), 0);
  });

  test('completed items do not push new captures down', () => {
    const all = [
      item({ id: 'old', bucket: 'later', order: 99, done: true }),
      item({ id: 'live', bucket: 'later', order: 0 })
    ];
    assert.equal(nextOrder(all, 'later'), 1);
  });
});

describe('filtering', () => {
  const ocufii = item({ id: 'a', catId: 'c_ocufii' });
  const loose = item({ id: 'b', catId: '' });

  test('no filter shows everything', () => {
    assert.ok(matchesFilter(ocufii, ''));
    assert.ok(matchesFilter(loose, ''));
  });

  test('a category filter shows only its own items', () => {
    assert.ok(matchesFilter(ocufii, 'c_ocufii'));
    assert.ok(!matchesFilter(loose, 'c_ocufii'));
  });

  test('__uncat__ shows only items with no category', () => {
    assert.ok(matchesFilter(loose, '__uncat__'));
    assert.ok(!matchesFilter(ocufii, '__uncat__'));
  });

  test('visibleItems hides done items and sorts what is left', () => {
    const all = [
      item({ id: 'done', bucket: 'now', order: 0, done: true }),
      item({ id: 'second', bucket: 'now', order: 2 }),
      item({ id: 'first', bucket: 'now', order: 1 }),
      item({ id: 'elsewhere', bucket: 'later', order: 0 })
    ];
    assert.deepEqual(visibleItems(all, 'now', '').map((i) => i.id), ['first', 'second']);
  });
});

describe('shared constants', () => {

  test('the bucket keys match the other clients', () => {
    assert.deepEqual(BUCKET_KEYS, ['now', 'waiting', 'later']);
  });

  test('the palette matches iOS and Android', () => {
    // A category created on one client has to render the same colour on the
    // others, so these ten values are part of the contract.
    assert.equal(CAT_PALETTE.length, 10);
    assert.equal(CAT_PALETTE[0], '#5EE6C5');
    assert.ok(CAT_PALETTE.every((c) => /^#[0-9A-F]{6}$/.test(c)));
  });

  test('colours are handed out in order, then wrap', () => {
    assert.equal(nextColor([]), CAT_PALETTE[0]);
    assert.equal(nextColor([CAT_PALETTE[0]]), CAT_PALETTE[1]);
    assert.ok(CAT_PALETTE.includes(nextColor(CAT_PALETTE)));
  });
});

describe('escaping', () => {

  test('neutralises markup so a task title cannot inject HTML', () => {
    assert.equal(
      esc('<img src=x onerror="alert(1)">'),
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
    );
  });

  test('handles null and undefined without printing "null"', () => {
    assert.equal(esc(null), '');
    assert.equal(esc(undefined), '');
  });
});
