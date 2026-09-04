'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildIndex, scanTailwind, scanVars, cssRuleSpans, planRename, planExtract, applyExtract } = require('./whouses');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whouses-'));
const w = (p, c) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), c); return path.join(root, p); };

w('styles/app.css', `
/* .commented-out { color: red } */
.btn { padding: 4px }
.btn-primary, .btn-danger { color: #fff }
@media (min-width: 700px) { .btn { padding: 8px } }
.card:not(.card--flat) { border: 1px solid }
.nobody-uses-me { display: none }
a[href=".pdf"] { color: blue }
`);
w('styles/Widget.module.css', `.wrapTight { gap: 2px }\n.legacy-name { gap: 4px }`);

w('src/Button.jsx', `export const B = () => <button className="btn btn-primary">go</button>;`);
w('src/Card.tsx', `const cls = \`card \${flat ? 'card--flat' : ''}\`;\nconst v = \`btn-\${kind}\`;`);
w('src/Widget.tsx', `import s from './Widget.module.css';\nexport default () => <div className={s.wrapTight}><i className={s.legacyName}/></div>;`);
w('src/legacy.js', `document.querySelector('.btn-danger').remove();`);
w('src/Note.vue', `<template><p :class="{ card: true }">hi</p></template>`);
w('src/prose.md', `The card game is fun.`);

const ix = buildIndex(root);
const files = (n) => new Set((ix.uses[n] || []).map((u) => path.relative(root, u.file))).size;
const kinds = (n) => (ix.uses[n] || []).map((u) => u.kind);
const at = (n) => (ix.uses[n] || []).map((u) => path.relative(root, u.file) + ':' + u.line).sort();

// definitions
assert.ok(ix.defs['btn'], 'plain class defined');
assert.ok(ix.defs['btn-danger'], 'comma-separated selector');
assert.ok(ix.defs['card--flat'], 'class inside :not()');
assert.strictEqual(ix.defs['btn'].length, 2, 'media-query duplicate counted twice');
assert.ok(!ix.defs['commented-out'], 'commented rule ignored');
assert.ok(!ix.defs['pdf'], 'attribute-selector string ignored');

// static usage in JSX
assert.deepStrictEqual(at('btn-primary'), ['src/Button.jsx:1', 'src/Card.tsx:2']);
assert.ok(kinds('btn-primary').includes('static'));

// querySelector string
assert.ok(at('btn-danger').includes('src/legacy.js:1'), 'querySelector string counted');

// template literal: complete token static, interpolated token dynamic
assert.ok(kinds('card--flat').includes('static'), 'quoted token inside template is static');
// `btn-${kind}` flags every .btn-* class as a dynamic candidate
const fromCard = (n) => (ix.uses[n] || []).filter((u) => u.file.endsWith('Card.tsx'));
assert.deepStrictEqual(fromCard('btn-primary').map((u) => u.kind), ['dynamic']);
assert.deepStrictEqual(fromCard('btn-danger').map((u) => u.kind), ['dynamic']);
assert.strictEqual(fromCard('btn').length, 0, 'prefix must be strictly longer, .btn itself not flagged');
assert.deepStrictEqual(fromCard('card').map((u) => u.kind + ':' + u.line), ['static:1'],
  '.card is a static hit on line 1 only, never flagged by the btn- prefix on line 2');

// css modules, incl. camelCase remap of a kebab class
assert.deepStrictEqual(at('wrapTight'), ['src/Widget.tsx:2']);
assert.deepStrictEqual(at('legacy-name'), ['src/Widget.tsx:2'], 'styles.legacyName maps back to .legacy-name');

// vue object syntax
assert.ok((ix.uses['card'] || []).some((u) => u.file.endsWith('Note.vue')), 'vue :class object key');

// prose must NOT count as usage
assert.ok(!(ix.uses['card'] || []).some((u) => u.file.endsWith('prose.md')), 'markdown prose is not a usage');

// orphans
assert.ok(!ix.uses['nobody-uses-me'], 'orphan detected');

// ---- Tailwind: flag fragments, never flag whole class names ----
w('src/Tw.jsx', [
  'const A = () => <div className={`bg-${color}-100 p-4`}/>;',           // BROKEN: fragment
  "const B = () => <div className={`p-4 ${big ? 'text-lg' : 'text-sm'}`}/>;", // FINE: whole classes
  'const C = () => <div className={`grid-cols-${n} gap-4`}/>;',          // BROKEN: fragment
  'const D = () => <div className="bg-red-100 p-4"/>;',                  // FINE: no interpolation
  'const E = () => <div className={`${cls} rounded`}/>;',                // FINE: nothing to judge
].join('\n'));
const tw = scanTailwind(root).filter((h) => h.file.endsWith('Tw.jsx'));
assert.deepStrictEqual(tw.map((h) => h.line), [1, 3], 'only the two real bugs, lines 1 and 3');
assert.deepStrictEqual(tw.map((h) => h.fragment), ['bg-', 'grid-cols-'], 'multi-word prefixes survive');

// ---- CSS custom properties, traced across CSS *and* JS ----
w('src/tok.css', ':root { --brand: #4f46e5; --dead: red }\n.x { color: var(--brand) }');
w('src/use.js', "const o = { color: 'var(--brand)' };");
const v = scanVars(root);
assert.strictEqual(v.defs['--brand'].length, 1, 'variable defined once');
assert.strictEqual(new Set(v.uses['--brand'].map((u) => u.file)).size, 2, 'used from both CSS and JS');
assert.ok(!v.uses['--dead'], 'unused variable has no users');
// a custom property is just as often defined from JS as from CSS
w('src/jsdef.tsx', [
  'const A = () => <div style={{ ["--s" as string]: "calc(100vw / 1440)" }}/>;',
  'const poppins = { variable: "--font-poppins" };',
  'el.style.setProperty("--live", x);',
  'const use = `calc(var(--s) * 2)`;',
].join('\n'));
w('src/theme.css', '@theme inline {\n  --color-bg: var(--raw);\n  --font-sans: var(--font-poppins);\n}\n:root { --raw: #000 }');
const v2 = scanVars(root);
assert.ok(v2.defs['--s'], 'inline style object key is a definition');
assert.ok(v2.defs['--font-poppins'], 'next/font variable is a definition');
assert.ok(v2.defs['--live'], 'setProperty is a definition');
assert.ok(v2.theme.has('--color-bg') && v2.theme.has('--font-sans'), '@theme names collected');
assert.ok(!v2.theme.has('--raw'), 'a :root name outside @theme is not a theme token');
assert.ok(v2.uses['--s'].length, 'var(--s) still counted as a use');

// ---- rule spans: a changed line must map to the rule that owns it ----
const spanFile = w('src/span.css', [
  '.one { color: red }',            // 1
  '.two {',                         // 2
  '  color: blue;',                 // 3
  '}',                              // 4
  '@media (min-width: 700px) {',    // 5
  '  .three { color: green }',      // 6
  '}',                              // 7
].join('\n'));
const spans = cssRuleSpans(spanFile);
const span = (c) => spans.find((s2) => s2.classes.includes(c));
assert.deepStrictEqual([span('one').start, span('one').end], [1, 1]);
assert.deepStrictEqual([span('two').start, span('two').end], [2, 4], 'multi-line rule covers all its lines');
assert.deepStrictEqual([span('three').start, span('three').end], [6, 6], 'rule nested in @media found');
assert.ok(!spans.some((s2) => /^@media/.test(s2.selector)), 'the @media prelude is not itself a rule');

// ---- rename: static sites rewritten, dynamic sites refused ----
w('src/ren.css', '.old-name { color: red }\n.old-name-extra { color: blue }');
w('src/Static.jsx', '<i className="old-name"/>');
w('src/Dyn.jsx', 'const c = `old-${part}`;');
const ix3 = buildIndex(root);
const plan = planRename(ix3, 'old-name', 'new-name');
const edited = plan.previews.filter((p) => !p.write);
assert.ok(edited.some((e) => e.file.endsWith('ren.css')), 'the definition is rewritten');
assert.ok(edited.some((e) => e.file.endsWith('Static.jsx')), 'the static call site is rewritten');
assert.ok(edited.every((e) => !/old-name-extra/.test(e.after)),
  'a longer class sharing the prefix is never touched: ' + JSON.stringify(edited.map((e) => e.after)));
assert.ok(plan.blocked.some((b) => b.file.endsWith('Dyn.jsx')), 'the runtime-built site is blocked, not rewritten');
assert.ok(plan.previews.filter((p) => p.write).every((p) => !p.file.endsWith('Dyn.jsx')),
  'no file content is ever produced for a blocked site');

// ---- extract: move only what is exclusively this component's ----
const gpath = w('ex/global.css', [
  '.shared { padding: 8px }',
  '.mine { position: fixed }',
  '.mine-title {',
  '  font-size: 20px;',
  '}',
  '.overridden { color: red }',
  '@media (max-width: 600px) {',
  '  .overridden { color: blue }',
  '}',
].join('\n'));
w('ex/Mine.jsx', '<div className="mine mine-title shared overridden"/>');
w('ex/Other.jsx', '<div className="shared"/>');
const ix4 = buildIndex(path.join(root, 'ex'));
const plan4 = planExtract(ix4, path.join(root, 'ex/Mine.jsx'));
const moved = plan4.move.map((m) => m.classes.join('+')).sort();
const stayed = plan4.stay.map((s2) => s2.classes.join('+') + ' :: ' + s2.why);
assert.deepStrictEqual(moved, ['mine', 'mine-title'], 'only exclusive top-level rules move: ' + moved);
assert.ok(stayed.some((x) => x.startsWith('shared') && /shared with/.test(x)), 'shared rule stays: ' + stayed);
assert.ok(stayed.some((x) => x.startsWith('overridden') && /import order/.test(x)),
  'a class with an @media override is never split across files: ' + stayed);

const outPath = path.join(root, 'ex/Mine.css');
applyExtract(plan4, outPath);
const produced = fs.readFileSync(outPath, 'utf8');
const remaining = fs.readFileSync(gpath, 'utf8');
assert.ok(produced.includes('font-size: 20px;'), 'multi-line rule moved whole');
assert.ok(/\.mine \{/.test(produced) && /\.mine-title \{/.test(produced));
assert.ok(!/\.mine\b/.test(remaining.replace(/\.mine-title/g, '')), 'moved rules removed from the origin');
assert.ok(remaining.includes('.shared { padding: 8px }'), 'shared rule untouched in the origin');
assert.ok(remaining.includes('@media (max-width: 600px)') && remaining.includes('.overridden { color: red }'),
  'the overridden class and its at-rule both stay together');
const braces = (t) => [...t].filter((c) => c === '{').length === [...t].filter((c) => c === '}').length;
assert.ok(braces(produced) && braces(remaining), 'both files still have balanced braces');

// ---- CSS inside <style> blocks: plain HTML, and every Vue/Svelte/Astro component ----
w('sfc/Card.vue', [
  '<template>',
  '  <div class="sfc-card"><b class="sfc-title">hi</b></div>',
  '</template>',
  '<style scoped>',
  '.sfc-card { padding: 4px }',
  '.sfc-title { font-weight: 700 }',
  '.sfc-dead { color: red }',
  '</style>',
].join('\n'));
w('sfc/page.html', [
  '<style>',
  '  .page-hero { height: 40px }',
  '</style>',
  '<div class="page-hero">x</div>',
].join('\n'));
const ix5 = buildIndex(path.join(root, 'sfc'));
assert.ok(ix5.defs['sfc-card'], 'class defined inside a Vue <style> block is found');
assert.strictEqual(ix5.defs['sfc-card'][0].line, 5, 'line number is the real line in the .vue file');
assert.ok(ix5.defs['page-hero'], 'class defined inside an HTML <style> block is found');
assert.strictEqual(ix5.defs['page-hero'][0].line, 2);
assert.ok((ix5.uses['sfc-card'] || []).length, 'the template markup counts as a usage');
assert.ok(!ix5.uses['sfc-dead'], 'unused class in a <style> block is still an orphan');
assert.ok(!ix5.defs['template'] && !ix5.defs['div'], 'markup outside <style> is never parsed as CSS');

fs.rmSync(root, { recursive: true, force: true });
console.log('ok — all checks passed');
