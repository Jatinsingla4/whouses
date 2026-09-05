'use strict';
// Every case here is a bug that shipped in 1.x, found by pointing adversarial testing
// at the real thing. Each name is the failure it prevents coming back.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const W = require('./whouses');
const { execFileSync, spawnSync } = require('child_process');

const CLI = path.join(__dirname, 'whouses.js');
const TC = path.join(__dirname, 'tracecss.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-'));
const w = (p, c) => { const f = path.join(root, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); return f; };
const run = (args) => { const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); return (r.stdout || '') + (r.stderr || ''); };
const defsOf = (f) => { const d = {}; W.parseCss(f, d); return d; };
const balanced = (t) => [...t].filter((c) => c === '{').length === [...t].filter((c) => c === '}').length;
let n = 0;
const ok = (label, fn) => { fn(); n++; };

// ---------- source scanning: a missed usage makes the tool advise deleting live CSS ----------
ok('apostrophe in JSX prose does not swallow the code after it', () => {
  w('a1/a.css', '.alpha { color: red }');
  w('a1/A.jsx', "export default () => (<div><p>it's here</p><span className=\"alpha\">x</span></div>);");
  assert.match(run(['--root', path.join(root, 'a1'), '--orphans']), /^0 orphan/);
});
ok('apostrophe in a // comment does not swallow the next string', () => {
  w('a2/a.css', '.alpha { color: red }');
  w('a2/A.js', "// don't rename this\nconst cls = 'alpha';\n");
  assert.match(run(['--root', path.join(root, 'a2'), '--orphans']), /^0 orphan/);
});
ok('a quote inside a regex literal is not a string delimiter', () => {
  w('a3/a.css', '.alpha { color: red }');
  w('a3/A.js', 'const re = /[\'"]/g;\nconst cls = "alpha";\n');
  assert.match(run(['--root', path.join(root, 'a3'), '--orphans']), /^0 orphan/);
});
ok('a backtick in a comment does not swallow a template literal', () => {
  w('a4/a.css', '.alpha{color:red}\n.beta{color:blue}');
  w('a4/A.js', '// migrate `card to something else\nconst c = `alpha beta`;\n');
  assert.match(run(['--root', path.join(root, 'a4'), '--orphans']), /^0 orphan/);
});
ok('prose is never counted as a usage', () => {
  w('a5/a.css', '.card{color:red}\n.alpha{color:blue}');
  w('a5/A.jsx', "export default () => (<div><p>it's a card you carry</p><i className=\"alpha\"/></div>);");
  assert.match(run(['--root', path.join(root, 'a5'), '.card']), /nobody/);
});
ok('${...} with two levels of braces still prefix-matches', () => {
  w('a6/a.css', '.btn-lg{color:red}');
  w('a6/A.jsx', 'export const C = ({o}) => <div className={`btn-${pick({a:{b:1}}, o)}`} />;');
  assert.match(run(['--root', path.join(root, 'a6'), '--orphans']), /^0 orphan/);
});
ok('suffix interpolation `${x}-item` is matched', () => {
  w('a7/a.css', '.card-item { color: red }');
  w('a7/A.jsx', 'export const C = ({t}) => <div className={`${t}-item`} />;');
  assert.match(run(['--root', path.join(root, 'a7'), '--orphans']), /^0 orphan/);
});
ok('a destructured CSS-module binding is a usage', () => {
  w('a8/x.module.css', '.cardBody { color: red }');
  w('a8/A.jsx', "import s from './x.module.css';\nconst { cardBody } = s;\nexport const C = () => <div className={cardBody}/>;");
  assert.match(run(['--root', path.join(root, 'a8'), '--orphans']), /^0 orphan/);
});
ok('an unquoted HTML class attribute is a usage', () => {
  w('a9/a.css', '.alpha{color:red}');
  w('a9/i.html', '<div class=alpha>hi</div>');
  assert.match(run(['--root', path.join(root, 'a9'), '--orphans']), /^0 orphan/);
});
ok('markup inside a .md file is scanned', () => {
  w('a10/a.css', '.alpha{color:red}');
  w('a10/R.md', '# T\n\n<div class="alpha">hi</div>');
  assert.match(run(['--root', path.join(root, 'a10'), '--orphans']), /^0 orphan/);
});
ok('a token in a multi-line template reports its own line', () => {
  w('a11/a.css', '.alpha{color:red}\n.beta{color:blue}');
  w('a11/A.jsx', 'const c = `\n  alpha\n  beta\n`;');
  assert.match(run(['--root', path.join(root, 'a11'), '.beta']), /A\.jsx:3/);
});

// ---------- CSS parsing ----------
ok('a rule after a ;-terminated at-rule is not lost', () => {
  const f = w('b1/q.css', '@charset "UTF-8";\n.lost { color: red }\n@import url(o.css);\n.lost2 { color: red }');
  assert.deepStrictEqual(Object.keys(defsOf(f)).sort(), ['lost', 'lost2']);
});
ok('escaped class names are unescaped, not truncated', () => {
  const f = w('b2/a.css', '.md\\:flex { display: flex }\n.w-1\\/2 { width: 50% }');
  assert.deepStrictEqual(Object.keys(defsOf(f)).sort(), ['md:flex', 'w-1/2']);
});
ok('a // inside a url() does not eat the rest of the sheet', () => {
  const f = w('b3/c.scss', '.hero { background: url("https://cdn.x/b.png"); }\n.footer { color: red }\n.side { color: blue }');
  const d = defsOf(f);
  assert.deepStrictEqual(Object.keys(d).sort(), ['footer', 'hero', 'side']);
  assert.strictEqual(d.footer[0].line, 2, 'line numbers survive the URL');
});
ok('a nested rule is attributed to its own line, with no phantom classes', () => {
  const f = w('b4/m.scss', '.card {\n  background: url(logo.png);\n  filter: progid:DX.Microsoft.gradient(x=1);\n  .card-title { color: red }\n}');
  const d = defsOf(f);
  assert.deepStrictEqual(Object.keys(d).sort(), ['card', 'card-title']);
  assert.strictEqual(d['card-title'][0].line, 4);
});
ok('a comment marker inside a string does not blank real rules', () => {
  const f = w('b5/s.css', '.open::before { content: "/*"; }\n.menu { color: red }\n.close::after { content: "*/"; }');
  assert.deepStrictEqual(Object.keys(defsOf(f)).sort(), ['close', 'menu', 'open']);
});
ok('--vars ignores comments and understands @property', () => {
  w('b6/v.css', '@property --angle { syntax: "<angle>" }\n:root { --brand: red;\n /* --dead: green */ }\n.a { color: var(--brand); rotate: var(--angle) }\n/* .b { color: var(--ghost) } */');
  const out = run(['--root', path.join(root, 'b6'), '--vars']);
  assert.match(out, /^2 CSS custom/);
  assert.ok(!/--dead|--ghost/.test(out), out);
});

// ---------- write paths: these destroyed real files in 1.x ----------
ok('--extract cuts by offset, so a rule sharing a line survives', () => {
  w('c1/src/vendor.css', '.hdr{color:#111}.nav{display:flex}.btn{color:red}.foot{color:#999}');
  w('c1/src/Button.jsx', 'export default () => <div className="btn">x</div>;');
  w('c1/src/Layout.jsx', 'export default () => <div className="hdr nav foot">y</div>;');
  run(['--root', path.join(root, 'c1'), '--extract', path.join(root, 'c1/src/Button.jsx'), '--write']);
  const left = fs.readFileSync(path.join(root, 'c1/src/vendor.css'), 'utf8');
  assert.ok(/\.hdr/.test(left) && /\.nav/.test(left) && /\.foot/.test(left), 'siblings kept: ' + left);
  assert.ok(!/\.btn\{/.test(left), 'the moved rule is gone from the origin');
  assert.ok(balanced(left) && balanced(fs.readFileSync(path.join(root, 'c1/src/Button.css'), 'utf8')));
});
ok('--extract never splits a rule from its closing brace', () => {
  w('c2/src/app.css', '.shared {\n  color: green;\n} .btn { color: blue; }\n.after { color: black; }');
  w('c2/src/Button.jsx', 'export default () => <div className="btn shared">x</div>;');
  w('c2/src/Other.jsx', 'export default () => <div className="shared">y</div>;');
  run(['--root', path.join(root, 'c2'), '--extract', path.join(root, 'c2/src/Button.jsx'), '--write']);
  const left = fs.readFileSync(path.join(root, 'c2/src/app.css'), 'utf8');
  assert.ok(balanced(left), 'origin still balanced: ' + left);
  assert.ok(/\.after/.test(left) && /\.shared/.test(left));
});
ok('--extract refuses to overwrite an existing component stylesheet', () => {
  w('c3/src/app.css', '.btn { color: red }');
  w('c3/src/Button.jsx', 'export default () => <div className="btn">x</div>;');
  const hand = w('c3/src/Button.css', '/* HAND-WRITTEN */\n.glow { box-shadow: 0 0 20px gold }');
  const out = run(['--root', path.join(root, 'c3'), '--extract', path.join(root, 'c3/src/Button.jsx'), '--write']);
  assert.match(out, /refusing to write/);
  assert.match(fs.readFileSync(hand, 'utf8'), /HAND-WRITTEN/);
});
ok('--extract leaves a class defined in two stylesheets alone', () => {
  w('c4/src/zz.css', '.btn { color: red }');
  w('c4/src/aa.css', '.btn { color: green }');
  w('c4/src/Button.jsx', "import './zz.css';\nimport './aa.css';\nexport default () => <div className=\"btn\">x</div>;");
  assert.match(run(['--root', path.join(root, 'c4'), '--extract', path.join(root, 'c4/src/Button.jsx')]),
    /stay .*more than one stylesheet/);
});
ok('--rename touches class occurrences only, never identifiers, comments or URLs', () => {
  w('c5/src/app.css', '.btn {\n  background: url("/img/btn.svg");\n}\n/* the .btn class */');
  w('c5/src/B.jsx', 'const btn = 1;\n// btn is the element\nexport default () => <div className="btn"/>;');
  run(['--root', path.join(root, 'c5'), '--rename', '.btn', '.btn-primary', '--write']);
  const js = fs.readFileSync(path.join(root, 'c5/src/B.jsx'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'c5/src/app.css'), 'utf8');
  assert.match(js, /const btn = 1;/, 'JS identifier untouched');
  assert.match(js, /\/\/ btn is the element/, 'comment untouched');
  assert.match(js, /className="btn-primary"/, 'the class string is renamed');
  assert.match(css, /url\("\/img\/btn\.svg"\)/, 'asset path untouched');
  assert.match(css, /^\.btn-primary \{/m, 'the selector is renamed');
});
ok('--install-hook refuses to append shell into a non-shell hook', () => {
  const g = path.join(root, 'c6');
  fs.mkdirSync(path.join(g, '.git/hooks'), { recursive: true });
  const hook = path.join(g, '.git/hooks/pre-commit');
  fs.writeFileSync(hook, '#!/usr/bin/env python3\nimport sys\n', { mode: 0o755 });
  assert.match(run(['--root', g, '--install-hook']), /not a shell script/);
  assert.ok(!/whouses/.test(fs.readFileSync(hook, 'utf8')), 'hook untouched');
});

// ---------- tracecss ----------
const tc = (dir) => { const r = spawnSync('node', [TC, 'build', path.join(root, dir)], { encoding: 'utf8' }); return (r.stdout || '') + (r.stderr || ''); };
ok('a ) inside a @deprecated message does not destroy the stylesheet', () => {
  w('d1/S.tcss', '@deprecated("use .btn-danger (new)") .btn-delete { color: red; }\n.keep { color: blue }');
  tc('d1');
  const out = fs.readFileSync(path.join(root, 'd1/S.css'), 'utf8');
  assert.match(out, /^\.btn-delete \{ color: red; \}/m, out);
  assert.match(out, /\.keep/, out);
});
ok('directive text inside strings and comments is preserved', () => {
  w('d2/Doc.tcss', '@component Doc;\n.badge::after { content: "@public"; }\n/* NOTE: @private rules */\n.hint { color: red }');
  tc('d2');
  const out = fs.readFileSync(path.join(root, 'd2/Doc.css'), 'utf8');
  assert.match(out, /content: "@public";/, out);
  assert.match(out, /NOTE: @private rules/, out);
  assert.ok(!/^@component/m.test(out), 'the real directive is still stripped');
});
ok('tracecss build refuses to destroy a hand-written .css', () => {
  w('d3/Doc.tcss', '@component Doc;\n.x { color: red }');
  const hand = w('d3/Doc.css', '/* HAND-WRITTEN 400 lines */\n.legacy { background: red }');
  assert.match(tc('d3'), /refusing to overwrite/);
  assert.match(fs.readFileSync(hand, 'utf8'), /HAND-WRITTEN/);
});

// ---------- scale: a project can be one file or a million lines ----------
ok('an empty project says so instead of crashing', () => {
  fs.mkdirSync(path.join(root, 'e0'), { recursive: true });
  assert.match(run(['--root', path.join(root, 'e0'), '--orphans']), /no CSS classes found/);
});
ok('200-deep nesting does not blow the stack', () => {
  w('e1/d.scss', '.l0 {\n'.replace('.l0', '.l0') + Array.from({ length: 199 }, (_, i) => `.l${i + 1} {`).join('\n') + '\ncolor: red;\n' + '}\n'.repeat(200));
  w('e1/A.jsx', '<div className="l0 l199"/>');
  const out = run(['--root', path.join(root, 'e1'), '--orphans']);
  assert.ok(!/Error|Maximum call stack/.test(out), out);
});
ok('a broad dynamic prefix does not explode into a per-class row', () => {
  // 4000 classes and 300 files all matched by one `u-${k}` — the old index stored a
  // row per class per file, which was 1.2M rows here and 30M on a real design system
  let css = '';
  for (let i = 0; i < 4000; i++) css += `.u-${i}{margin:${i % 9}px}\n`;
  w('e2/src/all.css', css);
  for (let i = 0; i < 300; i++) w(`e2/src/C${i}.jsx`, 'export default ({k}) => <div className={`u-${k}`}/>;');
  const t0 = Date.now();
  const out = run(['--root', path.join(root, 'e2'), '--orphans']);
  const ms = Date.now() - t0;
  assert.match(out, /^0 orphan/, out.slice(0, 200));
  assert.ok(ms < 30000, 'took ' + ms + 'ms — the fan-out regressed');
});
ok('a stylesheet on one very long line is parsed, not skipped', () => {
  let css = '';
  for (let i = 0; i < 20000; i++) css += `.x${i}{margin:${i % 9}px}`;
  w('e3/one.css', css);
  w('e3/A.jsx', '<div className="x1 x2"/>');
  const out = run(['--root', path.join(root, 'e3'), '--orphans']);
  assert.match(out, /^19998 orphan/, out.slice(0, 120));
});
ok('an unreadable or oversized file is reported, never silently dropped', () => {
  w('e4/a.css', '.k { color: red }');
  w('e4/A.jsx', '<div className="k"/>');
  const big = path.join(root, 'e4/huge.css');
  fs.writeFileSync(big, '.z{margin:0}\n'.repeat(10));
  fs.writeFileSync(big, Buffer.alloc(2, 0));            // a binary file
  assert.match(run(['--root', path.join(root, 'e4'), '--orphans']), /skipped 1 file/);
});

ok('build output and vendored trees are not scanned as source', () => {
  w('e5/src/a.css', '.live { color: red }');
  w('e5/src/A.jsx', '<div className="live"/>');
  for (const d of ['dist', 'build', 'release', 'target', '.next', 'out', 'coverage', 'Pods', 'bower_components', '.vercel']) {
    w(`e5/${d}/vendor.css`, '.build-artifact { color: blue }');
    w(`e5/${d}/LICENSES.html`, '<style>.license-junk{color:green}</style>');
  }
  const out = run(['--root', path.join(root, 'e5'), '--orphans']);
  assert.match(out, /^0 orphan/, out.slice(0, 200));
  assert.ok(!/build-artifact|license-junk/.test(out), 'build output leaked into the index: ' + out);
});

fs.rmSync(root, { recursive: true, force: true });
console.log('ok — ' + n + ' edge cases, all previously shipped bugs');
