// Command Deck — a small MIME reader, so an email can be attached rather than
// pasted.
//
// Pasting 288 KB of thread into a textarea works and is horrible. Dropping the
// .eml file in is what anyone would actually do. The browser gives you the
// bytes; everything between those bytes and readable text is this file.
//
// Deliberately small and deliberately not a general MIME implementation. It
// handles what Outlook and Gmail produce for a forwarded thread: multipart
// bodies, quoted-printable and base64 transfer encodings, a charset per part,
// and HTML when there is no plain text alternative. Anything stranger falls
// back to showing the raw text rather than throwing, because a human can still
// read a mangled email and fix it by hand — they cannot read an exception.
//
// Pure: no DOM beyond TextDecoder, no network. docs/eml.test.js covers it.

/** Unfolds the header block: a continuation line starts with whitespace. */
function parseHeaders(block) {
  const headers = new Map();
  const lines = block.split('\n');
  let current = '';
  for (const line of lines) {
    if (/^[ \t]/.test(line) && current) {
      current += ' ' + line.trim();
      continue;
    }
    if (current) addHeader(headers, current);
    current = line;
  }
  if (current) addHeader(headers, current);
  return headers;
}

function addHeader(headers, line) {
  const i = line.indexOf(':');
  if (i < 0) return;
  const name = line.slice(0, i).trim().toLowerCase();
  const value = line.slice(i + 1).trim();
  // Keep the first of a repeated header, which is the one that applies.
  if (!headers.has(name)) headers.set(name, value);
}

function paramOf(headerValue, name) {
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|([^;\\s]+))`, 'i');
  const m = (headerValue || '').match(re);
  return m ? (m[2] !== undefined ? m[2] : m[3]) : '';
}

/* ---------- transfer encodings ---------- */

export function decodeQuotedPrintable(input) {
  return input
    // A trailing "=" is a soft line break and the newline is not data.
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

export function decodeBase64(input) {
  const clean = input.replace(/[^A-Za-z0-9+/=]/g, '');
  try { return atob(clean); } catch (_) { return ''; }
}

/**
 * Re-reads a binary string as the part's charset.
 *
 * atob and quoted-printable both produce a "binary string" — one char per
 * byte. Treating that as text shows "Â·" where a UTF-8 middle dot should be,
 * which is exactly the kind of mess that makes a parser look broken when the
 * decoding is what failed.
 */
function reinterpret(binary, charset) {
  const cs = (charset || 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  if (/^(us-)?ascii$/.test(cs)) return binary;
  try {
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
    return new TextDecoder(cs, { fatal: false }).decode(bytes);
  } catch (_) {
    return binary;
  }
}

/* ---------- html, when that is all there is ---------- */

export function htmlToText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ---------- the part tree ---------- */

function splitPart(raw) {
  const sep = raw.indexOf('\n\n');
  if (sep < 0) return { headers: parseHeaders(raw), body: '' };
  return { headers: parseHeaders(raw.slice(0, sep)), body: raw.slice(sep + 2) };
}

function decodeBody(headers, body) {
  const enc = (headers.get('content-transfer-encoding') || '7bit').toLowerCase().trim();
  const charset = paramOf(headers.get('content-type') || '', 'charset');
  if (enc === 'base64') return reinterpret(decodeBase64(body), charset);
  if (enc === 'quoted-printable') return reinterpret(decodeQuotedPrintable(body), charset);
  return reinterpret(body, charset);
}

function walk(raw, out, depth = 0) {
  if (depth > 12) return;               // malformed nesting must not recurse forever
  const { headers, body } = splitPart(raw);
  const type = (headers.get('content-type') || 'text/plain').toLowerCase();

  if (type.startsWith('multipart/')) {
    const boundary = paramOf(headers.get('content-type') || '', 'boundary');
    if (!boundary) return;
    const marker = `--${boundary}`;
    const pieces = body.split(marker);
    // The first piece is the preamble and the last is the epilogue after "--".
    for (const piece of pieces.slice(1)) {
      if (/^--/.test(piece.trim())) break;
      walk(piece.replace(/^\r?\n/, ''), out, depth + 1);
    }
    return;
  }

  if (type.startsWith('text/')) {
    out.push({
      type: type.split(';')[0].trim(),
      // An attached file carries a filename; it is not the message body.
      attachment: /attachment/i.test(headers.get('content-disposition') || ''),
      text: decodeBody(headers, body)
    });
  }
}

/**
 * Reads an .eml file into its headers and best-effort body text.
 *
 * Returns { ok, subject, from, date, text, parts } — `text` is text/plain when
 * the message has one, otherwise the HTML alternative flattened. Both are kept
 * in `parts` so a caller can choose differently.
 */
export function parseEml(raw) {
  const source = String(raw || '').replace(/\r\n/g, '\n');
  if (!source.trim()) return { ok: false, error: 'That file is empty.', text: '' };

  const { headers } = splitPart(source);
  const looksLikeMail = headers.has('from') || headers.has('subject')
    || headers.has('content-type') || headers.has('received');

  if (!looksLikeMail) {
    // A .txt file, or an email saved oddly. Treat the whole thing as the body
    // rather than refusing: the caller only wants readable text.
    return { ok: true, subject: '', from: '', date: '', text: source, parts: [], plain: true };
  }

  const parts = [];
  walk(source, parts);

  const body = parts.filter((p) => !p.attachment);
  const plain = body.find((p) => p.type === 'text/plain' && p.text.trim());
  const html = body.find((p) => p.type === 'text/html' && p.text.trim());
  const text = plain ? plain.text : (html ? htmlToText(html.text) : source);

  return {
    ok: true,
    subject: decodeHeaderWords(headers.get('subject') || ''),
    from: decodeHeaderWords(headers.get('from') || ''),
    date: headers.get('date') || '',
    text,
    parts
  };
}

/** Decodes RFC 2047 =?utf-8?B?...?= words, which turn up in subjects. */
export function decodeHeaderWords(value) {
  return String(value || '').replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_, charset, enc, data) => {
      const binary = enc.toUpperCase() === 'B'
        ? decodeBase64(data)
        : decodeQuotedPrintable(data.replace(/_/g, ' '));
      return reinterpret(binary, charset);
    }
  ).replace(/\?=\s+=\?/g, '');
}

/** Reads a File or Blob as text, so a caller does not have to care how. */
export async function readEmlFile(file) {
  const raw = await file.text();
  const res = parseEml(raw);
  return { ...res, filename: file.name, bytes: file.size };
}
