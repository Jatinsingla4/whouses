'use strict';
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { parseTcss, compile, annotate, check, sheetsIn } = require('./tracecss');
const { buildIndex } = require('./whouses');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracecss-'));
const w = (p, c) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), c); return path.join(root, p); };

// --- the superset promise: any plain CSS is already valid tracecss ---
const plain = `.a { color: red }\n@media (min-width: 700px) { .b { color: blue } }\n`;
const asIs = w('src/plain.tcss', plain);
assert.strictEqual(compile(fs.readFileSync(asIs, 'utf8')), plain, 'plain CSS passes through byte-for-byte');
assert.deepStrictEqual(parseTcss(asIs).rules.map((r) => r.classes.flat()), [['a'], ['b']], 'nested rules found');

// --- directives ---
w('src/Button.tcss', `@component Button;

@public .btn { padding: 8px }
@private .btn-ripple { position: absolute }
@deprecated("use .btn-new") .btn-old { color: grey }
@owner("@jatin") .btn-lonely { color: pink }
`);
w('src/Button.jsx', `export const B = () => <b className="btn btn-ripple btn-old"/>;`);
w('src/Page.jsx', `<div className="btn-ripple"/><i className="btn-old"/>`);

const sheet = parseTcss(path.join(root, 'src/Button.tcss'));
assert.strictEqual(sheet.component, 'Button');
const by = Object.fromEntries(sheet.rules.map((r) => [r.classes[0], r]));
assert.strictEqual(by['btn'].access, 'public');
assert.strictEqual(by['btn-ripple'].access, 'private');
assert.strictEqual(by['btn-old'].deprecated, 'use .btn-new');
assert.strictEqual(by['btn-lonely'].owner, '@jatin');
assert.strictEqual(by['btn'].line, 3, 'line points at the selector, not the directive above it');

// compiled CSS must be free of every directive
const out = compile(sheet.src);
assert.ok(!/@component|@public|@private|@deprecated|@owner/.test(out), 'directives stripped: ' + out);
assert.ok(out.includes('.btn-ripple { position: absolute }'), 'declarations survive');

// --- enforcement ---
const ix = buildIndex(root);
const problems = check(ix, sheetsIn(root));
const find = (lvl, sub) => problems.filter((p) => p.level === lvl && p.msg.includes(sub));

assert.strictEqual(find('error', 'btn-ripple').length, 1, 'exactly one @private violation');
assert.ok(find('error', 'btn-ripple')[0].file.endsWith('Page.jsx'), 'violation blamed on the outsider');
assert.ok(!problems.some((p) => p.file.endsWith('Button.jsx') && p.level === 'error'),
  'the owning component may use its own @private class');
assert.strictEqual(find('warn', 'deprecated').length, 2, 'deprecation warns at every call site');
assert.ok(find('info', 'btn-lonely').length, 'unused public class reported');

// --- a guess must never fail a build ---
w('src/Wild.jsx', 'const c = `btn-${kind}`;');
const ix2 = buildIndex(root);
const p2 = check(ix2, sheetsIn(root));
const wild = p2.filter((p) => p.file.endsWith('Wild.jsx'));
assert.ok(wild.length, 'dynamic class still traced into Wild.jsx');
assert.ok(wild.every((p) => p.level !== 'error'), 'dynamic hits warn, never error: ' + JSON.stringify(wild));

// --- annotate is safe to run on every save ---
const s2 = parseTcss(path.join(root, 'src/Button.tcss'));
const once = annotate(ix2, s2);
fs.writeFileSync(s2.file, once);
const twice = annotate(ix2, parseTcss(s2.file));
assert.strictEqual(once, twice, 'annotate is idempotent — no drift on repeat runs');
assert.ok(/\/\* @used-by [^\n]*\[tracecss\] \*\/\n@public \.btn /.test(once), 'comment sits directly above its rule');
assert.ok(once.includes('@component Button;'), 'source directives preserved in the .tcss');
assert.ok(!compile(once).includes('@used-by'), 'generated comments never reach the compiled CSS');

fs.rmSync(root, { recursive: true, force: true });
console.log('ok — tracecss: superset, directives, enforcement, idempotent annotation');
