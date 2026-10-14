// Tests for the .docx reader.
//
// The fixtures are built with python-docx into a temp file by the test runner
// where possible; where that is not available the structures are exercised
// directly against the XML, which is what the parser actually consumes.
//
// The case that matters most is not a well-formed Word document. It is the
// kind of specification that arrives from a client: no heading styles at all,
// bold paragraphs standing in for section titles, and bullets nested by
// style name rather than by ilvl.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readZip, parseBody, renderBlocks, inferHeadings, blocksText, slugify, esc
} from './docx.js';

const w = (body) => `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`;
const para = (text, { style = '', bold = false, ilvl = null, numId = null } = {}) => {
  const pPr = (style || ilvl !== null || numId)
    ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${
        numId ? `<w:numPr><w:ilvl w:val="${ilvl ?? 0}"/><w:numId w:val="${numId}"/></w:numPr>` : ''}</w:pPr>`
    : '';
  return `<w:p>${pPr}<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t>${text}</w:t></w:r></w:p>`;
};

/* ---------- escaping ---------- */

test('text is escaped before it becomes HTML', () => {
  // A spec arrives from a client by email. A text run can hold anything, and
  // this output is injected into the page and later published to a URL.
  const blocks = parseBody(w(para('<script>alert(1)</script>')));
  const { html } = renderBlocks(blocks);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(esc(`<&">'`), '&lt;&amp;&quot;&gt;&#39;');
});

test('a hyperlink that is not http is dropped rather than rendered', () => {
  const rels = new Map([['rId1', 'javascript:alert(1)'], ['rId2', 'https://example.com']]);
  const xml = w(`<w:p><w:hyperlink r:id="rId1"><w:r><w:t>click</w:t></w:r></w:hyperlink></w:p>`
    + `<w:p><w:hyperlink r:id="rId2"><w:r><w:t>safe</w:t></w:r></w:hyperlink></w:p>`);
  const { html } = renderBlocks(parseBody(xml, { rels }));
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

/* ---------- real heading styles ---------- */

test('Word heading styles are used when the document has them', () => {
  const blocks = parseBody(w(para('Scope', { style: 'Heading1' }) + para('Users', { style: 'Heading2' })));
  assert.deepEqual(blocks.map((b) => [b.kind, b.level]), [['heading', 1], ['heading', 2]]);
});

test('a document with real headings is NOT second-guessed', () => {
  // Inferring on top of explicit structure is how a contents list ends up
  // with someone's bolded warning in it.
  const xml = w(para('Scope', { style: 'Heading1' }) + para('IMPORTANT', { bold: true }));
  const blocks = parseBody(xml);
  assert.equal(blocks[0].kind, 'heading');
  assert.equal(blocks[1].kind, 'para', 'the bold line stays a paragraph');
});

/* ---------- headings that are not headings ---------- */

test('bold paragraphs become headings when the document declares none', () => {
  // This is what the real SDS specification looks like: no heading styles,
  // bold lines standing in for section titles.
  const xml = w(
    para('SDS Project Draft Specification', { bold: true })
    + para('1. Facility & Capacity Overview', { bold: true })
    + para('This is the first screen.')
    + para('What to show', { bold: true })
    + para('2. Live Safe Monitoring', { bold: true })
  );
  const blocks = parseBody(xml);
  const headings = blocks.filter((b) => b.kind === 'heading');
  assert.equal(headings.length, 4);
  assert.deepEqual(headings.map((h) => h.level), [1, 2, 3, 2],
    'the first is the title, numbered ones are sections, unnumbered ones sit under them');
});

test('a bold phrase inside a sentence is not a heading', () => {
  const xml = w(`<w:p><w:r><w:t>Key requirement: </w:t></w:r>`
    + `<w:r><w:rPr><w:b/></w:rPr><w:t>two-factor authentication</w:t></w:r></w:p>`);
  assert.equal(parseBody(xml)[0].kind, 'para');
});

test('a long bold sentence is not a heading', () => {
  const long = 'This entire sentence is bold because the author was making a point, '
    + 'and it runs well past anything anyone would call a section title.';
  assert.equal(parseBody(w(para(long, { bold: true })))[0].kind, 'para');
});

test('a bold sentence ending in a full stop is emphasis, unless numbered', () => {
  assert.equal(parseBody(w(para('Do not ship this.', { bold: true })))[0].kind, 'para');
  assert.equal(parseBody(w(para('1. Scope of the work.', { bold: true })))[0].kind, 'heading');
});

test('inferHeadings is a no-op on a document that has none to find', () => {
  const blocks = [{ kind: 'para', text: 'plain', runs: [{ text: 'plain' }] }];
  assert.deepEqual(inferHeadings(blocks), blocks);
});

test('an inferred heading does not keep the bold it was recognised by', () => {
  const { html } = renderBlocks(parseBody(w(para('1. Scope', { bold: true }))));
  assert.match(html, /<h2[^>]*>1\. Scope<\/h2>/);
  assert.doesNotMatch(html, /<strong>/);
});

test('a numbered first line is section one, not the document title', () => {
  // A spec that opens with "1. Scope" has no title. Promoting it to <h1>
  // would put a section at the top of the outline pretending to be the whole
  // document.
  const numbered = parseBody(w(para('1. Scope', { bold: true }) + para('2. Users', { bold: true })));
  assert.deepEqual(numbered.map((b) => b.level), [2, 2]);

  const titled = parseBody(w(para('SDS Specification', { bold: true }) + para('1. Scope', { bold: true })));
  assert.deepEqual(titled.map((b) => b.level), [1, 2]);
});

/* ---------- lists ---------- */

test('bullets and numbers are told apart', () => {
  const xml = w(para('a', { style: 'ListBullet' }) + para('b', { style: 'ListNumber' }));
  const { html } = renderBlocks(parseBody(xml));
  assert.match(html, /<ul>/);
  assert.match(html, /<ol>/);
});

test('a second-level bullet nests inside its parent item', () => {
  // "Safes by state" and the four states under it must not become five
  // unrelated bullets — that is the structure a requirements list is made of.
  const xml = w(
    para('Safes by state', { style: 'ListBullet' })
    + para('Available', { style: 'ListBullet2' })
    + para('Rented', { style: 'ListBullet2' })
    + para('Capacity utilization', { style: 'ListBullet' })
  );
  const { html } = renderBlocks(parseBody(xml));
  assert.match(html, /<li>Safes by state\s*<ul>/, 'the child list opens inside the parent item');
  assert.doesNotMatch(html, /<\/li>\s*<ul>/, 'a <ul> as a sibling of <li> is invalid');
});

test('every list and item that opens is closed', () => {
  const xml = w(
    para('one', { style: 'ListBullet' })
    + para('deep', { style: 'ListBullet2' })
    + para('deeper', { style: 'ListBullet3' })
    + para('back out', { style: 'ListBullet' })
    + para('after the list')
  );
  const { html } = renderBlocks(parseBody(xml));
  assert.equal((html.match(/<ul>/g) || []).length, (html.match(/<\/ul>/g) || []).length);
  assert.equal((html.match(/<li>/g) || []).length, (html.match(/<\/li>/g) || []).length);
  assert.match(html, /<p>after the list<\/p>$/, 'the list closes before the next paragraph');
});

test('ilvl nests too, for documents that use numbering properly', () => {
  const xml = w(para('top', { numId: '1', ilvl: 0 }) + para('under', { numId: '1', ilvl: 1 }));
  const blocks = parseBody(xml, { numbering: new Map([['1', 'bullet']]) });
  assert.deepEqual(blocks.map((b) => b.level), [0, 1]);
});

/* ---------- tables ---------- */

test('a table becomes a table, with the first row as its head', () => {
  const xml = w('<w:tbl>'
    + '<w:tr><w:tc><w:p><w:r><w:t>Field</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Type</w:t></w:r></w:p></w:tc></w:tr>'
    + '<w:tr><w:tc><w:p><w:r><w:t>boxId</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>string</w:t></w:r></w:p></w:tc></w:tr>'
    + '</w:tbl>');
  const { html } = renderBlocks(parseBody(xml));
  assert.match(html, /<th>Field<\/th><th>Type<\/th>/);
  assert.match(html, /<td>boxId<\/td><td>string<\/td>/);
});

/* ---------- contents ---------- */

test('headings get anchors, and repeated titles get distinct ones', () => {
  // "Overview" appears under three sections in most specs; duplicate ids make
  // the contents links jump to the wrong place.
  const xml = w(para('Overview', { style: 'Heading2' })
    + para('Overview', { style: 'Heading2' })
    + para('Overview', { style: 'Heading2' }));
  const { html, toc } = renderBlocks(parseBody(xml));
  assert.deepEqual(toc.map((t) => t.id), ['overview', 'overview-2', 'overview-3']);
  assert.equal(new Set(html.match(/id="[^"]+"/g)).size, 3);
});

test('slugify survives punctuation and never returns nothing', () => {
  assert.equal(slugify('1. Facility & Capacity Overview'), '1-facility-capacity-overview');
  assert.equal(slugify('!!!'), 'section');
  assert.equal(slugify(''), 'section');
});

/* ---------- plain text, for the diff ---------- */

test('the text rendering carries structure without formatting', () => {
  // The diff runs on this. Comparing rendered HTML would report a bold tweak
  // as a specification change.
  const xml = w(para('Scope', { style: 'Heading1' })
    + para('Body text')
    + para('item', { style: 'ListBullet' }));
  const text = blocksText(parseBody(xml));
  assert.match(text, /^# Scope$/m);
  assert.match(text, /^Body text$/m);
  assert.match(text, /^- item$/m);
  assert.doesNotMatch(text, /<|&/);
});

test('empty paragraphs are dropped so spacing does not become diff churn', () => {
  const xml = w(para('one') + '<w:p/>' + '<w:p><w:r><w:t>  </w:t></w:r></w:p>' + para('two'));
  assert.deepEqual(parseBody(xml).map((b) => b.text), ['one', 'two']);
});

/* ---------- the zip reader ---------- */

test('a file that is not a zip is refused with a readable message', () => {
  assert.throws(() => readZip(new Uint8Array([1, 2, 3, 4])), /not a \.docx/);
  assert.throws(() => readZip(new TextEncoder().encode('hello world')), /not a \.docx/);
});

test('the reader survives a truncated directory instead of throwing', () => {
  // 22 zero bytes with a valid EOCD signature and a claimed entry count that
  // the file cannot satisfy.
  const b = new Uint8Array(22);
  new DataView(b.buffer).setUint32(0, 0x06054b50, true);
  new DataView(b.buffer).setUint16(10, 5, true);
  assert.equal(readZip(b).size, 0);
});
