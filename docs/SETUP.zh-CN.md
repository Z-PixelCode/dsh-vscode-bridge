# DSH ↔ VS Code 接线操作手册

> 基于本机实测。所有结论都有出处（asar 里的定义、或实测输出），不是推测。

---

## 一、当前状态

| 组件 | 状态 |
|---|---|
| VS Code 扩展 `dsh-vscode-bridge` | 已装 **0.1.3**（8 个工具，监听 `127.0.0.1:37251`） |
| 桥的新版 **0.2.0** | ✅ 已打包在 `D:\vscode tool\dsh-vscode-bridge-0.2.0.vsix`，**尚未安装** |
| DSH 侧 bundle | ✅ 已写入 **web** 与 **desktop** 两个 profile 的 `cordis.patch.yml` |
| 效果 | ✅ **desktop profile 被热加载**（未重启 app），agent 已能直接调用 `mcp__vscode__*` |

0.2.0 相比 0.1.3 新增/修复：

| 项 | 说明 |
|---|---|
| **`write_file`**（第 9 个工具） | 新建/覆盖文件；`preview` 缺省 `true` → **只出 diff 提案，接受后才落盘**。这是"文件审核"的最后一块拼图 |
| 新建文件的 diff | `show_diff` 支持目标文件不存在（左侧用空虚拟文档） |
| 命令面板决定进日志 | 之前"人在编辑器里按接受/拒绝"在调用日志里看不到，现在会记一笔 `diff_decision(命令面板:accept)` |
| 不必先激活 diff 标签 | `接受/拒绝当前 diff` 会扫描所有已打开的提案，取最近的 |

---

## 二、三步验收（你需要动手的部分）

### 步骤 1：安装桥 0.2.0

```
Ctrl+Shift+X → 右上角 ... → Install from VSIX...
  → D:\vscode tool\dsh-vscode-bridge-0.2.0.vsix
然后 Ctrl+Shift+P → Developer: Reload Window
```

验证：右下角状态栏点 `🔌 DSH:37251` → **显示调用日志**，头部应显示 `工具数: 9`；或跑一次
`python dsh_bridge.py ping`（在 `D:\work\demo` 下），它会显示服务端版本 **v0.2.0**。

### 步骤 2：让两边的目录一致（**关键，不做这步审核没有意义**）

会话的 cwd 在**创建那一刻**固定，解析优先级是：

> 显式选中的 Workspace → 当前会话的 Workspace → **最近活跃的 Workspace** → 空白新会话页

你的 `~/.dsh` 里已经注册过 `default-workspace`（这一串会话用的就是它），所以新会话会继承它，**子进程 cwd 那个兜底永远轮不到**。

做法：在 DSH 面板/网页的**侧栏 Workspaces 区域**里选/添加 `D:\work\demo`，**然后在这个工作区下新建会话**。

验证：在新会话里让我"报一下你的工作目录"，或直接看我生成的文件落在哪。

### 步骤 3（推荐）：把新会话默认权限设成只读，让审批默认生效

DSH 核心**没有**"改文件前先审批"——它的写工具直接落盘。审批只能建在桥上，做法是**让我写不了**：

```
General settings → 新会话默认权限预设 → 选只读（read-only）沙箱
```

> 为什么不直接改 profile 补丁？`sandbox-policy` 那一行确实有"部署默认模式"，但**覆盖它会替换整份 config**（连 `workspaceRoot` 都要重述），改错会影响所有会话的工作区围栏。GUI 里点两下安全得多。

**代价要清楚**：默认只读之后，我在**任何**会话里都不能直接写文件（包括在 DSH 自己的工作区）。所有落地都得走桥的 `show_diff`/`write_file` → 你按接受。VS Code 关着时我就完全写不了。**不想这么极端就按会话切换**：`/permission` 只在需要审批的会话里切成只读。

---

## 三、文件审核工作流（拼好之后的样子）

```
你在面板/网页里跟我对话
        ↓
我改文件只有两条路：
  (a) DSH 自带 write/edit ── 只读沙箱下被 OS 级拦住 ❌
  (b) 桥的 show_diff / write_file(preview) ── 唯一通道 ✅
        ↓
VS Code 弹出并排 diff（原生 diff 引擎，不是简易面板）
        ↓
你按「接受」→ 走 WorkspaceEdit 落盘，**进撤销栈**
你按「拒绝」→ 什么都不发生
```

两种决定入口：

| 入口 | 说明 |
|---|---|
| 我调 `diff_decision` | 需要你在对话里说"接受/拒绝" |
| **你自己在编辑器里按** | `Ctrl+Shift+P` → `DSH Bridge: 接受当前 diff` / `拒绝当前 diff`。**不要求先激活那个 diff 标签** |

**已知差距**：目前是**整文件**接受/拒绝，**不支持逐 hunk**。DSH 核心没有 hunk 概念（我全库搜过），要做得在桥里另写 diff 计算 + 部分应用。这是与 Claude Code 插件最后一块差距。

---

## 四、坐标系统（最容易搞混的地方）

| 谁 | 按什么坐标干活 |
|---|---|
| **DSH 会话（我）** | 会话 cwd（相对路径的基准、默认 shell 工作目录） |
| **桥（MCP 工具）** | **绝对路径**，跟会话 cwd 完全无关 |
| **VS Code** | 打开的文件夹 |

所以"感知不到工作区"和"生成的文件落在 default-workspace"是**会话 cwd** 的问题；而桥的 `open_file`/`apply_edit` 一直是对的（它们收绝对路径）。**两者必须绑成同一个目录**，否则我在 A 目录提议、你在 B 目录审。

---

## 五、排错手册

| 症状 | 查这里 |
|---|---|
| 面板起不来 / `dsh not found` | `D:\work\demo\.vscode\settings.json` 里的 `dsh.desktopCommandPath`；扩展默认只在 `%LOCALAPPDATA%\Programs` 下探测，而 app 装在 `D:\` |
| 桥没监听了 | `%TEMP%\dsh-bridge-trace.log`（UTF-8，扩展每一步都写）；或 VS Code「输出 → DSH Bridge」 |
| 我想看桥被调了什么 | 状态栏 `🔌 DSH:37251` → **显示调用日志**（每条可展开/复制） |
| DSH 侧没出现 `mcp__vscode__*` | 检查 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里的 `mcp-vscode-bridge` 行；DSH 启动日志里找 mcp-client 的连接报错 |
| 文件落到 `default-workspace` | 步骤 2 没做——会话工作区还是旧的 |
| 报 `session/writer-held` | 同一会话被两个宿主同时驱动（app 与面板宿主）。**一个写者 + 多读者**是架构约束 |
| 端口是否在监听 | **不要用 `Get-NetTCPConnection`**（在受限 shell 里会误报"未监听"）→ 用 HTTP 探测：`Invoke-RestMethod http://127.0.0.1:37251/mcp ...` |

---

## 六、关键参数

| 项 | 值 |
|---|---|
| 桥的 MCP 端点 | `http://127.0.0.1:37251/mcp`（仅绑 loopback） |
| 令牌 | **留空即自动生成随机串**（存在本机，并写进 `.vscode/dsh-bridge.json`）；也可用 `dsh-bridge.token` 显式指定 |
| 桥的 9 个工具 | `get_editor_state` `list_open_editors` `get_diagnostics` `open_file` `apply_edit` `write_file` `show_diff` `diff_decision` `run_command` |
| 模型侧工具名 | `mcp__vscode__<tool>` |
| DSH 补丁位置 | `~/.dsh/profiles/{web,desktop}/cordis.patch.yml` |
| 桥的代码/打包 | `D:\vscode tool\`（`build\pack-vsix.ps1` 重新打包，注意 PS 5.1 需要 UTF-8 BOM） |
| 已验证的测试 | `node test\protocol-test.cjs` → 17 项全过（不需要 VS Code） |

---

## 七、还没做 / 待决定

| 项 | 说明 |
|---|---|
| 逐 hunk 接受 | 追平 Claude Code 的最后一块，需要桥里实现 hunk diff + 选择 UI |
| 薄侧栏扩展 | 让面板自动跟随 VS Code 文件夹（现在需要手动选工作区）。这要求扩展去调 DSH 的 host API 注册工作区，是那个第三方面板插件的先天短板 |
| `dsh-vscode-panel` 的名字冲突 | web profile 里有一行它自己的 `dsh-vscode-bridge`（认证中继用），和本项目同名但不同 id。刻意用了 `mcp-vscode-bridge` 避开 |
