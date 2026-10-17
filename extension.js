'use strict';
/**
 * DSH VS Code Bridge —— 扩展入口
 *
 * 激活后在 127.0.0.1 上启动一个 MCP over HTTP 服务端，
 * 把连接信息写到 <工作区>/.vscode/dsh-bridge.json，供 DSH 侧 bundle 使用。
 *
 * 交互面（有意做得很小）：
 *  - 状态栏常驻项：显示端口与已服务调用数，点击弹菜单
 *  - 「DSH Bridge 调用日志」面板：实时显示每次工具调用
 *  - 输出通道「DSH Bridge」：全过程日志
 */
const vscode = require('vscode');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { createMcpHttpServer } = require('./src/mcp-server');
const { TOOLS, createToolDispatcher } = require('./src/tools');
const { createVscodeIde } = require('./src/ide-vscode');
const { createBridgeUi } = require('./src/ui');
const { createReviewUi } = require('./src/review-ui');
const { createChatUi } = require('./src/chat-ui');
const { createChangeTimeline } = require('./src/timeline');
const { insertSnippet, overlayPatchYaml } = require('./src/bridge-overlay');

const EXT_NAME = 'dsh-vscode-bridge';
const TRACE_FILE = path.join(os.tmpdir(), 'dsh-bridge-trace.log');

/** 版本号只从扩展清单读，避免和 package.json 对不上 */
function extVersion(context) {
  try {
    return context.extension.packageJSON.version;
  } catch {
    return '0.0.0';
  }
}

/** 当前窗口的 IDE 适配层实例（在 start() 里创建；注册期用它需要惰性访问） */
let runtimeIde = null;
/** 对话改动快照（时间线/diff） */
let changeTimeline = null;

/**
 * 审核面板的动作：惰性转发到 runtimeIde。
 *
 * 为什么不能在 start() 里创建审核面板：那样**桥启动失败（例如端口被占）时，
 * 审核面板和它的命令就全都没了**。面板属于界面，应当在 activate() 里注册好，
 * 动作通过这层代理按需找 runtimeIde。
 */
const REVIEW_ACTION_NAMES = [
  'acceptHunk', 'rejectHunk', 'acceptFile', 'rejectFile', 'acceptAll', 'rejectAll', 'applyAccepted', 'openDiff'
];
function lazyReviewActions() {
  const out = {};
  for (const name of REVIEW_ACTION_NAMES) {
    out[name] = async (...args) => (runtimeIde ? runtimeIde.reviewActions[name](...args) : undefined);
  }
  return out;
}
function lazyGetBatch() {
  return runtimeIde ? runtimeIde.getBatch() : null;
}

let output = null;
function channel() {
  if (!output) output = vscode.window.createOutputChannel('DSH Bridge');
  return output;
}

function trace(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  try {
    fs.appendFileSync(TRACE_FILE, line + '\n', 'utf8');
  } catch {
    /* 临时目录不可写也不该影响主流程 */
  }
  try {
    channel().appendLine(line);
  } catch {
    /* 输出通道在极早期可能不可用 */
  }
  console.log(`[${EXT_NAME}] ${msg}`);
}

/** @type {{server: import('node:http').Server, url: string, token: string, port: number, ide: any, info: object}|null} */
let runtime = null;
/** @type {ReturnType<typeof createBridgeUi>|null} */
let ui = null;
/** @type {ReturnType<typeof createReviewUi>|null} */
let reviewUi = null;
/** @type {ReturnType<typeof createChatUi>|null} */
let chatUi = null;

/** 当前窗口的第一个工作区文件夹（侧栏对话的会话根） */
function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length ? folders[0].uri.fsPath : undefined;
}

function firstFolder() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length ? folders[0] : undefined;
}

function discoveryFile() {
  const folder = firstFolder();
  if (!folder) return undefined;
  return path.join(folder.uri.fsPath, '.vscode', 'dsh-bridge.json');
}

function writeDiscovery(info) {
  const file = discoveryFile();
  if (!file) return undefined;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(info, null, 2), 'utf8');
    return file;
  } catch (err) {
    trace(`写发现文件失败: ${err.message}`);
    return undefined;
  }
}

function bundlePatchSnippet(url, token) {
  // 必须用 `- insert:` 形态：裸写 `- id:` 是"覆盖已存在的 id"，
  // 目标 profile 里没有这一行时会直接报 patch: entry "..." not found（实测确认）。
  return insertSnippet({ url, token });
}

/**
 * 侧栏对话的 SDK 子进程要用的 --patch 叠层文件：把 VS Code 桥挂进 sdk profile。
 * 懒执行（每次 spawn 前调用），这样改了端口/令牌立刻生效。
 * 返回文件路径；关闭功能时返回 undefined 并清掉旧文件。
 */
const TOKEN_KEY = 'dshBridge.token';

/**
 * MCP \u4ee4\u724c\u3002
 *
 * \u4ee5\u524d\u9ed8\u8ba4\u503c\u662f\u5199\u6b7b\u7684 `dsh-demo-token` \u2014\u2014 \u516c\u5f00\u53d1\u5e03\u540e\u90a3\u5c31\u662f\u4e00\u4e2a\u4eba\u4eba\u7686\u77e5\u7684\u5171\u4eab\u5bc6\u94a5\u3002
 * \u73b0\u5728\u7684\u987a\u5e8f\uff1a
 *   1) \u8bbe\u7f6e\u9879 `dsh-bridge.token`\uff08\u663e\u5f0f\u914d\u7f6e\u4f18\u5148\uff09
 *   2) \u5de5\u4f5c\u533a\u5df2\u6709\u7684 .vscode/dsh-bridge.json \u91cc\u7684 token\uff08\u5347\u7ea7\u65f6\u6cbf\u7528\uff0c\u4e0d\u6253\u65ad\u6b63\u5728\u7528\u7684\u73af\u5883\uff09
 *   3) \u672c\u673a globalStorage \u91cc\u7684\u968f\u673a token\uff08\u9996\u6b21\u81ea\u52a8\u751f\u6210\u5e76\u6301\u4e45\u5316\uff09
 */
function resolveToken(context) {
  const cfg = vscode.workspace.getConfiguration('dsh-bridge');
  const configured = String(cfg.get('token', '') || '').trim();
  if (configured) return configured;

  // \u5de5\u4f5c\u533a\u91cc\u5df2\u7ecf\u5199\u8fc7\u7684 token\uff1a\u6cbf\u7528\uff0c\u907f\u514d\u5347\u7ea7\u540e\u628a\u73b0\u6709\u914d\u7f6e\u6253\u65ad
  try {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length) {
      const file = require('node:path').join(folders[0].uri.fsPath, '.vscode', 'dsh-bridge.json');
      if (fs.existsSync(file)) {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (j && typeof j.token === 'string' && j.token.trim()) return j.token.trim();
      }
    }
  } catch (err) {
    trace(`\u8bfb\u53d6\u5df2\u6709 token \u5931\u8d25\uff08\u5ffd\u7565\uff09\uff1a${err.message}`);
  }

  let saved = context.globalState.get(TOKEN_KEY);
  if (typeof saved === 'string' && saved.length >= 16) return saved;
  saved = crypto.randomBytes(24).toString('hex');
  void context.globalState.update(TOKEN_KEY, saved);
  trace('\u5df2\u751f\u6210\u672c\u673a\u968f\u673a MCP \u4ee4\u724c\uff0824 \u5b57\u8282\uff09');
  return saved;
}

/** \u53ef\u89c6\u5316\u914d\u7f6e dsh \u542f\u52a8\u5668\u8def\u5f84\uff08\u547d\u4ee4\u9762\u677f\uff1aDSH: \u8bbe\u7f6e dsh \u542f\u52a8\u5668\u8def\u5f84\uff09 */
async function setLauncher() {
  const cfg = vscode.workspace.getConfiguration('dsh-bridge');
  const current = String(cfg.get('launcher', '') || '');
  let detected = 'dsh';
  try {
    detected = require('./src/sdk-client').detectLauncher();
  } catch (err) {
    /* ignore */
  }
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(search) \u81ea\u52a8\u63a2\u6d4b', description: detected === 'dsh' ? '\u4f7f\u7528 PATH \u4e0a\u7684 dsh' : detected, value: '' },
      { label: '$(file-directory) \u624b\u52a8\u9009\u62e9 dsh \u542f\u52a8\u5668\u2026', description: '\u6253\u5f00\u6587\u4ef6\u9009\u62e9\u5668\uff0c\u9009\u4e2d dsh / dsh.cmd', value: '__pick__' }
    ],
    { title: 'DSH \u542f\u52a8\u5668\u8def\u5f84', placeHolder: current ? `\u5f53\u524d\uff1a${current}` : '\u5c1a\u672a\u914d\u7f6e\uff08\u81ea\u52a8\u63a2\u6d4b\uff09' }
  );
  if (!pick) return;
  let next = pick.value;
  if (next === '__pick__') {
    const sel = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      openLabel: '\u4f7f\u7528\u8fd9\u4e2a\u542f\u52a8\u5668',
      title: '\u9009\u62e9 dsh \u542f\u52a8\u5668\uff08dsh.cmd / dsh\uff09'
    });
    if (!sel || !sel.length) return;
    next = sel[0].fsPath;
  }
  const hasWs = !!(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length);
  await cfg.update('launcher', next, hasWs ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(
    next ? `DSH \u542f\u52a8\u5668\u5df2\u8bbe\u4e3a\uff1a${next}\uff08\u91cd\u8f7d\u7a97\u53e3\u540e\u751f\u6548\uff09` : 'DSH \u542f\u52a8\u5668\u5df2\u6062\u590d\u4e3a\u81ea\u52a8\u63a2\u6d4b'
  );
}

function syncOverlay(context) {
  const cfg = vscode.workspace.getConfiguration('dsh-bridge');
  const enabled = cfg.get('chat.bridgeTools', true);
  const port = Number(cfg.get('port', 37251)) || 37251;
  const token = resolveToken(context);
  const dir = context.globalStorageUri.fsPath;
  const file = path.join(dir, 'sdk-bridge-overlay.yml');
  try {
    if (!enabled) {
      if (fs.existsSync(file)) fs.rmSync(file);
      return undefined;
    }
    fs.mkdirSync(dir, { recursive: true });
    const next = overlayPatchYaml({
      url: `http://127.0.0.1:${port}/mcp`,
      token,
      comment: [
        'DSH Bridge 自动生成的叠层补丁（每次启动侧栏对话前重写，请勿手改）',
        '用途：让 dsh --profile sdk 的子进程也持有 mcp__vscode__* 工具，',
        '      从而在只读沙箱下仍能"提案改文件" → 由你在审核面板里逐块接受。'
      ].join('\n')
    });
    const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (prev !== next) {
      fs.writeFileSync(file, next, 'utf8');
      trace(`已写桥叠层: ${file}`);
    }
    return file;
  } catch (err) {
    trace(`写桥叠层失败: ${err.message}`);
    return undefined;
  }
}

function currentInfo() {
  return runtime ? { url: runtime.url, token: runtime.token, port: runtime.port } : null;
}

async function start(context) {
  if (runtime) {
    trace(`已在运行: ${runtime.url}`);
    vscode.window.showInformationMessage(`DSH Bridge 已在运行: ${runtime.url}`);
    return runtime;
  }
  const cfg = vscode.workspace.getConfiguration('dsh-bridge');
  const port = Number(cfg.get('port', 37251)) || 37251;
  const token = resolveToken(context);
  trace(`准备启动: port=${port} token长度=${token.length} 工具数=${TOOLS.length}`);

  const ide = createVscodeIde(context, {
    onDecision: ({ diffId, decision, result, source }) => {
      trace(`决定(${source || '?'}): ${decision} diffId=${diffId} applied=${JSON.stringify(result && result.applied)}`);
      if (ui) {
        ui.logCall({
          tool: `diff_decision(${source || '?'}:${decision})`,
          args: { diffId },
          ok: true,
          ms: 0,
          text: JSON.stringify(result, null, 2)
        });
      }
    },
    onBatchChanged: () => {
      if (reviewUi) reviewUi.refresh();
      if (chatUi) chatUi.noteBatchChanged();
    },
    // 落盘后累计"本次对话改动了哪些文件"，供聊天界面的汇总卡片
    onFilesChanged: (list) => {
      // 聊天侧记录（每轮一张卡片）+ 快照（供「改动前 ↔ 改动后」的隔离 diff）
      const turn = chatUi ? chatUi.noteChanges(list) : 0;
      if (changeTimeline) void changeTimeline.record(list, turn);
    },
    applied: (result) => {
      trace(
        `审核批次落盘: 写入 ${result.written.length} / 跳过 ${result.skipped.length} / 冲突 ${result.conflicts.length}`
      );
      if (ui) {
        ui.logCall({
          tool: 'review:apply',
          args: { written: result.written, skipped: result.skipped, conflicts: result.conflicts },
          ok: result.conflicts.length === 0,
          ms: 0,
          text: JSON.stringify(result, null, 2)
        });
      }
      if (result.conflicts.length) {
        vscode.window.showWarningMessage(
          `DSH 审核：${result.conflicts.length} 个文件在审核期间被改动，已跳过以免覆盖 —— ${result.conflicts.join('、')}`
        );
      } else if (result.written.length) {
        vscode.window.showInformationMessage(`DSH 审核：已按你的选择写入 ${result.written.length} 个文件`);
      }
    }
  });
  runtimeIde = ide;
  trace('IDE 适配层已创建');
  const callTool = createToolDispatcher(ide, {
    // 审核门（默认开）：桥是只读沙箱唯一的出口，所有写操作一律转成提案由人决定。
    // 关掉它，apply_edit / write_file(preview:false) 才会直接落盘。
    reviewGate: () => vscode.workspace.getConfiguration('dsh-bridge').get('reviewGate', true),
    // 默认禁止 agent 自己批准自己的提案（否则"提案人=裁决人"，人不在回路里）。
    // reject 仍然允许，用于撤回自己的提案。
    agentCanApprove: () => vscode.workspace.getConfiguration('dsh-bridge').get('agentCanApprove', false)
  });
  const server = createMcpHttpServer({
    name: EXT_NAME,
    version: extVersion(context),
    tools: TOOLS,
    callTool,
    token,
    onLog: (m) => trace(m),
    onCall: (evt) => {
      if (ui) ui.logCall(evt);
      trace(`调用 ${evt.tool} ${evt.ok ? 'OK' : 'FAIL'} ${evt.ms}ms`);
    }
  });

  trace(`开始监听 127.0.0.1:${port} ...`);
  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        reject(new Error(`端口 ${port} 已被占用（可能已有一份扩展在跑），请改 dsh-bridge.port`));
      } else {
        reject(err);
      }
    });
    server.listen(port, '127.0.0.1', resolve);
  });

  const actualPort = server.address().port;
  const url = `http://127.0.0.1:${actualPort}/mcp`;
  const info = {
    url,
    token,
    port: actualPort,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    tools: TOOLS.map((t) => t.name)
  };
  runtime = { server, url, token, port: actualPort, ide, info };
  const file = writeDiscovery(info);

  trace(`监听成功: ${url}`);
  trace(`发现文件: ${file || '(当前窗口没有打开文件夹，跳过)'}`);
  if (ui) {
    ui.reset();
    ui.refresh();
  }
  vscode.window
    .showInformationMessage(`DSH Bridge 已启动: ${url}（${TOOLS.length} 个工具）`, '打开调用日志', '复制 DSH 配置')
    .then((picked) => {
      if (picked === '打开调用日志' && ui) ui.show();
      if (picked === '复制 DSH 配置') copyConfig();
    });
  return runtime;
}

async function stop(silent) {
  if (!runtime) return;
  const s = runtime.server;
  runtime = null;
  await new Promise((resolve) => s.close(resolve));
  trace('服务端已停止');
  if (ui) ui.refresh();
  if (!silent) vscode.window.showInformationMessage('DSH Bridge 已停止');
}

async function copyConfig() {
  if (!runtime) {
    vscode.window.showWarningMessage('DSH Bridge 尚未启动');
    return;
  }
  await vscode.env.clipboard.writeText(bundlePatchSnippet(runtime.url, runtime.token));
  vscode.window.showInformationMessage('已复制 DSH bundle 的补丁片段到剪贴板');
}

async function decideActive(decision) {
  if (!runtime) {
    vscode.window.showWarningMessage('DSH Bridge 尚未启动');
    return;
  }
  const diffId = runtime.ide.activeDiffId();
  if (!diffId) {
    vscode.window.showWarningMessage('当前没有 DSH 提案的 diff 标签');
    trace(`命令面板决定失败: 没有可决定的提案 (decision=${decision})`);
    return;
  }
  // 命令面板这条路不经过 MCP 服务端，所以这里手动记一笔，
  // 否则调用日志面板上看不到"人在编辑器里按了接受/拒绝"。
  const startedAt = Date.now();
  const r = await runtime.ide.diffDecision({ diffId, decision });
  trace(
    `命令面板决定: ${decision} diffId=${diffId} applied=${r.applied ? JSON.stringify(r.applied) : '无'}`
  );
  if (ui) {
    ui.logCall({
      tool: `diff_decision(命令面板:${decision})`,
      args: { diffId },
      ok: true,
      ms: Date.now() - startedAt,
      text: JSON.stringify(r, null, 2)
    });
  }
  vscode.window.showInformationMessage(
    `${decision === 'accept' ? '已接受' : '已拒绝'}提案: ${r.path}${r.createdFile ? '（新建）' : ''}`
  );
}

async function menu(context) {
  const info = runtime;
  const items = info
    ? [
        { label: '$(output) 显示调用日志', action: 'log' },
        { label: '$(clippy) 复制 DSH bundle 配置', action: 'copy' },
        { label: '$(debug-restart) 重启服务端', action: 'restart' },
        { label: '$(debug-stop) 停止服务端', action: 'stop' }
      ]
    : [
        { label: '$(play) 启动服务端', action: 'start' },
        { label: '$(output) 显示调用日志', action: 'log' }
      ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'DSH Bridge',
    placeHolder: info ? `${info.url} · 已服务 ${info.port ? '' : ''}调用` : '当前未运行'
  });
  if (!picked) return;
  switch (picked.action) {
    case 'log':
      if (ui) ui.show();
      break;
    case 'copy':
      await copyConfig();
      break;
    case 'restart':
      await stop(true);
      try {
        await start(context);
      } catch (err) {
        vscode.window.showErrorMessage(`重启失败: ${err.message}`);
      }
      break;
    case 'stop':
      await stop();
      break;
    case 'start':
      try {
        await start(context);
      } catch (err) {
        vscode.window.showErrorMessage(`启动失败: ${err.message}`);
      }
      break;
  }
}

function activate(context) {
  trace('================ activate() 进入 ================');
  try {
    trace(`VS Code ${vscode.version} / Node ${process.versions.node} / pid ${process.pid}`);
    trace(`扩展路径 ${context.extensionPath}`);
    trace(`工作区 ${(vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath).join(' | ') || '(无)'}`);
  } catch (err) {
    trace(`环境信息输出失败: ${err.message}`);
  }

  try {
    ui = createBridgeUi({ getInfo: currentInfo, getToolCount: () => TOOLS.length });
    ui.refresh();
    context.subscriptions.push(
      vscode.commands.registerCommand('dsh-bridge.start', () => start(context)),
      vscode.commands.registerCommand('dsh-bridge.stop', () => stop()),
      vscode.commands.registerCommand('dsh-bridge.copyConfig', () => copyConfig()),
      vscode.commands.registerCommand('dsh-bridge.showLog', () => ui && ui.show()),
      vscode.commands.registerCommand('dsh-bridge.setLauncher', () => setLauncher()),
      vscode.commands.registerCommand('dsh-bridge.menu', () => menu(context)),
      vscode.commands.registerCommand('dsh-bridge.acceptDiff', () => decideActive('accept')),
      vscode.commands.registerCommand('dsh-bridge.rejectDiff', () => decideActive('reject')),
      { dispose: () => ui && ui.dispose() },
      channel(),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        if (!runtime) return;
        const file = writeDiscovery(runtime.info);
        trace(`工作区变化，重写发现文件: ${file || '(无)'}`);
      })
    );
    // 对话改动的快照（每处改动存 before/after，点卡片里的行就开隔离 diff）
    changeTimeline = createChangeTimeline({ context, log: (m) => trace(`timeline: ${m}`) });

    // 「待审改动」面板：在**注册期**就建好（不依赖桥是否启动成功），动作惰性转发给 runtimeIde
    reviewUi = createReviewUi({
      context,
      getBatch: lazyGetBatch,
      actions: lazyReviewActions(),
      log: (m) => trace(`review-ui: ${m}`)
    });
    trace('审核面板已注册');

    // 侧栏「对话」视图：原生 webview + 每个窗口一个 dsh --profile sdk 子进程（视图打开时才启动）
    chatUi = createChatUi({
      context,
      log: (m) => trace(`chat-ui: ${m}`),
      getWorkspaceRoot: workspaceRoot,
      getOverlayPath: () => syncOverlay(context),
      // 让聊天面板自己能显示「待审 N 个文件」并放全部接受/忽略按钮。
      //
      // 注意：ide 是在 start() 里才创建的局部变量，**注册期这里拿不到**。
      // 之前写 `reviewActions: ide.reviewActions` 会直接抛 ReferenceError，
      // 把整个注册块炸掉（命令/视图全都没注册）——所以必须用惰性取值。
      getReviewStatus: () => (runtimeIde ? runtimeIde.getReviewStatus() : null),
      reviewActions: {
        acceptAll: async () => {
          if (runtimeIde) await runtimeIde.reviewActions.acceptAll();
        },
        rejectAll: async () => {
          if (runtimeIde) await runtimeIde.reviewActions.rejectAll();
        }
      }
    });
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(chatUi.VIEW_ID, chatUi.provider, {
        webviewOptions: { retainContextWhenHidden: true }
      }),
      {
        dispose: () => {
          if (chatUi) void chatUi.dispose();
        }
      }
    );
    trace('侧栏对话视图已注册');

    trace('命令、状态栏与输出通道注册完成');
  } catch (err) {
    trace(`注册失败: ${err && err.stack ? err.stack : err}`);
    // 不能只写日志：注册块一旦抛错，命令与视图全都没注册，界面上却毫无提示
    vscode.window.showErrorMessage(
      `DSH Bridge 注册失败：${err && err.message ? err.message : err}（详见「输出 → DSH Bridge」）`
    );
  }

  const cfg = vscode.workspace.getConfiguration('dsh-bridge');
  const autoStart = cfg.get('autoStart', true);
  trace(`autoStart=${autoStart}`);
  if (autoStart) {
    start(context).catch((err) => {
      trace(`启动失败: ${err && err.stack ? err.stack : err}`);
      vscode.window.showErrorMessage(`DSH Bridge 启动失败: ${err.message}（详见「输出 → DSH Bridge」）`);
    });
  }
  trace('activate() 返回');
}

function deactivate() {
  trace('deactivate() 被调用');
  return stop(true);
}

module.exports = { activate, deactivate };
