# whouses

**You need to change a CSS class. Who breaks?**

```bash
npx whouses .btn-primary
```

```
.btn-primary
  defined  styles/app.css:2  .btn-primary
  used by  2 file(s), 3 site(s)
    src/Button.jsx:2   <button className={`btn btn-${kind}`}>   ~dynamic
    src/Toolbar.vue:1  <button class="btn btn-primary">Save</button>
    src/legacy.js:1    document.querySelector('.btn-primary')
```

No install, no config, no dependencies. Point it at a repo and it answers.

## Why not just grep?

Grep finds `btn-primary`. It does not find `` `btn-${kind}` `` — the usage that turns
your safe refactor into a production incident. That is the whole reason this exists.

whouses builds the index CSS never had: **class → every place that reaches it.**

| It finds | Example |
|---|---|
| Plain class attributes | `class="btn"`, `className="btn"` |
| Template interpolation | `` `btn-${kind}` `` → flags `.btn-primary`, `.btn-danger` as `~dynamic` |
| Strings inside interpolation | `` `card ${flat ? 'card--flat' : ''}` `` |
| CSS Modules, incl. camelCase remap | `s.legacyName` → `.legacy-name` |
| clsx / classnames / cn | `clsx('card', flat && 'card--flat')` |
| Vue object syntax | `:class="{ card: true }"` |
| Svelte directives | `class:active` |
| Runtime DOM lookups | `querySelector('.btn')`, `classList.add('open')` |

## Commands

```bash
npx whouses .btn-primary        # who uses this class — files and line numbers
npx whouses styles/app.css      # blast radius of a whole stylesheet, class by class
npx whouses --file Card.tsx     # which classes this component depends on
npx whouses --orphans           # defined, used by nobody — safe to delete
npx whouses --dynamic           # only reachable through ${interpolation} — check by hand
npx whouses --json              # the full index, for your own tooling
npx whouses --root packages/ui  # scan somewhere other than cwd
```

### Before you edit a stylesheet

```
$ npx whouses styles/app.css

blast radius: styles/app.css

.btn            2 file(s), 2 site(s)
.btn-primary    2 file(s), 2 site(s)  ~has dynamic uses
.card           1 file(s), 1 site(s)
.legacy-banner  orphan — nobody uses it

1 orphan(s) of 6 classes.
```

Now you know which lines are safe to touch before you touch them.

### Before you delete

`--orphans` lists what nobody references. `--dynamic` lists what is referenced *only*
through string interpolation — the classes that look dead and are not. Read that list
before trusting the first one.

```bash
npx whouses --dynamic    # always check this before acting on --orphans
```

### In CI

`--orphans` exits `1` when dead CSS exists, so it gates a pipeline as-is:

```yaml
- run: npx whouses --orphans
```

## What it does not do

- **styled-components, emotion, vanilla-extract** — styles live in JS, not `.css`. Not indexed.
- **Tailwind utilities** — you want [the Tailwind tooling](https://tailwindcss.com), not this.
- It is a scanner, not a parser. It optimises for *never missing a usage*, which means it
  will occasionally show you a line that turns out to be unrelated. Every result carries
  `file:line` precisely so that costs you one glance.

The bias is deliberate: a false positive wastes a second, a false negative ships a bug.

## Requirements

Node 16+. Zero dependencies.


---

# tracecss — the language

`whouses` answers the question *after* you ask it. **tracecss makes the answer live inside your CSS**, so you never have to ask.

## Adopting it takes one rename

```bash
mv styles/Button.css styles/Button.tcss
npx tracecss build src/
```

That is the whole migration. **Every valid CSS file is already a valid tracecss file** — no rewrite, no new syntax to learn, no lock-in. tracecss compiles back down to plain `.css`, so every bundler, framework and browser keeps working exactly as before. You can delete it tomorrow and lose nothing.

That is the same deal TypeScript made with JavaScript, and Next.js made with React: a superset, never a replacement.

## What you get: the stylesheet writes its own documentation

Run `tracecss build` and open your stylesheet. It has annotated itself:

```css
@component Button;

/* @used-by 3 file(s) · src/Button.jsx:2 · src/Modal.tsx:14 · src/Nav.vue:8 [tracecss] */
@public .btn { padding: 8px }

/* @used-by 1 file(s) · src/Button.jsx:2 ~dyn [tracecss] */
@public .btn-delete { background: red }

/* @used-by nobody — orphan [tracecss] */
@public .btn-legacy { border: 1px dotted }
```

**There is no command to remember and no dashboard to open.** You open the CSS file to change it — and the answer to "who uses this?" is already sitting on the line above. `~dyn` means the class is built at runtime, so grep will never find it and you must not delete it.

Run it on every save with `tracecss watch`. The comments are regenerated, never duplicated — running build a hundred times leaves the file byte-for-byte identical.

## Four directives, and the compiler enforces them

| Directive | What it does |
|---|---|
| `@component Button;` | This sheet belongs to Button |
| `@public .btn { }` | Anyone may use it |
| `@private .btn-inner { }` | Only Button may use it — **anyone else is a compile error** |
| `@deprecated("use .btn-danger") .x { }` | Warns at every call site, with your message |
| `@owner("@jatin") .card { }` | Who to ask before changing it |

```
$ npx tracecss check src/

src/Page.jsx:2   error  .btn-ripple is @private to Button — not usable here  (declared src/Button.tcss:8)
src/Page.jsx:3   warn   .btn-danger is deprecated — use .btn-delete instead  (declared src/Button.tcss:10)
src/Button.tcss:12  unused  .btn-legacy is used by nobody (owner @jatin)

1 sheet(s), 6 rule(s) · 1 error(s) · 1 warning(s) · 1 unused
```

Exits `1` on error, so `npx tracecss check` gates CI with no configuration.

**`@private` is the part that ends the problem instead of diagnosing it.** CSS has been globally scoped since 1996 — any file can reach any class, which is exactly why nobody knows who uses what. `@private` gives CSS the boundary every other language has had for decades, and enforces it at build time.

## The one thing no other tool does

Deprecation warnings follow classes that are **assembled at runtime**:

```jsx
<button className={`btn-${type}`}>     // type is "danger"
```

That code uses `.btn-danger`. The text `btn-danger` appears nowhere in your repo. Grep finds nothing, ESLint sees a template string, stylelint never reads your JSX — and tracecss still warns you, on the right line.

A dynamic match is a strong guess, not a fact, so it always warns and **never fails your build**. A tool that fails builds on guesses gets switched off in a week.

## Commands

```bash
npx tracecss build src/      # compile .tcss → .css, annotate, enforce
npx tracecss annotate src/   # just refresh the @used-by comments
npx tracecss check src/      # enforce only, no writes — for CI
npx tracecss watch src/      # keep it all fresh while you code
```

## How it compares

|  | Finds dynamic classes | Enforces boundaries | Self-documenting | Migration cost |
|---|---|---|---|---|
| grep | no | no | no | — |
| stylelint | no | no | no | config |
| PurgeCSS | guesses, then deletes | no | no | build setup |
| CSS Modules | n/a | scoping only, no visibility | no | rewrite every import |
| **tracecss** | **yes, and says so** | **`@private` at build time** | **yes, in the file** | **one rename** |

## Requirements

Node 16+. Zero dependencies.

---

# Works with Tailwind too

Tailwind builds its CSS by scanning your files for **complete class names**. This component
looks perfect, compiles clean, and ships to production with no background and no text colour:

```jsx
<div className={`bg-${color}-100 text-${color}-800 p-4`}>
```

`bg-red-100` is never written as text anywhere, so Tailwind never generates it. No build error,
no runtime error, no warning. Just an unstyled element and an afternoon lost to it.

```bash
npx whouses --tailwind
```

```
3 dynamic Tailwind class(es) — the JIT scanner cannot see these, so the CSS is never generated

src/Alert.jsx:2  fragment bg-${...}
    `bg-${color}-100 text-${color}-800 p-4 rounded`
src/Alert.jsx:7  fragment grid-cols-${...}
    `grid grid-cols-${n} gap-4`

fix: map to whole class names — { red: "bg-red-100", blue: "bg-blue-100" }[color]
```

It exits `1`, so it gates CI. And it deliberately stays quiet about the patterns that are
**safe** — `` `p-4 ${big ? 'text-lg' : 'text-sm'}` `` is never flagged, because those are whole
class names and Tailwind finds them fine. A tool that cries wolf on working code gets uninstalled.

# Design tokens, in every framework

CSS custom properties are how modern projects share values — and nothing tells you who reads one.
Change `--brand-primary` and you are guessing about the blast radius.

```bash
npx whouses --vars
```

```
--brand-danger     src/theme.css:3  1 file(s), 1 use(s)
--brand-primary    src/theme.css:2  2 file(s), 2 use(s)
--legacy-blue      src/theme.css:5  used by nobody
--spacing-lg       src/theme.css:4  2 file(s), 2 use(s)
```

It follows the variable out of your CSS and into your JavaScript — `{ color: 'var(--brand-primary)' }`
counts as a use. This works in **plain CSS, Tailwind, CSS Modules, and styled-components alike**,
because they all end up reading the same custom properties.

# What about styled-components?

Honestly: you don't need this, and we won't pretend otherwise. Your styles live in a JS binding,
so "who uses this?" is "who imports this variable" — your IDE's *Find References* already answers
that perfectly. Use `--vars` for your theme tokens; skip the rest.


---

# The two commands you'll actually use every day

## "What did I just break?"

You changed two lines of CSS. Which components need testing? Nobody knows, so nobody tests any of them.

```bash
npx whouses --diff
```

```
you changed 2 CSS rule(s) — 3 file(s) are affected

  .btn   src/app.css:1  → 2 file(s)
      src/Button.jsx:1
      src/Modal.tsx:1
  .card  src/app.css:4  → 2 file(s)
      src/Card.jsx:1
      src/Modal.tsx:1

test these 3 file(s) before you push
```

It reads your actual `git diff`, maps each changed line to the rule that owns it, and tells you
the blast radius **before** you push. `npx whouses --diff main` does the same against a branch,
which is the perfect PR comment.

Never want to remember it?

```bash
npx whouses --install-hook
```

Now every commit that touches CSS prints its blast radius by itself. It never blocks the commit —
it just makes sure nobody changes shared CSS blind again.

## "I want to rename this, but I'm scared"

```bash
npx whouses --rename .footer-note .card-note          # dry run, shows every line
npx whouses --rename .footer-note .card-note --write  # apply
```

```
.footer-note → .card-note  2 line(s) in 2 file(s)

src/app.css:5
  - .footer-note { font-size: 12px }
  + .card-note { font-size: 12px }
src/Card.jsx:1
  - <p className="footer-note">tiny</p>
  + <p className="card-note">tiny</p>
```

Dry run by default. Never touches a longer class that merely shares the prefix
(`.footer-note-small` stays put). And the part that matters:

```
1 site(s) build this class at runtime — NOT renamed, fix these by hand:
  src/Button.jsx:1  <button className={`btn btn-${type}`}/>

refusing to write. the rename would be half-applied: the CSS becomes .btn-success
while the site(s) above still build .btn-save at runtime.
```

**It refuses to finish a rename it cannot finish safely.** A half-applied rename — CSS renamed,
runtime call site still building the old name — is a silently broken app and the single worst
thing an automated refactor can do. Pass `--force` only once you've fixed those lines yourself.



---

# Escaping the monolith

The hardest part of a 5,000-line global stylesheet isn't understanding it — it's getting out of it.
`--extract` pulls a component's own rules into their own file:

```bash
npx whouses --extract src/Modal.jsx           # dry run
npx whouses --extract src/Modal.jsx --write   # apply
```

```
extract src/Modal.jsx → src/Modal.css

  move  .modal-title  src/global.css:4-7
  move  .modal-close  src/global.css:8
  stay  .btn          shared with src/Page.jsx
  stay  .modal        also overridden inside an at-rule — moving it would depend on import order
```

**It moves only what is exclusively yours.** A rule used by another component stays where it is —
silently relocating shared CSS is how you break three pages you never opened. And a class with an
`@media` override is never split across two files, because the cascade would then depend on import
order: a bug nobody would ever trace back to this tool.

Multi-line rules move whole, the origin stylesheet is left with balanced braces, and both are
verified by tests. Then it prints the one import line for you to paste.

Run it component by component and a monolith becomes a modular codebase, without a rewrite.

## License

MIT
