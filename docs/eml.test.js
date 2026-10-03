// Tests for the .eml reader.
//
// The failure mode worth guarding is not a crash — it is quietly returning
// mojibake or the wrong part of a multipart message, which looks like the
// release parser breaking rather than the decoding.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEml, decodeQuotedPrintable, decodeBase64, htmlToText, decodeHeaderWords } from './eml.js';

const mp = (boundary, parts) =>
  `From: a@b.com\nSubject: Test\nContent-Type: multipart/alternative; boundary="${boundary}"\n\n`
  + parts.map((p) => `--${boundary}\n${p}`).join('\n') + `\n--${boundary}--\n`;

test('quoted-printable decodes, and a soft line break is not data', () => {
  assert.equal(decodeQuotedPrintable('caf=C3=A9'), 'cafÃ©');
  assert.equal(decodeQuotedPrintable('one =\ntwo'), 'one two');
  assert.equal(decodeQuotedPrintable('Path: =5C=5Cfs04'), 'Path: \\\\fs04');
});

test('base64 decodes and survives line wrapping', () => {
  assert.equal(decodeBase64('aGVsbG8='), 'hello');
  assert.equal(decodeBase64('aGVs\nbG8='), 'hello');
  assert.equal(decodeBase64('!!!not base64!!!'), '');
});

test('plain text is preferred over the HTML alternative', () => {
  const raw = mp('xyz', [
    'Content-Type: text/plain; charset="utf-8"\n\nthe plain one\n',
    'Content-Type: text/html; charset="utf-8"\n\n<p>the html one</p>\n'
  ]);
  const r = parseEml(raw);
  assert.equal(r.ok, true);
  assert.match(r.text, /the plain one/);
  assert.doesNotMatch(r.text, /the html one/);
});

test('HTML is used when there is no plain alternative', () => {
  const raw = mp('xyz', ['Content-Type: text/html; charset="utf-8"\n\n<p>Release: v1</p><br><p>Env</p>\n']);
  const r = parseEml(raw);
  assert.match(r.text, /Release: v1/);
  assert.doesNotMatch(r.text, /<p>/, 'tags must not survive into the text');
});

test('a quoted-printable utf-8 body comes back as characters, not bytes', () => {
  // The classic symptom of getting this wrong is "Â·" where a middle dot
  // belongs — which reads as a broken parser, not a broken decoder.
  const raw = mp('b1', [
    'Content-Type: text/plain; charset="utf-8"\nContent-Transfer-Encoding: quoted-printable\n\nRelease =C2=B7 caf=C3=A9\n'
  ]);
  assert.match(parseEml(raw).text, /Release · café/);
});

test('a base64 body is decoded', () => {
  const raw = mp('b2', [
    `Content-Type: text/plain; charset="utf-8"\nContent-Transfer-Encoding: base64\n\n${btoa('Release: v1.3.2 (189)')}\n`
  ]);
  assert.match(parseEml(raw).text, /v1\.3\.2 \(189\)/);
});

test('an attached file is not mistaken for the message body', () => {
  const raw = mp('b3', [
    'Content-Type: text/plain\n\nthe real body\n',
    'Content-Type: text/plain\nContent-Disposition: attachment; filename="notes.txt"\n\nan attachment\n'
  ]);
  const r = parseEml(raw);
  assert.match(r.text, /the real body/);
  assert.doesNotMatch(r.text, /an attachment/);
});

test('headers are unfolded, so a wrapped subject is not truncated', () => {
  const raw = 'From: a@b.com\nSubject: RE: Ocufii Android\n Version Management\nContent-Type: text/plain\n\nbody\n';
  assert.equal(parseEml(raw).subject, 'RE: Ocufii Android Version Management');
});

test('encoded-word subjects are decoded', () => {
  assert.equal(decodeHeaderWords('=?utf-8?B?SGVsbG8gd29ybGQ=?='), 'Hello world');
  assert.equal(decodeHeaderWords('=?utf-8?Q?caf=C3=A9?='), 'café');
  assert.equal(decodeHeaderWords('plain subject'), 'plain subject');
});

test('a plain .txt file is accepted as its own body rather than refused', () => {
  const r = parseEml('Release: v1.3.2 (189)\nEnvironment: (California)');
  assert.equal(r.ok, true);
  assert.match(r.text, /v1\.3\.2/);
});

test('an empty file is refused with a message', () => {
  assert.equal(parseEml('').ok, false);
  assert.equal(parseEml('   ').ok, false);
});

test('malformed nesting terminates instead of recursing forever', () => {
  // A part that declares itself as its own container is the pathological case.
  const raw = 'Content-Type: multipart/mixed; boundary="x"\n\n--x\nContent-Type: multipart/mixed; boundary="x"\n\n--x\nContent-Type: text/plain\n\nhi\n--x--\n';
  const r = parseEml(raw);
  assert.equal(r.ok, true);
});

test('CRLF line endings are handled, which is what a real .eml has', () => {
  const raw = 'From: a@b.com\r\nContent-Type: text/plain\r\n\r\nRelease: v1\r\n';
  assert.match(parseEml(raw).text, /Release: v1/);
});

test('htmlToText keeps structure and unescapes entities', () => {
  assert.equal(htmlToText('<p>a</p><p>b</p>'), 'a\nb');
  assert.equal(htmlToText('x<br>y'), 'x\ny');
  assert.equal(htmlToText('<style>p{}</style><p>only</p>'), 'only');
  assert.equal(htmlToText('&lt;tag&gt; &amp; &quot;q&quot;'), '<tag> & "q"');
});
