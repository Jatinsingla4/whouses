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
const rel = (f) => path.relative(root, f).split(path.sep).join('/');   // windows gives backslashes
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

// ---------- the first things a stranger types ----------
ok('--version prints a version, not the help screen', () => {
  assert.match(run(['--version']).trim(), /^\d+\.\d+\.\d+$/);
  assert.match(run(['-v']).trim(), /^\d+\.\d+\.\d+$/);
});
ok('--help and -h show help instead of being read as a class name', () => {
  for (const f of ['--help', '-h']) {
    const out = run([f]);
    assert.match(out, /reverse index for CSS/, f + ' => ' + out.slice(0, 80));
    assert.ok(!/not defined in any stylesheet/.test(out), f + ' was parsed as a class name');
  }
});
ok('a mistyped flag is an error, not a silent help screen', () => {
  const r = spawnSync('node', [CLI, '--orphan'], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  assert.match(out, /unknown option: --orphan/, out.slice(0, 120));
  assert.match(out, /did you mean.*--orphans/, out);
  assert.notStrictEqual(r.status, 0, 'a typo must not exit 0');
});
ok('tracecss rejects an unknown command', () => {
  const r = spawnSync('node', [TC, 'bogus'], { encoding: 'utf8' });
  assert.match((r.stdout || '') + (r.stderr || ''), /unknown command: bogus/);
  assert.notStrictEqual(r.status, 0);
});

// ---------- every pattern from Tailwind's own docs page ----------
ok("the docs' recommended patterns are never flagged", () => {
  w('tw1/Good.jsx', [
    'export function A({ color }) {',
    '  const colors = { black: "bg-black text-white", blue: "bg-blue-500 text-white" };',
    '  return <button className={`${colors[color]} rounded-full px-2 py-1.5 text-sm/6 shadow`}/>;',
    '}',
    'export function B({ color }) {',
    '  const v = { blue: "bg-blue-600 hover:bg-blue-500", red: "bg-red-600 hover:bg-red-500" };',
    '  return <button className={`${v[color]} ...`}/>;',
    '}',
  ].join('\n'));
  const hits = W.scanTailwind(path.join(root, 'tw1'));
  assert.deepStrictEqual(hits, [], 'flagged the docs own correct example: ' + JSON.stringify(hits));
});
ok("the docs' anti-patterns are all flagged, variants included", () => {
  w('tw2/Bad.jsx', [
    'const a = <div className={`bg-${color}-600 hover:bg-${color}-500 ...`}/>;',
    'const b = <div className={`hover:bg-${color}-100`}/>;',
    'const c = <div className={`md:grid-cols-${n}`}/>;',
    'const d = <div className={`dark:text-${c}-500`}/>;',
    'const e = <div className={`w-[calc(100%-${x}rem)]`}/>;',
  ].join('\n'));
  const frags = W.scanTailwind(path.join(root, 'tw2')).map((h) => h.line + ':' + h.fragment).sort();
  assert.deepStrictEqual(frags, [
    '1:bg-', '1:hover:bg-', '2:hover:bg-', '3:md:grid-cols-', '4:dark:text-', '5:w-[calc(100%-',
  ].sort(), JSON.stringify(frags));
});
ok('{{ }} interpolation in a class attribute is flagged', () => {
  // the first anti-pattern example on Tailwind's docs page is Blade/Handlebars syntax
  w('tw3/page.html', '<div class="text-{{ error ? \'red\' : \'green\' }}-600"></div>');
  w('tw3/ok.html', '<div class="text-red-600"></div>');
  const hits = W.scanTailwind(path.join(root, 'tw3'));
  assert.strictEqual(hits.length, 1, JSON.stringify(hits));
  assert.strictEqual(hits[0].fragment, 'text-');
  assert.ok(hits[0].file.endsWith('page.html'));
});

ok('a sibling project without Tailwind is not reported on', () => {
  // a folder holding several projects: only some use Tailwind, and a `p-${x}` in a
  // non-Tailwind sibling is that developer's own class scheme, not a Tailwind bug
  w('mono/with-tw/package.json', JSON.stringify({ name: 'a', dependencies: { tailwindcss: '^4' } }));
  w('mono/with-tw/App.jsx', 'const a = <div className={`bg-${color}-100`}/>;');
  w('mono/no-tw/package.json', JSON.stringify({ name: 'b', dependencies: { react: '^18' } }));
  w('mono/no-tw/App.jsx', 'const b = <div className={`priority-tag p-${level}`}/>;');
  const hits = W.scanTailwind(path.join(root, 'mono'));
  assert.strictEqual(hits.length, 1, JSON.stringify(hits.map((h) => h.file + ':' + h.fragment)));
  assert.ok(hits[0].file.includes('with-tw'), 'flagged the wrong project: ' + hits[0].file);
});
ok('--tailwind says so plainly when the project has no Tailwind', () => {
  w('notw/package.json', JSON.stringify({ name: 'c', dependencies: { react: '^18' } }));
  w('notw/a.css', '.btn { padding: 8px }');
  w('notw/App.jsx', 'const a = <div className={`p-${x}`}/>;');
  const out = run(['--root', path.join(root, 'notw'), '--tailwind']);
  assert.match(out, /does not appear to use Tailwind/, out.slice(0, 200));
  assert.ok(!/dynamic Tailwind class/.test(out), 'reported findings anyway: ' + out);
});

ok('a fragment is a bug if ANY value it takes is uncovered, not only if all are', () => {
  // the real case: a StatCard given five colours, four spelled out elsewhere and one not.
  // Asking "does any bg-*-50 exist" called this safe and hid a genuinely broken card.
  w('vals/package.json', JSON.stringify({ name: 'v', dependencies: { tailwindcss: '^4' } }));
  w('vals/Card.jsx', 'export const Card = ({ color }) => <div className={`bg-${color}-50 p-3`}/>;');
  w('vals/Page.jsx', 'export default () => (<><Card color="blue"/><Card color="red"/><Card color="orange"/>' +
    '<i className="bg-blue-50"/><i className="bg-red-50"/></>);');
  const hits = W.scanTailwind(path.join(root, 'vals'));
  assert.strictEqual(hits.length, 1, JSON.stringify(hits));
  assert.deepStrictEqual(hits[0].missing, ['bg-orange-50'],
    'only orange is uncovered: ' + JSON.stringify(hits[0]));
  assert.ok(hits[0].resolved.includes('bg-blue-50'), 'all values resolved, not just the broken one');
});

ok('prop values come from the owning component only, not any component with that prop name', () => {
  w('scope/package.json', JSON.stringify({ name: 's', dependencies: { tailwindcss: '^4' } }));
  w('scope/Card.jsx', 'export const Card = ({ color }) => <div className={`bg-${color}-50`}/>;');
  w('scope/Chart.jsx', [
    'export const A = () => <Legend color="#ff0000"/>;',
    'export const B = () => <Svg color="currentColor"/>;',
    'export const C = () => <Box color="primary"/>;',
  ].join('\n'));
  w('scope/Page.jsx', 'export default () => (<><Card color="blue"/><i className="bg-blue-50"/></>);');
  const hits = W.scanTailwind(path.join(root, 'scope'));
  assert.deepStrictEqual(hits, [],
    'unrelated components polluted the values: ' + JSON.stringify(hits.map((h) => h.missing)));
});
ok('a call site with JSX inside an attribute is still read fully', () => {
  // icon={<Database className="w-6 h-6" />} closes a naive [^>]* match early, so every
  // prop after it was invisible and a genuinely broken colour was missed
  w('jsx/package.json', JSON.stringify({ name: 'j', dependencies: { tailwindcss: '^4' } }));
  w('jsx/Card.jsx', 'export const Card = ({ color }) => <div className={`bg-${color}-50`}/>;');
  w('jsx/Page.jsx', [
    'export default () => (<>',
    '  <Card',
    '    title="Database"',
    '    icon={<Database className="w-6 h-6" />}',
    '    color="orange"',
    '  />',
    '  <Card color="blue"/>',
    '  <i className="bg-blue-50"/>',
    '</>);',
  ].join('\n'));
  const hits = W.scanTailwind(path.join(root, 'jsx'));
  assert.strictEqual(hits.length, 1, JSON.stringify(hits));
  assert.ok(hits[0].resolved.includes('bg-orange-50'), 'the prop after the nested JSX was not read');
  assert.deepStrictEqual(hits[0].missing, ['bg-orange-50']);
});

// ---------- the 10 defects an adversarial pass found in --tailwind ----------
// Each was confirmed against a real tailwindcss build before being fixed.
const twFix = (dir, files) => {
  w(dir + '/package.json', JSON.stringify({ name: 'x', dependencies: { tailwindcss: '^4' } }));
  for (const [f, c] of Object.entries(files)) w(dir + '/' + f, c);
  return W.scanTailwind(path.join(root, dir));
};

ok('FP-1 a ternary condition operand is not a class value', () => {
  const h = twFix('fp1', {
    'Badge.jsx': 'export function Badge({ variant }) {\n  return <span className={`bg-${variant === "primary" ? "blue" : "gray"}-500`}/>;\n}',
    'App.jsx': 'export default () => <div className="bg-blue-500 bg-gray-500"><Badge variant="primary"/></div>;',
  });
  assert.deepStrictEqual(h, [], 'invented bg-primary-500 from the comparison: ' + JSON.stringify(h));
});
ok('FP-2 a nested JSX attribute is not the outer component prop', () => {
  const h = twFix('fp2', {
    'Card.jsx': 'export function Card({ color, icon }) { return <div className={`bg-${color}-50`}>{icon}</div>; }',
    'App.jsx': 'import { Card } from "./Card";\nexport default () => <div className="bg-red-50"><Card color="red" icon={<Icon color="currentColor"/>}/></div>;',
  });
  assert.deepStrictEqual(h, [], 'took the child icon prop as a colour: ' + JSON.stringify(h));
});
ok('FP-3 two components with the same name are not merged', () => {
  const h = twFix('fp3', {
    'web/Alert.jsx': 'export function Alert({ tone }) { return <div className={`bg-${tone}-100`}/>; }',
    'web/Page.jsx': 'import { Alert } from "./Alert";\nexport default () => <div className="bg-red-100"><Alert tone="red"/></div>;',
    'admin/Alert.jsx': 'const L = { critical: "border-red-600" };\nexport function Alert({ tone }) { return <div className={L[tone]}/>; }',
    'admin/Console.jsx': 'import { Alert } from "./Alert";\nexport default () => <Alert tone="critical"/>;',
  });
  assert.deepStrictEqual(h, [], 'merged the admin Alert tone into the web one: ' + JSON.stringify(h));
});
ok('FP-4 a class spelled out in a non-JS file still counts', () => {
  const h = twFix('fp4', {
    'Card.jsx': 'export function Card({ color }) { return <div className={`bg-${color}-50`}/>; }',
    'App.jsx': 'export default () => <Card color="orange"/>;',
    'legacy.py': 'BADGE = "bg-orange-50 text-orange-800"',
  });
  assert.deepStrictEqual(h, [], 'Tailwind scans .py too: ' + JSON.stringify(h));
});
ok('FP-5 @source inline() safelisting counts as generated', () => {
  const h = twFix('fp5', {
    'Card.jsx': 'export function Card({ color }) { return <div className={`bg-${color}-50`}/>; }',
    'App.jsx': 'export default () => <Card color="orange"/>;',
    'in.css': '@import "tailwindcss";\n@source inline("bg-orange-50");',
  });
  assert.deepStrictEqual(h, [], 'safelisted class treated as missing: ' + JSON.stringify(h));
});
ok('FN-1 a multi-segment root is recognised', () => {
  const h = twFix('fn1', {
    'Text.jsx': 'export function Text({ shade }) {\n  return <p className={`text-gray-${shade} border-t-${shade} bg-red-${shade}`}/>;\n}\nexport const U = () => <Text shade="700"/>;',
  });
  assert.strictEqual(h.length, 3, 'text-gray-${n} class of fragments was dropped: ' + JSON.stringify(h));
});
ok('FN-2 spread props, default params and renamed imports are all handled', () => {
  const spread = twFix('fn2a', {
    'Card.jsx': 'export function Card({ color }) { return <div className={`bg-${color}-50`}/>; }',
    'App.jsx': 'import { Card } from "./Card";\nexport default () => <div className="bg-red-50"><Card {...{ color: "orange" }}/></div>;',
  });
  assert.strictEqual(spread.length, 1, 'a spread prop cannot be proven safe: ' + JSON.stringify(spread));
  const dflt = twFix('fn2b', {
    'Card.jsx': 'export function Card({ color = "orange" }) { return <div className={`bg-${color}-50`}/>; }',
    'App.jsx': 'import { Card } from "./Card";\nexport default () => <div className="bg-red-50"><Card color="red"/><Card/></div>;',
  });
  assert.strictEqual(dflt.length, 1, 'the default value orange was missed: ' + JSON.stringify(dflt));
  const alias = twFix('fn2c', {
    'Card.jsx': 'export function Card({ color }) { return <div className={`bg-${color}-50`}/>; }',
    'App.jsx': 'import { Card as Tile } from "./Card";\nexport default () => <div className="bg-red-50"><Tile color="orange"/></div>;',
  });
  assert.strictEqual(alias.length, 1, 'the renamed import was not followed: ' + JSON.stringify(alias));
});
ok('FN-3 a partly readable set of values is not treated as complete', () => {
  const h = twFix('fn3', {
    'Card.jsx': 'export function Card({ color }) { return <div className={`bg-${color}-50`}/>; }',
    'App.jsx': 'import { Card } from "./Card";\nconst T = ["orange"];\nexport default () => <div className="bg-red-50"><Card color="red"/>{T.map(t => <Card color={t}/>)}</div>;',
  });
  assert.strictEqual(h.length, 1, 'color={t} was unreadable, so this is not provably safe: ' + JSON.stringify(h));
});
ok('FN-4 the template need not sit directly after className=', () => {
  for (const [name, code] of [
    ['arg', 'export const C = ({ color }) => <div className={cn("rounded", `bg-${color}-50`)}/>;'],
    ['ternary', 'export const C = ({ color, big }) => <div className={big ? `bg-${color}-50` : "p-1"}/>;'],
  ]) {
    const h = twFix('fn4' + name, { 'C.jsx': code + '\nexport default () => <C color="orange"/>;' });
    assert.strictEqual(h.length, 1, name + ' was invisible: ' + JSON.stringify(h));
  }
});
ok('FN-5 an interpolation at the start is judged by what it produces', () => {
  const h = twFix('fn5', {
    'Box.jsx': 'export const Box = ({ side }) => <div className={`${side}-4`}/>;\nexport default () => <Box side="mt"/>;',
  });
  assert.strictEqual(h.length, 1, 'mt-4 is never generated: ' + JSON.stringify(h));
});
ok('a template literal outside a class position is left alone', () => {
  // `items[${i}]: must be an object` is an error message, and "items" is a real
  // Tailwind root (items-center). Scanning every template made these false positives.
  const h = twFix('ctx', {
    'validate.js': 'export function check(i) {\n  throw new Error(`items[${i}]: must be an object`);\n}',
  });
  assert.deepStrictEqual(h, [], 'flagged an error message: ' + JSON.stringify(h));
});

// ---------- the 10 defects a SECOND adversarial pass found ----------
ok('R2-1 a class-object argument does not hide the template after it', () => {
  const h = twFix('r1', {
    'Badge.jsx': 'export function Badge({ color, active }) {\n  return <span className={clsx("px-2", { "font-bold": active }, `bg-${color}-500`)}/>;\n}',
    'App.jsx': 'export default () => <Badge color="orange"/>;',
  });
  assert.strictEqual(h.length, 1, 'the most common clsx form was invisible: ' + JSON.stringify(h));
});
ok('R2-3 a sibling attribute is not judged as a class', () => {
  const h = twFix('r3', {
    'Panel.jsx': 'export function Panel({ id, sort }) {\n  return <section className="p-4" id={`content-${id}`} data-sort={`order-${sort}`}/>;\n}',
  });
  assert.deepStrictEqual(h, [], 'an html id was reported as a class: ' + JSON.stringify(h));
});
ok('R2-2 utility families beyond the first segment are known', () => {
  const h = twFix('r2', {
    'L.jsx': 'export function L({ side, pe }) {\n  return <div><span className={`float-${side}`}/><span className={`pointer-events-${pe}`}/></div>;\n}',
  });
  assert.strictEqual(h.length, 2, 'float-* and pointer-events-* were dropped silently: ' + JSON.stringify(h));
});
ok('R2-4 member expressions, renamed destructuring, createElement and ?? are all handled', () => {
  const member = twFix('r4a', {
    'Card.jsx': 'export function Card({ color = "blue" }) { return <div className={`bg-${color}-500`}/>; }',
    'App.jsx': 'import * as UI from "./Card";\nexport default () => <div className="bg-blue-500"><UI.Card color="orange"/></div>;',
  });
  assert.strictEqual(member.length, 1, '<UI.Card> call site missed: ' + JSON.stringify(member));
  const renamed = twFix('r4b', {
    'Card.jsx': 'export function Card({ color: c = "blue" }) { return <div className={`bg-${c}-500`}/>; }',
    'App.jsx': 'import { Card } from "./Card";\nexport default () => <div className="bg-blue-500"><Card color="orange"/></div>;',
  });
  assert.strictEqual(renamed.length, 1, '{ color: c } rename not followed: ' + JSON.stringify(renamed));
  const nullish = twFix('r4d', {
    'Card.jsx': 'export function Card(props) { return <div className={`bg-${props.color ?? "blue"}-500`}/>; }',
    'App.jsx': 'import { Card } from "./Card";\nexport default () => <div className="bg-blue-500"><Card color="orange"/></div>;',
  });
  assert.strictEqual(nullish.length, 1, 'a ?? fallback is not the complete value set: ' + JSON.stringify(nullish));
});
ok('R2-6 a class built one statement earlier is still found', () => {
  const h = twFix('r6', {
    'Alert.jsx': 'export function Alert({ tone }) {\n  const ring = `ring-${tone}-400`;\n  return <div className={ring}/>;\n}',
    'styles.js': 'export const toneClass = (t) => `bg-${t}-500`;',
    'App.jsx': 'import { toneClass } from "./styles";\nexport default () => <><Alert tone="orange"/><div className={toneClass("orange")}/></>;',
  });
  assert.strictEqual(h.length, 2, 'a template assigned to a variable, and a cross-file helper: ' + JSON.stringify(h));
});
ok('R2-7 a default belongs to its own component', () => {
  const h = twFix('r7', {
    'Badges.jsx': 'export function Card({ color }) { return <div className={`bg-${color}-500`}/>; }\n\nexport function Spacer({ color = "chartreuse" }) { return <hr/>; }',
    'App.jsx': 'export default () => <div className="bg-blue-500"><Card color="blue"/></div>;',
  });
  assert.deepStrictEqual(h, [], 'took the next component default: ' + JSON.stringify(h));
});
ok('R2-8 string method arguments are not class values', () => {
  const h = twFix('r8', {
    'Card.jsx': 'export function Card({ token }) { return <div className={`bg-${token.replace("_", "-")}-500`}/>; }',
  });
  assert.strictEqual(h.length, 1, JSON.stringify(h));
  assert.strictEqual(h[0].resolved, null, 'invented bg-_-500 from a separator: ' + JSON.stringify(h[0]));
});
ok('R2-9 @source not inline() removes a class again', () => {
  const h = twFix('r9', {
    'Card.jsx': 'export function Card({ color }) { return <div className={`bg-${color}-500`}/>; }',
    'App.jsx': 'export default () => <Card color="orange"/>;',
    'app.css': '@import "tailwindcss";\n@source inline("bg-{red,orange}-500");\n@source not inline("bg-orange-500");',
  });
  assert.strictEqual(h.length, 1, 'a de-safelisted class still counted as generated: ' + JSON.stringify(h));
});
ok('R2-5 text outside the content scope does not prove coverage', () => {
  const scoped = twFix('r5a', {
    'src/app.css': '@import "tailwindcss" source("./src");',
    'src/Card.jsx': 'export function Card({ color }) { return <div className={`bg-${color}-500`}/>; }',
    'src/App.jsx': 'export default () => <Card color="orange"/>;',
    'scripts/seed.py': 'PALETTE = "bg-orange-500"',
  });
  assert.strictEqual(scoped.length, 1, 'counted a file outside source(): ' + JSON.stringify(scoped));
  const ignored = twFix('r5b', {
    '.gitignore': 'storybook-static/',
    'src/Card.jsx': 'export function Card({ color }) { return <div className={`bg-${color}-500`}/>; }',
    'src/App.jsx': 'export default () => <Card color="orange"/>;',
    'storybook-static/index.html': '<div class="bg-orange-500"></div>',
  });
  assert.strictEqual(ignored.length, 1, 'counted a gitignored build artifact: ' + JSON.stringify(ignored));
});
ok('R2-10 two fragments on one line are two findings', () => {
  const h = twFix('r10', {
    'Card.jsx': 'export function Card({ a, b }) { return <div className={`bg-${a}-500 bg-${b}-700`}/>; }',
  });
  assert.strictEqual(h.length, 2, 'the second fragment was deduped away: ' + JSON.stringify(h));
});

fs.rmSync(root, { recursive: true, force: true });
console.log('ok — ' + n + ' edge cases, all previously shipped bugs');
