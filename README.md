# DSH VS Code Bridge

Run **[DeepSeek Harness](https://github.com/deepseek-ai)** (DSH) inside VS Code: a native chat panel in the sidebar, plus an **approval gate** that turns every AI file edit into a reviewable diff you accept or reject.

> 中文文档：[README.zh-CN.md](README.zh-CN.md)

**Source**: [github.com/Z-PixelCode/dsh-vscode-bridge](https://github.com/Z-PixelCode/dsh-vscode-bridge) ·
[Issues](https://github.com/Z-PixelCode/dsh-vscode-bridge/issues) ·
[Changelog](CHANGELOG.md) ·
[Architecture](docs/ARCHITECTURE.md) ·
[Contributing](CONTRIBUTING.md)

[![CI](https://github.com/Z-PixelCode/dsh-vscode-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Z-PixelCode/dsh-vscode-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85-blue.svg)](https://code.visualstudio.com/)

---

## What it does

The extension has two halves that work together.

**1. A sidebar chat (`DSH 对话`)** — one `dsh` child process per VS Code window, so multiple windows never interfere. Model, reasoning effort and edit permission are switchable from the composer; elapsed time, turns, tokens, cache-hit ratio and context usage are shown live.

**2. An MCP bridge** — DSH gets real editor context instead of guesses:

| Tool | What the agent gets |
|---|---|
| `get_editor_state` | active file, cursor, selection, visible range, language, open editors |
| `get_diagnostics` | the **Problems** panel (language-server diagnostics), no copy-paste |
| `read_file` / `glob` / `grep` | reading inside the workspace |
| `write_file` / `apply_edit` / `propose_changes` | edits — **gated**, see below |
| `diff_decision` / `get_review_status` | inspecting the review queue |
| `run_command` | a whitelist of editor commands (format, organize imports, save all) |

**3. The approval gate** — the point of the whole thing:

- The bridge's write tools **never touch disk directly**. They create a proposal, open a native diff, and wait.
- Accept or reject at **three levels**: per hunk, per file, or the whole batch — from the chat panel or from the diff editor title bar.
- Declining is safe: a stale proposal is refused rather than overwriting a file that changed underneath it.
- Every applied change is recorded **per conversation turn**, and keeps **before ↔ after snapshots** — so clicking a line shows that one change in isolation, correct even after later edits or your own manual edits.

## Requirements

- **VS Code ≥ 1.85**
- **DeepSeek Harness installed** — the extension spawns its CLI (`dsh`). No runtime is bundled.
- Nothing else. **Zero npm dependencies, no build step** — plain JavaScript, `F5` runs it.

### Where the extension finds `dsh`

In order:

1. The `dsh-bridge.launcher` setting (use this if auto-detection fails)
2. The `DSH_LAUNCHER` environment variable
3. Common install locations
   - Windows: `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`, `%ProgramFiles%\DeepSeek Harness\...`, `C:\DeepSeek Harness\...`, `D:\DeepSeek Harness\...`
   - macOS: `/Applications/DeepSeek Harness.app/Contents/resources/runtime/cli/bin/dsh`, `/usr/local/bin/dsh`
   - Linux: `/opt/DeepSeek Harness/resources/runtime/cli/bin/dsh`, `~/.local/bin/dsh`, `/usr/local/bin/dsh`
4. `dsh` on `PATH`

If it still cannot start, the chat panel reports the failure and the **Output → DSH Bridge** channel has the details.

## Install

- **Marketplace**: search **DSH VS Code Bridge**, or
  `code --install-extension Z-PixelCode.dsh-vscode-bridge`
- **From a VSIX**: `code --install-extension dsh-vscode-bridge-<version>.vsix`
- After installing a new version: **Developer: Reload Window**. The version chip in the chat header tells you which build is actually running.

## Quick start

1. Open a folder in VS Code — that folder becomes the agent's working directory.
2. Open the **DSH 对话** container in the activity bar.
3. Type a message and press Enter.
4. The agent proposes file changes → a diff opens and the bar above the input shows `待审 N 个文件` with **全部接受 / 全部忽略**.
5. Accept per hunk, per file, or all at once. The record lands in the conversation as a per-turn “已编辑 N 个文件” card.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `dsh-bridge.launcher` | `""` | Path to `dsh`. Empty = auto-detect (above), or run **`DSH: 设置 dsh 启动器路径`** from the command palette. |
| `dsh-bridge.profile` | `sdk` | Profile passed to `dsh`. |
| `dsh-bridge.autoStart` | `true` | Start the MCP bridge on activation. |
| `dsh-bridge.port` | `37251` | Local MCP endpoint (bound to `127.0.0.1` only). |
| `dsh-bridge.token` | `""` | Empty = **a random token is generated once** and stored locally; an existing token in `.vscode/dsh-bridge.json` is reused on upgrade. |
| `dsh-bridge.chat.model` | `deepseek-flash` | Model for the sidebar chat. |
| `dsh-bridge.chat.reasoningEffort` | `""` | Reasoning effort. |
| `dsh-bridge.chat.permissionMode` | `""` (read-only) | `read-only` keeps the sandbox locked; `workspace-write` lets the agent write **without** review. |
| `dsh-bridge.reviewGate` | `true` | Bridge writes become proposals. |
| `dsh-bridge.agentCanApprove` | `false` | Let the agent accept its own proposals. Leave off unless you want no gate at all. |
| `dsh-bridge.chat.hideTools` | `["*get_review_status*"]` | Tool cards kept out of the transcript. `["*"]` hides all of them. |
| `dsh-bridge.chat.streamReplay` | `true` | Replay streamed messages; turn off for instant text. |
| `dsh-bridge.changeTimeline` | `false` | Also register changes in the VS Code Timeline. |

## Example `settings.json`

```jsonc
{
  // point at your install if auto-detection misses it
  "dsh-bridge.launcher": "C:\\Program Files\\\\DeepSeek Harness\\\\resources\\\\runtime\\\\cli\\\\bin\\\\dsh.cmd",
  "dsh-bridge.profile": "sdk",

  // sidebar chat defaults
  "dsh-bridge.chat.model": "deepseek-flash",
  "dsh-bridge.chat.reasoningEffort": "medium",

  // keep every write behind the gate
  "dsh-bridge.chat.permissionMode": "read-only",
  "dsh-bridge.reviewGate": true,
  "dsh-bridge.agentCanApprove": false,

  // quieter transcript
  "dsh-bridge.chat.hideTools": ["*get_review_status*", "*get_editor_state*", "read", "glob"]
}
```

## How approval works

Three switches decide how much autonomy the agent has:

| | `permissionMode` | `reviewGate` | `agentCanApprove` |
|---|---|---|---|
| Every change needs your click | `read-only` | `true` | `false` |
| Agent writes directly | `workspace-write` | — | — |
| Agent may accept its own proposals | `read-only` | `true` | `true` |

The sandbox mode governs the agent's **native** tools; the review gate governs the **bridge** tools. Only `read-only` + gate + no self-approval guarantees nothing is written until you say so.

## Troubleshooting

| Symptom | Where to look |
|---|---|
| Chat says it cannot start | **Output → DSH Bridge**; set `dsh-bridge.launcher` |
| Buttons do nothing | The webview script failed to load — the Output channel logs the view being resolved |
| Edits were written without review | Check `permissionMode` (`workspace-write` bypasses the gate) |
| A proposal was refused as stale | The file changed after the proposal; ask the agent to re-propose |

Trace file: `%TEMP%\dsh-bridge-trace.log` (Windows) / `$TMPDIR/dsh-bridge-trace.log`.

## Architecture

```
extension.js              activation, commands, status bar, overlay wiring
src/
  chat-ui.js              sidebar chat: webview HTML + dsh child lifecycle
  chat-model.js           pure logic: events → entries, markdown, stats, sessions
  sdk-client.js           DSH SDK stdio client (newline-delimited JSON-RPC)
  ide-vscode.js           VS Code adapter + single owner of review batches
  review.js               hunk/batch model (pure)
  review-ui.js            review commands
  change-store.js         before/after snapshots (pure)
  timeline.js             native diff + optional Timeline registration
  tools.js                MCP tool dispatcher (the review gate lives here)
  mcp-server.js           local HTTP MCP endpoint
  bridge-overlay.js       generates the `--patch` overlay that mounts the bridge
```

Design rules worth keeping:

- **Pure logic lives in `*-model.js` / `*-store.js` / `review.js`** so it can be unit-tested without VS Code.
- **The extension side must never touch the DOM.** A test fails if `document.` / `window.` appears outside the webview HTML — a stray `document.getElementById` in a `session.status` callback once broke the entire status path.
- **The webview script is embedded in a template literal**, so `\n` and `\s` inside it must be written `\\n` and `\\s`. A test parses the emitted script to catch this.

## Tests

```bash
node build/run-tests.cjs       # all suites
node test/chat-model-test.cjs  # a single suite
```

Suites cover pure logic, protocol contracts, webview HTML (including a real parse of the emitted script), and an **activation smoke test** that runs `activate()` against a fake `vscode` API.

## Contributing

Issues and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). This project was built iteratively against a real DSH install; bug reports with a concrete symptom (“after accepting, the box disappears”) are the most useful kind.

## License

[MIT](LICENSE)
