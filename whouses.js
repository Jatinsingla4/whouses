#!/usr/bin/env node
'use strict';
// whouses — reverse index for CSS. "I want to change this class. Who breaks?"
const fs = require('fs');
const path = require('path');

// build output and vendored trees are not your source. An Electron project here shipped
// a 9.8MB LICENSES.chromium.html under release/, which was read twice and dominated
// both the runtime and the memory of every command.
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
  '.svelte-kit', 'coverage', '.cache', 'vendor', '__pycache__', '.turbo', 'release',
  'target', '.output', '.vercel', '.netlify', '.parcel-cache', 'bower_components',
  'Pods', '.venv', 'venv', '.gradle', 'vendor.bundle', '.terraform']);
// CSS also lives inside <style> blocks: plain HTML pages, and every Vue/Svelte/Astro component
const HTML_EXT = new Set(['.html', '.htm', '.vue', '.svelte', '.astro']);
const onlyStyleBlocks = (src) => {
  let out = blank(src);                       // same length, same newlines — line numbers survive
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(src))) {
    const at = m.index + m[0].indexOf(m[1]);
    out = out.slice(0, at) + m[1] + out.slice(at + m[1].length);
  }
  return out;
};
const CSS_EXT = new Set(['.css', '.scss', '.sass', '.less', '.styl', '.pcss', '.tcss']);
const SRC_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte',
  '.astro', '.html', '.htm', '.hbs', '.ejs', '.erb', '.php', '.twig', '.mdx', '.md']);

// ponytail: heuristic scanner, not a parser. Reports file:line so a human verifies.
// Upgrade path: swap parseCss for postcss + parseSrc for babel/ts-morph if false
// positives ever actually cost you more than reading a line of output.

const blank = (m) => m.replace(/[^\n]/g, ' ');           // keep line numbers stable
const camel = (s) => s.replace(/-+([a-z0-9])/gi, (_, c) => c.toUpperCase());
const lineOffsets = (s) => { const o = [0]; for (let i = 0; i < s.length; i++) if (s[i] === '\n') o.push(i + 1); return o; };
const lineAt = (o, i) => { let lo = 0, hi = o.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; o[m] <= i ? lo = m : hi = m - 1; } return lo + 1; };

// a 10MB stylesheet lexes in about a second, so the old 2MB cap was silently skipping
// files the tool handles fine. Anything past this is reported, never skipped in silence.
const MAX_BYTES = 32 * 1024 * 1024;
const skipped = [];
function read(file) {
  try {
    if (fs.statSync(file).size > MAX_BYTES) { skipped.push(file + ' (too large)'); return null; }
    const s = fs.readFileSync(file, 'utf8');
    if (s.includes('\u0000')) { skipped.push(file + ' (binary)'); return null; }
    return s;
  } catch (e) { skipped.push(file + ' (' + e.code + ')'); return null; }
}

function* walk(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}

// ---------- CSS side: where is each class DEFINED ----------
// A regex pipeline cannot survive `content: "/*"`, `url(https://x)`, a `;`-terminated
// at-rule, or nested rules. So walk the stylesheet once, tracking comments, strings and
// url() properly, and record real character offsets — --extract cuts on those, never on
// whole lines (cutting lines destroyed any rule sharing a line with the one being moved).
const CLASS_RE = /\.(-?(?:[_a-zA-Z -￿]|\\.)(?:[-\w -￿]|\\.)*)/g;
const unesc = (s) => s.replace(/\\(.)/g, '$1');

// blank comments, string bodies and url() contents in place — same length, same
// newlines — so brace scanning cannot be fooled by `content: "/*"` or `url(https://x)`
// while every offset still points at the real file.
function sanitizeCss(src, lineComments) {
  const a = src.split('');
  const n = src.length;
  const wipe = (from, to) => { for (let k = from; k < to && k < n; k++) if (a[k] !== '\n') a[k] = ' '; };
  const endString = (start) => {
    const q = src[start];
    let j = start + 1;
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === q) return j + 1;
      j++;
    }
    return j;
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      j = Math.min(j + 2, n); wipe(i, j); i = j; continue;
    }
    if (lineComments && c === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      wipe(i, j); i = j; continue;
    }
    if (c === '"' || c === "'") { const j = endString(i); wipe(i, j); i = j; continue; }
    if ((c === 'u' || c === 'U') && /^url\(/i.test(src.slice(i, i + 4))) {
      let j = i + 4;
      while (j < n && src[j] !== ')') {
        if (src[j] === '"' || src[j] === "'") { j = endString(j); continue; }
        j++;
      }
      j = Math.min(j + 1, n); wipe(i, j); i = j; continue;
    }
    i++;
  }
  return a.join('');
}

function lexCss(src, lineComments) {
  const clean = sanitizeCss(src, lineComments);
  const rules = [], stack = [];
  const n = clean.length;
  let i = 0, bound = 0;
  while (i < n) {
    const c = clean[i];
    // a ';' ends a statement at-rule (@import, @use) and every declaration, so the next
    // selector starts after it — without this the rule after @charset vanished, and a
    // nested selector was attributed to the declaration above it
    if (c === ';') { bound = ++i; continue; }
    if (c === '{') { stack.push({ open: i, sel: clean.slice(bound, i), selStart: bound }); bound = ++i; continue; }
    if (c === '}') {
      const top = stack.pop();
      if (top) {
        const trimmed = top.sel.trim();
        if (trimmed && trimmed[0] !== '@') {
          rules.push({
            selector: trimmed.replace(/\s+/g, ' '), depth: stack.length,
            selStart: top.selStart + (top.sel.length - top.sel.trimStart().length),
            rawSel: top.sel.slice(top.sel.length - top.sel.trimStart().length),
            open: top.open, close: i,
          });
        }
      }
      bound = ++i; continue;
    }
    i++;
  }
  return rules;
}

// tracecss directives sit in front of the selector. The quoted argument is matched to
// its closing quote first, so a message containing ')' cannot eat the rule after it.
const TCSS_DIRECTIVE = /@component\s+[\w-]+\s*;|@(?:deprecated|owner|since)\s*\([^)]*\)|@(?:public|private|internal)\b/g;
const stripDirectives = (src) => {
  const clean = sanitizeCss(src, true);          // messages and comments already blanked here
  const a = src.split('');
  TCSS_DIRECTIVE.lastIndex = 0;
  let m;
  while ((m = TCSS_DIRECTIVE.exec(clean))) {
    for (let k = m.index; k < m.index + m[0].length; k++) if (a[k] !== '\n') a[k] = ' ';
  }
  return a.join('');
};

function cssSource(file) {
  let src = read(file);
  if (src === null) return null;
  const ext = path.extname(file);
  if (HTML_EXT.has(ext)) src = onlyStyleBlocks(src);
  if (ext === '.tcss') src = stripDirectives(src);
  return src;
}

// classes in a selector, with the :global(...) regions that make a name a library's, not yours
function selectorClasses(sel) {
  const globals = [];
  const gp = /:global\s*\(/g;
  let g;
  while ((g = gp.exec(sel))) {
    let depth = 1, i = g.index + g[0].length;
    for (; i < sel.length && depth; i++) { if (sel[i] === '(') depth++; else if (sel[i] === ')') depth--; }
    globals.push([g.index, i]);
  }
  const bare = /:global(?!\s*\()/.exec(sel);
  if (bare) globals.push([bare.index, sel.length]);
  const out = [];
  CLASS_RE.lastIndex = 0;
  let c;
  while ((c = CLASS_RE.exec(sel))) {
    out.push({
      name: unesc(c[1]), raw: c[1], at: c.index + 1,
      external: globals.some(([a, b]) => c.index > a && c.index < b),
    });
  }
  return out;
}

function parseCss(file, defs) {
  const src = cssSource(file);
  if (src === null) return;
  const offs = lineOffsets(src);
  for (const r of lexCss(src, path.extname(file) !== '.css')) {
    for (const c of selectorClasses(r.selector)) {
      (defs[c.name] ||= []).push({ file, line: lineAt(offs, r.selStart), selector: r.selector, external: c.external });
    }
  }
}

function cssRuleSpans(file) {
  const src = cssSource(file);
  if (src === null) return [];
  const offs = lineOffsets(src);
  return lexCss(src, path.extname(file) !== '.css').map((r) => ({
    file, depth: r.depth, selector: r.selector,
    classes: selectorClasses(r.selector).map((c) => c.name),
    start: lineAt(offs, r.selStart), end: lineAt(offs, r.close),
    from: r.selStart, to: r.close + 1,
  }));
}

// ---------- source side: who USES each class ----------
const AGGRESSIVE = /(?::class|v-bind:class|querySelector(?:All)?|getElementsByClassName|classList\.\w+|\.matches)\s*[=(]\s*$/;
// '<' and '>' are deliberately absent: in JSX a '/' after '<' is a closing tag, and
// treating `</p>` as the start of a regex swallowed the rest of the line — including
// the className next to it. No real code writes `a < /re/.test(b)`.
const REGEX_OK = new Set(['', '(', '[', '{', '=', ':', ',', ';', '!', '&', '|', '?', '+', '-', '*', '%', '~', '^', 'return']);

// A regex cannot tell a string from an apostrophe in prose, and getting that wrong
// hides every class after it — the one failure this tool must never have. So walk the
// source once and emit only real string/template literals: comments and regex literals
// are skipped, and ${...} is matched by counting braces rather than by a pattern.
function lexStrings(src) {
  const out = [];
  const n = src.length;
  let i = 0, prev = '';
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '/' && REGEX_OK.has(prev)) {
      let j = i + 1, inClass = false, closed = false;
      for (; j < n; j++) {
        const d = src[j];
        if (d === '\\') { j++; continue; }
        if (d === '\n') break;
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { closed = true; break; }
      }
      if (closed) { i = j + 1; prev = '/'; continue; }
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c, start = ++i;
      let body = '';
      while (i < n) {
        const d = src[i];
        if (d === '\\') { body += '  '; i += 2; continue; }   // 2 chars in, 2 out: offsets stay aligned
        if (q === '`' && d === '$' && src[i + 1] === '{') {
          let depth = 1, j = i + 2;
          while (j < n && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
          body += src.slice(i, j);
          i = j;
          continue;
        }
        if (d === q) { i++; break; }
        if (q !== '`' && d === '\n') break;                   // unterminated: not a real string
        body += d; i++;
      }
      out.push({ quote: q, body, index: start });
      prev = q;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

// split a template body on ${...} by counting braces, so `${pick({a:{b:1}})}` works
function templateParts(s) {
  const parts = [], interps = [];
  let i = 0, last = 0;
  while (i < s.length) {
    if (s[i] === '$' && s[i + 1] === '{') {
      let depth = 1, j = i + 2;
      while (j < s.length && depth) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; j++; }
      parts.push({ text: s.slice(last, i), off: last, pre: last > 0, post: true });
      interps.push({ text: s.slice(i, j), off: i });
      i = j; last = j;
      continue;
    }
    i++;
  }
  parts.push({ text: s.slice(last), off: last, pre: last > 0, post: false });
  return { parts, interps };
}

const tokensAt = (text, base) => {
  const out = [], re = /\S+/g;
  let m;
  while ((m = re.exec(text))) out.push({ t: m[0], at: base + m.index });
  return out;
};

function parseSrc(file, names, uses, camelMap, dyn) {
  const src = read(file);
  if (src === null) return;
  const offs = lineOffsets(src);
  const lines = src.split('\n');
  const seen = new Set();
  const hit = (name, i, kind) => {
    const line = lineAt(offs, i);
    const key = name + ':' + line + ':' + kind;
    if (seen.has(key)) return;
    seen.add(key);
    (uses[name] ||= []).push({ file, line, kind, text: (lines[line - 1] || '').trim().slice(0, 120) });
  };
  const tryToken = (t, i, aggressive) => {
    if (names.has(t)) return hit(t, i, 'static');
    const bare = t.replace(/^[.#]/, '');
    if (aggressive && names.has(bare)) return hit(bare, i, 'static');
  };

  // "it's" is prose, not an open quote. Blanking the apostrophe between two word
  // characters keeps every offset intact and can never hit a real delimiter, which
  // is always preceded by =, (, whitespace or similar.
  const lexable = src.replace(/(\w)'(\w)/g, (_, a, b) => a + ' ' + b);

  for (const s of lexStrings(lexable)) {
    const at0 = s.index;
    const aggressive = AGGRESSIVE.test(src.slice(Math.max(0, at0 - 61), at0 - 1));
    if (s.quote === '`') {
      const { parts, interps } = templateParts(s.body);
      for (const ex of interps) {
        for (const q of lexStrings(ex.text)) {
          if (q.quote === '`') continue;
          for (const tk of tokensAt(q.body, at0 + ex.off + q.index)) tryToken(tk.t, tk.at, aggressive);
        }
      }
      for (const p of parts) {
        const toks = tokensAt(p.text, at0 + p.off);
        toks.forEach((tk, k) => {
          const runsIntoInterp = k === toks.length - 1 && p.post && !/\s$/.test(p.text);
          const runsOutOfInterp = k === 0 && p.pre && !/^\s/.test(p.text);
          // record the fragment once, not one row per class it could match: `u-${k}`
          // against 10k classes used to produce a row per class PER FILE
          const frag = (kind) => {
            const key = kind + ' ' + tk.t;
            const line = lineAt(offs, tk.at);
            if (!dyn.has(key)) dyn.set(key, { kind, frag: tk.t, sites: [] });
            const e = dyn.get(key);
            if (!e.sites.some((x) => x.file === file && x.line === line)) {
              e.sites.push({ file, line, text: (lines[line - 1] || '').trim().slice(0, 120) });
            }
          };
          if (runsIntoInterp && tk.t.length >= 2) frag('prefix');
          else if (runsOutOfInterp && tk.t.length >= 2) frag('suffix');
          else if (!runsIntoInterp && !runsOutOfInterp) tryToken(tk.t, tk.at, aggressive);
        });
      }
    } else {
      for (const tk of tokensAt(s.body, at0)) tryToken(tk.t, tk.at, aggressive);
      if (aggressive) {
        const re = /[\w-]+/g;
        let m;
        while ((m = re.exec(s.body))) tryToken(m[0], at0 + m.index, false);
      }
    }
  }

  // unquoted attribute — valid HTML5 and common in .hbs/.ejs/.erb
  const attr = /\bclass(?:Name)?\s*=\s*([A-Za-z_-][\w-]*)/g;
  let a;
  while ((a = attr.exec(src))) if (names.has(a[1])) hit(a[1], a.index, 'static');

  // CSS-module bindings: styles.fooBar, and destructured off the same import
  const imp = /(?:import\s+(?:\*\s+as\s+)?(\w+)\s+from\s*|import\s*\{\s*default\s+as\s+(\w+)\s*\}\s*from\s*|(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*)['"][^'"]+\.(?:module\.)?(?:css|scss|sass|less|styl)['"]/g;
  let b;
  while ((b = imp.exec(src))) {
    const bind = b[1] || b[2] || b[3];
    const resolve = (ident, at) => {
      const raw = names.has(ident) ? ident : camelMap.get(ident);
      if (raw) hit(raw, at, 'static');
    };
    const use = new RegExp('\\b' + bind + '\\.([A-Za-z_$][\\w$]*)', 'g');
    let u;
    while ((u = use.exec(src))) resolve(u[1], u.index);
    const dest = new RegExp('(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*' + bind + '\\b', 'g');
    let dd;
    while ((dd = dest.exec(src))) {
      for (const piece of dd[1].split(',')) {
        const nm = piece.split(':')[0].trim();
        if (nm) resolve(nm, dd.index);
      }
    }
  }

  // svelte class:foo directive
  const dir = /\bclass:([\w-]+)/g;
  let d;
  while ((d = dir.exec(src))) if (names.has(d[1])) hit(d[1], d.index, 'static');
}

const TW = new Set(('bg text border ring outline fill stroke from via to decoration divide ' +
  'placeholder accent caret shadow p px py pt pr pb pl m mx my mt mr mb ml w h size gap ' +
  'min-w max-w min-h max-h gap-x gap-y space-x space-y grid-cols grid-rows col-span row-span ' +
  'col-start row-start flex basis grow shrink order justify items content self place rounded ' +
  'opacity z top right bottom left inset translate-x translate-y scale rotate skew origin font ' +
  'leading tracking indent align whitespace break columns aspect object overflow cursor select ' +
  'resize snap duration delay ease animate transition blur brightness contrast grayscale ' +
  'saturate sepia backdrop table list underline line max min ' +
  // families the first pass missed entirely, each verified against a real build
  'float clear grid-flow auto-cols auto-rows col-end row-end pointer-events mix-blend ' +
  'bg-blend will-change scroll-m scroll-mx scroll-my scroll-mt scroll-mr scroll-mb scroll-ml ' +
  'scroll-p scroll-px scroll-py scroll-pt scroll-pr scroll-pb scroll-pl border-spacing ' +
  'hue-rotate invert drop-shadow touch appearance caption isolation forced-color-adjust ' +
  'stroke-width outline-offset ring-offset divide-x divide-y text-wrap field-sizing ' +
  'inset-x inset-y start end backdrop-blur backdrop-brightness').split(' '));

// A fragment's utility root. Strips variant prefixes (hover:, md:) and any
// arbitrary-value bracket, then walks back segment by segment, because a root can be
// multi-segment: `text-gray-${n}` has prefix "text-gray-", whose root is "text".
function twHead(frag) {
  let h = frag.split(':').pop().split('[')[0].replace(/-+$/, '');
  while (h) {
    if (TW.has(h)) return h;
    const cut = h.lastIndexOf('-');
    if (cut < 0) return null;
    h = h.slice(0, cut);
  }
  return null;
}


// Does this project use Tailwind at all? Without this, --tailwind reported
// "Tailwind bugs" in projects with no Tailwind, where `p-${x}` is just someone's
// own class naming scheme. Crying wolf is how a tool gets uninstalled.
//
// Resolved per project, not per run: a folder can hold several projects, only some
// of which use Tailwind, and a finding in a non-Tailwind sibling is pure noise.
const TW_CONFIGS = ['tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.mjs', 'tailwind.config.cjs'];
const twScopeCache = new Map();

function dirUsesTailwind(dir) {
  if (TW_CONFIGS.some((f) => fs.existsSync(path.join(dir, f)))) return true;
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;                  // not a project boundary, keep walking
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return Object.keys(deps).some((d) => /tailwind/i.test(d));
  } catch {
    return null;
  }
}

// walk up from a file to its nearest project root and ask whether THAT project uses Tailwind
function tailwindScope(file, root) {
  let dir = path.dirname(path.resolve(file));
  const stop = path.resolve(root);
  const seen = [];
  for (;;) {
    if (twScopeCache.has(dir)) {
      const v = twScopeCache.get(dir);
      for (const d of seen) twScopeCache.set(d, v);
      return v;
    }
    seen.push(dir);
    const verdict = dirUsesTailwind(dir);
    if (verdict !== null) {
      for (const d of seen) twScopeCache.set(d, verdict);
      return verdict;
    }
    const up = path.dirname(dir);
    if (dir === stop || up === dir) break;
    dir = up;
  }
  // no project boundary found at all: unknown, not proven absent. Only exclude a file
  // when its own project demonstrably does not use Tailwind.
  for (const d of seen) twScopeCache.set(d, true);
  return true;
}

function usesTailwind(root, cssFiles) {
  if (dirUsesTailwind(path.resolve(root)) === true) return true;
  return (cssFiles || []).some((f) => /@tailwind\b|@import\s+["']tailwindcss/.test(read(f) || ''));
}


// Tailwind scans every file that is not gitignored, in node_modules, binary, CSS or a
// lock file. Restricting this to SRC_EXT meant a class spelled out in a .py, .json or
// .liquid file looked absent, and every fragment in a Django/Rails/CMS project was
// reported broken.
const NOT_SCANNED = /\.(css|scss|sass|less|styl|pcss|tcss|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|zip|gz|pdf|map)$/i;
const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'composer.lock', 'Gemfile.lock']);

// Tailwind honours `@import "tailwindcss" source("./src")` and skips gitignored paths.
// Counting text outside its real scope proved coverage that the build does not have.
function contentScope(root) {
  const dirs = [];
  for (const f of walk(root)) {
    if (!CSS_EXT.has(path.extname(f))) continue;
    const src = read(f);
    if (src === null) continue;
    for (const m of src.matchAll(/@import\s+["']tailwindcss["']\s+source\(\s*["']([^"']+)["']\s*\)/g)) {
      dirs.push(path.resolve(path.dirname(f), m[1]));
    }
  }
  return dirs;
}

function gitIgnored(root) {
  const out = [];
  try {
    for (let line of fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n')) {
      line = line.trim();
      if (!line || line.startsWith('#') || line.startsWith('!')) continue;
      out.push(path.resolve(root, line.replace(/^\//, '').replace(/\/$/, '')));
    }
  } catch { /* no .gitignore is fine */ }
  return out;
}

function literalClasses(root) {
  const set = new Set();
  const scope = contentScope(root);
  const ignored = gitIgnored(root);
  const inScope = (f) => {
    const r = path.resolve(f);
    if (ignored.some((i) => r === i || r.startsWith(i + path.sep))) return false;
    if (!scope.length) return true;
    return scope.some((d) => r.startsWith(d + path.sep) || r === d);
  };
  for (const f of walk(root)) {
    if (NOT_SCANNED.test(f) || LOCKFILES.has(path.basename(f))) continue;
    if (!inScope(f)) continue;
    const src = read(f);
    if (src === null) continue;
    // permissive on purpose: Tailwind scans plain text, so a token anywhere in the
    // file is enough for it to generate that utility, even in a comment
    for (const t of src.split(/[^\w:/[\]().%-]+/)) {
      if (!t || t.endsWith('-') || t.includes('$')) continue;   // fragments are not classes
      if (t.length > 1) set.add(t);
    }
  }
  for (const c of safelisted(root)) set.add(c);
  return set;
}

// brace expansion, as Tailwind documents for @source inline: {a,b}, {1..9}, {1..9..2}
function expandBraces(pattern) {
  const open = pattern.indexOf('{');
  if (open < 0) return [pattern];
  let depth = 0, close = -1;
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++;
    else if (pattern[i] === '}' && --depth === 0) { close = i; break; }
  }
  if (close < 0) return [pattern];
  const head = pattern.slice(0, open), tail = pattern.slice(close + 1);
  const body = pattern.slice(open + 1, close);
  const opts = [];
  let d = 0, cur = '';
  for (const ch of body) {
    if (ch === '{') d++;
    if (ch === '}') d--;
    if (ch === ',' && d === 0) { opts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  opts.push(cur);
  const out = [];
  for (const opt of opts) {
    const range = /^(-?\d+)\.\.(-?\d+)(?:\.\.(\d+))?$/.exec(opt.trim());
    if (range) {
      const [a, b] = [+range[1], +range[2]];
      const step = Math.abs(+(range[3] || 1)) || 1;
      for (let v = a; a <= b ? v <= b : v >= b; v += a <= b ? step : -step) out.push(String(v));
    } else {
      out.push(...expandBraces(opt));
    }
  }
  return out.flatMap((v) => expandBraces(head + v + tail));
}

// classes Tailwind is told to generate regardless of whether they appear in source
function safelisted(root) {
  const out = [], excluded = [];
  for (const f of walk(root)) {
    if (!CSS_EXT.has(path.extname(f))) continue;
    const src = read(f);
    if (src === null) continue;
    for (const m of src.matchAll(/@source\s+(not\s+)?inline\(\s*["']([^"']+)["']\s*\)/g)) {
      const classes = expandBraces(m[2]);
      if (m[1]) excluded.push(...classes);          // @source not inline() un-generates them
      else out.push(...classes);
    }
  }
  return out.filter((c) => !excluded.includes(c));
}


// ---------- Tailwind: classes the JIT scanner will silently drop ----------
// Tailwind generates a utility only if the COMPLETE class name appears somewhere in
// the project as plain text. `bg-${color}-50` produces a name that is never written
// down, so the element ships unstyled with no error.
//
// Deciding which classes a fragment can produce means knowing what the expression
// evaluates to. That was attempted with regular expressions and failed twenty times
// in ways confirmed against real Tailwind builds: member expressions, renamed
// destructuring, default parameters, spread props, nullish fallbacks, string methods.
// Those are language semantics, so this reads a real syntax tree instead.
const { parse } = require('@babel/parser');

const PARSE_OPTS = {
  sourceType: 'unambiguous',
  errorRecovery: true,
  plugins: ['jsx', 'typescript', 'decorators-legacy', 'classProperties', 'dynamicImport'],
};

function parseFile(src) {
  try { return parse(src, PARSE_OPTS); } catch { return null; }
}

function walkAst(node, visit, parent) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
    const v = node[key];
    if (Array.isArray(v)) { for (const c of v) walkAst(c, visit, node); }
    else if (v && typeof v.type === 'string') walkAst(v, visit, node);
  }
}

const CLASS_ATTRS = new Set(['className', 'class']);
const CLASS_FNS = new Set(['clsx', 'classnames', 'classNames', 'cn', 'cx', 'twMerge', 'cva', 'tv', 'tw']);

// the component a node sits inside, and the props it declares
function componentIndex(ast) {
  const comps = [];
  walkAst(ast, (n) => {
    let name = null, params = null;
    if (n.type === 'FunctionDeclaration' && n.id) { name = n.id.name; params = n.params; }
    else if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' &&
             n.init && /FunctionExpression|ArrowFunctionExpression/.test(n.init.type)) {
      name = n.id.name; params = n.init.params;
    }
    if (name && /^[A-Z]/.test(name)) comps.push({ name, params: params || [], start: n.start, end: n.end });
  });
  return comps;
}

// which local identifier maps to which declared prop, following renames and defaults
function propBindings(params) {
  const map = new Map();        // local name -> { prop, default }
  const first = params[0];
  if (!first) return map;
  if (first.type === 'Identifier') return map;      // (props) => ..., handled as member access
  if (first.type !== 'ObjectPattern') return map;
  for (const p of first.properties) {
    if (p.type !== 'ObjectProperty') continue;
    const prop = p.key.name || p.key.value;
    let target = p.value, dflt = null;
    if (target.type === 'AssignmentPattern') {
      dflt = target.right.type === 'StringLiteral' ? target.right.value : null;
      target = target.left;
    }
    if (target.type === 'Identifier') map.set(target.name, { prop, default: dflt });
  }
  return map;
}

const jsxName = (n) => n.type === 'JSXIdentifier' ? n.name
  : n.type === 'JSXMemberExpression' ? jsxName(n.property) : null;

// every value a prop is given, across every call site of a component
// which local names in this file refer to the component declared in defFile
function importedAs(ast, file, defFile, component) {
  const names = new Set();
  if (path.resolve(file) === path.resolve(defFile)) names.add(component);
  if (!ast) return names;
  walkAst(ast, (n) => {
    if (n.type !== 'ImportDeclaration' || !n.source.value.startsWith('.')) return;
    const base = path.resolve(path.dirname(file), n.source.value);
    const target = path.resolve(defFile);
    const hit = ['', '.jsx', '.tsx', '.js', '.ts', '.mjs', '.vue', '.svelte']
      .some((e) => base + e === target || path.join(base, 'index' + e) === target);
    if (!hit) return;
    for (const sp of n.specifiers) {
      if (sp.type === 'ImportSpecifier' && (sp.imported.name || sp.imported.value) === component) names.add(sp.local.name);
      else if (sp.type === 'ImportDefaultSpecifier' || sp.type === 'ImportNamespaceSpecifier') names.add(sp.local.name);
    }
  });
  return names;
}

const csCache = new Map();
function callSiteValues(files, component, prop, defFile) {
  const key = component + '\u0000' + prop + '\u0000' + (defFile || '');
  if (csCache.has(key)) return csCache.get(key);
  const result = callSiteValuesUncached(files, component, prop, defFile);
  csCache.set(key, result);
  return result;
}

function callSiteValuesUncached(files, component, prop, defFile) {
  const collect = (byImport) => {
    const values = new Set();
    let complete = true, sites = 0;
    for (const entry of files) {
      const { ast, file } = entry;
      if (!ast) continue;
      const names = byImport && defFile ? importedAs(ast, file, defFile, component) : new Set([component]);
      if (!names.size) continue;
      walkAst(ast, (n) => {
        if (n.type === 'JSXOpeningElement' && names.has(jsxName(n.name))) {
          sites++;
          for (const a of n.attributes) {
            if (a.type === 'JSXSpreadAttribute') { complete = false; continue; }
            if (!a.name || a.name.name !== prop) continue;
            const v = a.value;
            if (!v) continue;
            if (v.type === 'StringLiteral') { values.add(v.value); continue; }
            if (v.type === 'JSXExpressionContainer') {
              const r = staticValues(v.expression);
              if (r.complete && r.values.length) for (const x of r.values) values.add(x);
              else complete = false;
            } else complete = false;
          }
          return;
        }
        // React.createElement(Card, { color: 'orange' })
        if (n.type !== 'CallExpression') return;
        const callee = n.callee;
        const isCE = (callee.type === 'Identifier' && callee.name === 'createElement') ||
          (callee.type === 'MemberExpression' && callee.property && callee.property.name === 'createElement');
        if (!isCE || !n.arguments.length) return;
        if (n.arguments[0].type !== 'Identifier' || !names.has(n.arguments[0].name)) return;
        sites++;
        const props = n.arguments[1];
        if (!props || props.type !== 'ObjectExpression') { complete = false; return; }
        for (const pr of props.properties) {
          if (pr.type === 'SpreadElement') { complete = false; continue; }
          if (!pr.key || (pr.key.name || pr.key.value) !== prop) continue;
          const r = staticValues(pr.value);
          if (r.complete && r.values.length) for (const x of r.values) values.add(x);
          else complete = false;
        }
      });
    }
    return { values: [...values], complete, sites };
  };

  const precise = collect(true);
  if (precise.sites) return precise;
  // no resolvable import reached it: barrel export, auto-import, or an untyped fixture.
  // Fall back to the bare name rather than treating the component as never rendered.
  return collect(false);
}

// what can this expression evaluate to, as a set of strings
function staticValues(node) {
  if (!node) return { values: [], complete: false };
  switch (node.type) {
    case 'StringLiteral':
      return { values: [node.value], complete: true };
    case 'NumericLiteral':
      return { values: [String(node.value)], complete: true };
    case 'TemplateLiteral':
      if (!node.expressions.length) return { values: [node.quasis[0].value.cooked], complete: true };
      return { values: [], complete: false };
    case 'ConditionalExpression': {
      const a = staticValues(node.consequent), b = staticValues(node.alternate);
      return { values: [...a.values, ...b.values], complete: a.complete && b.complete };
    }
    case 'LogicalExpression': {
      // `props.color ?? 'blue'` shows only the fallback, the left side is unknown
      const a = staticValues(node.left), b = staticValues(node.right);
      return { values: [...a.values, ...b.values], complete: a.complete && b.complete };
    }
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'ParenthesizedExpression':
      return staticValues(node.expression);
    default:
      return { values: [], complete: false };
  }
}

// the class-carrying expressions in a file: a className attribute's value, and any
// clsx/cn/cva call. A template literal anywhere inside one of these is a class string;
// one outside is an error message or an id, and must not be judged.
function classExpressions(ast) {
  const out = [];
  walkAst(ast, (n) => {
    if (n.type === 'JSXAttribute' && n.name && CLASS_ATTRS.has(jsxName(n.name) || n.name.name) && n.value) {
      out.push(n.value.type === 'JSXExpressionContainer' ? n.value.expression : n.value);
    }
    if (n.type === 'CallExpression') {
      const c = n.callee;
      const name = c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' ? c.property.name : null;
      if (name && CLASS_FNS.has(name)) out.push(...n.arguments);
    }
  });
  return out;
}

// resolve an identifier used as a class value back to what it was assigned
// name -> initialiser, built once for the whole project. Doing this per identifier
// re-walked every AST and made a real project take minutes.
function bindingIndex(files) {
  const local = new Map();     // file -> Map(name -> init)
  for (const { file, ast } of files) {
    if (!ast) continue;
    const m = new Map();
    walkAst(ast, (n) => {
      if (n.type !== 'VariableDeclarator' || n.id.type !== 'Identifier' || !n.init) return;
      if (!m.has(n.id.name)) m.set(n.id.name, n.init);
    });
    local.set(file, m);
  }
  return local;
}

// bindings visible in one file: its own, plus what it explicitly imports. A project-wide
// name map looked tempting and was catastrophic: every identifier resolved to some
// unrelated template somewhere and Billing System went from 2 findings to 68.
function visibleBindings(file, ast, local) {
  const out = new Map(local.get(file) || []);
  if (!ast) return out;
  walkAst(ast, (n) => {
    if (n.type !== 'ImportDeclaration' || !n.source.value.startsWith('.')) return;
    const base = path.resolve(path.dirname(file), n.source.value);
    let from = null;
    for (const e of ['', '.js', '.jsx', '.ts', '.tsx', '.mjs']) {
      for (const cand of [base + e, path.join(base, 'index' + e)]) {
        if (local.has(cand)) { from = local.get(cand); break; }
      }
      if (from) break;
    }
    if (!from) return;
    for (const sp of n.specifiers) {
      const orig = sp.type === 'ImportSpecifier' ? (sp.imported.name || sp.imported.value) : sp.local.name;
      if (from.has(orig)) out.set(sp.local.name, from.get(orig));
    }
  });
  return out;
}

function templatesIn(node, binds, seen = new Set()) {
  const out = [];
  walkAst(node, (n) => {
    if (n.type === 'TemplateLiteral' && n.expressions.length) out.push(n);
    // className={ring} where ring holds the template, or a helper that returns one
    if (n.type === 'Identifier' && !seen.has(n.name)) {
      seen.add(n.name);
      const init = binds.get(n.name);
      if (init) out.push(...templatesIn(init, binds, seen));
    }
  });
  return out;
}

// A single-file component is not JavaScript. Parse only its <script>, keeping every
// offset, so line numbers still point at the real file.
function scriptOf(file, src) {
  if (!HTML_EXT.has(path.extname(file))) return src;
  let out = src.replace(/[^\n]/g, ' ');
  for (const m of src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const at = m.index + m[0].indexOf(m[1]);
    out = out.slice(0, at) + m[1] + out.slice(at + m[1].length);
  }
  return out;
}

function scanTailwind(root) {
  csCache.clear();
  const out = [], covered = [];
  const literals = literalClasses(root);
  let binds = null;

  const files = [];
  for (const f of walk(root)) {
    if (!SRC_EXT.has(path.extname(f))) continue;
    if (!tailwindScope(f, root)) continue;
    const src = read(f);
    if (src === null) continue;
    files.push({ file: f, src, ast: parseFile(scriptOf(f, src)), offs: lineOffsets(src) });
  }

  const judge = (file, offs, tpl, node, ctx) => {
    for (let i = 0; i < tpl.expressions.length; i++) {
      const before = tpl.quasis[i].value.cooked ?? '';
      const after = tpl.quasis[i + 1] ? (tpl.quasis[i + 1].value.cooked ?? '') : '';
      const prefix = (!before || /\s$/.test(before)) ? '' : before.split(/\s+/).pop();
      const suffix = (!after || /^\s/.test(after)) ? '' : after.split(/\s+/)[0];
      if (!prefix && !suffix) continue;                 // `${cls} rounded` is a whole class
      if (prefix && !twHead(prefix)) continue;          // not a Tailwind utility at all

      const expr = tpl.expressions[i];
      let { values, complete } = staticValues(expr);
      let via = 'literal';
      if (!values.length || !complete) {
        const resolved = resolveIdentifier(expr, ctx);
        if (resolved) { values = resolved.values; complete = resolved.complete; via = 'prop'; }
      }
      const line = lineAt(offs, expr.start);
      const entry = { file, line, fragment: prefix, suffix, via,
        expr: '`' + rawTemplate(tpl, ctx.src) + '`' };
      if (out.some((o) => o.file === file && o.line === line && o.fragment === prefix && o.suffix === suffix)) continue;
      if (covered.some((o) => o.file === file && o.line === line && o.fragment === prefix && o.suffix === suffix)) continue;

      if (values.length && complete) {
        const produced = values.map((v) => prefix + v + suffix).filter((c) => twHead(c));
        if (!produced.length) continue;
        const missing = produced.filter((c) => !literals.has(c));
        if (missing.length) out.push({ ...entry, resolved: produced, missing });
        else covered.push({ ...entry, resolved: produced });
      } else if (prefix) {
        // cannot be evaluated, so it cannot be proven safe
        out.push({ ...entry, resolved: null, missing: ['?'] });
      }
      // with no prefix and nothing resolvable there is no evidence this is a class at
      // all: `${v.toFixed(1)}s` is "1.5s" and `${Math.round(v)}ms` is a duration
    }
  };

  // an identifier in a template is usually a prop: find what callers pass for it
  const resolveIdentifier = (expr, ctx) => {
    let local = null;
    if (expr.type === 'Identifier') local = expr.name;
    else if (expr.type === 'MemberExpression' && expr.object.type === 'Identifier' &&
             expr.property.type === 'Identifier' && !expr.computed) local = expr.property.name;
    if (!local || !ctx.component) return null;
    const bound = ctx.bindings.get(local);
    const prop = bound ? bound.prop : local;
    const r = callSiteValues(files, ctx.component.name, prop, ctx.file);
    if (bound && bound.default) r.values.push(bound.default);
    if (!r.sites && !r.values.length) return null;
    return { values: [...new Set(r.values)], complete: r.complete };
  };

  for (const entry of files) {
    const { file, src, ast, offs } = entry;
    // markup attributes in single-file components and plain templates
    if (HTML_EXT.has(path.extname(file)) || /\.(html?|hbs|ejs|erb|php|twig)$/i.test(file)) {
      for (const m of src.matchAll(/\b(?::|v-bind:|\[)?class(?:Name)?\]?\s*=\s*"([^"]*)"/g)) {
        const body = m[1];
        const at = m.index + m[0].indexOf(body);
        if (body.includes('{{')) markupFragments(body, /\{\{[\s\S]*?\}\}/g, file, offs, at, out);
        else if (body.includes('${')) markupFragments(body.replace(/^`|`$/g, ''), /\$\{[^}]*\}/g, file, offs, at, out);
      }
    }
    if (!ast) continue;
    if (!binds) binds = bindingIndex(files);
    const fileBinds = visibleBindings(file, ast, binds);
    const comps = componentIndex(ast);
    for (const clsExpr of classExpressions(ast)) {
      for (const tpl of templatesIn(clsExpr, fileBinds)) {
        const comp = comps.filter((c) => tpl.start >= c.start && tpl.end <= c.end).pop() || null;
        judge(file, offs, tpl, tpl, { src, file, component: comp, bindings: comp ? propBindings(comp.params) : new Map() });
      }
    }
  }
  Object.defineProperty(out, 'covered', { value: covered, enumerable: false });
  return out;
}

const rawTemplate = (tpl, src) => src.slice(tpl.start + 1, tpl.end - 1);

// split a class string on its interpolation syntax
function splitInterp(str, re) {
  const parts = [];
  let last = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(str))) {
    parts.push({ text: str.slice(last, m.index) });
    last = m.index + m[0].length;
  }
  parts.push({ text: str.slice(last) });
  return parts;
}

// markup has no AST here, but the shape is simple: split on the interpolation and take
// the fragment either side. Nothing is resolvable, so it is reported, never called safe.
function markupFragments(body, re, file, offs, at, out) {
  const parts = splitInterp(body, re);
  for (let i = 0; i < parts.length - 1; i++) {
    const before = parts[i].text, after = parts[i + 1] ? parts[i + 1].text : '';
    const prefix = (!before || /\s$/.test(before)) ? '' : before.split(/\s+/).pop();
    const suffix = (!after || /^\s/.test(after)) ? '' : after.split(/\s+/)[0];
    if (!prefix || !twHead(prefix)) continue;
    const line = lineAt(offs, at);
    if (out.some((o) => o.file === file && o.line === line && o.fragment === prefix)) continue;
    out.push({ file, line, fragment: prefix, suffix, via: 'markup', resolved: null, missing: ['?'],
      expr: '"' + body.slice(0, 90) + '"' });
  }
}

// blank JS comments so a commented-out var() is not counted as a live use
function sanitizeJs(src) {
  const a = src.split('');
  const n = src.length;
  const wipe = (f, t) => { for (let k = f; k < t && k < n; k++) if (a[k] !== '\n') a[k] = ' '; };
  let i = 0, prev = '';
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { let j = i; while (j < n && src[j] !== '\n') j++; wipe(i, j); i = j; continue; }
    if (c === '/' && src[i + 1] === '*') { let j = i + 2; while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++; j = Math.min(j + 2, n); wipe(i, j); i = j; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; let j = i + 1;
      while (j < n) { if (src[j] === '\\') { j += 2; continue; } if (src[j] === q) { j++; break; } if (q !== '`' && src[j] === '\n') break; j++; }
      i = j; continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return a.join('');
}

// ---------- CSS custom properties: the one index that works everywhere ----------
function scanVars(root) {
  const defs = Object.create(null), uses = Object.create(null), theme = new Set();
  for (const f of walk(root)) {
    const ext = path.extname(f);
    const isCss = CSS_EXT.has(ext) || HTML_EXT.has(ext);
    if (!isCss && !SRC_EXT.has(ext)) continue;
    const raw = read(f);
    if (raw === null) continue;
    const offs = lineOffsets(raw);
    const src = isCss ? sanitizeCss(HTML_EXT.has(ext) ? onlyStyleBlocks(raw) : raw, ext !== '.css') : sanitizeJs(raw);
    const at = (i) => ({ file: f, line: lineAt(offs, i) });
    let m;
    if (isCss) {
      const prop = /@property\s+(--[\w-]+)/g;      // @property declares a name before its block
      while ((m = prop.exec(src))) (defs[m[1]] ||= []).push(at(m.index));
      const d = /(--[\w-]+)\s*:/g;
      while ((m = d.exec(src))) (defs[m[1]] ||= []).push(at(m.index));
      // Tailwind v4: names declared in @theme are consumed by the framework itself to
      // generate utilities (bg-background, font-sans). They are used, just not via var().
      const t = /@theme[^{]*\{/g;
      while ((m = t.exec(src))) {
        let depth = 1, i = m.index + m[0].length;
        for (; i < src.length && depth; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; }
        for (const v of src.slice(m.index, i).matchAll(/(--[\w-]+)\s*:/g)) theme.add(v[1]);
      }
    } else {
      // a custom property can just as easily be defined from JS
      const inline = /['"](--[\w-]+)['"]\s*(?:as\s+\w+\s*)?\]?\s*:/g;      // style={{ ["--s"]: ... }}
      while ((m = inline.exec(src))) (defs[m[1]] ||= []).push(at(m.index));
      const setp = /setProperty\(\s*['"](--[\w-]+)['"]/g;                    // el.style.setProperty('--s', …)
      while ((m = setp.exec(src))) (defs[m[1]] ||= []).push(at(m.index));
      const font = /variable\s*:\s*['"](--[\w-]+)['"]/g;                     // next/font
      while ((m = font.exec(src))) (defs[m[1]] ||= []).push(at(m.index));
    }
    const u = /var\(\s*(--[\w-]+)/g;
    while ((m = u.exec(src))) (uses[m[1]] ||= []).push(at(m.index));
  }
  return { defs, uses, theme };
}

// ---------- what did I just break? ----------
function changedCssLines(root, base) {
  const { execFileSync } = require('child_process');
  const args = ['-C', root, 'diff', '-U0'];
  if (base) args.push(base);
  args.push('--', '*.css', '*.scss', '*.less', '*.tcss', '*.styl');
  let out;
  try { out = execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { return null; }
  const touched = new Map();
  let file = null;
  for (const line of out.split('\n')) {
    const f = /^\+\+\+ b\/(.+)$/.exec(line);
    if (f) { file = path.join(root, f[1]); touched.set(file, touched.get(file) || new Set()); continue; }
    const h = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && file) {
      const from = +h[1], count = h[2] === undefined ? 1 : +h[2];
      for (let i = from; i < from + count; i++) touched.get(file).add(i);
    }
  }
  return touched;
}

// ---------- rename, without breaking the dynamic call sites ----------
// A whole-file regex replace rewrote JS identifiers, comment prose and image paths —
// `const btn =` became `const btn-primary =`, which does not parse. Only the exact
// offsets of a class in a selector, or of a whole token inside a class string, are
// edited; everything else in the file is left alone.
function renameEdits(ix, file, from) {
  const raw = read(file);
  if (raw === null) return [];
  const out = [];
  const ext = path.extname(file);
  if (CSS_EXT.has(ext) || HTML_EXT.has(ext)) {
    const css = cssSource(file);                       // same length as raw: offsets align
    if (css !== null) {
      for (const r of lexCss(css, ext !== '.css')) {
        for (const c of selectorClasses(r.rawSel)) {
          if (c.name === from) out.push({ at: r.selStart + c.at, len: c.raw.length });
        }
      }
    }
  }
  if (SRC_EXT.has(ext)) {
    const lexable = raw.replace(/(\w)'(\w)/g, (_, x, y) => x + ' ' + y);
    for (const lit of lexStrings(lexable)) {
      const re = /\S+/g;
      let m;
      while ((m = re.exec(lit.body))) {
        if (m[0] === from) out.push({ at: lit.index + m.index, len: from.length });
      }
    }
    const attr = /\bclass(?:Name)?\s*=\s*([A-Za-z_-][\w-]*)/g;
    let a2;
    while ((a2 = attr.exec(raw))) {
      if (a2[1] === from) out.push({ at: a2.index + a2[0].length - a2[1].length, len: from.length });
    }
  }
  return out.sort((x, y) => x.at - y.at).filter((e, k, arr) => k === 0 || e.at !== arr[k - 1].at);
}

function planRename(ix, from, to) {
  const blocked = ix.usedBy(from).filter((u) => u.kind === 'dynamic');
  const files = new Set([
    ...(ix.defs[from] || []).map((d) => d.file),
    ...ix.usedBy(from).filter((u) => u.kind !== 'dynamic').map((u) => u.file),
  ]);
  const previews = [];
  for (const f of files) {
    const raw = read(f);
    if (raw === null) continue;
    const edits = renameEdits(ix, f, from);
    if (!edits.length) continue;
    const offs = lineOffsets(raw);
    const lines = raw.split('\n');
    let next = '', cursor = 0;
    for (const e of edits) { next += raw.slice(cursor, e.at) + to; cursor = e.at + e.len; }
    next += raw.slice(cursor);
    for (const e of edits) {
      const ln = lineAt(offs, e.at);
      const before = (lines[ln - 1] || '').trim();
      previews.push({ file: f, line: ln, before, after: before.replace(new RegExp('(?<![\\w-])' + from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])', 'g'), to) });
    }
    previews.push({ file: f, write: next });
  }
  return { previews, blocked, collision: !!(ix.defs[to] || ix.isUsed(to)) };
}

// ---------- extract: lift a component's own rules out of the monolith ----------
// Only rules whose every class is used by this component ALONE can move. Anything
// shared stays put — silently moving a shared rule is how you break three other pages.
function planExtract(ix, componentFile) {
  const abs = path.resolve(componentFile);
  const mine = ix.usedNames().filter((n) => ix.usedBy(n).some((u) => path.resolve(u.file) === abs));
  const exclusive = new Set(mine.filter((n) =>
    ix.usedBy(n).every((u) => path.resolve(u.file) === abs || CSS_EXT.has(path.extname(u.file)))));
  const move = [], stay = [];
  const sheets = new Set();
  for (const n of mine) for (const d of ix.defs[n] || []) sheets.add(d.file);
  // a class with an @media override must not be split across two files — the cascade
  // would then depend on import order, which is a bug nobody would trace back to us
  const overridden = new Set();
  const sheetsOf = new Map();
  for (const sheet of sheets) for (const span of cssRuleSpans(sheet)) {
    if (span.depth > 0) for (const c of span.classes) overridden.add(c);
    for (const c of span.classes) (sheetsOf.get(c) || sheetsOf.set(c, new Set()).get(c)).add(sheet);
  }
  for (const sheet of sheets) {
    for (const span of cssRuleSpans(sheet)) {
      if (!span.classes.some((c) => mine.includes(c))) continue;
      const why = span.depth > 0 ? 'nested in an at-rule'
        : span.classes.some((c) => (sheetsOf.get(c) || new Set()).size > 1) ? 'defined in more than one stylesheet — moving it would flip the cascade'
        : span.classes.some((c) => overridden.has(c)) ? 'also overridden inside an at-rule — moving it would depend on import order'
        : span.classes.every((c) => exclusive.has(c)) ? null
        : 'shared with ' + [...new Set(span.classes.filter((c) => !exclusive.has(c))
            .flatMap((c) => ix.usedBy(c).map((u) => u.file))
            .filter((f) => path.resolve(f) !== abs && !CSS_EXT.has(path.extname(f))))]
            .map((f) => path.relative(ix.root, f)).join(', ');
      (why ? stay : move).push({ ...span, why });
    }
  }
  return { move, stay, exclusive: [...exclusive].sort() };
}

function applyExtract(plan, outFile) {
  const bySheet = new Map();
  for (const m of plan.move) (bySheet.get(m.file) || bySheet.set(m.file, []).get(m.file)).push(m);
  const chunks = [];
  for (const [sheet, spans] of bySheet) {
    const src = fs.readFileSync(sheet, 'utf8');
    // character offsets, not lines: `.a {} .b {}` on one line must not lose .b, and a
    // rule's closing brace must never be cut away from the rule that keeps it
    let kept = '', cursor = 0;
    for (const s2 of spans.slice().sort((a, b) => a.from - b.from)) {
      chunks.push(src.slice(s2.from, s2.to));
      kept += src.slice(cursor, s2.from);
      cursor = s2.to;
    }
    kept += src.slice(cursor);
    fs.writeFileSync(sheet, kept);
  }
  fs.writeFileSync(outFile, chunks.join('\n') + '\n');
}

function buildIndex(root) {
  const defs = Object.create(null), uses = Object.create(null);
  const cssFiles = [], srcFiles = [];
  for (const f of walk(root)) {
    const e = path.extname(f);
    if (CSS_EXT.has(e)) cssFiles.push(f);
    else if (SRC_EXT.has(e)) { srcFiles.push(f); if (HTML_EXT.has(e)) cssFiles.push(f); }
  }
  for (const f of cssFiles) parseCss(f, defs);
  const names = new Set(Object.keys(defs));
  const sorted = [...names].sort();
  const camelMap = new Map(sorted.map((n) => [camel(n), n]));
  const dyn = new Map();
  for (const f of srcFiles) parseSrc(f, names, uses, camelMap, dyn);

  const matchers = [...dyn.values()].map((d) => ({
    ...d,
    test: d.kind === 'prefix'
      ? (n) => n.length > d.frag.length && n.startsWith(d.frag)
      : (n) => n.length > d.frag.length && n.endsWith(d.frag),
  }));
  const SHOW = 200;                       // display cap only — never affects isUsed
  const cache = new Map();
  const usedBy = (name) => {
    if (cache.has(name)) return cache.get(name);
    const out = (uses[name] || []).slice();
    for (const m of matchers) {
      if (!m.test(name)) continue;
      for (const site of m.sites.slice(0, SHOW)) out.push({ ...site, kind: 'dynamic' });
    }
    cache.set(name, out);
    return out;
  };
  const isUsed = (name) => !!uses[name] || matchers.some((m) => m.test(name));
  const usedNames = () => {
    const out = new Set(Object.keys(uses));
    for (const n of sorted) if (!out.has(n) && matchers.some((m) => m.test(n))) out.add(n);
    return [...out];
  };
  return { defs, uses, usedBy, isUsed, usedNames, matchers, cssFiles, srcFiles, root, skipped };
}

// ---------- reporting ----------
const C = process.stdout.isTTY
  ? { dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m` }
  : new Proxy({}, { get: () => (s) => s });

const rel = (root, f) => path.relative(root, f) || f;

function suggest(ix, name) {
  const all = Object.keys(ix.defs);
  const near = all.filter((n) => n.includes(name) || name.includes(n)).sort((a, b) => a.length - b.length);
  return near.slice(0, 8);
}

function reportClass(ix, name) {
  const defs = ix.defs[name] || [], uses = ix.usedBy(name);
  console.log(C.b('.' + name));
  if (!defs.length) {
    console.log(C.r('  not defined in any stylesheet'));
    const near = suggest(ix, name);
    if (near.length) console.log(C.dim('  did you mean  ') + near.map((n) => '.' + n).join('  '));
  }
  for (const d of defs) console.log(C.dim('  defined  ') + rel(ix.root, d.file) + ':' + d.line + C.dim('  ' + d.selector));
  if (!uses.length) { console.log(C.y('  used by  nobody — orphan, safe to delete')); return; }
  const byFile = new Map();
  for (const u of uses) (byFile.get(u.file) || byFile.set(u.file, []).get(u.file)).push(u);
  console.log(C.dim('  used by  ') + C.b(byFile.size + ' file(s), ' + uses.length + ' site(s)'));
  for (const [f, list] of [...byFile].sort()) {
    for (const u of list) {
      const tag = u.kind === 'dynamic' ? C.y(' ~dynamic') : '';
      console.log('    ' + rel(ix.root, f) + ':' + u.line + tag + C.dim('  ' + u.text));
    }
  }
}

function reportImpact(ix, cssFile) {
  const abs = path.resolve(cssFile);
  const own = Object.keys(ix.defs).filter((n) => ix.defs[n].some((d) => path.resolve(d.file) === abs)).sort();
  if (!own.length) return console.log('no classes defined in ' + cssFile);
  console.log(C.b('blast radius: ' + rel(ix.root, abs)) + '\n');
  const rows = own.map((n) => {
    const u = ix.usedBy(n);
    return { n, files: new Set(u.map((x) => x.file)).size, sites: u.length, dyn: u.some((x) => x.kind === 'dynamic') };
  }).sort((a, b) => b.sites - a.sites);
  const w = Math.max(...rows.map((r) => r.n.length)) + 2;
  for (const r of rows) {
    const label = ('.' + r.n).padEnd(w);
    if (!r.sites) console.log(C.y(label) + C.dim('orphan — nobody uses it'));
    else console.log(C.g(label) + r.files + ' file(s), ' + r.sites + ' site(s)' + (r.dyn ? C.y('  ~has dynamic uses') : ''));
  }
  console.log(C.dim('\n' + rows.filter((r) => !r.sites).length + ' orphan(s) of ' + rows.length + ' classes. Run: whouses .<class> for call sites.'));
}

function reportFile(ix, srcFile) {
  const abs = path.resolve(srcFile);
  const found = ix.usedNames().filter((n) => ix.usedBy(n).some((u) => path.resolve(u.file) === abs)).sort();
  console.log(C.b('classes used by ' + rel(ix.root, abs)) + '\n');
  for (const n of found) {
    const d = (ix.defs[n] || [])[0];
    const shared = new Set(ix.usedBy(n).map((u) => u.file)).size;
    console.log(C.g(('.' + n).padEnd(28)) + (d ? rel(ix.root, d.file) + ':' + d.line : C.r('undefined')) +
      (shared > 1 ? C.y('  shared with ' + (shared - 1) + ' other file(s)') : C.dim('  exclusive')));
  }
  if (!found.length) console.log(C.dim('none'));
}

function helpText(ix) {
  return `whouses — reverse index for CSS

  whouses .btn-primary        who uses this class (files + line numbers)
  whouses src/theme.css       blast radius of a stylesheet, class by class
  whouses --file Button.tsx   which classes this component depends on
  whouses --diff              what did I just break? blast radius of your CSS edits
  whouses --rename .a .b      rename everywhere, refuse if a runtime site would break
  whouses --extract C.jsx     lift a component's own rules out of a giant stylesheet
  whouses --orphans           defined but never used — safe to delete
  whouses --dynamic           only matched through \${interpolation} — check by hand
  whouses --tailwind          classes Tailwind's scanner will silently drop
  whouses --vars              CSS custom properties, traced into your JS too
  whouses --install-hook      print the blast radius on every commit, automatically
  whouses --json              machine-readable index

  --root <dir>                scan somewhere else (default: cwd)
  --write                     apply --rename / --extract (both are dry runs without it)
  --force                     override a refusal, once you understand why it refused
  --version                   print the version

exit codes: 0 ok · 1 something to act on (orphans, errors) · 2 bad usage` +
    (ix ? `\n\nindexed ${ix.cssFiles.length} stylesheet(s), ${ix.srcFiles.length} source file(s), ${Object.keys(ix.defs).length} classes` : '');
}

const VERSION = (() => { try { return require(path.join(__dirname, 'package.json')).version; } catch { return '0.0.0'; } })();
const FLAGS = new Set(['--orphans', '--dynamic', '--tailwind', '--vars', '--diff', '--file',
  '--rename', '--extract', '--install-hook', '--json', '--write', '--force', '--root',
  '--help', '-h', '--version', '-v']);

function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--version') || args.includes('-v')) return console.log(VERSION);
  if (args.includes('--help') || args.includes('-h')) return console.log(helpText(null));
  // a typo like --orphan used to print help and exit 0, so it looked like it had run
  const unknown = args.filter((a) => a.startsWith('-') && !FLAGS.has(a));
  if (unknown.length) {
    console.error('unknown option: ' + unknown.join(' '));
    const stem = unknown[0].replace(/^-+/, '').slice(0, 4);
    const near = [...FLAGS].filter((f) => f.startsWith('--') && stem && f.includes(stem));
    if (near.length) console.error('  did you mean  ' + near.join('  '));
    console.error('  run  whouses --help  for the full list');
    process.exitCode = 2;
    return;
  }
  const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
  const root = path.resolve(opt('--root', '.'));
  const json = args.includes('--json');
  const target = args.filter((a) => !a.startsWith('-'))[0];
  const ix = buildIndex(root);
  // a file the tool could not read is a hole in the answer — never hide it
  if (ix.skipped.length) {
    console.error(C.y('skipped ' + ix.skipped.length + ' file(s) — results below are incomplete:'));
    for (const f of ix.skipped.slice(0, 5)) console.error(C.dim('  ' + rel(root, f)));
    if (ix.skipped.length > 5) console.error(C.dim('  +' + (ix.skipped.length - 5) + ' more'));
  }

  const standalone = args.includes('--tailwind') || args.includes('--vars') || args.includes('--diff') || args.includes('--install-hook');
  if (!standalone && !Object.keys(ix.defs).length) {
    const tw = usesTailwind(root, ix.cssFiles);
    console.error(C.y('no CSS classes found under ' + root));
    console.error(C.dim('  scanned ' + ix.cssFiles.length + ' stylesheet(s), ' + ix.srcFiles.length + ' source file(s).'));
    if (tw) {
      console.error('\n  this looks like a ' + C.b('Tailwind') + ' project. these are the commands for you:\n');
      console.error('    ' + C.b('whouses --tailwind') + C.dim('   classes the JIT scanner silently drops — real bugs'));
      console.error('    ' + C.b('whouses --vars') + C.dim('       your design tokens, and who reads them'));
    } else {
      console.error(C.dim('  styles-in-JS (styled-components, emotion) are not indexed —'));
      console.error(C.dim('  whouses reads .css/.scss/.less files. Point it at one with --root <dir>.'));
    }
    process.exitCode = 1;
    if (!json) return;
  }
  if (json) {
    const out = {};
    for (const n of ix.usedNames()) out[n] = ix.usedBy(n);
    return console.log(JSON.stringify({ defs: ix.defs, uses: out }, null, 2));
  }
  if (args.includes('--orphans')) {
    const isExternal = (n) => ix.defs[n].every((d) => d.external);
    const orphans = Object.keys(ix.defs).filter((n) => !ix.isUsed(n) && !isExternal(n)).sort();
    const external = Object.keys(ix.defs).filter((n) => !ix.isUsed(n) && isExternal(n)).sort();
    console.log(C.b(orphans.length + ' orphan class(es)') + C.dim(' — defined, never referenced\n'));
    for (const n of orphans) console.log(C.y('.' + n).padEnd(40) + C.dim(ix.defs[n].map((d) => rel(root, d.file) + ':' + d.line).join(', ')));
    if (external.length) console.log(C.dim('\n' + external.length + ' :global() class(es) skipped — generated by a library at runtime, not dead: ') +
      external.slice(0, 6).map((n) => '.' + n).join(' '));
    process.exitCode = orphans.length ? 1 : 0;   // usable as a CI gate
    return;
  }
  if (args.includes('--dynamic')) {
    const dyn = Object.keys(ix.defs).filter((n) => !ix.uses[n] && ix.isUsed(n)).sort();
    console.log(C.b(dyn.length + ' class(es) matched only via string interpolation') + C.dim(' — verify by hand before deleting\n'));
    for (const n of dyn) console.log(C.y('.' + n).padEnd(30) + C.dim(ix.usedBy(n).slice(0, 4).map((u) => rel(root, u.file) + ':' + u.line).join(', ')));
    return;
  }
  if (args.includes('--tailwind')) {
    if (!usesTailwind(root, ix.cssFiles)) {
      console.log(C.y('this project does not appear to use Tailwind.'));
      console.log(C.dim('  no tailwind config, no tailwind dependency, and no @tailwind or'));
      console.log(C.dim('  @import "tailwindcss" in any stylesheet. Nothing to check.'));
      console.log(C.dim('  for plain CSS use:  whouses --orphans   or   whouses .a-class'));
      return;
    }
    const hits = scanTailwind(root);
    const safe = hits.covered || [];
    console.log(C.b(hits.length + ' dynamic Tailwind class(es) that will not be generated') +
      C.dim(hits.length ? '' : ' — nothing to fix') + '\n');
    for (const h of hits) {
      console.log(C.r(rel(root, h.file) + ':' + h.line) + '  fragment ' + C.y(h.fragment + '${...}' + h.suffix));
      console.log(C.dim('    ' + h.expr.slice(0, 100)));
      if (h.resolved) {
        const how = h.via === 'prop' ? ' (from the values it is actually given)' : '';
        console.log(C.dim('    resolves to ') + h.resolved.join(', ') + C.dim(how));
        console.log(C.r('    never generated: ') + h.missing.join(', '));
      } else {
        console.log(C.y('    could not be resolved') +
          C.dim(' — no call site gives it a literal value, so it cannot be proven safe'));
      }
    }
    if (safe.length) {
      console.log(C.g((hits.length ? '\n' : '') + safe.length + ' other interpolated class(es) are fine') +
        C.dim(' — the classes they produce are spelled out elsewhere, so Tailwind generates them:'));
      for (const c of safe.slice(0, 5)) {
        console.log(C.dim('  ' + rel(root, c.file) + ':' + c.line + '  ' + c.fragment + '${...}' + c.suffix +
          (c.resolved ? '  -> ' + c.resolved.join(', ') : '')));
      }
      if (safe.length > 5) console.log(C.dim('  +' + (safe.length - 5) + ' more'));
    }
    if (hits.length) console.log(C.dim('\nfix: map to whole class names — { red: "bg-red-100", blue: "bg-blue-100" }[color]'));
    process.exitCode = hits.length ? 1 : 0;
    return;
  }
  if (args.includes('--vars')) {
    const v = scanVars(root);
    const all = [...new Set([...Object.keys(v.defs), ...Object.keys(v.uses)])].sort();
    console.log(C.b(all.length + ' CSS custom propert(ies)\n'));
    for (const n of all) {
      const d = v.defs[n] || [], u = v.uses[n] || [];
      const where = d.length ? rel(root, d[0].file) + ':' + d[0].line : C.r('never defined');
      if (v.theme.has(n)) console.log(C.g(n.padEnd(28)) + where + C.dim('  @theme token — Tailwind generates utilities from it') +
        (u.length ? '  ' + u.length + ' var() use(s)' : ''));
      else if (!u.length) console.log(C.y(n.padEnd(28)) + where + C.dim('  used by nobody'));
      else console.log(C.g(n.padEnd(28)) + where + '  ' + new Set(u.map((x) => x.file)).size + ' file(s), ' + u.length + ' use(s)');
    }
    return;
  }
  if (args.includes('--diff')) {
    const base = args.filter((a) => !a.startsWith('--'))[0];
    const touched = changedCssLines(root, base);
    if (touched === null) { console.error(C.r('not a git repository (or git unavailable)')); process.exitCode = 1; return; }
    const hit = new Map();
    for (const [f, lines] of touched) {
      for (const span of cssRuleSpans(f)) {
        if (![...lines].some((l) => l >= span.start && l <= span.end)) continue;
        for (const cls of span.classes) {
              if (!hit.has(cls)) hit.set(cls, { span, uses: ix.usedBy(cls) });
        }
      }
    }
    if (!hit.size) { console.log(C.g('no CSS rules changed') + C.dim(base ? ' vs ' + base : ' in your working tree')); return; }
    const all = new Set(), dynamic = new Set();
    for (const [, v] of hit) for (const u of v.uses) { all.add(u.file); if (u.kind === 'dynamic') dynamic.add(u.file); }
    console.log(C.b('you changed ' + hit.size + ' CSS rule(s) — ' + all.size + ' file(s) are affected\n'));
    for (const [cls, v] of [...hit].sort((a, b) => b[1].uses.length - a[1].uses.length)) {
      const files = new Set(v.uses.map((u) => u.file));
      if (!files.size) { console.log(C.y('  .' + cls) + C.dim('  used by nobody — new or dead')); continue; }
      console.log(C.b('  .' + cls) + C.dim('  ' + rel(root, v.span.file) + ':' + v.span.start + '  → ' + files.size + ' file(s)'));
      for (const u of v.uses.slice(0, 6)) {
        console.log('      ' + rel(root, u.file) + ':' + u.line + (u.kind === 'dynamic' ? C.y('  ~dynamic — test this one by hand') : ''));
      }
      if (v.uses.length > 6) console.log(C.dim('      +' + (v.uses.length - 6) + ' more'));
    }
    console.log(C.dim('\ntest these ' + all.size + ' file(s) before you push') +
      (dynamic.size ? C.y('  · ' + dynamic.size + ' reached dynamically, so a screenshot test will not catch it') : ''));
    return;
  }
  if (args.includes('--rename')) {
    const [from, to] = args.filter((a) => !a.startsWith('--')).map((a) => a.replace(/^\./, ''));
    if (!from || !to) { console.error('usage: whouses --rename .old-name .new-name [--write]'); process.exitCode = 1; return; }
    const { previews, blocked, collision } = planRename(ix, from, to);
    const lines = previews.filter((p) => !p.write);
    if (!lines.length) { console.log(C.y('.' + from + ' not found')); process.exitCode = 1; return; }
    console.log(C.b('.' + from) + ' → ' + C.b('.' + to) + C.dim('  ' + lines.length + ' line(s) in ' + new Set(lines.map((l) => l.file)).size + ' file(s)\n'));
    for (const l of lines) {
      console.log(C.dim(rel(root, l.file) + ':' + l.line));
      console.log(C.r('  - ' + l.before.slice(0, 110)));
      console.log(C.g('  + ' + l.after.slice(0, 110)));
    }
    if (collision) console.log(C.y('\nnote: .' + to + ' already exists — the two rules will merge and .' + from + ' may be shadowed.'));
    if (blocked.length) {
      console.log(C.y('\n' + blocked.length + ' site(s) build this class at runtime — NOT renamed, fix these by hand:'));
      for (const b of blocked) console.log('  ' + rel(root, b.file) + ':' + b.line + C.dim('  ' + b.text.slice(0, 90)));
    }
    if (args.includes('--write') && blocked.length && !args.includes('--force')) {
      // renaming the CSS while a runtime call site still builds the old name = a silently broken app
      console.log(C.r('\nrefusing to write.') + ' the rename would be half-applied: the CSS becomes .' + to +
        ' while the site(s) above still build .' + from + ' at runtime.');
      console.log(C.dim('  fix those line(s) first, or pass --force if you have already handled them.'));
      process.exitCode = 1;
      return;
    }
    if (args.includes('--write')) {
      for (const p of previews) if (p.write) fs.writeFileSync(p.file, p.write);
      console.log(C.g('\nwritten.') + (blocked.length ? C.y(' ' + blocked.length + ' dynamic site(s) were forced past — verify them.') : ''));
    } else {
      console.log(C.dim('\ndry run — nothing changed. add --write to apply.'));
    }
    process.exitCode = blocked.length ? 1 : 0;
    return;
  }
  if (args.includes('--install-hook')) {
    const dir = path.join(root, '.git', 'hooks');
    if (!fs.existsSync(dir)) { console.error(C.r('no .git/hooks — run this inside a git repository')); process.exitCode = 1; return; }
    const hook = path.join(dir, 'pre-commit');
    const body = '#!/bin/sh\n# added by whouses — show the blast radius of staged CSS changes\nnpx whouses --diff HEAD || true\n';
    if (fs.existsSync(hook) && fs.readFileSync(hook, 'utf8').includes('whouses')) {
      console.log(C.dim('pre-commit hook already installed'));
      return;
    }
    if (fs.existsSync(hook)) {
      const shebang = (fs.readFileSync(hook, 'utf8').split('\n')[0] || '');
      if (!/^#!.*\b(sh|bash|zsh|dash)\b/.test(shebang)) {
        // appending shell into a python/node hook breaks every commit in the repo
        console.error(C.r('your pre-commit hook is not a shell script') + C.dim(' (' + (shebang || 'no shebang') + ')'));
        console.error(C.dim('  add this line to it yourself:  ') + C.b('npx whouses --diff HEAD || true'));
        process.exitCode = 1;
        return;
      }
      fs.appendFileSync(hook, '\n' + body.split('\n').slice(1).join('\n'));   // keep whatever is already there
      console.log(C.g('appended to your existing ') + rel(root, hook));
    } else {
      fs.writeFileSync(hook, body, { mode: 0o755 });
      console.log(C.g('installed ') + rel(root, hook));
    }
    console.log(C.dim('every commit that touches CSS now prints what it affects. it never blocks the commit.'));
    return;
  }
  if (args.includes('--extract')) {
    if (!target || !fs.existsSync(target)) { console.error('usage: whouses --extract src/Button.jsx [--write]'); process.exitCode = 1; return; }
    const plan = planExtract(ix, target);
    const out = path.join(path.dirname(target), path.basename(target).replace(/\.[^.]+$/, '') + '.css');
    console.log(C.b('extract ' + rel(root, target)) + C.dim(' → ' + rel(root, out) + '\n'));
    if (!plan.move.length) console.log(C.y('  nothing can move — every rule it uses is shared or nested'));
    for (const m of plan.move) console.log(C.g('  move  ') + m.selector.slice(0, 70) + C.dim('  ' + rel(root, m.file) + ':' + m.start + (m.end > m.start ? '-' + m.end : '')));
    for (const s2 of plan.stay) console.log(C.y('  stay  ') + s2.selector.slice(0, 70) + C.dim('  ' + s2.why));
    if (args.includes('--write') && plan.move.length && fs.existsSync(out) && !args.includes('--force')) {
      console.error(C.r('\nrefusing to write: ') + rel(root, out) + ' already exists.');
      console.error(C.dim('  it would be replaced, not merged. move it aside, or pass --force.'));
      process.exitCode = 1;
      return;
    }
    if (args.includes('--write') && plan.move.length) {
      applyExtract(plan, out);
      console.log(C.g('\nwritten ') + rel(root, out) + C.dim(' — ' + plan.move.length + ' rule(s) moved out of the monolith'));
      console.log(C.dim('add to ' + rel(root, target) + ':  ') + C.b("import './" + path.basename(out) + "';"));
    } else if (plan.move.length) {
      console.log(C.dim('\ndry run — nothing changed. add --write to apply.'));
    }
    return;
  }
  if (args.includes('--file')) return reportFile(ix, target);
  if (!target) {
    console.log(helpText(ix));
    return;
  }
  const ext = path.extname(target);
  if (fs.existsSync(target) && (CSS_EXT.has(ext) || HTML_EXT.has(ext))) return reportImpact(ix, target);
  reportClass(ix, target.replace(/^\./, ''));
}

module.exports = { buildIndex, usesTailwind, tailwindScope, literalClasses, contentScope, gitIgnored, expandBraces,
  parseFile, walkAst, staticValues, classExpressions, componentIndex, propBindings, callSiteValues, parseCss, parseSrc, lexCss, sanitizeCss, stripDirectives, scanTailwind, scanVars, cssRuleSpans, changedCssLines, planRename, planExtract, applyExtract };
if (require.main === module) main(process.argv);
