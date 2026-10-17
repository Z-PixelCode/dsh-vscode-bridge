'use strict';
/**
 * 激活冒烟测试：用**假 vscode** 真跑一遍 activate()。
 *
 * 为什么必须要有这个：0.11.5 里我写了 `reviewActions: ide.reviewActions`，
 * 而 `ide` 是 start() 里的局部变量 —— 注册期取它会抛 ReferenceError，
 * 把整个注册块炸掉（命令、侧栏对话视图、审核面板全都没注册），用户看到的是
 * "最新版本无法正常加载"。而这一整类错误：
 *   - `node --check` 只查语法，查不出未定义变量
 *   - 各层单测都不加载 extension.js（它需要 vscode）
 *   - activate() 的 try/catch 还把错误吞了，只写进 trace
 * 所以必须有这个测试：断言 activate() 期间**没有弹错误提示**、且关键组件确实注册了。
 *
 * 运行：node test/activation-test.cjs
 */
const assert = require('node:assert');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

let passed = 0;
const failures = [];
function t(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  ✗ ${name} -> ${err.message}`);
  }
}

// ---------------------------------------------------------------- 假 vscode

/** 万能对象：可调用、可 new、任意属性还是万能对象（省得逐个模拟 API） */
function universal(name) {
  const fn = function () {};
  return new Proxy(fn, {
    get(target, prop) {
      if (prop === 'then') return undefined; // 别被当成 Promise
      if (prop === 'toString' || prop === Symbol.toPrimitive) return () => name;
      if (prop === 'dispose') return () => {};
      return universal(`${name}.${String(prop)}`);
    },
    set() {
      return true;
    },
    construct() {
      return universal(`${name}#new`);
    },
    apply() {
      return universal(`${name}()`);
    }
  });
}

const registered = { commands: [], viewProviders: [], trees: [], errors: [], configUpdates: [], docProviders: [] };

const configStub = {
  // autoStart 给 false：测试里不真的去监听端口、也不写发现文件
  get: (key, def) => (key === 'autoStart' ? false : def),
  update: async (...args) => {
    registered.configUpdates.push(args);
  }
};

const base = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: path.join(os.tmpdir(), 'fake-ws') }, name: 'fake-ws', index: 0 }],
    getConfiguration: () => configStub,
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    registerTextDocumentContentProvider: (scheme) => {
      registered.docProviders.push(scheme);
      return { dispose() {} };
    },
    onDidChangeConfiguration: () => ({ dispose() {} }),
    fs: { readFile: async () => new Uint8Array(), writeFile: async () => {} },
    openTextDocument: async () => ({
      getText: () => '',
      positionAt: () => ({ line: 0, character: 0 }),
      save: async () => {}
    }),
    asRelativePath: (p) => String(p)
  },
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '', tooltip: '', command: '' }),
    registerWebviewViewProvider: (id) => {
      registered.viewProviders.push(id);
      return { dispose() {} };
    },
    createTreeView: (id) => {
      registered.trees.push(id);
      return { dispose() {} };
    },
    showInformationMessage: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
    showErrorMessage: (msg) => {
      registered.errors.push(String(msg));
      return Promise.resolve(undefined);
    },
    showQuickPick: () => Promise.resolve(undefined),
    showTextDocument: async () => ({ selection: null, revealRange() {} })
  },
  commands: {
    registerCommand: (id) => {
      registered.commands.push(id);
      return { dispose() {} };
    },
    executeCommand: async () => undefined
  },
  Uri: {
    file: (p) => ({ fsPath: p, scheme: 'file' }),
    parse: (s) => ({ toString: () => s })
  },
  EventEmitter: class {
    constructor() {
      this.event = () => ({ dispose() {} });
    }
    fire() {}
    dispose() {}
  },
  TreeItem: class {
    constructor(label, state) {
      this.label = label;
      this.collapsibleState = state;
    }
  },
  ThemeIcon: class {
    constructor(id) {
      this.id = id;
    }
  },
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  MarkdownString: class {
    constructor(v) {
      this.value = v;
    }
  },
  Position: class {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }
  },
  Range: class {
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
  },
  Selection: class {
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
  },
  WorkspaceEdit: class {
    replace() {}
  },
  Disposable: class {
    constructor(fn) {
      this.dispose = fn || (() => {});
    }
  },
  RelativePattern: class {},
  ConfigurationTarget: { Workspace: 2, Global: 1 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { One: 1 },
  TextEditorRevealType: { InCenter: 2 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  timeline: { registerTimelineProvider: () => ({ dispose() {} }) }
};

const vscodeStub = new Proxy(base, {
  get(target, prop) {
    if (prop in target) return target[prop];
    return universal(`vscode.${String(prop)}`);
  }
});

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, ...rest);
};

let ext = null;
let loadError = null;
try {
  ext = require('../extension');
} catch (err) {
  loadError = err;
}
Module._load = originalLoad;

const context = {
  subscriptions: [],
  extensionPath: path.resolve(__dirname, '..'),
  extension: { packageJSON: { version: '9.9.9-test' } },
  globalStorageUri: { fsPath: path.join(os.tmpdir(), 'dsh-bridge-test-storage') },
  workspaceState: { get: () => undefined, update: async () => {} },
  globalState: { get: () => undefined, update: async () => {} }
};

(async () => {
  console.log('\n[1] 模块加载与激活');

  await t('extension.js 能被 require（模块级无抛错）', () => {
    if (loadError) throw loadError;
    assert.ok(ext && typeof ext.activate === 'function', '应当导出 activate');
  });

  if (ext && typeof ext.activate === 'function') {
    let activateError = null;
    try {
      await ext.activate(context);
    } catch (err) {
      activateError = err;
    }

    await t('activate() 本身不抛错', () => {
      if (activateError) throw activateError;
    });

    await t('activate() 期间没有弹出错误提示（注册块没有抛错）', () => {
      assert.deepStrictEqual(registered.errors, [], `弹了错误: ${registered.errors.join(' | ')}`);
    });

    await t('注册了命令（不是只剩零个）', () => {
      assert.ok(registered.commands.length >= 5, `只注册了 ${registered.commands.length} 个命令`);
      for (const need of ['dsh-bridge.start', 'dsh-bridge.stop', 'dsh-bridge.acceptAll', 'dsh-bridge.rejectAll']) {
        assert.ok(registered.commands.includes(need), `缺少命令 ${need}`);
      }
    });

    await t('注册了侧栏「对话」视图；审核树已按要求移除', () => {
      assert.ok(registered.viewProviders.includes('dshBridge.chat'), '缺少对话视图');
      assert.ok(!registered.trees.includes('dshBridge.review'), '审核树应已移除（视图不再贡献）');
      assert.ok(registered.commands.includes('dsh-bridge.acceptAll'), '全部接受命令仍需注册');
      assert.ok(registered.commands.includes('dsh-bridge.openDiff'), '打开 diff 命令仍需注册');
    });

    await t('注册块把 dispose 挂进了 subscriptions（不会泄漏）', () => {
      assert.ok(context.subscriptions.length > 5, `subscriptions 只有 ${context.subscriptions.length} 项`);
    });

    await t('deactivate 可安全调用（未启动服务端时）', async () => {
      await ext.deactivate();
    });
  }

  console.log('\n[2] 静态度量：扩展侧不得碰 DOM');

  await t('chat-ui.js 在 webview HTML 之外没有 document/window 引用', () => {
    // 回归：onStatus（扩展侧回调）里曾误留 document.getElementById，
    // 于是每次状态通知都抛 "document is not defined"，后面的 postMeta() 永远到不了，
    // 表现就是"发送按钮卡住、无法发送内容、状态行不更新"。
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat-ui.js'), 'utf8');
    const htmlEnd = src.lastIndexOf('</html>');
    assert.ok(htmlEnd > 0, '找不到 webview HTML 的结尾，无法界定扩展侧范围');
    const nodeSide = src.slice(htmlEnd);
    // 注意排除 vscode.window.*（那是合法 API），只揪"裸"的 window./document.
    const hits = nodeSide.match(/(?<![\w.])(?:document|window)\./g) || [];
    assert.deepStrictEqual(
      hits,
      [],
      `扩展侧出现了 DOM 引用（运行时必抛 document is not defined）：${hits.join(', ')}`
    );
  });

  await t('点改动会选中并高亮改动范围（对齐 app）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat-ui.js'), 'utf8');
    assert.ok(src.includes('createTextEditorDecorationType'), '需要高亮装饰');
    assert.ok(src.includes('setDecorations'), '需要把装饰应用到编辑器');
    assert.ok(src.includes('new vscode.Selection(range.start, range.end)'), '需要选中改动范围');
  });

  await t('改动快照（改动前 ↔ 改动后）模块装上了', () => {
    assert.ok(registered.commands.includes('dsh-bridge.showChange'), '需要注册 showChange 命令');
    assert.ok(registered.docProviders.includes('dsh-change'), '需要注册快照内容提供者');
  });

  await t('输入框上方的框只放待审（已落盘的记录在历史卡片里）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat-ui.js'), 'utf8');
    assert.ok(src.includes('if (!pending.length) return null'), '没有待审就整框隐藏');
    // appliedAdded 只存在于“已落盘也列进框”的旧实现；对话里那张卡片用的是 appliedFiles，不应该连坐
    assert.ok(!src.includes('appliedAdded'), '不再往这个框里塞已落盘的改动');
  });

  console.log(`\n结果: ${passed} 通过, ${failures.length} 失败`);
  if (failures.length) {
    console.log('失败项:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
})();
