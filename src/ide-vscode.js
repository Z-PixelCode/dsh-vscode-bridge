'use strict';
/**
 * VS Code 侧实现：把 vscode API 包成 src/tools.js 需要的 `ide` 接口。
 * 只有这个文件依赖 `vscode` 模块，因此协议层与工具层可以脱离 VS Code 测试。
 */
const vscode = require('vscode');
const path = require('node:path');
const crypto = require('node:crypto');
const review = require('./review');
const { entryChangeStats } = require('./chat-model');
const { makeChangeId } = require('./change-store');

const DIFF_SCHEME = 'dsh-bridge-diff';
/** diff 左侧的"空文档"标记（用于新建文件时的提案） */
const EMPTY_QUERY = '__empty__';
const SEVERITY_NAMES = ['error', 'warning', 'info', 'hint'];

/** 允许通过 run_command 执行的命令白名单 */
const ALLOWED_COMMANDS = new Set([
  'editor.action.formatDocument',
  'editor.action.formatSelection',
  'editor.action.organizeImports',
  'workbench.action.files.saveAll'
]);

function toPosition(line, character) {
  const l = Number.isFinite(line) ? Math.max(0, Math.floor(line) - 1) : 0;
  const c = Number.isFinite(character) ? Math.max(0, Math.floor(character) - 1) : 0;
  return new vscode.Position(l, c);
}

function fromPosition(p) {
  return { line: p.line + 1, character: p.character + 1 };
}

function createVscodeIde(context, hooks) {
  const h = hooks || {};
  /** diffId -> { path, newText, title } */
  const proposals = new Map();

  /** 把"是否有待审提案"同步成 context key，供 package.json 里菜单的 when 子句用 */
  function syncProposalContext() {
    void vscode.commands.executeCommand('setContext', 'dsh-bridge.hasProposal', proposals.size > 0);
  }

  // ---------- 审核批次（多文件 × 逐块）----------
  /** 当前批次；决定与应用都归这一层（单一所有者） */
  let batch = review.createBatch(`b-${Date.now().toString(36)}`);

  function notify() {
    if (h.onBatchChanged) h.onBatchChanged(batch);
  }

  function newBatch() {
    batch = review.createBatch(`b-${Date.now().toString(36)}`);
  }

  /** 读文件的当前文本；不存在或读失败返回 null */
  async function readTextOrNull(uri) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(bytes).toString('utf8');
    } catch {
      return null;
    }
  }

  /**
   * 把"已接受的块"一次性落盘。
   * 一次性是关键：块的行号基于**原始文本**，逐个写盘会让后续行号失效。
   * 带版本守卫：磁盘内容必须仍等于提案时的原文，否则判为冲突、拒绝写入。
   */
  /**
   * 把给定的若干条目落盘，并把这些条目从批次里移走（冲突的留下）。
   * 调用方负责挑"哪些条目已经可以结算了"。
   */
  /**
   * 忘掉某个条目对应的提案（删记录 + 关 diff 标签）。
   *
   * 必须做：面板里"接受/忽略"会把条目移出批次，但如果不清理 proposals，
   * 那条 diff 标签会一直开着；用户之后在它上面点 ✓ 就会走"提案不在批次里"的兜底
   * 路径，而磁盘内容已经变了 → 报"该提案已过期"。所以两个数据结构必须同步收拾。
   */
  async function forgetProposal(entry) {
    if (!entry || !entry.diffId) return;
    proposals.delete(entry.diffId);
    try {
      await closeDiffTabs(entry.diffId);
    } catch {
      /* ignore */
    }
    syncProposalContext();
  }

  async function applyEntriesNow(list) {
    const written = [];
    const skipped = [];
    const conflicts = [];
    const changedFiles = [];
    for (const entry of list) {
      const { text, changed } = review.finalText(entry);
      if (!changed) {
        skipped.push(entry.path);
        review.removeEntry(batch, entry.path);
        await forgetProposal(entry);
        continue;
      }
      const uri = vscode.Uri.file(entry.path);
      const current = await readTextOrNull(uri);
      if ((current === null ? '' : current) !== entry.oldText) {
        conflicts.push(entry.path);
        continue;
      }
      await writeWholeFile(uri, text);
      written.push(entry.path);
      changedFiles.push(
        Object.assign(
          { path: entry.path, before: entry.oldText, after: text, changeId: makeChangeId() },
          entryChangeStats(entry)
        )
      );
      review.removeEntry(batch, entry.path);
      await forgetProposal(entry);
    }
    if (changedFiles.length && h.onFilesChanged) h.onFilesChanged(changedFiles);
    return { written, skipped, conflicts };
  }

  /**
   * 只结算一个文件（agent 通过 diff_decision 下结论时用）。
   * 与 applyEntriesNow 的区别：不要求同批其它文件也决定完。
   */
  async function applyEntryNow(entry) {
    const { text, changed } = review.finalText(entry);
    review.removeEntry(batch, entry.path);
    if (!changed) {
      notify();
      return { path: entry.path, written: false, created: false };
    }
    const uri = vscode.Uri.file(entry.path);
    const current = await readTextOrNull(uri);
    if ((current === null ? '' : current) !== entry.oldText) {
      notify();
      throw new Error(`文件在审核期间已被改动，拒绝覆盖: ${entry.path}`);
    }
    const r = await writeWholeFile(uri, text);
    // 记入"本次对话改动"，供聊天界面的「已编辑 N 个文件」卡片
    if (h.onFilesChanged) {
      h.onFilesChanged([
        Object.assign(
          { path: entry.path, before: entry.oldText, after: text, changeId: makeChangeId() },
          entryChangeStats(entry)
        )
      ]);
    }
    notify();
    return { path: entry.path, written: true, created: !!r.created };
  }

  /** 一批里所有块都有结论时自动结算（应用 + 清空批次） */
  async function settleReadyEntries() {
    // 逐文件结算：某个文件的块全部有结论就立刻落盘它。
    //
    // 之前是"整批都有结论才落盘"，理由（块的行号基于原文、必须一次性应用）其实
    // **只需要文件内原子**，不需要跨文件原子。要求整批的后果很难受：
    // 8 个文件待审时，用户接受了一个文件却什么都没发生。
    const ready = batch.files.filter((f) => !review.hasPending(f));
    if (!ready.length) {
      notify();
      return null;
    }
    const result = await applyEntriesNow(ready);
    h.applied && h.applied(result);
    if (!batch.files.length) newBatch();
    notify();
    return result;
  }

  /** 审核动作：给 UI 层调用（UI 只转发，不改状态） */
  const actions = {
    getBatch: () => batch,
    async acceptHunk(entry, index) {
      review.decideHunk(entry, index, 'accept');
      return settleReadyEntries();
    },
    async rejectHunk(entry, index) {
      review.decideHunk(entry, index, 'reject');
      return settleReadyEntries();
    },
    async acceptFile(entry) {
      review.decideFile(entry, 'accept');
      return settleReadyEntries();
    },
    async rejectFile(entry) {
      review.decideFile(entry, 'reject');
      return settleReadyEntries();
    },
    async acceptAll() {
      review.decideBatch(batch, 'accept');
      return settleReadyEntries();
    },
    async rejectAll() {
      review.decideBatch(batch, 'reject');
      return settleReadyEntries();
    },
    /** 忽略尚未决定的块，直接应用已接受的（强制结算） */
    async applyAccepted() {
      // finalText 只应用 accepted 的块；pending 天然不会被写入，因此无需先改状态
      const result = await applyEntriesNow(batch.files.slice());
      h.applied && h.applied(result);
      newBatch();
      notify();
      return result;
    },
    async openDiff(entry) {
      if (entry.diffId && proposals.has(entry.diffId)) {
        await vscode.commands.executeCommand('dsh-bridge.reopenDiff', entry.diffId);
      }
    }
  };

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, {
      provideTextDocumentContent(uri) {
        if (uri.query === EMPTY_QUERY) return ''; // 新建文件时 diff 左侧的空文档
        const p = proposals.get(uri.query);
        return p ? p.newText : '';
      }
    }),
    // 面板里点「打开 diff 预览」时重开（或聚焦）那个提案的 diff 标签
    vscode.commands.registerCommand('dsh-bridge.reopenDiff', async (diffId) => {
      const p = proposals.get(diffId);
      if (!p) throw new Error('该提案已失效，请重新提案');
      const base = path.basename(p.path);
      const virtualUri = vscode.Uri.parse(`${DIFF_SCHEME}:${encodeURIComponent(base)}?${diffId}`);
      const leftUri = p.existed
        ? vscode.Uri.file(p.path)
        : vscode.Uri.parse(`${DIFF_SCHEME}:${encodeURIComponent(base + ' (尚不存在)')}?${EMPTY_QUERY}`);
      await vscode.commands.executeCommand('vscode.diff', leftUri, virtualUri, p.title || base, {
        preview: false
      });
    })
  );

  function listOpenEditors() {
    const out = [];
    vscode.window.tabGroups.all.forEach((group, gi) => {
      group.tabs.forEach((tab) => {
        const input = tab.input;
        if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputTextDiff) {
          const uri = input instanceof vscode.TabInputTextDiff ? input.modified : input.uri;
          out.push({
            path: uri.fsPath,
            group: gi,
            active: tab.isActive,
            dirty: tab.isDirty,
            label: tab.label,
            preview: tab.isPreview
          });
        }
      });
    });
    return out;
  }

  /**
   * 找要处理的提案：
   *  1) 当前活动标签就是 bridge diff → 用它
   *  2) 否则扫描所有已打开的 bridge diff，取最近创建的
   *  3) 标签被关掉但提案还在 → 也用最近的（否则用户"按了没反应"）
   * 这样命令面板的接受/拒绝不要求用户先手动激活那个标签。
   */
  function activeDiffId() {
    const active = vscode.window.tabGroups.activeTabGroup
      ? vscode.window.tabGroups.activeTabGroup.activeTab
      : undefined;
    const activeInput = active && active.input;
    if (activeInput instanceof vscode.TabInputTextDiff &&
        activeInput.modified.scheme === DIFF_SCHEME &&
        proposals.has(activeInput.modified.query)) {
      return activeInput.modified.query;
    }
    const openIds = new Set();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputTextDiff && input.modified.scheme === DIFF_SCHEME) {
          openIds.add(input.modified.query);
        }
      }
    }
    const ids = Array.from(proposals.keys());
    for (let i = ids.length - 1; i >= 0; i -= 1) {
      if (openIds.has(ids[i])) return ids[i];
    }
    return ids.length ? ids[ids.length - 1] : undefined;
  }

  async function closeDiffTabs(diffId) {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputTextDiff &&
            input.modified.scheme === DIFF_SCHEME &&
            input.modified.query === diffId) {
          try {
            await vscode.window.tabGroups.close(tab);
          } catch {
            /* 关闭失败不影响决定结果 */
          }
        }
      }
    }
  }

  async function fileExists(uri) {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 用整份文本覆盖（或新建）目标文件。
   * 已存在的文件走 WorkspaceEdit —— 保留 VS Code 的撤销栈，这是"审批可撤销"的关键；
   * 不存在的文件走 workspace.fs 新建（openTextDocument 对不存在的路径会失败）。
   */
  async function writeWholeFile(uri, newText) {
    let doc = null;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      doc = null;
    }
    if (!doc) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(newText, 'utf8'));
      const created = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(created, { preview: false });
      return { created: true };
    }
    const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, full, newText);
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) throw new Error('应用编辑被编辑器拒绝');
    await doc.save();
    return { created: false };
  }

  const ide = {
    activeDiffId,
    listOpenEditors,

    async getEditorState() {
      const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
      const focused = vscode.window.activeTextEditor;
      // 焦点不在编辑器里时（例如你正在 DSH 面板、输出面板或命令面板里），
      // activeTextEditor 是 undefined。此时退回到"可见的第一个编辑器"，
      // 否则你一边看面板一边让我干活时，我会完全读不到上下文。
      const ed = focused || vscode.window.visibleTextEditors[0];
      if (!ed) {
        return {
          focusInEditor: false,
          hasEditor: false,
          workspaceFolders: folders,
          openEditors: listOpenEditors()
        };
      }
      const doc = ed.document;
      const sel = ed.selection;
      const visible = ed.visibleRanges[0];
      return {
        focusInEditor: !!focused,
        hasEditor: true,
        source: focused ? 'active' : 'visible-fallback',
        path: doc.uri.fsPath,
        languageId: doc.languageId,
        isDirty: doc.isDirty,
        lineCount: doc.lineCount,
        cursor: fromPosition(sel.active),
        selection: {
          isEmpty: sel.isEmpty,
          text: doc.getText(sel),
          start: fromPosition(sel.start),
          end: fromPosition(sel.end)
        },
        visibleRange: visible
          ? { start: fromPosition(visible.start), end: fromPosition(visible.end) }
          : null,
        workspaceFolders: folders,
        openEditors: listOpenEditors()
      };
    },

    async getDiagnostics(args) {
      const a = args || {};
      const wantPath = typeof a.path === 'string' && a.path ? path.resolve(a.path) : undefined;
      const sev = typeof a.severity === 'string' && a.severity !== 'all' ? a.severity : undefined;
      const maxIndex = sev ? SEVERITY_NAMES.indexOf(sev) : undefined;
      const limit = Number.isFinite(a.limit) && a.limit > 0 ? Math.floor(a.limit) : 50;

      const items = [];
      for (const [uri, diags] of vscode.languages.getDiagnostics()) {
        if (wantPath && path.resolve(uri.fsPath) !== wantPath) continue;
        for (const d of diags) {
          if (maxIndex !== undefined && d.severity > maxIndex) continue;
          const code = d.code && typeof d.code === 'object' ? d.code.value : d.code;
          items.push({
            path: uri.fsPath,
            severity: SEVERITY_NAMES[d.severity] || 'unknown',
            message: d.message,
            line: d.range.start.line + 1,
            character: d.range.start.character + 1,
            endLine: d.range.end.line + 1,
            source: d.source || null,
            code: code === undefined || code === null ? null : String(code)
          });
        }
      }
      items.sort((x, y) => {
        const sx = SEVERITY_NAMES.indexOf(x.severity);
        const sy = SEVERITY_NAMES.indexOf(y.severity);
        if (sx !== sy) return sx - sy;
        if (x.path !== y.path) return x.path < y.path ? -1 : 1;
        return x.line - y.line;
      });
      return {
        filter: { path: wantPath || null, severity: sev || 'all' },
        total: items.length,
        returned: Math.min(items.length, limit),
        truncated: items.length > limit,
        items: items.slice(0, limit)
      };
    },

    async openFile({ path: filePath, line, column }) {
      const uri = vscode.Uri.file(path.resolve(filePath));
      const doc = await vscode.workspace.openTextDocument(uri);
      const ed = await vscode.window.showTextDocument(doc, { preview: false });
      let revealed = null;
      if (Number.isFinite(line)) {
        const pos = toPosition(line, column);
        ed.selection = new vscode.Selection(pos, pos);
        ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        revealed = fromPosition(pos);
      }
      return { opened: uri.fsPath, revealedAt: revealed };
    },

    async applyEdit({ path: filePath, oldText, newText, save }) {
      const uri = vscode.Uri.file(path.resolve(filePath));
      const doc = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();
      const first = text.indexOf(oldText);
      if (first < 0) throw new Error('oldText 未在文件中找到（可能已被改动）');
      if (text.indexOf(oldText, first + oldText.length) >= 0) {
        throw new Error('oldText 在文件中出现多次，请提供更长的唯一片段');
      }
      const start = doc.positionAt(first);
      const end = doc.positionAt(first + oldText.length);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(start, end), newText);
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) throw new Error('应用编辑被编辑器拒绝');
      if (save !== false) await doc.save();
      return {
        path: uri.fsPath,
        appliedAt: { line: start.line + 1, character: start.character + 1 },
        replacedChars: oldText.length,
        insertedChars: newText.length,
        saved: save !== false
      };
    },

    async showDiff({ path: filePath, newText, title, open }) {
      const uri = vscode.Uri.file(path.resolve(filePath));
      const exists = await fileExists(uri);
      const diffId = crypto.randomUUID();
      const base = path.basename(uri.fsPath);
      const label = title || `${exists ? 'DSH 提案' : 'DSH 新建'}: ${base}`;
      proposals.set(diffId, { path: uri.fsPath, newText, title: label, existed: exists });
      const virtualUri = vscode.Uri.parse(`${DIFF_SCHEME}:${encodeURIComponent(base)}?${diffId}`);
      // 目标不存在时，左侧用一个空虚拟文档，否则 vscode.diff 打不开不存在的文件
      const leftUri = exists
        ? uri
        : vscode.Uri.parse(`${DIFF_SCHEME}:${encodeURIComponent(base + ' (尚不存在)')}?${EMPTY_QUERY}`);

      // 进入当前审核批次（多文件 × 逐块）
      const diskText = exists ? await readTextOrNull(uri) : '';
      // 记下提案生成时的原文，供"接受过期提案"时做版本守卫（diskText 必须先算出来）
      const recorded = proposals.get(diffId);
      if (recorded) recorded.baseText = diskText === null ? '' : diskText;
      review.addChange(batch, {
        path: uri.fsPath,
        oldText: diskText === null ? '' : diskText,
        newText,
        existed: exists,
        title: label,
        diffId
      });
      notify();

      const shouldOpen = open !== false;
      if (shouldOpen) {
        await vscode.commands.executeCommand('vscode.diff', leftUri, virtualUri, label, { preview: false });
        syncProposalContext();
        // 通知里的按钮：不依赖 when 子句，保证任何情况下都有可点的接受/拒绝
        void vscode.window
          .showInformationMessage(`DSH 提案：${base}`, '接受', '拒绝')
          .then(async (picked) => {
            if (picked !== '接受' && picked !== '拒绝') return;
            const decision = picked === '接受' ? 'accept' : 'reject';
            try {
              const result = await ide.diffDecision({ diffId, decision });
              if (h.onDecision) h.onDecision({ diffId, decision, result, source: 'notification' });
            } catch (err) {
              vscode.window.showErrorMessage(`DSH 提案处理失败：${err.message}`);
            }
          });
      }

      const entry = review.findEntry(batch, uri.fsPath);
      return {
        diffId,
        path: uri.fsPath,
        targetExisted: exists,
        hunks: entry ? entry.hunks.length : 0,
        hint: '在「DSH 审核」面板里逐块接受/忽略，或用 diff_decision 处理整个文件'
      };
    },

    /**
     * 一次提交多个文件的改动（多文件审核）。
     * 默认不逐个打开 diff 标签（N 个文件 = N 个标签太吵），面板是决定的地方；
     * 需要看某个文件时在面板里点它的「打开 diff 预览」。
     */
    async proposeChanges({ changes, openDiffs }) {
      const files = [];
      let index = 0;
      for (const change of changes) {
        const r = await ide.showDiff({
          path: change.path,
          newText: change.content,
          title: change.title,
          // 第一个文件总是打开 diff 预览（接受前就能看到内容）；其余默认不逐个开标签
          open: !!openDiffs || index === 0
        });
        files.push({ path: r.path, existed: r.targetExisted, hunks: r.hunks, diffId: r.diffId });
        index += 1;
      }
      return { batchId: batch.id, files, stats: review.stats(batch) };
    },

    async diffDecision({ diffId, decision, hunks }) {
      const p = proposals.get(diffId);
      if (!p) throw new Error(`未知的 diffId: ${diffId}`);
      if (decision !== 'accept' && decision !== 'reject') {
        throw new Error('decision 只能是 accept 或 reject');
      }

      const entry = review.findEntry(batch, p.path);
      if (entry) {
        // 走批次模型：可以整文件，也可以只处理指定几块
        if (Array.isArray(hunks) && hunks.length) {
          for (const i of hunks) review.decideHunk(entry, i, decision);
        } else {
          review.decideFile(entry, decision);
        }
        let applied = null;
        if (decision === 'accept') {
          // agent 驱动时立即结算这一个文件（不等整批）
          applied = await applyEntryNow(entry);
        } else {
          review.removeEntry(batch, entry.path);
          notify();
        }
        proposals.delete(diffId);
        await closeDiffTabs(diffId);
        syncProposalContext();
        return {
          diffId,
          decision,
          path: p.path,
          // 本次实际处理的块数：此前只回 batch 统计，而条目结算后已移出批次，
          // 于是 accepted 永远显示 0，容易被误判成"没生效"
          decidedHunks: Array.isArray(hunks) && hunks.length ? hunks.length : entry.hunks.length,
          applied,
          remainingBatch: review.stats(batch)
        };
      }

      // 兜底：提案不在批次里（例如扩展重载后的残留）→ 老路径整份替换
      let wrote = false;
      let created = false;
      if (decision === 'accept') {
        const text = Array.isArray(hunks) && hunks.length
          ? null
          : p.newText;
        if (text === null) throw new Error('该提案已不在批次里，无法按块应用；请重新提案');
        // 版本守卫：同一个路径先后可能有多个提案，接受过期的那份会把后来的改动覆盖掉。
        // 磁盘内容必须仍等于该提案生成时的原文，否则判为过期、拒绝写入。
        const now = await readTextOrNull(vscode.Uri.file(p.path));
        if ((now === null ? '' : now) !== (p.baseText === undefined ? '' : p.baseText)) {
          throw new Error(
            '该提案已经处理过了（可能已在「DSH 审核」面板里接受/忽略），或者是文件在这期间被改动过，因此拒绝覆盖。' +
              '如果还需要这处改动，请让 AI 重新提案。'
          );
        }
        const r = await writeWholeFile(vscode.Uri.file(p.path), text);
        wrote = true;
        created = !!r.created;
      }
      proposals.delete(diffId);
      await closeDiffTabs(diffId);
      syncProposalContext();
      return { diffId, decision, path: p.path, wroteFile: wrote, createdFile: created };
    },

    /**
     * 新建或覆盖文件。
     * preview 默认 true：只弹 diff 提案，等 diff_decision 接受才落盘 —— 这就是"文件审核"。
     * preview=false 才直接写盘（只有在权限预设允许时才应该用）。
     */
    async writeFile({ path: filePath, content, preview, createOnly }) {
      const uri = vscode.Uri.file(path.resolve(filePath));
      const exists = await fileExists(uri);
      if (createOnly && exists) {
        throw new Error(`文件已存在（createOnly=true）: ${uri.fsPath}`);
      }
      if (preview !== false) {
        const r = await ide.showDiff({ path: uri.fsPath, newText: content, title: undefined });
        return {
          ...r,
          preview: true,
          note: '尚未写入磁盘；接受后才会落盘',
          willCreate: !exists
        };
      }
      const r = await writeWholeFile(uri, content);
      return {
        path: uri.fsPath,
        bytes: Buffer.byteLength(content, 'utf8'),
        created: !!r.created,
        preview: false
      };
    },

    /** 读文件当前文本（审核门把 apply_edit 换算成整份提案时需要）；不存在返回 null */
    async readTextFile(filePath) {
      return readTextOrNull(vscode.Uri.file(path.resolve(filePath)));
    },

    /**
     * 只读的审核状态查询。
     *
     * 之前 agent 只能靠"提案那一刻的统计快照 + 磁盘事实"去猜审核状态 —— 它自己在
     * 对话里明确报告了这个缺口（"MCP 这边没有只读的状态查询接口"）。有它就能准确回报
     * 「哪些文件/哪些块还在待审、哪些已接受/已忽略」。
     */
    getReviewStatus() {
      return {
        batchId: batch.id,
        stats: review.stats(batch),
        files: batch.files.map((f) => review.describeEntry(f))
      };
    },

    async runCommand({ command, args }) {
      if (!ALLOWED_COMMANDS.has(command)) {
        throw new Error(`命令不在白名单内: ${command}`);
      }
      const result = await vscode.commands.executeCommand(command, ...(args || []));
      let summary = null;
      if (result === null || result === undefined || typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean') {
        summary = result === undefined ? null : result;
      } else {
        summary = '[非原始返回值，已省略]';
      }
      return { command, ok: true, result: summary };
    },

    /** 当前审核批次（只读；给 review-ui 渲染用） */
    getBatch: () => batch,
    /** 审核动作（review-ui 只转发，不改状态） */
    reviewActions: actions
  };

  syncProposalContext();
  return ide;
}

module.exports = { createVscodeIde, DIFF_SCHEME, ALLOWED_COMMANDS };
