'use strict';
/**
 * 工具定义（MCP tools/list 的 schema）与派发。
 *
 * 所有工具都通过注入的 `ide` 对象访问编辑器，因此这一层可以脱离 VS Code 单独测试
 * （见 test/protocol-test.cjs 里的 fakeIde）。
 */

const TOOLS = [
  {
    name: 'get_editor_state',
    description:
      '读取当前编辑器状态：活动文件路径、语言、光标位置、选中的文本与范围、可见范围、工作区根目录，以及所有已打开的文件。用于获取"用户此刻在看什么"。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'list_open_editors',
    description: '列出所有已打开的文件（按编辑器分组），标注哪个是活动的、是否有未保存修改。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_diagnostics',
    description:
      '读取 VS Code 的 Problems 面板（语言服务诊断）：文件、行、列、严重级别、消息、来源。不需要用户手动复制报错。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '只返回该文件的诊断（绝对路径）。省略则返回全部。' },
        severity: {
          type: 'string',
          enum: ['error', 'warning', 'info', 'hint', 'all'],
          description: '最低级别过滤，默认 all（含全部）。'
        },
        limit: { type: 'number', description: '最多返回多少条，默认 50。' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'open_file',
    description: '在编辑器中打开文件并可跳到指定位置（1-based 行列）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径。' },
        line: { type: 'number', description: '1-based 行号。' },
        column: { type: 'number', description: '1-based 列号。' }
      },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'apply_edit',
    description:
      '把文件中一段唯一的 oldText 替换为 newText，走 VS Code 的 WorkspaceEdit（因此进入撤销栈）。oldText 必须唯一，否则报错并要求提供更长的片段。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径。' },
        oldText: { type: 'string', description: '要被替换的原文，必须在文件中唯一。' },
        newText: { type: 'string', description: '替换后的文本。' },
        save: { type: 'boolean', description: '是否立即保存，默认 true。' }
      },
      required: ['path', 'oldText', 'newText'],
      additionalProperties: false
    }
  },
  {
    name: 'write_file',
    description:
      '新建或覆盖文件。默认 preview=true：只弹出一个 diff 提案、不落盘，等人用 diff_decision 接受后才写入（这就是文件审核）。preview=false 才直接写盘。已存在的文件走 WorkspaceEdit（保留撤销栈），不存在的文件走 workspace.fs 新建。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径。' },
        content: { type: 'string', description: '文件的完整内容。' },
        preview: {
          type: 'boolean',
          description: 'true（默认）= 只出提案等审批；false = 直接写盘。'
        },
        createOnly: {
          type: 'boolean',
          description: 'true 时若文件已存在则报错，避免误覆盖。默认 false。'
        }
      },
      required: ['path', 'content'],
      additionalProperties: false
    }
  },
  {
    name: 'propose_changes',
    description:
      '一次提交**多个文件**的改动，进入同一个审核批次（多文件 × 逐块审核）。每个文件会自动算出 hunk 列表，人在 VS Code 的「DSH 审核」面板里逐块接受/忽略、按文件接受/忽略、或整批接受。所有块都有结论后才一次性落盘（因此行号不会互相干扰）。默认不逐个打开 diff 标签，需要看某个文件时在面板里点它。',
    inputSchema: {
      type: 'object',
      properties: {
        changes: {
          type: 'array',
          description: '要提案的文件列表。',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '文件绝对路径。' },
              content: { type: 'string', description: '该文件的完整新内容。' },
              title: { type: 'string', description: '可选的标签标题。' }
            },
            required: ['path', 'content'],
            additionalProperties: false
          }
        },
        openDiffs: {
          type: 'boolean',
          description: 'true 时同时为每个文件打开 diff 标签（默认 false，避免 N 个标签）。'
        }
      },
      required: ['changes'],
      additionalProperties: false
    }
  },
  {
    name: 'show_diff',
    description:
      '不改文件，先在编辑器里打开一个 diff 视图（磁盘版本 vs 提案版本），返回 diffId。之后用 diff_decision 接受或拒绝。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径。' },
        newText: { type: 'string', description: '提案的完整新内容。' },
        title: { type: 'string', description: 'diff 标签标题。' }
      },
      required: ['path', 'newText'],
      additionalProperties: false
    }
  },
  {
    name: 'get_review_status',
    description:
      '只读查询当前审核队列的状态：批次 id、整体统计（文件数/待决/已接受/已忽略），以及每个文件的每个块（类型、起始行、增删行数、状态、预览）。用它来确认"接受一部分后到底落盘了没有"，不需要靠读磁盘猜。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'diff_decision',
    description:
      '对 show_diff / write_file / propose_changes 产生的提案做决定。可按整个文件（默认），也可只针对指定几块（hunks 传块下标）。**accept 默认只能由人在「DSH 审核」面板里点击**：agent 调用 accept 会被拒绝（除非把 dsh-bridge.agentCanApprove 打开）。reject 随时可用，用来撤回自己提出的提案。',
    inputSchema: {
      type: 'object',
      properties: {
        diffId: { type: 'string', description: '提案返回的 diffId。' },
        decision: { type: 'string', enum: ['accept', 'reject'] },
        hunks: {
          type: 'array',
          items: { type: 'number' },
          description: '可选：只对这些块下结论（下标从 0 开始，见 show_diff 返回的 hunks 数量）。省略则处理整个文件。'
        }
      },
      required: ['diffId', 'decision'],
      additionalProperties: false
    }
  },
  {
    name: 'run_command',
    description:
      '执行白名单内的 VS Code 命令（如格式化、整理 import、保存全部）。白名单外的命令会被拒绝。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'VS Code 命令 id。' },
        args: { type: 'array', items: {}, description: '传给命令的参数。' }
      },
      required: ['command'],
      additionalProperties: false
    }
  }
];

function requireString(args, key) {
  const v = args[key];
  if (typeof v !== 'string' || !v) throw new Error(`参数 ${key} 必须是非空字符串`);
  return v;
}

/**
 * @param {object} ide 见 src/ide-vscode.js 实现的接口
 * @returns {(name: string, args: object) => Promise<any>}
 */
function createToolDispatcher(ide, opts) {
  const options = opts || {};
  /**
   * 审核门。
   *
   * 为什么必须在这一层堵：桥是只读沙箱**唯一的出口**，而 `apply_edit` 原本用
   * WorkspaceEdit 直接写盘、`write_file(preview:false)` 也直接写 —— 于是"权限=只读"
   * 时 agent 只要挑这两个工具，照样落盘、根本没有审核阶段。
   * 门开着时，所有写操作都转成提案（人必须在「DSH 审核」面板里点接受）。
   */
  const reviewGate =
    typeof options.reviewGate === 'function' ? options.reviewGate : () => options.reviewGate !== false;

  /**
   * 是否允许 agent 自己批准提案。
   *
   * 默认**不允许**。理由：桥跑在 VS Code 扩展宿主里，落盘的是 VS Code 进程，不受 DSH 沙箱
   * 约束；如果 `diff_decision(accept)` 对模型可见且放行，那么**提案人和裁决人就是同一个 AI**，
   * 人在回路里被摘掉 —— 实测发生过（agent 自己 accept 了 6 次，用户看到"直接落盘、没有审核过程"）。
   *
   * 允许 reject 仍然保留：撤回自己提出的提案无害，反而便于收拾残局。
   */
  const agentCanApprove =
    typeof options.agentCanApprove === 'function' ? options.agentCanApprove : () => options.agentCanApprove === true;

  return async function callTool(name, args) {
    const a = args && typeof args === 'object' ? args : {};
    switch (name) {
      case 'get_editor_state':
        return ide.getEditorState();
      case 'list_open_editors':
        return ide.listOpenEditors();
      case 'get_diagnostics':
        return ide.getDiagnostics(a);
      case 'open_file':
        return ide.openFile({ path: requireString(a, 'path'), line: a.line, column: a.column });
      case 'apply_edit': {
        const target = requireString(a, 'path');
        const oldText = requireString(a, 'oldText');
        const newText = typeof a.newText === 'string' ? a.newText : '';
        if (!reviewGate()) {
          return ide.applyEdit({ path: target, oldText, newText, save: a.save !== false });
        }
        // 审核门开着：把"片段替换"换算成"整份新内容"，然后走提案（不落盘）
        const current = await ide.readTextFile(target);
        if (current === null || current === undefined) {
          throw new Error(`文件不存在或读不到，无法按片段编辑: ${target}`);
        }
        const first = current.indexOf(oldText);
        if (first < 0) throw new Error('oldText 未在文件中找到（可能已被改动）');
        if (current.indexOf(oldText, first + oldText.length) >= 0) {
          throw new Error('oldText 在文件中出现多次，请提供更长的唯一片段');
        }
        const nextText = current.slice(0, first) + newText + current.slice(first + oldText.length);
        const proposed = await ide.writeFile({ path: target, content: nextText, preview: true });
        return {
          gated: true,
          path: proposed.path,
          diffId: proposed.diffId,
          hunks: proposed.hunks,
          hint: '审核门开着：这次编辑已转成提案，请在「DSH 审核」面板里逐块接受/忽略'
        };
      }
      case 'write_file': {
        const gated = reviewGate();
        const result = await ide.writeFile({
          path: requireString(a, 'path'),
          content: typeof a.content === 'string' ? a.content : '',
          // 门开着时无视调用方要求，强制走预览
          preview: gated ? true : a.preview !== false,
          createOnly: a.createOnly === true
        });
        if (gated && a.preview === false) {
          return Object.assign({ gated: true, forcedPreview: true }, result, {
            hint: '审核门开着：preview:false 被忽略，已转成提案'
          });
        }
        return result;
      }
      case 'show_diff':
        return ide.showDiff({
          path: requireString(a, 'path'),
          newText: typeof a.newText === 'string' ? a.newText : '',
          title: a.title
        });
      case 'propose_changes': {
        const list = Array.isArray(a.changes) ? a.changes : [];
        if (!list.length) throw new Error('changes 不能为空');
        return ide.proposeChanges({
          changes: list.map((c) => {
            const item = c && typeof c === 'object' ? c : {};
            return {
              path: requireString(item, 'path'),
              content: typeof item.content === 'string' ? item.content : '',
              title: item.title
            };
          }),
          openDiffs: a.openDiffs === true
        });
      }
      case 'get_review_status':
        return ide.getReviewStatus();
      case 'diff_decision': {
        const decision = requireString(a, 'decision');
        if (decision === 'accept' && !agentCanApprove()) {
          throw new Error(
            '拒绝：审批（accept）只能由人在 VS Code 的「DSH 审核」面板里点击完成，agent 不能批准自己提出的提案。' +
              '请只提交提案（show_diff / write_file / propose_changes）并等待人工确认；' +
              '若确实需要自动化审批，把设置 dsh-bridge.agentCanApprove 打开。'
          );
        }
        return ide.diffDecision({
          diffId: requireString(a, 'diffId'),
          decision,
          hunks: Array.isArray(a.hunks) ? a.hunks : undefined
        });
      }
      case 'run_command':
        return ide.runCommand({
          command: requireString(a, 'command'),
          args: Array.isArray(a.args) ? a.args : []
        });
      default:
        throw new Error(`未知工具: ${name}`);
    }
  };
}

module.exports = { TOOLS, createToolDispatcher };
