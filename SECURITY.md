# Security notes

`dsh-memory-budget` is deliberately small: two Markdown files, one tool, one
prompt section. This page documents exactly what the code touches, so a reviewer
(or a `dsh.so` scan) can match findings against intent.

## What it reads and writes

- **Files**: `<dir>/MEMORY.md` and `<dir>/USER.md`, plus a `.bak` of the previous
  content and a short-lived `.tmp` file next to them. `dir` is the `dir` config
  value, or `<DSH_HOME>/memories` by default.
- **Nothing else.** No other paths are read or written; the plugin never walks
  the filesystem, never reads project sources, and never touches credentials.
- **No network.** The plugin makes no HTTP calls, opens no sockets, and has no
  telemetry. The only network traffic this repository produces is the `pnpm
  install` you run yourself.
- **No child processes, no `eval`, no dynamic `import()`** beyond the two host
  peers it declares (`@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`).

## Environment variables

`lib/store.js:246` reads three variables only to build the default directory
when no `dir` is configured:

```
base = homeDir || process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".dsh")
```

Setting `dir` (or passing `homeDir` in tests) bypasses it entirely.

## Why the scanner flags `fs.writeFileSync` (`lib/store.js:77`)

Writes are atomic and confined to the memory directory:

```js
const file = this.fileFor(target);                  // <dir>/MEMORY.md or <dir>/USER.md
const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
fs.writeFileSync(tmp, body, "utf8");                // write a fresh file
fs.renameSync(tmp, file);                           // swap it in
```

The preceding `copyFileSync(file, `${file}.bak`)` keeps the previous content.
A failed backup is swallowed on purpose: losing history must not block a memory
write. There is no append-in-place, so a crash leaves either the old file or the
new one, never a half-written one.

## Threat model

Memory content originates from the assistant itself, not from untrusted remote
input. The realistic risks are therefore:

1. **Self-poisoning** — a model writes a wrong or injected "fact" that keeps
   influencing later sessions. Mitigations: entries are plain text you can edit
   or delete at any time, `list` shows everything, and writes that would exceed
   the budget are rejected with the current entries attached.
2. **Prompt growth** — unbounded memory would silently inflate every request.
   Mitigations: hard character budgets (`memoryCharLimit` 4000, `userCharLimit`
   1500) enforced before any write, batch operations are validated against the
   final budget and committed atomically.
3. **Prompt-cache churn** — `refreshOnWrite: true` rebuilds the prompt section
   after each write, costing one prefix-cache miss. Set it to `false` for a
   frozen-at-startup snapshot.

The plugin does not scan memory content for "threat patterns"; the entries are
written by the model and read back by the model, so such scanning would mostly
flag the model's own summaries. Keep `dir` inside a directory you control if you
want to review changes with `git diff`.

## Reporting

Open an issue at https://github.com/chengzhixing/dsh-memory-budget/issues .
