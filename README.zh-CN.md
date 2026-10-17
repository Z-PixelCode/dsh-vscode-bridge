# DSH VS Code Bridge

把 **DeepSeek Harness（DSH）** 搬进 VS Code：侧栏里的原生对话面板，加一道**审核门**——AI 的每一处文件改动都变成可接受/拒绝的 diff。

> English docs: [README.md](README.md)

**源码**：[github.com/Z-PixelCode/dsh-vscode-bridge](https://github.com/Z-PixelCode/dsh-vscode-bridge) ·
[问题反馈](https://github.com/Z-PixelCode/dsh-vscode-bridge/issues) ·
[更新日志](CHANGELOG.md) ·
[架构说明](docs/ARCHITECTURE.md) ·
[参与贡献](CONTRIBUTING.md)

[![CI](https://github.com/Z-PixelCode/dsh-vscode-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Z-PixelCode/dsh-vscode-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85-blue.svg)](https://code.visualstudio.com/)

---

## 它做什么

扩展由两半组成，配合工作：

**① 侧栏对话（`DSH 对话`）** —— **每个 VS Code 窗口一个 `dsh` 子进程**，多窗口互不干扰。模型、思考强度、编辑权限都可在输入框上方切换；用时、轮次、token、缓存命中率、上下文占用实时显示。

**② MCP 桥** —— 让 DSH 拿到**真实的编辑器上下文**，而不是靠猜：

| 工具 | agent 能拿到什么 |
|---|---|
| `get_editor_state` | 活动文件、光标、选中文本、可见范围、语言、已打开文件 |
| `get_diagnostics` | **Problems 面板**（语言服务诊断），不用你复制粘贴报错 |
| `read_file` / `glob` / `grep` | 工作区内读取 |
| `write_file` / `apply_edit` / `propose_changes` | 写操作 —— **走审核门**，见下 |
| `diff_decision` / `get_review_status` | 查看审核队列 |
| `run_command` | 白名单编辑器命令（格式化、整理 import、保存全部） |

**③ 审核门** —— 这是整个东西的重点：

- 桥的写工具**从不直接落盘**：先生成提案、打开原生 diff、等你决定。
- **三级粒度**：按块（hunk）/ 按文件 / 整批，在对话面板和 diff 标题栏都能操作。
- 拒绝是安全的：提案若已过期（文件被改过）会被**拒绝覆盖**，而不是盖掉新内容。
- 每处已落盘的改动**按轮次记录**，并保留**改动前 ↔ 改动后**两份快照 —— 点开就是那一次改动的隔离 diff，后面再改、你再手动改都不影响它。

## 环境要求

- **VS Code ≥ 1.85**
- **本机已安装 DeepSeek Harness** —— 扩展会去拉起它的命令行 `dsh`，不内置运行时。
- 没了。**零 npm 依赖、零构建步骤**，纯 JavaScript，`F5` 就能跑。

### 扩展在哪里找 `dsh`

按顺序：

1. 设置项 `dsh-bridge.launcher`（自动探测失败时填这个）
2. 环境变量 `DSH_LAUNCHER`
3. 常见安装目录
   - Windows：`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`、`%ProgramFiles%\DeepSeek Harness\...`、`C:\DeepSeek Harness\...`、`D:\DeepSeek Harness\...`
   - macOS：`/Applications/DeepSeek Harness.app/Contents/resources/runtime/cli/bin/dsh`、`/usr/local/bin/dsh`
   - Linux：`/opt/DeepSeek Harness/resources/runtime/cli/bin/dsh`、`~/.local/bin/dsh`、`/usr/local/bin/dsh`
4. `PATH` 上的 `dsh`

还是起不来时，对话面板会显示失败原因，**输出 → DSH Bridge** 通道里有细节。

## 安装

- **商城**：搜索 **DSH VS Code Bridge**，或
  `code --install-extension Z-PixelCode.dsh-vscode-bridge`
- **直接下载**：从 [Releases](https://github.com/Z-PixelCode/dsh-vscode-bridge/releases/latest) 拿 VSIX，然后
  `code --install-extension dsh-vscode-bridge-<版本>.vsix`
- **装了新版本后必须 `Developer: Reload Window`**。对话面板顶部的版本芯片会告诉你实际在跑哪一版。

## 快速上手

1. 在 VS Code 里打开一个文件夹（该文件夹就是 agent 的工作目录）。
2. 从活动栏打开 **DSH 对话** 容器。
3. 输入一句话回车。
4. agent 提出文件改动 → 自动弹出 diff，输入框上方出现 `待审 N 个文件` 与 **全部接受 / 全部忽略**。
5. 按块、按文件或整批接受。记录会以"已编辑 N 个文件"卡片落在**那一轮对话的末尾**。

## 设置项

| 设置 | 默认 | 作用 |
|---|---|---|
| `dsh-bridge.launcher` | `""` | `dsh` 路径。留空 = 自动探测（见上）；也可在命令面板跑 **`DSH: 设置 dsh 启动器路径`**。 |
| `dsh-bridge.profile` | `sdk` | 传给 `dsh` 的 profile。 |
| `dsh-bridge.autoStart` | `true` | 激活时启动 MCP 桥。 |
| `dsh-bridge.port` | `37251` | 本地 MCP 端点（仅绑定 `127.0.0.1`）。 |
| `dsh-bridge.token` | `""` | 留空 = **首次自动生成随机令牌**并存在本机；升级时沿用已有 `.vscode/dsh-bridge.json` 里的 token。 |
| `dsh-bridge.chat.model` | `deepseek-flash` | 侧栏对话用的模型。 |
| `dsh-bridge.chat.reasoningEffort` | `""` | 思考强度。 |
| `dsh-bridge.chat.permissionMode` | `""`（只读） | `read-only` 锁死沙箱；`workspace-write` 会让 agent **绕过审核**直接写。 |
| `dsh-bridge.reviewGate` | `true` | 桥的写操作转成提案。 |
| `dsh-bridge.agentCanApprove` | `false` | 允许 agent 自己接受提案。除非你不想要审核，否则别开。 |
| `dsh-bridge.chat.hideTools` | `["*get_review_status*"]` | 不在对话里显示的工具卡。填 `["*"]` 则全部隐藏。 |
| `dsh-bridge.chat.streamReplay` | `true` | 重放流式消息；关掉则文字一次性出现。 |
| `dsh-bridge.changeTimeline` | `false` | 同时登记到 VS Code 时间线。 |

## 配置示例（settings.json）

```jsonc
{
  // 自动探测找不到就显式指定
  "dsh-bridge.launcher": "C:\\Program Files\\\\DeepSeek Harness\\\\resources\\\\runtime\\\\cli\\\\bin\\\\dsh.cmd",
  "dsh-bridge.profile": "sdk",

  // 侧栏对话默认值
  "dsh-bridge.chat.model": "deepseek-flash",
  "dsh-bridge.chat.reasoningEffort": "medium",

  // 每处改动都要我点头
  "dsh-bridge.chat.permissionMode": "read-only",
  "dsh-bridge.reviewGate": true,
  "dsh-bridge.agentCanApprove": false,

  // 让对话安静些
  "dsh-bridge.chat.hideTools": ["*get_review_status*", "*get_editor_state*", "read", "glob"]
}
```

## 审核到底怎么生效

三个开关决定 agent 的自主程度：

| | `permissionMode` | `reviewGate` | `agentCanApprove` |
|---|---|---|---|
| 每处改动都要你点一下 | `read-only` | `true` | `false` |
| agent 直接写盘 | `workspace-write` | — | — |
| agent 可自己接受提案 | `read-only` | `true` | `true` |

沙箱模式管的是 agent 的**原生**工具；审核门管的是**桥**的工具。只有 `read-only` + 审核门 + 禁止自审 这一组，才能保证"你没点之前，磁盘不会被改"。

## 排障

| 现象 | 去哪看 |
|---|---|
| 对话说启动失败 | **输出 → DSH Bridge**；设置 `dsh-bridge.launcher` |
| 按钮全都没反应 | webview 脚本没加载起来 —— 输出通道里有视图解析记录 |
| 改动没经审核就落盘了 | 查 `permissionMode`（`workspace-write` 会绕过审核门） |
| 提案被拒（过期） | 文件在提案之后被改过；让 agent 重新提案 |

追踪文件：`%TEMP%\dsh-bridge-trace.log`（Windows）/ `$TMPDIR/dsh-bridge-trace.log`。

## 代码结构

```
extension.js              激活、命令、状态栏、叠层装配
src/
  chat-ui.js              侧栏对话：webview HTML + dsh 子进程生命周期
  chat-model.js           纯逻辑：事件→条目、markdown、统计、会话
  sdk-client.js           DSH SDK stdio 客户端（换行分隔的 JSON-RPC）
  ide-vscode.js           VS Code 适配层 + 审核批次的唯一所有者
  review.js               块/批次模型（纯）
  review-ui.js            审核相关命令
  change-store.js         改动前/后快照（纯）
  timeline.js             原生 diff + 可选时间线登记
  tools.js                MCP 工具分发（审核门就在这层）
  mcp-server.js           本地 HTTP MCP 端点
  bridge-overlay.js       生成把桥挂进 profile 的 `--patch` 叠层
```

几条**必须守住**的设计约束：

- **纯逻辑放 `*-model.js` / `*-store.js` / `review.js`**，这样不用 VS Code 就能单测。
- **扩展侧绝不能碰 DOM**。有一条测试专门盯着：webview HTML 之外出现 `document.` / `window.` 就失败——曾经有一句 `document.getElementById` 留在 `session.status` 回调里，把整条状态通道炸掉了。
- **webview 脚本是嵌在模板字符串里的**，所以里面的 `\n`、`\s` 必须写成 `\\n`、`\\s`。有测试会真正解析生成的脚本，专门抓这个。

## 测试

```bash
node build/run-tests.cjs      # 全部
node test/chat-model-test.cjs # 单个
```

覆盖：纯逻辑、协议契约、webview HTML（含对生成脚本的真实解析）、以及一个用假 `vscode` API 跑真实 `activate()` 的**激活冒烟测试**。

## 参与贡献

欢迎 issue 和 PR，见 [CONTRIBUTING.md](CONTRIBUTING.md)。这个项目是**对着真实 DSH 一轮轮改出来的**——带具体现象的问题描述（"接受完那个框就消失了"）最有用。

## 许可

[MIT](LICENSE)
