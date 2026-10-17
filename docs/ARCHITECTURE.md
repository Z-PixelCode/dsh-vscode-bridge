# Architecture

## The two halves

```
┌──────────────────────── VS Code window ────────────────────────┐
│                                                                │
│  DSH 对话 (webview)                      MCP HTTP endpoint     │
│    │  postMessage                          ▲                   │
│    ▼                                       │                   │
│  chat-ui.js  ──spawns──►  dsh --profile sdk --patch <overlay>  │
│    │                          │ (stdio JSON-RPC)               │
│    │                          ▼                                │
│    │                     DSH agent ──MCP tools──► tools.js     │
│    │                                                     │      │
│    └────────────── review batch ◄── ide-vscode.js ◄──────┘      │
│                         │                                      │
│                         ▼                                      │
│                   human accepts → write to disk                │
└────────────────────────────────────────────────────────────────┘
```

- **The bridge** (`mcp-server.js` + `tools.js`) exposes the editor to the agent over MCP.
- **The chat UI** (`chat-ui.js` + `sdk-client.js`) spawns `dsh` per window and renders the conversation.
- **The review gate** (`ide-vscode.js` + `review.js`) sits between "the agent wants to write" and "disk changes".

## Why the bridge is injected with `--patch`

The shipped `sdk` profile has no `mcp-vscode-bridge` row, so an agent running under it either cannot write at all (read-only sandbox) or writes natively without review. Rather than editing the user's `$DSH_HOME`, the extension generates a small overlay patch into `globalStorageUri` and passes it as `dsh --patch <file>`:

```yaml
- insert:
    - id: mcp-vscode-bridge
      name: '@deepseek-ai/dsh-mcp-client'
      config: { url: 'http://127.0.0.1:<port>/mcp', token: '<token>' }
```

Notes that cost time to learn:

- A bare `- id: X` means **override an existing entry** → `patch: entry "X" not found`. Inserting requires the `- insert:` form.
- Values are YAML: anything starting with an indicator character (`@`, `*`, `&`, `-` …) or containing `: ` must be quoted. `src/bridge-overlay.js` has `scalar()` for this and a test to keep it honest.

## Event flow (chat)

`session.event` notifications carry whole messages — **there are no delta events**. `assistant/message` includes a `stream` record (`reasoning-chunks` / `text-chunks` / `tool-call-chunks`) which `replayPlan()` turns back into a readable typing effect. Turn statistics come from `request/context` (context window) and `request/header` (max tokens) plus the usage counters on each message.

`session.status` drives the status line, and **must stay cheap and exception-free**: it runs on every status notification, and throwing there silently breaks the whole panel.

## Session identity

`sessionId` must be globally unique in DSH's persistent store, so a reused id makes `agents.create` fail with `session "x" already exists`. The UI keeps its own conversation ids and appends a per-child **epoch**; on collision it retries inside the *same* conversation rather than silently starting a new one.

## Review semantics

| Layer | Owner | Governs |
|---|---|---|
| Sandbox mode (`permissionMode`) | DSH child env | the agent's **native** tools |
| Review gate (`reviewGate`) | `tools.js` dispatcher | the **bridge** write tools |
| Self-approval (`agentCanApprove`) | `tools.js` | whether the agent may accept proposals |

Only `read-only` + gate + no self-approval guarantees nothing is written without a human click. A proposal is a single accumulating **queue**; `batchId` changes only when the queue empties. Accepting is per-file-settled so that accepting one file does not wait for the rest.

Stale proposals are refused by comparing the on-disk text with the text captured at proposal time — silently overwriting a file someone else changed is worse than an error message.

## Change snapshots

`change-store.js` keeps **before and after** content for each applied change. Storing only "before" would force the diff's right side to be the *current* file, which mixes in later turns and your own edits. Bounded by per-file and global caps plus a size limit.

## Testing strategy

| Layer | How it is tested |
|---|---|
| Pure logic | direct unit tests (`chat-model`, `review`, `change-store`, `bridge-overlay`) |
| Protocol contracts | fake transports (`sdk-client`, `protocol`) |
| Generated webview HTML | static assertions **plus** a real parse of the emitted script |
| Activation | `activate()` against a fake `vscode` API (`activation-test`) |

The activation smoke test exists because a `ReferenceError` during registration once killed every command and view while the bridge kept running — and the `try/catch` swallowed the error into a log file.
