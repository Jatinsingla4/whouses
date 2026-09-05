# Changelog

## 2.1.0

- `--version` / `-v` print the version. They previously printed the help screen.
- `--help` / `-h` show help. `-h` was previously parsed as a class name (`.-h`).
- A mistyped flag is now an error with a suggestion and exit code 2. `--orphan`
  previously printed help and exited 0, so it looked like a successful run that found
  nothing.
- `tracecss <unknown-command>` is an error instead of silently showing help.
- Help lists every command, says which ones write, and documents the exit codes.

## 2.0.0

**Upgrade if you use any 1.x version — they are deprecated for data loss.**

Adversarial testing against generated fixtures and 25 real projects found bugs that
destroyed files and bugs that hid usages. Both classes are fixed.

### Data loss and corruption

- `--extract --write` cut whole **lines**, so a rule sharing a line with a moved rule was
  deleted — a minified stylesheet was emptied to 0 bytes, and closing braces were split
  from their rules. It now cuts exact character offsets.
- `--extract --write` silently replaced an existing `Component.css`. It now refuses.
- `--extract` moved a class defined in two stylesheets, reversing the cascade. It now
  refuses.
- `--rename --write` did a whole-file regex replace, rewriting JS identifiers, comment
  prose and image paths (`const btn-primary =` does not parse). It now edits only the
  offsets the index recorded.
- `tracecss build` silently replaced a hand-written `.css`. It now refuses without
  `--force`.
- `tracecss` compile broke on a `)` inside a `@deprecated` message and stripped directive
  text out of strings and comments.
- `--install-hook` appended shell into a Python `pre-commit`, blocking every commit in
  the repo. It now checks the shebang.

### Missed usages (each one advised deleting live CSS)

- An apostrophe in JSX prose, a quote in a regex literal, or a backtick in a comment
  swallowed the rest of the file. Source is now read with a real lexer.
- `${...}` with two levels of braces; suffix interpolation `` `${x}-item` ``.
- Destructured CSS-module bindings; unquoted `class=` attributes; `.md` files.
- Any rule following a `;`-terminated at-rule (`@charset`, `@import`, `@use`) was
  dropped — this hit every Tailwind v4 and SCSS file.
- Escaped class names (`.md\:flex`, `.w-1\/2`) were truncated to `.md` and `.w-1`.
- A `//` inside `url(https://…)` ate the rest of an `.scss` file or `<style>` block.

### Correctness and scale

- Nested rules are attributed to their own line, not the declaration above them.
- No more phantom classes from unquoted declaration values.
- `--vars` ignores comments and understands `@property`.
- The 2MB read cap silently skipped large stylesheets; it is now 32MB, and a file that
  cannot be read is reported on every command instead of dropped in silence.
- A broad interpolation like `` `u-${k}` `` stored a row per class per file. 10k classes
  across 3k components went from 91.9s / 2.09GB to 0.7s / 71MB.
- A 1,000,000-line stylesheet went from silently skipped to 3.6s.
- Build and vendor trees (`release`, `target`, `Pods`, `.vercel`, …) are skipped.

## 1.1.0

- Read CSS from `<style>` blocks in HTML, Vue, Svelte and Astro.

## 1.0.1

- `--vars`: find custom properties defined in JS (inline styles, `setProperty`,
  `next/font`), and treat Tailwind v4 `@theme` tokens as used.

## 1.0.0

Initial release.
