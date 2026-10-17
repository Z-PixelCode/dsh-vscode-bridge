# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.17.0] - 2026-10-16

### Added
- 命令 **`DSH: 设置 dsh 启动器路径`**：弹出选择器（自动探测 / 手动选文件），分别写入工作区或用户设置。
- 所有设置项补上**示例与可选值**；README 新增 `settings.json` 配置示例。

### Changed
- **MCP 令牌不再有固定默认值**：空值时自动生成 24 字节随机令牌并存在本机；
  升级时沿用工作区 `.vscode/dsh-bridge.json` 里已有的 token，不打断现有环境。
- `dsh-bundle/cordis.patch.yml` 的固定 token 改为 `<YOUR_TOKEN>` 占位符。

## [0.16.0] - 2026-10-16

首次准备对外发布（商城 + 开源）。

### Added
- **`dsh-bridge.launcher` / `dsh-bridge.profile` 设置**，并自动探测 `dsh`：
  环境变量 `DSH_LAUNCHER` → 常见安装目录（Windows / macOS / Linux）→ `PATH`。
  （之前是硬编码的绝对路径，别人装上起不来。）
- 商城图标 `assets/icon.png`（128×128）、完整的发布元数据（publisher / repository / bugs / keywords / categories / galleryBanner）。
- 开源基础设施：`README.md`（EN）+ `README.zh-CN.md`、`CONTRIBUTING.md`、`docs/ARCHITECTURE.md`、
  `docs/PUBLISHING.md`、`LICENSE`、`CHANGELOG.md`、`.gitignore`、`.vscodeignore`、`.github/workflows/ci.yml`。
- 统一测试入口 `node build/run-tests.cjs`（CI 与本机共用）。

### Changed
- 打包排除规则与 `.vscodeignore` 对齐（`test/`、`docs/`、`build/`、`.github/` 不进安装包）。

## [0.15.3] - 2026-10-16

### Fixed
- **流式重建导致执行日志丢失**：气泡节点被重建后，已并入思考区的工具卡会按 id 重新挂回（以前会出现"计数在、日志没了"）。

## [0.15.2] - 2026-10-16
### Changed
- 并进思考区的工具卡**默认展开**，展开思考即可看到执行内容。

## [0.15.1] - 2026-10-16
### Added
- 工具卡折叠区内提供「打开文件」入口（上游会截断工具结果，完整内容在磁盘上）。

## [0.15.0] - 2026-10-16
### Changed
- 工具卡**并进上一条 AI 气泡的「思考过程」折叠区**，气泡头显示 `N 次工具调用（read ×3, glob）`，不再铺满对话。

## [0.14.5] - 2026-10-16
### Changed
- 输入框上方的框**只放待审提案**；已落盘的记录在对话里按轮次的卡片上（消除重复）。

## [0.14.4] - 2026-10-16
### Added
- 思考块**生成中自动展开、生成完自动折叠**；用户手动关过则尊重其选择。
- 只有本来就贴着底部时才自动跟随滚动（翻历史不再被拽走）。

## [0.14.0] - 2026-10-16
### Added
- **改动快照**：每处改动同时保留「改动前 / 改动后」两份内容，点开就是那一次改动的**隔离 diff**（不受后续修改与行号漂移影响）。
- 可选的 VS Code **时间线**登记（`dsh-bridge.changeTimeline`，默认关闭）。

## [0.13.0] - 2026-10-16
### Added
- **按轮次记录改动**：每一轮一张「已编辑 N 个文件」卡片，落在该轮对话末尾；历史轮次的卡片随历史上移。

## [0.12.0] - 2026-10-16
### Changed
- 状态与计时**全部移到输入框上方那一行**（空闲 / 启动中 / 深度求索中，用时 / 已完成，本轮用时），移除顶部状态芯片。

## [0.11.0] - 2026-10-16
### Added
- 对话级「本次改动了哪些文件」卡片（每文件 `+A -R`，点击跳到改动处）。

## [0.10.0] - 2026-10-16
### Added
- 侧栏**原生对话**（webview）：每个 VS Code 窗口一个 `dsh --profile sdk` 子进程，多窗口互不干扰。
- 对话可选模型 / 思考强度 / 编辑权限，实时状态与 token 用量。

## [0.9.0] - 2026-10-16
### Added
- 「待审改动」审核面板（按块 / 按文件 / 整批三级），跨文件批次与 diff 标签。
- **审核门**：桥的写操作一律先转成提案，由人点接受。

## [0.1.0] - 2026-10-16
### Added
- 初始版：MCP server + VS Code 上下文 / Problems / 跳转 / 应用编辑 / diff 提案 / 白名单命令。
