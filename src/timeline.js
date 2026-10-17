'use strict';
/**
 * 「本次对话改了什么」的快照 + 原生 diff。
 *
 * 关键设计（都是踩过坑才定下来的）：
 *   1. 每个改动存**改动前 + 改动后**两份内容，diff 两端都来自我们自己的快照 ——
 *      所以看到的就是"那一轮改了什么"，与文件现在的样子无关，也不受后续几轮影响。
 *      （只跟最新版比的话，后面几轮和用户手动改的内容都会混进 `+` 侧。）
 *   2. **默认不注册 Timeline**（`dsh-bridge.changeTimeline` 默认 false）：
 *      时间线里本来是 Git/本地历史/用户自己改的条目，掺进去容易混。
 *      打开后我们的条目也是自洽的（点开是 before↔after 的隔离 diff）。
 *   3. 记录挂在**文件**上，所以后面从聊天卡片、时间线、命令哪个入口点开都是同一个隔离 diff。
 */
const vscode = require('vscode');
const store = require('./change-store');

const SCHEME = 'dsh-change';
const SOURCE = 'DSH 对话';
const STATE_KEY = 'dshBridge.changeHistory';

function baseName(p) {
  const parts = String(p || '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** 快照的虚拟 URI：dsh-change:/<编码路径>?id=<改动 id>&side=before|after */
function snapshotUri(changeId, filePath, side) {
  return vscode.Uri.parse(
    `${SCHEME}:/${encodeURIComponent(String(filePath))}?id=${encodeURIComponent(
      String(changeId)
    )}&side=${side === 'after' ? 'after' : 'before'}`
  );
}

function createChangeTimeline(deps) {
  const context = deps.context;
  const log = deps.log || (() => {});
  const emitter = new vscode.EventEmitter();
  context.subscriptions.push(emitter);

  let data = store.normalizeStore(safeGet());

  function safeGet() {
    try {
      return context.workspaceState.get(STATE_KEY);
    } catch (err) {
      log(`读取改动快照失败：${err.message}`);
      return null;
    }
  }

  async function persist() {
    try {
      await context.workspaceState.update(STATE_KEY, data);
    } catch (err) {
      log(`保存改动快照失败：${err.message}`);
    }
  }

  /** 记录一批刚落盘的改动：{ path, before, after, added, removed, turn, changeId } */
  async function record(list, turn) {
    const rows = (list || []).map((c) => Object.assign({}, c, { turn: Number(turn) || c.turn || 0 }));
    const ids = store.recordChanges(data, rows, Date.now());
    if (!ids.length) return 0;
    await persist();
    // 让时间线/内容提供者刷新
    for (const c of list || []) {
      if (c && c.path) {
        try {
          emitter.fire(vscode.Uri.file(c.path));
        } catch {
          /* ignore */
        }
      }
    }
    log(`改动快照 +${ids.length}（当前共 ${store.countChanges(data)} 条）`);
    return ids.length;
  }

  /** 打开原生 diff：左 = 改动前，右 = 改动后（两端都是快照，隔离且不怕行号漂移） */
  async function showChange(filePath, changeId) {
    const snap = store.findChange(data, changeId);
    if (!snap) {
      vscode.window.showWarningMessage('这次改动的快照已经不在记录里了（可能已被更早的记录挤掉）。');
      return;
    }
    const file = snap.path || filePath;
    const left = snapshotUri(snap.id, file, 'before');
    const right = snapshotUri(snap.id, file, 'after');
    const round = snap.turn ? `第 ${snap.turn} 轮 · ` : '';
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      `${baseName(file)}（DSH 对话：${round}+${snap.added} -${snap.removed}）`
    );
  }

  const contentProvider = {
    onDidChange: emitter.event,
    provideTextDocumentContent(uri) {
      const q = new URLSearchParams(String(uri.query || ''));
      const snap = store.findChange(data, q.get('id'));
      if (!snap) return '';
      return q.get('side') === 'after' ? snap.after : snap.before;
    }
  };
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, contentProvider));

  context.subscriptions.push(
    vscode.commands.registerCommand('dsh-bridge.showChange', (filePath, changeId) =>
      showChange(filePath, changeId)
    )
  );

  // 时间线：默认关（避免和用户自己的改动混在一起），开关打开时我们的条目也是自洽 diff
  let timelineDisposable = null;
  function timelineEnabled() {
    try {
      return vscode.workspace.getConfiguration('dsh-bridge').get('changeTimeline', false) === true;
    } catch {
      return false;
    }
  }
  function syncTimelineProvider() {
    if (timelineEnabled()) {
      if (timelineDisposable) return;
      const provider = {
        onDidChangeTimeline: emitter.event,
        provideTimeline(uri) {
          if (!uri || uri.scheme !== 'file') return { items: [] };
          const items = store.changesFor(data, uri.fsPath).map((it) => ({
            id: it.id,
            label: `+${it.added} -${it.removed}${it.turn ? ` · 第 ${it.turn} 轮` : ''}`,
            description: new Date(it.time).toLocaleTimeString(),
            detail: '本次对话对该文件的改动（点开是改动前↔改动后）',
            timestamp: it.time,
            command: {
              title: '对比这次改动',
              command: 'dsh-bridge.showChange',
              arguments: [it.path, it.id]
            }
          }));
          return { items };
        }
      };
      try {
        timelineDisposable = vscode.timeline.registerTimelineProvider(SOURCE, provider, { scheme: 'file' });
        context.subscriptions.push(timelineDisposable);
        log('改动时间线已注册（changeTimeline=true）');
      } catch (err) {
        log(`注册时间线失败：${err.message}`);
      }
    } else if (timelineDisposable) {
      try {
        timelineDisposable.dispose();
      } catch {
        /* ignore */
      }
      timelineDisposable = null;
      log('改动时间线已关闭');
    }
  }
  syncTimelineProvider();
  try {
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e && e.affectsConfiguration && e.affectsConfiguration('dsh-bridge.changeTimeline')) {
          syncTimelineProvider();
        }
      })
    );
  } catch {
    /* ignore */
  }

  return {
    record,
    showChange,
    find: (id) => store.findChange(data, id),
    changesFor: (p) => store.changesFor(data, p),
    count: () => store.countChanges(data),
    SCHEME,
    SOURCE,
    STATE_KEY
  };
}

module.exports = { createChangeTimeline, snapshotUri, SOURCE, SCHEME, STATE_KEY };
