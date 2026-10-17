# DSH VS Code Bridge（demo）

把 **VS Code 暴露成一个 MCP server**，让 DeepSeek Harness（DSH）能：

- 读取你**此刻在看什么**（活动文件、光标、选中文本、可见范围、已打开文件）
- 直接读 **Problems 面板**（语言服务诊断），不用你手动复制报错
- 跳到指定文件的指定行
- 应用编辑（走 `WorkspaceEdit`，进撤销栈）
- **提出 diff 让你接受/拒绝**（在编辑器里并排看）
- 执行白名单内的编辑器命令（格式化、整理 import、保存全部）

零依赖、零构建：纯 JavaScript 扩展，`F5` 就能跑。

---

## 交互面（你能看到的部分）

这个扩展是**管道**，不是聊天面板——对话界面属于 DSH 自己（浏览器里的 Web GUI，或用 `dsh-vscode-panel` 这类扩展把 DSH 界面嵌进侧栏）。它自己只提供"确认它在工作"的最小界面：

| 位置 | 内容 |
|---|---|
| **状态栏右下角** | `🔌 DSH:37251 · N` —— 端口与已服务调用数。**点击弹菜单**：显示调用日志 / 复制 DSH bundle 配置 / 重启 / 停止。未运行时显示黄色警告底 |
| **「DSH Bridge 调用日志」面板** | 命令面板运行 `DSH Bridge: 显示调用日志`，或点状态栏。实时列出**每一次工具调用**：时间、工具名、✓/✗、耗时、参数、结果。内容**不截断**（单条上限 20000 字符，超出会标注）；每条可**展开/复制**，顶部有**全部展开 / 全部收起 / 清空** |
| **输出通道** | 「输出 → DSH Bridge」看到全过程日志（含 `tools/call` 的成败） |
| **启动通知** | 启动时弹一条，带「打开调用日志」「复制 DSH 配置」两个按钮 |

调日志面板是排查"DSH 到底有没有连上、调了什么"最直接的地方。

---

## 文件审核工作流（怎么得到"应用前审批"）

DSH 核心**没有**"改文件前先审批"这一层——它的编辑工具直接写盘，变更卡只是事后记录。**审批只能建在这座桥上**。做法是把权限收紧，让 agent 物理上写不了，就只能走提案：

```
/permission → 选 read-only 沙箱
    ├─ agent 用 DSH 自带的 write/edit → 被 OS 级拦住（连绕路都没有）
    └─ agent 唯一的落地通道 = 本桥的 show_diff / write_file(preview)
             ↓
        VS Code 弹出并排 diff
             ↓
        你按「接受」才落盘（走 WorkspaceEdit，进撤销栈）
        按「拒绝」什么都不发生
```

配合要点：

| 要点 | 说明 |
|---|---|
| **两边目录要一致** | 会话的 cwd（agent 写相对路径的地方）必须和 VS Code 打开的文件夹相同，否则你在 A 目录审、agent 在 B 目录想 |
| **`write_file` 默认就是提案** | `preview` 缺省为 `true`，所以 agent "新建文件"也天然要过你这一关 |
| **接受/拒绝两种入口** | ① agent 调 `diff_decision`；② 你在编辑器里按 `Ctrl+Shift+P` → `DSH Bridge: 接受/拒绝当前 diff`（**不要求先激活那个 diff 标签**，会扫描所有已打开的提案） |
| **两种决定都进调用日志** | 命令面板这条路也会记一笔（`diff_decision(命令面板:accept)`），所以"人按的"和"agent 调的"在日志里都能看到 |
| **已知差距** | 已支持**多文件 × 逐块**；尚未做的是"在一个 diff 视图里内联逐块按钮"——决定动作在侧栏 `DSH 审核` 面板里，不在 diff 编辑器里 |

---

## 审核面板：多文件 × 逐块

活动栏多了一个 **`DSH 审核`** 容器（图标：清单+对勾），里面是**待审改动**的树：

```
待审：2 个文件 · 5 块待决定
├── main.py            3 块 · D:\test_demo        [⧉ 打开 diff] [✓ 整文件接受] [✗ 整文件忽略]
│   ├── 第 3 行 · 修改 +1 -1     return 10                  ✓  ← 每块单独的接受/忽略
│   ├── 第 6 行 · 修改 +1 -1     已忽略 · return 20          ✗
│   └── 第 9 行 · 修改 +1 -1     return 30
└── new.py             新建 · 2 块 · D:\test_demo
    ├── 第 1 行 · 新增 +2 -0
    └── 第 3 行 · 新增 +1 -0
```

| 层级 | 操作 | 入口 |
|---|---|---|
| **块** | 接受这一块 / 忽略这一块 | 行内 ✓ / ✗ 图标，或右键菜单 |
| **文件** | 接受整个文件 / 忽略整个文件 / 打开 diff 预览 | 文件行的行内按钮 |
| **整批** | 批量接受 / 批量忽略 / 丢弃整批 / 刷新 | 视图标题栏按钮 |

**关键设计：决定与应用分离。**

- 每一个「接受/忽略」只记录状态，**不立刻写盘**
- **只有当一批里所有块都有结论时**，才按"原始文本 + 全部已接受的块"**一次性**算出每个文件的最终文本并落盘
- 原因：块的行号基于**原始文本**；如果逐块增量写盘，后面块的行号会因前面的写入而偏移，索引就失效了
- 落盘前有**版本守卫**：磁盘内容必须仍等于提案时的原文，否则判为冲突、**拒绝写入**并在提示里告知

其余决定入口仍然有效：diff 标签标题栏的 ✓/✗、右下角通知里的按钮、`Ctrl+Shift+P` 的 `DSH Bridge: 接受/拒绝当前 diff`（都作用于**整个文件**）。

---

## 目录结构

```
.
├── package.json               # 扩展清单（无 dependencies，不需要 npm install）
├── extension.js               # 入口：启动 MCP 服务端 + 注册命令 + 写发现文件
├── src/
│   ├── mcp-server.js          # MCP over HTTP 服务端（零依赖实现，协议子集）
│   ├── tools.js               # 8 个工具的 schema 与派发
│   ├── ide-vscode.js          # vscode API 适配层（唯一依赖 vscode 模块的文件）
│   └── ui.js                  # 状态栏项 + 调用日志面板
├── test/
│   └── protocol-test.cjs      # 协议层测试（不需要 VS Code，可直接 node 跑）
├── build/
│   ├── pack-vsix.ps1          # 打包 .vsix（不需要 @vscode/vsce、不需要联网）
│   └── vsix/                  # 打包暂存：extension/ + vsixmanifest + [Content_Types].xml
├── dsh-bundle/                # DSH 侧：配置型 bundle，让 DSH 连上这个 MCP server
│   ├── package.json
│   └── cordis.patch.yml
└── dsh-vscode-bridge-0.1.1.vsix   # 打包产物
```

---

## 一、跑扩展（需要你在 VS Code 里操作）

1. VS Code 打开本目录（`package.json` 所在目录）
2. 按 `F5` → 会开一个「扩展开发宿主」新窗口
3. 新窗口激活后，右下角提示 `DSH Bridge 已启动: http://127.0.0.1:37251/mcp（8 个工具）`
4. 连接信息也会写到该窗口工作区的 `.vscode/dsh-bridge.json`：

```json
{ "url": "http://127.0.0.1:37251/mcp", "token": "dsh-demo-token", "port": 37251, "pid": 12345, "tools": ["get_editor_state", "..."] }
```

可用命令（`Ctrl+Shift+P`）：

| 命令 | 作用 |
|---|---|
| `DSH Bridge: 启动 MCP 服务端` | 手动启动 |
| `DSH Bridge: 停止 MCP 服务端` | 停止 |
| `DSH Bridge: 复制连接配置（供 DSH bundle 使用）` | 把补丁片段复制到剪贴板 |
| `DSH Bridge: 接受/拒绝当前 diff` | 对当前 DSH 提案做决定 |

设置项：`dsh-bridge.port`（默认 37251）、`dsh-bridge.token`（默认 `dsh-demo-token`）、`dsh-bridge.autoStart`（默认 true）。
**端口或令牌改了，DSH 侧补丁也要同步改。**

---

## 二、接进 DSH

`dsh-bundle/` 是**配置型 bundle**（只有 patch、没有代码），它插入一条 `@deepseek-ai/dsh-mcp-client`：

```yaml
- id: mcp-vscode-bridge
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: vscode
    transport: streamable-http
    url: http://127.0.0.1:37251/mcp
    headers:
      Authorization: Bearer dsh-demo-token
    failOnStartupError: false
```

两种接入方式：

1. **Plugin Manager**（推荐）：GUI 侧栏 Plugins 面板 / `plugin_manager` 工具，安装 `dsh-bundle/` 这个包
2. **手动**：把上面那段追加到 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 的数组末尾

**验证**：模型侧的工具名是 `mcp__vscode__<tool>`。让 DSH 调用一次
`mcp__vscode__get_editor_state`，如果返回了你在 VS Code 里打开的文件路径，链路就通了。

---

## 三、8 个工具

| 工具 | 模型侧名字 | 背后 API |
|---|---|---|
| `get_editor_state` | `mcp__vscode__get_editor_state` | `window.activeTextEditor` + `tabGroups` |
| `list_open_editors` | `mcp__vscode__list_open_editors` | `window.tabGroups.all` |
| `get_diagnostics` | `mcp__vscode__get_diagnostics` | `languages.getDiagnostics()` |
| `open_file` | `mcp__vscode__open_file` | `showTextDocument` + `revealRange` |
| `apply_edit` | `mcp__vscode__apply_edit` | `WorkspaceEdit.replace`（要求 oldText 唯一） |
| `write_file` | `mcp__vscode__write_file` | **默认只出提案不落盘**（`preview:true`）；`preview:false` 才写盘。已有文件走 `WorkspaceEdit`（进撤销栈），新文件走 `workspace.fs` |
| `propose_changes` | `mcp__vscode__propose_changes` | **一次提交多个文件**，进入同一审核批次（多文件 × 逐块）。默认不逐个开 diff 标签 |
| `show_diff` | `mcp__vscode__show_diff` | `vscode.diff` + `TextDocumentContentProvider`。目标不存在时左侧用空虚拟文档，因此**新建文件也能提案** |
| `diff_decision` | `mcp__vscode__diff_decision` | 接受＝整份替换/新建并保存；拒绝＝丢弃。可传 `hunks: [0,2]` **只处理指定几块** |
| `run_command` | `mcp__vscode__run_command` | `commands.executeCommand`（**白名单**：格式化 / 整理 import / 保存全部） |

---

## 四、已验证 / 未验证（重要）

**已在本次开发中跑通（不需要 VS Code）**——`node test/protocol-test.cjs`，15/15 通过：

- MCP 握手：`initialize` 回显客户端协议版本、声明 tools 能力；`notifications/initialized` 返回 202
- `tools/list` 返回 8 个工具、schema 结构合法、名字集合正确
- `tools/call` 三条链路（读状态 / 应用编辑 / show_diff→diff_decision）参数正确透传到 IDE 层
- 错误分支：未知工具与缺参数走 `isError:true`（不是 JSON-RPC 错误）；未知方法 `-32601`；非法 JSON `400 + -32700`
- 传输与鉴权：错误令牌 / 无令牌 → 401；`GET /mcp` → 405；其他路径 → 404；batch → 数组响应

**尚未验证（需要你在真实环境确认）**：

1. **扩展在 VS Code 里能否正常激活并监听端口**——我没有 GUI，跑不了扩展宿主
2. **DSH 的 `dsh-mcp-client` 能否与这个手写服务端握手成功**——我是照着官方 spec 的传输子集实现的（POST 返回 `application/json`，不用 SSE）。DSH 用的是官方 `@modelcontextprotocol/sdk` 客户端，理论上接受单条 JSON 响应；**若不兼容，报错信息会出现在 DSH 启动日志里**，届时可以改成 SSE 响应或换用官方 SDK 重写传输层（只有 `src/mcp-server.js` 一个文件需要动）
3. **`.vsix` 打包**——需要 `@vscode/vsce`（要联网装）；demo 阶段直接 `F5` 跑不需要打包

---

## 五、安全说明

- 服务端**只绑定 127.0.0.1**，外部网络访问不到
- 所有请求要带 `Authorization: Bearer <token>`，令牌不匹配直接 401
- `run_command` 有白名单，不在名单里的命令一律拒绝
- `apply_edit` 要求 `oldText` 在文件中**唯一**，避免改错位置
- **默认令牌 `dsh-demo-token` 是明文固定值，仅适合本机 demo**。正式使用请改成随机串，并用 Loader 的 `!!js` 从环境变量读取，不要把密钥写进补丁或对话

---

## 六、后续可以往哪走

1. **让 diff 更好用**：给 diff 视图加 `CodeLens`（接受/拒绝按钮直接点在代码行上）、显示逐块变更
2. **ACP 路线**：本扩展再加一个形态——作为 ACP 客户端连 `dsh --profile acp`，就能在编辑器内部出对话面板（注意：DSH 的 ACP 是 automation-only，不使用编辑器的 fs/terminal）
3. **更细的上下文**：把当前选区/光标附近的符号通过 LSP 展开（调用 VS Code 的 `vscode.executeDefinitionProvider` 之类）
4. **多工作区 / 多窗口**：现在只取第一个工作区根目录写发现文件
5. **用官方 SDK 重写传输层**：换掉手写的 `mcp-server.js`，拿到 SSE、会话管理、通知等完整能力
