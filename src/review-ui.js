'use strict';
/**
 * 审核面板：把"批次 → 文件 → 块"渲染成侧栏树，并把按钮点击转成批次决定。
 *
 * 这一层刻意做薄：所有判断（哪些块被接受、最终文本是什么）都在已单测过的
 * src/review.js 与 src/diff.js 里；这里只做渲染 + 转发 + 落盘 + 刷新。
 */
const vscode = require('vscode');
const path = require('node:path');
const review = require('./review');

const VIEW_ID = 'dshBridge.review';
const CTRL = new Set(); // 占位：避免模块被误认为有副作用

/** 块状态 -> 图标与说明 */
const HUNK_ICON = {
  pending: new vscode.ThemeIcon('circle-outline'),
  accepted: new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green')),
  rejected: new vscode.ThemeIcon('close', new vscode.ThemeColor('descriptionForeground'))
};

const KIND_LABEL = { add: '新增', remove: '删除', replace: '修改' };

/**
 * @param {object} deps
 * @param {import('vscode').ExtensionContext} deps.context
 * @param {() => object|null} deps.getBatch        当前批次
 * @param {(batch: object) => Promise<any>} deps.applyBatch  落盘
 * @param {(msg: string) => void} deps.log
 */
function createReviewUi(deps) {
  const { context, getBatch, applyBatch, log } = deps;

  const emitter = new vscode.EventEmitter();
  context.subscriptions.push(emitter);

  function batch() {
    return getBatch();
  }

  function refresh() {
    emitter.fire();
    const b = batch();
    const s = b ? review.stats(b) : { files: 0, pending: 0, accepted: 0 };
    void vscode.commands.executeCommand('setContext', 'dsh-bridge.hasProposal', !!b && s.files > 0);
  }

  // ---------- 侧栏「待审改动」视图已移除 ----------
  // 审核入口现在在：对话面板的待审条（列出文件 + 全部接受/忽略）、diff 标签标题栏（按文件接受/拒绝）。
  // 原来那棵树的数据提供者与 createTreeView 一并删除，下面只保留命令转发。

  // ---------- 命令：全部转发给 ide 的动作层 ----------
  // 状态与落盘归 ide（单一所有者）；这里只做转发 + 刷新，避免两处都 apply。

  function nodeOf(arg) {
    return arg && arg.kind ? arg : null;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('dsh-bridge.acceptHunk', async (arg) => {
      const node = nodeOf(arg);
      if (!node || node.kind !== 'hunk') return;
      await deps.actions.acceptHunk(node.entry, node.hunk.index);
      refresh();
    }),

    vscode.commands.registerCommand('dsh-bridge.rejectHunk', async (arg) => {
      const node = nodeOf(arg);
      if (!node || node.kind !== 'hunk') return;
      await deps.actions.rejectHunk(node.entry, node.hunk.index);
      refresh();
    }),

    vscode.commands.registerCommand('dsh-bridge.acceptFile', async (arg) => {
      const node = nodeOf(arg);
      if (!node || node.kind !== 'file') return;
      await deps.actions.acceptFile(node.entry);
      refresh();
    }),

    vscode.commands.registerCommand('dsh-bridge.rejectFile', async (arg) => {
      const node = nodeOf(arg);
      if (!node || node.kind !== 'file') return;
      await deps.actions.rejectFile(node.entry);
      refresh();
    }),

    vscode.commands.registerCommand('dsh-bridge.acceptAll', async () => {
      const b = batch();
      if (!b || !b.files.length) {
        vscode.window.showInformationMessage('DSH 审核：没有待审改动');
        return;
      }
      await deps.actions.acceptAll();
      refresh();
    }),

    vscode.commands.registerCommand('dsh-bridge.rejectAll', async () => {
      await deps.actions.rejectAll();
      refresh();
    }),

    vscode.commands.registerCommand('dsh-bridge.applyBatch', async () => {
      const b = batch();
      if (!b || !b.files.length) {
        vscode.window.showInformationMessage('DSH 审核：没有待审改动');
        return;
      }
      const s = review.stats(b);
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(check-all) 全部接受并应用', action: 'accept' },
          { label: '$(circle-slash) 全部忽略', action: 'reject' }
        ],
        { title: `DSH 审核（${s.files} 文件 / ${s.pending} 块待决定）`, placeHolder: '选择操作' }
      );
      if (!pick) return;
      if (pick.action === 'accept') await deps.actions.acceptAll();
      else await deps.actions.rejectAll();
      refresh();
    }),

    vscode.commands.registerCommand('dsh-bridge.discardBatch', async () => {
      await deps.actions.rejectAll();
      refresh();
    }),

    vscode.commands.registerCommand('dsh-bridge.openDiff', async (arg) => {
      const node = nodeOf(arg);
      if (!node || node.kind !== 'file') return;
      await deps.actions.openDiff(node.entry);
    }),

    vscode.commands.registerCommand('dsh-bridge.refreshReview', () => refresh()),

    vscode.commands.registerCommand('dsh-bridge.focusReview', async () => {
      await vscode.commands.executeCommand('dshBridge.chat.focus');
    })
  );

  return { refresh, VIEW_ID };
}

module.exports = { createReviewUi, VIEW_ID, CTRL };
