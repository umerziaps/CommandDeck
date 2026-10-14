// Command Deck — reading a .docx in the browser, with no library.
//
// A .docx is a zip holding XML. Browsers can now inflate a raw deflate stream
// natively (DecompressionStream), so the only thing missing is a zip directory
// reader and enough of WordprocessingML to render a specification document.
// That is a few hundred lines and no dependency, which matters for a static
// site that otherwise ships nothing but its own code.
//
// Deliberately a SUBSET. It handles what a spec document is actually made of:
// headings, paragraphs, bold/italic/underline, bullet and numbered lists,
// tables, hyperlinks, and line breaks. It ignores images, footnotes, comments
// and revision marks rather than rendering them wrongly.
//
// Everything it produces is escaped before it becomes HTML. A spec arrives
// from a client by email, which makes it untrusted input: a Word document can
// carry anything in a text run, and this output is injected into the page and
// later published to a URL other people open.
//
// Pure: no DOM, no network. docs/docx.test.js runs it under node --test.

/* ---------- zip ---------- */

const EOCD = 0x06054b50;

/** Reads the central directory. Returns a map of name → { method, bytes }. */
export function readZip(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // The end-of-central-directory record sits at the back, after a comment of
  // unknown length, so it is found by scanning backwards for its signature.
  let eocd = -1;
  const floor = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (dv.getUint32(i, true) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('That file is not a .docx (no zip directory found).');

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const files = new Map();

  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));

    // The local header repeats the name and extra fields with its OWN
    // lengths, which are not always the central directory's. Using the
    // central ones here is the classic way to read a zip slightly wrong.
    if (localOff + 30 <= buf.length) {
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const start = localOff + 30 + lNameLen + lExtraLen;
      files.set(name, { method, bytes: buf.subarray(start, start + compSize) });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

export async function inflateEntry(entry) {
  if (!entry) return '';
  if (entry.method === 0) return new TextDecoder().decode(entry.bytes);
  if (entry.method !== 8) throw new Error(`Unsupported compression in the .docx (method ${entry.method}).`);
  const stream = new Blob([entry.bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

/* ---------- xml ---------- */

export const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const unesc = (s) => String(s ?? '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  .replace(/&amp;/g, '&');

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : '';
};

/* ---------- document model ---------- *
 *
 * Parsed into blocks first, HTML second. The intermediate form is what the
 * diff compares and what a table of contents is built from — going straight
 * to a string would mean regex-ing it back apart later.
 */

const HEADING = /^heading\s*([1-6])$/i;

function parseRuns(xml) {
  const runs = [];
  // Hyperlinks wrap runs; capture the relationship id so the href can be
  // resolved against the rels file.
  const re = /<w:hyperlink\b([^>]*)>([\s\S]*?)<\/w:hyperlink>|<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[2] !== undefined) {
      for (const r of parseRuns(m[2])) runs.push({ ...r, rel: attr(m[1], 'r:id') });
      continue;
    }
    const body = m[3] || '';
    const props = (body.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/) || [])[1] || '';
    let text = '';
    const tre = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g;
    let t;
    while ((t = tre.exec(body))) {
      if (t[1] !== undefined) text += unesc(t[1]);
      else if (t[0].startsWith('<w:tab')) text += '\t';
      else text += '\n';
    }
    if (!text) continue;
    runs.push({
      text,
      b: /<w:b\s*\/>|<w:b\s[^>]*\/>|<w:b>/.test(props) && !/w:val="(0|false)"/.test(props),
      i: /<w:i\s*\/>|<w:i\s[^>]*\/>|<w:i>/.test(props) && !/w:val="(0|false)"/.test(props),
      u: /<w:u\b/.test(props),
      code: /w:ascii="(Consolas|Courier New|Menlo|Monaco)"/i.test(props)
    });
  }
  return runs;
}

function paragraphBlock(xml, numbering) {
  const props = (xml.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/) || [])[1] || '';
  const style = attr((props.match(/<w:pStyle[^>]*\/?>/) || [''])[0], 'w:val');
  const runs = parseRuns(xml);
  const text = runs.map((r) => r.text).join('').trim();

  const numId = attr((props.match(/<w:numId[^>]*\/?>/) || [''])[0], 'w:val');
  const ilvl = Number(attr((props.match(/<w:ilvl[^>]*\/?>/) || [''])[0], 'w:val') || 0);

  const heading = HEADING.exec(style || '');
  if (heading) return { kind: 'heading', level: Number(heading[1]), runs, text };
  if (/^title$/i.test(style)) return { kind: 'heading', level: 1, runs, text, title: true };
  if (/^subtitle$/i.test(style)) return { kind: 'para', runs, text, subtitle: true };

  if (numId) {
    // numbering.xml says whether a list is bulleted or numbered. Without it,
    // Word's own "List Number"/"List Bullet" style names are the next best
    // signal, and a bullet is the safer default.
    const ordered = numbering?.get(numId) === 'decimal' || /list\s*number|listparagraph.*number/i.test(style);
    return { kind: 'li', ordered, level: Math.min(ilvl, 4), runs, text };
  }
  // "List Bullet 2" is Word's second-level bullet and carries its depth in the
  // style name rather than in ilvl.
  const listStyle = /^list\s*(bullet|number)\s*(\d)?$/i.exec((style || '').replace(/([a-z])(\d)/i, '$1 $2'));
  if (listStyle) {
    const depth = Number(listStyle[2] || 1) - 1;
    return { kind: 'li', ordered: /number/i.test(listStyle[1]), level: Math.min(Math.max(ilvl, depth), 4), runs, text };
  }

  return { kind: 'para', runs, text };
}

function tableBlock(xml, numbering) {
  const rows = [];
  const rre = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
  let r;
  while ((r = rre.exec(xml))) {
    const cells = [];
    const cre = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g;
    let c;
    while ((c = cre.exec(r[1]))) {
      const paras = [];
      const pre = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>|<w:p\b[^>]*\/>/g;
      let pm;
      while ((pm = pre.exec(c[1]))) paras.push(paragraphBlock(pm[1] || '', numbering));
      cells.push(paras.map((p) => p.text).filter(Boolean).join(' '));
    }
    if (cells.length) rows.push(cells);
  }
  return rows.length ? { kind: 'table', rows } : null;
}

/** numId → format, read from numbering.xml when it is present. */
function readNumbering(xml) {
  const map = new Map();
  if (!xml) return map;
  const abstractFmt = new Map();
  const are = /<w:abstractNum\b([^>]*)>([\s\S]*?)<\/w:abstractNum>/g;
  let a;
  while ((a = are.exec(xml))) {
    const id = attr(a[1], 'w:abstractNumId');
    const first = (a[2].match(/<w:numFmt[^>]*\/?>/) || [''])[0];
    abstractFmt.set(id, attr(first, 'w:val'));
  }
  const nre = /<w:num\b([^>]*)>([\s\S]*?)<\/w:num>/g;
  let n;
  while ((n = nre.exec(xml))) {
    const numId = attr(n[1], 'w:numId');
    const abs = attr((n[2].match(/<w:abstractNumId[^>]*\/?>/) || [''])[0], 'w:val');
    map.set(numId, abstractFmt.get(abs) || 'bullet');
  }
  return map;
}

function readRels(xml) {
  const map = new Map();
  if (!xml) return map;
  const re = /<Relationship\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const id = attr(m[1], 'Id');
    const target = attr(m[1], 'Target');
    if (id && target) map.set(id, target);
  }
  return map;
}

/* ---------- headings that are not headings ---------- *
 *
 * Real specifications are rarely written with Word's heading styles. The ones
 * that arrive from clients use a bold paragraph as a section title, which
 * renders as an undifferentiated wall of text: no outline, no contents, no
 * anchors to link a discussion to.
 *
 * So when a document declares no headings at all, they are inferred. Only
 * then — a document that uses real styles is trusted completely, because
 * guessing on top of explicit structure is how you get a contents list with
 * someone's bolded warning in it.
 */

const NUMBERED = /^\s*\d+(\.\d+)*[.)]\s+\S/;

function looksLikeHeading(b) {
  if (b.kind !== 'para') return false;
  const text = (b.text || '').trim();
  if (!text || text.length > 140) return false;
  // Entirely bold. A sentence with a bold phrase in it is not a title.
  if (!b.runs.length || !b.runs.every((r) => r.b || !r.text.trim())) return false;
  // A bold sentence ending in a full stop is emphasis, not a heading —
  // unless it is numbered, which section titles often are.
  if (/[.!?]$/.test(text) && !NUMBERED.test(text)) return false;
  return true;
}

export function inferHeadings(blocks) {
  if (blocks.some((b) => b.kind === 'heading')) return blocks;

  let first = true;
  return blocks.map((b) => {
    if (!looksLikeHeading(b)) return b;
    const text = b.text.trim();
    const numbered = NUMBERED.test(text);
    let level;
    // The first bold line is the document's title — unless it is numbered, in
    // which case it is section 1 and the document simply has no title.
    if (first && !numbered) { level = 1; first = false; }
    else if (/^\s*\d+\.\d+/.test(text)) { level = 3; first = false; }
    else if (numbered) { level = 2; first = false; }
    else level = 3;   // an unnumbered label like "What to show" sits under its section
    return { ...b, kind: 'heading', level, inferred: true };
  });
}

/** Splits the body into blocks, in order. */
export function parseBody(documentXml, { numbering, rels } = {}) {
  const body = (documentXml.match(/<w:body>([\s\S]*)<\/w:body>/) || [])[1] || documentXml;
  const blocks = [];
  // Paragraphs and tables at the top level, in document order.
  const re = /<w:tbl>([\s\S]*?)<\/w:tbl>|<w:p\b[^>]*>([\s\S]*?)<\/w:p>|<w:p\b[^>]*\/>/g;
  let m;
  while ((m = re.exec(body))) {
    if (m[1] !== undefined) {
      const t = tableBlock(m[1], numbering);
      if (t) blocks.push(t);
    } else {
      const b = paragraphBlock(m[2] || '', numbering);
      // An empty paragraph is spacing, not content; dropping it keeps the
      // diff from filling with blank-line churn.
      if (b.text || b.kind === 'heading') blocks.push({ ...b, rels });
    }
  }
  return inferHeadings(blocks);
}

/* ---------- rendering ---------- */

function runsHtml(runs, rels) {
  return runs.map((r) => {
    let html = esc(r.text).replace(/\n/g, '<br>').replace(/\t/g, '&#9;');
    if (r.code) html = `<code>${html}</code>`;
    if (r.b) html = `<strong>${html}</strong>`;
    if (r.i) html = `<em>${html}</em>`;
    if (r.u) html = `<u>${html}</u>`;
    const href = r.rel && rels ? rels.get(r.rel) : '';
    // Only http(s). A Word hyperlink can carry file:// or javascript:, and
    // this output is published to a page other people open.
    if (href && /^https?:\/\//i.test(href)) {
      html = `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${html}</a>`;
    }
    return html;
  }).join('');
}

export const slugify = (s) => String(s || '')
  .toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'section';

/**
 * Blocks → HTML, plus the headings for a table of contents.
 *
 * Heading ids are made unique by suffixing repeats: "Overview" appears under
 * three different sections in most specs, and duplicate ids make the contents
 * links jump to the wrong one.
 */
export function renderBlocks(blocks) {
  const out = [];
  const toc = [];
  const seen = new Map();
  // Open lists, outermost first. `openLi` tracks whether that level has an
  // <li> still waiting to be closed, because a nested list belongs INSIDE its
  // parent <li> — a <ul> as a direct child of a <ul> is invalid, and browsers
  // only forgive it until something tries to style or parse the result.
  const stack = [];

  const closeLists = (toDepth = 0) => {
    while (stack.length > toDepth) {
      const lvl = stack.pop();
      if (lvl.openLi) out.push('</li>');
      out.push(lvl.ordered ? '</ol>' : '</ul>');
      if (stack.length) stack[stack.length - 1].openLi = true;
    }
    if (stack.length && stack.length === toDepth && toDepth === 0) return;
  };

  for (const b of blocks) {
    if (b.kind !== 'li') closeLists();

    if (b.kind === 'heading') {
      const base = slugify(b.text);
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      const id = n === 1 ? base : `${base}-${n}`;
      toc.push({ id, level: b.level, text: b.text });
      // Strip the bold a heading was recognised BY — an <h2> is already bold,
      // and <strong> inside it is a tag that says nothing.
      const hRuns = b.inferred ? b.runs.map((r) => ({ ...r, b: false })) : b.runs;
      out.push(`<h${b.level} id="${esc(id)}">${runsHtml(hRuns, b.rels)}</h${b.level}>`);
      continue;
    }

    if (b.kind === 'li') {
      const want = (b.level || 0) + 1;

      // A sub-bullet is nested, not a sibling. Flattening them loses the
      // structure that makes a requirements list readable: "Safes by state"
      // and the four states under it become six unrelated bullets.
      if (stack.length > want) closeLists(want);

      if (stack.length === want && stack[stack.length - 1].ordered !== b.ordered) {
        closeLists(want - 1);
      }
      while (stack.length < want) {
        // Going deeper: the parent's <li> stays open and the child list goes
        // inside it.
        if (stack.length) stack[stack.length - 1].openLi = false;
        out.push(b.ordered ? '<ol>' : '<ul>');
        stack.push({ ordered: b.ordered, openLi: false });
      }

      const top = stack[stack.length - 1];
      if (top.openLi) out.push('</li>');
      out.push(`<li>${runsHtml(b.runs, b.rels)}`);
      top.openLi = true;
      continue;
    }

    if (b.kind === 'table') {
      const [head, ...rest] = b.rows;
      out.push('<table><thead><tr>'
        + head.map((c) => `<th>${esc(c)}</th>`).join('')
        + '</tr></thead><tbody>'
        + rest.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')
        + '</tbody></table>');
      continue;
    }

    out.push(`<p${b.subtitle ? ' class="subtitle"' : ''}>${runsHtml(b.runs, b.rels)}</p>`);
  }
  closeLists();
  return { html: out.join('\n'), toc };
}

/* ---------- the whole thing ---------- */

/**
 * Reads a .docx File or ArrayBuffer into { html, toc, blocks, text }.
 *
 * `text` is the plain reading of the document, kept for the diff: comparing
 * rendered HTML would report every formatting tweak as a change.
 */
export async function readDocx(input) {
  const bytes = input instanceof Uint8Array
    ? input
    : new Uint8Array(input instanceof ArrayBuffer ? input : await input.arrayBuffer());

  const files = readZip(bytes);
  const docEntry = files.get('word/document.xml');
  if (!docEntry) throw new Error('That .docx has no document body — is it really a Word file?');

  const [documentXml, numberingXml, relsXml] = await Promise.all([
    inflateEntry(docEntry),
    inflateEntry(files.get('word/numbering.xml')).catch(() => ''),
    inflateEntry(files.get('word/_rels/document.xml.rels')).catch(() => '')
  ]);

  const blocks = parseBody(documentXml, {
    numbering: readNumbering(numberingXml),
    rels: readRels(relsXml)
  });
  const { html, toc } = renderBlocks(blocks);

  return {
    html,
    toc,
    blocks: blocks.map(({ rels, ...b }) => b),   // rels are not worth storing
    text: blocksText(blocks),
    words: blocksText(blocks).split(/\s+/).filter(Boolean).length
  };
}

/** The document as lines, which is what the diff works on. */
export function blocksText(blocks) {
  return blocks.map((b) => {
    if (b.kind === 'table') return b.rows.map((r) => r.join(' | ')).join('\n');
    if (b.kind === 'heading') return `${'#'.repeat(b.level)} ${b.text}`;
    if (b.kind === 'li') return `${'  '.repeat(b.level || 0)}- ${b.text}`;
    return b.text;
  }).filter(Boolean).join('\n');
}
