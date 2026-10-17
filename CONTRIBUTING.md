# Contributing

Thanks for taking a look. This extension was built iteratively against a real DSH install, so the codebase carries a lot of hard-won specifics — the notes below are the ones that matter most.

## Getting started

```bash
git clone https://github.com/Z-PixelCode/dsh-vscode-bridge
cd dsh-vscode-bridge
node build/run-tests.cjs      # all suites, no dependencies to install
```

Open the folder in VS Code and press `F5` to launch an Extension Development Host. There is **no build step** and **no npm dependency** — an edit is live after `Developer: Reload Window` (or the reload button in the debug toolbar).

## Before opening a PR

1. `node build/run-tests.cjs` is green.
2. `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"` parses.
3. If you changed UI behaviour, add or update an assertion. Suites are cheap; regressions here have historically been visible to users within minutes.

## Where to put what

| Kind of change | Where |
|---|---|
| Pure logic (parsing, marking up, statistics, snapshots) | `src/*-model.js`, `src/review.js`, `src/change-store.js` — **no `vscode` import** |
| VS Code API usage | `src/ide-vscode.js`, `extension.js`, `src/review-ui.js` |
| Sidebar chat UI (HTML/CSS/webview script) | `src/chat-ui.js` |
| MCP tools | `src/tools.js` (the review gate lives here) |

## Four traps that have bitten us

1. **The extension side must not touch the DOM.** A leftover `document.getElementById` inside a `session.status` callback threw on every status notification, so `postMeta()` never ran and every button in the panel went dead. `test/activation-test.cjs` now fails if `document.` / `window.` appears outside the webview HTML.

2. **The webview script lives inside a template literal.** `'\n'` and `/\s/` written as `'\n'` / `/\s/` inside that literal get evaluated by the *outer* template, producing a real newline or a bare `s` — the emitted script then either fails to parse (all buttons dead) or silently misbehaves. Write `\\n` / `\\s` in the source. `test/webview-html-test.cjs` parses the emitted script to catch it.

3. **Rebuilding a DOM node loses whatever you appended into it.** Streaming updates replace the whole bubble node; anything nested inside (tool cards) must be re-appended by id. `upsert()` keeps `host.ids` for exactly this reason.

4. **Two owners of the same state is a bug.** Review batches are owned by `src/ide-vscode.js`; settings are the single source of truth for permissions. Do not mirror them.

## Reporting bugs

The most useful report is a concrete symptom plus what you expected:

> “After I accept a review, the box above the input disappears.” — that is enough to find it.

If you can, include:

- the version chip value from the chat header (e.g. `v0.15.3`)
- the tail of **Output → DSH Bridge** (or `%TEMP%\dsh-bridge-trace.log`)
- whether you are on `read-only` or `workspace-write`

## Commit style

Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`). Keep the *why* in the body — several fixes here only make sense with the story attached.
