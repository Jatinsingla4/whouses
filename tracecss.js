#!/usr/bin/env node
'use strict';
// tracecss — CSS with backtracing built in. Every .css file is already valid .tcss.
const fs = require('fs');
const path = require('path');
const { buildIndex, sanitizeCss } = require('./whouses');

const MARK = '[tracecss]';
const blank = (m) => m.replace(/[^\n]/g, ' ');
const lineOf = (s, i) => s.slice(0, i).split('\n').length;

// ---------- the language: CSS + four directives ----------
// @component Button;            this file belongs to Button
// @public  .btn { }             anyone may use it
// @private .btn-inner { }       only the owning component may use it  -> compile error
// @deprecated("use .btn-danger") .btn-delete { }   -> warning at every call site
// @owner("@jatin") .card { }    who to ask before changing it

function parseTcss(file) {
  const src = fs.readFileSync(file, 'utf8');
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, blank);
  const comp = /@component\s+([\w-]+)\s*;/.exec(clean);
  const rules = [];
  const re = /([^{}]+)\{/g;
  let m;
  while ((m = re.exec(clean))) {
    let chunk = m[1];
    if (/^\s*@(?:media|supports|keyframes|layer|container|font-face|import|charset)/.test(chunk)) continue;
    const dep = /@deprecated\s*\(\s*['"]([^'"]*)['"]\s*\)/.exec(chunk);
    const own = /@owner\s*\(\s*['"]([^'"]*)['"]\s*\)/.exec(chunk);
    const access = /@private\b/.test(chunk) ? 'private' : /@public\b/.test(chunk) ? 'public' : null;
    chunk = chunk.replace(/@component\s+[\w-]+\s*;/g, blank)
                 .replace(/@(?:deprecated|owner|since)\s*\([^)]*\)/g, blank)
                 .replace(/@(?:public|private|internal)\b/g, blank);
    const sel = chunk.trim();
    if (!sel || sel[0] === '@') continue;
    const classes = [...sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((c) => c[1]);
    if (!classes.length) continue;
    const at = m.index + chunk.search(/\S/);   // the selector's own line, not the directive's
    rules.push({
      file, classes, selector: sel.replace(/\s+/g, ' '), access,
      deprecated: dep ? dep[1] : null, owner: own ? own[1] : null,
      line: lineOf(clean, at), start: at,
    });
  }
  return { file, component: comp ? comp[1] : null, rules, src };
}

// plain CSS out. Directives are located on a sanitized copy (comments and string bodies
// blanked) and cut by offset, so `content: "@public"` and a @deprecated message containing
// ')' both survive untouched.
// matched on the SANITIZED copy, where any ')' inside a message has already been
// blanked — so [^)]* cannot run past the end of the directive
const DIRECTIVE = /@component\s+[\w-]+\s*;[ \t]*\r?\n?|@(?:deprecated|owner|since)\s*\([^)]*\)\s*|@(?:public|private|internal)\b\s*/g;
function compile(src) {
  const clean = sanitizeCss(src, true);
  const cuts = [];
  DIRECTIVE.lastIndex = 0;
  let m;
  while ((m = DIRECTIVE.exec(clean))) cuts.push([m.index, m.index + m[0].length]);
  let out = '', cursor = 0;
  for (const [a, b] of cuts) { out += src.slice(cursor, a); cursor = b; }
  out += src.slice(cursor);
  return out.replace(/^[ \t]*\/\* @used-by [\s\S]*?\[tracecss\] \*\/[ \t]*\r?\n/gm, '');
}

const owns = (component, file) => {
  if (!component) return false;
  const base = path.basename(file).replace(/\.[^.]+$/, '').replace(/\.module$/, '');
  return base === component || base === component + '.module';
};

// ---------- enforcement: the part a linter cannot do ----------
function check(ix, sheets) {
  const out = [];
  for (const sheet of sheets) {
    for (const r of sheet.rules) {
      for (const cls of r.classes) {
        const uses = (ix.uses[cls] || []).filter((u) => path.extname(u.file) !== '.tcss');
        // a dynamic hit is a strong guess, not a fact — never fail a build on a guess
        if (r.access === 'private') {
          for (const u of uses) {
            if (owns(sheet.component, u.file)) continue;
            const guess = u.kind === 'dynamic';
            out.push({ level: guess ? 'warn' : 'error', file: u.file, line: u.line,
              msg: `.${cls} is @private to ${sheet.component || path.basename(sheet.file)}`
                 + (guess ? ' — possibly reached here via an interpolated class' : ' — not usable here'),
              hint: `declared ${path.relative(ix.root, sheet.file)}:${r.line}` });
          }
        }
        if (r.deprecated) {
          for (const u of uses) {
            out.push({ level: 'warn', file: u.file, line: u.line,
              msg: `.${cls}${u.kind === 'dynamic' ? ' (possibly)' : ''} is deprecated — ${r.deprecated}`,
              hint: `declared ${path.relative(ix.root, sheet.file)}:${r.line}` });
          }
        }
        if (!uses.length && r.access !== 'private') {
          out.push({ level: 'info', file: sheet.file, line: r.line,
            msg: `.${cls} is used by nobody` + (r.owner ? ` (owner ${r.owner})` : ''), hint: '' });
        }
      }
    }
  }
  return out;
}

// ---------- the masterstroke: the stylesheet documents itself ----------
function annotate(ix, sheet) {
  const stripped = sheet.src.replace(/^[ \t]*\/\* @used-by [\s\S]*?\[tracecss\] \*\/[ \t]*\r?\n/gm, '');
  const lines = stripped.split('\n');
  const reparsed = parseString(stripped, sheet.file);
  const insert = new Map();
  for (const r of reparsed.rules) {
    const uses = [];
    for (const cls of r.classes) for (const u of ix.uses[cls] || []) {
      if (path.extname(u.file) !== '.tcss') uses.push(u);
    }
    const files = new Set(uses.map((u) => u.file));
    const indent = (lines[r.line - 1] || '').match(/^[ \t]*/)[0];
    let body;
    if (!uses.length) body = 'nobody — orphan';
    else {
      const shown = [...files].slice(0, 4).map((f) => {
        const first = uses.find((u) => u.file === f);
        const dyn = uses.some((u) => u.file === f && u.kind === 'dynamic') ? ' ~dyn' : '';
        return path.relative(ix.root, f) + ':' + first.line + dyn;
      });
      body = `${files.size} file(s) · ` + shown.join(' · ') + (files.size > 4 ? ` · +${files.size - 4} more` : '');
    }
    insert.set(r.line, `${indent}/* @used-by ${body} ${MARK} */`);
  }
  const out = [];
  lines.forEach((l, i) => { if (insert.has(i + 1)) out.push(insert.get(i + 1)); out.push(l); });
  return out.join('\n');
}

function parseString(src, file) {
  const tmp = { file, rules: [] };
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, blank);
  const re = /([^{}]+)\{/g;
  let m;
  while ((m = re.exec(clean))) {
    let chunk = m[1];
    if (/^\s*@(?:media|supports|keyframes|layer|container|font-face|import|charset)/.test(chunk)) continue;
    chunk = chunk.replace(/@component\s+[\w-]+\s*;/g, blank)
                 .replace(/@(?:deprecated|owner|since)\s*\([^)]*\)/g, blank)
                 .replace(/@(?:public|private|internal)\b/g, blank);
    const sel = chunk.trim();
    if (!sel || sel[0] === '@') continue;
    const classes = [...sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((c) => c[1]);
    if (!classes.length) continue;
    tmp.rules.push({ classes, line: lineOf(clean, m.index + chunk.search(/\S/)) });
  }
  return tmp;
}

// ---------- cli ----------
const T = process.stdout.isTTY;
const c = (n, s) => (T ? `\x1b[${n}m${s}\x1b[0m` : s);
const red = (s) => c(31, s), yel = (s) => c(33, s), grn = (s) => c(32, s), dim = (s) => c(2, s), bold = (s) => c(1, s);

function sheetsIn(root) {
  const out = [];
  const walk = (d) => {
    let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const x of e) {
      if (['node_modules', '.git', 'dist', 'build', '.next', 'out'].includes(x.name)) continue;
      const p = path.join(d, x.name);
      if (x.isDirectory()) walk(p); else if (p.endsWith('.tcss')) out.push(parseTcss(p));
    }
  };
  walk(root);
  return out;
}

function run(root, { write, doAnnotate, quiet, force }) {
  const sheets = sheetsIn(root);
  if (!sheets.length) { console.error(yel('no .tcss files under ' + root) + dim('\n  rename a .css file to .tcss — it already compiles.')); return 1; }
  const ix = buildIndex(root);
  const problems = check(ix, sheets);

  if (write) {
    for (const s of sheets) {
      const out = s.file.replace(/\.tcss$/, '.css');
      // a .css next to a .tcss may be a hand-written file, not our output. Only replace
      // one we previously generated (byte-identical to what compile() produces).
      if (fs.existsSync(out) && fs.readFileSync(out, 'utf8') !== compile(s.src)) {
        const prev = fs.readFileSync(out, 'utf8');
        const ours = sheets.some((o) => prev === compile(o.src)) || prev.trim() === '';
        if (!ours && !force) {
          console.error(red('refusing to overwrite ') + path.relative(root, out) +
            dim(' — it does not look generated. move it aside, or pass --force.'));
          return 1;
        }
      }
      fs.writeFileSync(out, compile(s.src));
    }
  }
  if (doAnnotate) for (const s of sheets) fs.writeFileSync(s.file, annotate(ix, s));

  const errs = problems.filter((p) => p.level === 'error');
  const warns = problems.filter((p) => p.level === 'warn');
  const infos = problems.filter((p) => p.level === 'info');
  if (!quiet) {
    for (const p of [...errs, ...warns, ...infos]) {
      const tag = p.level === 'error' ? red('error') : p.level === 'warn' ? yel('warn ') : dim('unused');
      console.log(`${path.relative(root, p.file)}:${p.line}  ${tag}  ${p.msg}${p.hint ? dim('  (' + p.hint + ')') : ''}`);
    }
    const n = sheets.length, r = sheets.reduce((a, s) => a + s.rules.length, 0);
    console.log(dim(`\n${n} sheet(s), ${r} rule(s) · `) +
      (errs.length ? red(errs.length + ' error(s)') : grn('0 errors')) +
      dim(` · ${warns.length} warning(s) · ${infos.length} unused`) +
      (write ? grn('  → compiled to .css') : '') + (doAnnotate ? grn('  → annotated') : ''));
  }
  return errs.length ? 1 : 0;
}

function main() {
  const [cmd, dirArg] = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const root = path.resolve(dirArg || '.');
  const force = process.argv.includes('--force');
  if (cmd === 'build') return process.exit(run(root, { write: true, doAnnotate: true, force }));
  if (cmd === 'check') return process.exit(run(root, {}));
  if (cmd === 'annotate') return process.exit(run(root, { doAnnotate: true }));
  if (cmd === 'watch') {
    run(root, { write: true, doAnnotate: true });
    let t = null, busy = false;
    fs.watch(root, { recursive: true }, (_, f) => {
      if (!f || busy || /\.css$/.test(f)) return;         // our own output must not retrigger us
      clearTimeout(t);
      t = setTimeout(() => { busy = true; console.log(dim('\n— rebuild —')); run(root, { write: true, doAnnotate: true }); busy = false; }, 120);
    });
    return console.log(dim('watching ' + root + ' … ctrl-c to stop'));
  }
  console.log(`${bold('tracecss')} — CSS that knows who uses it

  Every .css file is already valid .tcss. Rename one and it compiles.

  ${bold('tracecss build')} [dir]     compile .tcss → .css, annotate, enforce
  ${bold('tracecss annotate')} [dir]  write @used-by comments back into your stylesheets
  ${bold('tracecss check')} [dir]     enforce only, no writes — exits 1 on error (CI)
  ${bold('tracecss watch')} [dir]     keep everything fresh while you code

  ${dim('directives')}
    @component Button;                     this sheet belongs to Button
    @public  .btn { }                      anyone may use it
    @private .btn-inner { }                only Button may use it → compile error
    @deprecated("use .btn-danger") .x { }  warns at every call site
    @owner("@jatin") .card { }             who to ask before changing it`);
}

module.exports = { parseTcss, compile, annotate, check, sheetsIn };
if (require.main === module) main();
