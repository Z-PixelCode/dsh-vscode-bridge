'use strict';
/**
 * 协议层 + 工具层测试（不需要 VS Code，也不需要联网/装依赖）。
 *
 * 用真正的 HTTP 套接字跑一遍 MCP 握手与工具调用，IDE 部分用 fakeIde 替换。
 * 运行：node test/protocol-test.cjs
 */
const assert = require('node:assert');
const { createMcpHttpServer } = require('../src/mcp-server');
const { TOOLS, createToolDispatcher } = require('../src/tools');

const TOKEN = 'test-token-123';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push(`${name}: ${err.message}`);
    console.log(`  ✗ ${name} -> ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push(`${name}: ${err.message}`);
    console.log(`  ✗ ${name} -> ${err.message}`);
  }
}

function makeFakeIde() {
  const calls = [];
  return {
    calls,
    async getEditorState() {
      return {
        hasActiveEditor: true,
        path: 'C:/demo/src/app.ts',
        languageId: 'typescript',
        cursor: { line: 12, character: 5 },
        selection: { isEmpty: false, text: 'const a = 1;', start: { line: 12, character: 1 }, end: { line: 12, character: 13 } },
        workspaceFolders: ['C:/demo'],
        openEditors: [{ path: 'C:/demo/src/app.ts', active: true, dirty: false }]
      };
    },
    async listOpenEditors() {
      return [{ path: 'C:/demo/src/app.ts', active: true, dirty: false }];
    },
    async getDiagnostics(args) {
      return {
        filter: { path: args.path || null, severity: args.severity || 'all' },
        total: 1,
        returned: 1,
        truncated: false,
        items: [{ path: 'C:/demo/src/app.ts', severity: 'error', message: "Cannot find name 'x'.", line: 3, character: 7 }]
      };
    },
    async openFile(a) {
      calls.push(['openFile', a]);
      return { opened: a.path, revealedAt: { line: a.line || 1, character: a.column || 1 } };
    },
    async applyEdit(a) {
      calls.push(['applyEdit', a]);
      return { path: a.path, appliedAt: { line: 3, character: 1 }, saved: a.save };
    },
    async readTextFile(p) {
      calls.push(['readTextFile', p]);
      return 'line1\nOLD\nline2\n';
    },
    async getReviewStatus() {
      calls.push(['getReviewStatus']);
      return {
        batchId: 'b-test',
        stats: { files: 2, pending: 3, accepted: 1, rejected: 1 },
        files: [
          {
            path: 'C:/demo/a.ts',
            existed: true,
            hunks: 1,
            summary: [{ index: 0, kind: 'replace', startLine: 3, added: 1, removed: 1, preview: 'NEW', status: 'accepted' }]
          }
        ]
      };
    },
    async writeFile(a) {
      calls.push(['writeFile', a]);
      if (a.preview !== false) {
        return { diffId: 'diff-new', path: a.path, targetExisted: false, preview: true, willCreate: true };
      }
      return { path: a.path, bytes: Buffer.byteLength(a.content, 'utf8'), created: true, preview: false };
    },
    async proposeChanges(a) {
      calls.push(['proposeChanges', a]);
      return {
        batchId: 'b-test',
        files: a.changes.map((c) => ({ path: c.path, existed: false, hunks: 2, diffId: 'diff-' + c.path })),
        stats: { files: a.changes.length, pending: a.changes.length * 2, accepted: 0, rejected: 0 }
      };
    },
    async showDiff(a) {
      calls.push(['showDiff', a]);
      return { diffId: 'diff-1', path: a.path };
    },
    async diffDecision(a) {
      calls.push(['diffDecision', a]);
      return { diffId: a.diffId, decision: a.decision, path: 'C:/demo/src/app.ts', wroteFile: a.decision === 'accept' };
    },
    async runCommand(a) {
      calls.push(['runCommand', a]);
      return { command: a.command, ok: true, result: null };
    }
  };
}

async function main() {
  const fakeIde = makeFakeIde();
  let reviewGateOn = true;
  // 默认禁止 agent 自己批准提案（与插件默认一致）
  let agentApproveOn = false;
  const server = createMcpHttpServer({
    name: 'dsh-vscode-bridge',
    version: '0.1.0',
    tools: TOOLS,
    // 审核门：默认开（与插件默认一致），个别用例临时关掉验证"直写"分支
    callTool: createToolDispatcher(fakeIde, {
      reviewGate: () => reviewGateOn,
      agentCanApprove: () => agentApproveOn
    }),
    token: TOKEN,
    onLog: () => {}
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const rpc = (body, { token = TOKEN, method = 'POST', path = '/mcp' } = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(token === null ? {} : { Authorization: `Bearer ${token}` })
      },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {})
    });

  console.log('\n[1] 握手');
  await checkAsync('initialize 回显客户端协议版本并声明 tools 能力', async () => {
    const res = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } }
    });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await res.json();
    assert.strictEqual(body.jsonrpc, '2.0');
    assert.strictEqual(body.id, 1);
    assert.strictEqual(body.result.protocolVersion, '2025-06-18');
    assert.ok(body.result.capabilities.tools);
    assert.strictEqual(body.result.serverInfo.name, 'dsh-vscode-bridge');
  });

  await checkAsync('notifications/initialized 返回 202 且无内容', async () => {
    const res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.strictEqual(res.status, 202);
    assert.strictEqual(await res.text(), '');
  });

  console.log('\n[2] 工具面');
  await checkAsync(`tools/list 返回 ${TOOLS.length} 个工具且 schema 合法`, async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const body = await res.json();
    const tools = body.result.tools;
    assert.strictEqual(tools.length, TOOLS.length);
    for (const t of tools) {
      assert.ok(typeof t.name === 'string' && t.name, 'name 必填');
      assert.ok(typeof t.description === 'string' && t.description, `${t.name} 缺 description`);
      assert.strictEqual(t.inputSchema.type, 'object', `${t.name} inputSchema.type`);
    }
    const names = tools.map((t) => t.name).sort();
    assert.deepStrictEqual(names, [
      'apply_edit', 'diff_decision', 'get_diagnostics', 'get_editor_state', 'get_review_status',
      'list_open_editors', 'open_file', 'propose_changes', 'run_command', 'show_diff', 'write_file'
    ]);
  });

  await checkAsync('get_editor_state 返回编辑器上下文', async () => {
    const res = await rpc({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'get_editor_state', arguments: {} }
    });
    const body = await res.json();
    assert.strictEqual(body.result.isError, false);
    assert.strictEqual(body.result.content[0].type, 'text');
    const data = JSON.parse(body.result.content[0].text);
    assert.strictEqual(data.path, 'C:/demo/src/app.ts');
    assert.strictEqual(data.selection.text, 'const a = 1;');
  });

  await checkAsync('apply_edit 把参数正确传到 IDE 层（门关掉时）', async () => {
    reviewGateOn = false;
    const res = await rpc({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: {
        name: 'apply_edit',
        arguments: { path: 'C:/demo/src/app.ts', oldText: 'const a = 1;', newText: 'const a = 2;' }
      }
    });
    const body = await res.json();
    assert.strictEqual(body.result.isError, false);
    const last = fakeIde.calls.filter((c) => c[0] === 'applyEdit').pop();
    assert.strictEqual(last[1].newText, 'const a = 2;');
    assert.strictEqual(last[1].save, true, 'save 默认应为 true');
    reviewGateOn = true;
  });

  await checkAsync('write_file 默认是"提案"而不是写盘（preview 缺省为 true）', async () => {
    const res = await rpc({
      jsonrpc: '2.0', id: 41, method: 'tools/call',
      params: { name: 'write_file', arguments: { path: 'C:/demo/src/new.ts', content: 'export const x = 1;\n' } }
    });
    const body = await res.json();
    assert.strictEqual(body.result.isError, false);
    const data = JSON.parse(body.result.content[0].text);
    assert.strictEqual(data.preview, true);
    const last = fakeIde.calls.filter((c) => c[0] === 'writeFile').pop();
    assert.strictEqual(last[1].preview, true, '缺省必须走提案分支');
    assert.strictEqual(last[1].createOnly, false);
  });

  await checkAsync('审核门开着：write_file(preview:false) 被强制转成提案', async () => {
    reviewGateOn = true;
    const res = await rpc({
      jsonrpc: '2.0', id: 42, method: 'tools/call',
      params: { name: 'write_file', arguments: { path: 'C:/demo/src/new.ts', content: 'x', preview: false, createOnly: true } }
    });
    const body = await res.json();
    const data = JSON.parse(body.result.content[0].text);
    assert.strictEqual(data.gated, true);
    assert.strictEqual(data.forcedPreview, true);
    const last = fakeIde.calls.filter((c) => c[0] === 'writeFile').pop();
    assert.strictEqual(last[1].preview, true, '门开着时 preview 必须被强制为 true');
    assert.strictEqual(last[1].createOnly, true, 'createOnly 仍然透传');
  });

  await checkAsync('审核门关掉：write_file(preview:false) 才直接写盘', async () => {
    reviewGateOn = false;
    const res = await rpc({
      jsonrpc: '2.0', id: 46, method: 'tools/call',
      params: { name: 'write_file', arguments: { path: 'C:/demo/src/new.ts', content: 'x', preview: false, createOnly: true } }
    });
    const body = await res.json();
    const data = JSON.parse(body.result.content[0].text);
    assert.strictEqual(data.preview, false);
    assert.strictEqual(data.created, true);
    const last = fakeIde.calls.filter((c) => c[0] === 'writeFile').pop();
    assert.strictEqual(last[1].preview, false);
    assert.strictEqual(last[1].createOnly, true);
    reviewGateOn = true;
  });

  await checkAsync('审核门开着：apply_edit 转成提案，绝不调用 applyEdit', async () => {
    reviewGateOn = true;
    fakeIde.calls.length = 0;
    const res = await rpc({
      jsonrpc: '2.0', id: 47, method: 'tools/call',
      params: { name: 'apply_edit', arguments: { path: 'C:/demo/src/app.ts', oldText: 'OLD', newText: 'NEW' } }
    });
    const body = await res.json();
    assert.strictEqual(body.result.isError, false);
    const data = JSON.parse(body.result.content[0].text);
    assert.strictEqual(data.gated, true, '必须标记为已走审核门');
    assert.ok(data.diffId, '应当返回提案 diffId');
    const kinds = fakeIde.calls.map((c) => c[0]);
    assert.ok(kinds.includes('readTextFile'), '要先读原文以换算整份内容');
    assert.ok(kinds.includes('writeFile'), '要走提案');
    assert.ok(!kinds.includes('applyEdit'), '绝不能直接落盘');
    const wf = fakeIde.calls.find((c) => c[0] === 'writeFile')[1];
    assert.strictEqual(wf.preview, true);
    assert.strictEqual(wf.content, 'line1\nNEW\nline2\n', '内容应是替换后的整份文本');
  });

  await checkAsync('审核门开着：oldText 找不到时明确报错，不乱写', async () => {
    reviewGateOn = true;
    const res = await rpc({
      jsonrpc: '2.0', id: 48, method: 'tools/call',
      params: { name: 'apply_edit', arguments: { path: 'C:/demo/src/app.ts', oldText: 'NOT_THERE', newText: 'x' } }
    });
    const body = await res.json();
    assert.strictEqual(body.result.isError, true);
    assert.match(body.result.content[0].text, /未在文件中找到/);
  });

  await checkAsync('审核门关掉：apply_edit 直接应用（WorkspaceEdit）', async () => {
    reviewGateOn = false;
    fakeIde.calls.length = 0;
    const res = await rpc({
      jsonrpc: '2.0', id: 49, method: 'tools/call',
      params: { name: 'apply_edit', arguments: { path: 'C:/demo/src/app.ts', oldText: 'OLD', newText: 'NEW' } }
    });
    const body = await res.json();
    assert.strictEqual(body.result.isError, false);
    assert.deepStrictEqual(fakeIde.calls.map((c) => c[0]), ['applyEdit']);
    reviewGateOn = true;
  });

  await checkAsync('propose_changes 一次提交多文件并透传', async () => {
    const res = await rpc({
      jsonrpc: '2.0', id: 43, method: 'tools/call',
      params: {
        name: 'propose_changes',
        arguments: {
          changes: [
            { path: 'C:/demo/a.ts', content: 'a\n' },
            { path: 'C:/demo/b.ts', content: 'b\n', title: 'B' }
          ]
        }
      }
    });
    const body = await res.json();
    assert.strictEqual(body.result.isError, false);
    const data = JSON.parse(body.result.content[0].text);
    assert.strictEqual(data.files.length, 2);
    const last = fakeIde.calls.filter((c) => c[0] === 'proposeChanges').pop();
    assert.strictEqual(last[1].changes.length, 2);
    assert.strictEqual(last[1].openDiffs, false, '默认不打开 diff 标签');
  });

  await checkAsync('propose_changes 空列表 -> isError', async () => {
    const res = await rpc({
      jsonrpc: '2.0', id: 44, method: 'tools/call',
      params: { name: 'propose_changes', arguments: { changes: [] } }
    });
    const body = await res.json();
    assert.strictEqual(body.result.isError, true);
    assert.match(body.result.content[0].text, /changes/);
  });

  await checkAsync('diff_decision 可以只针对指定几块（hunks）', async () => {
    agentApproveOn = true; // 本用例测的是 hunks 透传，单独放开审批
    const res = await rpc({
      jsonrpc: '2.0', id: 45, method: 'tools/call',
      params: { name: 'diff_decision', arguments: { diffId: 'diff-1', decision: 'accept', hunks: [1, 3] } }
    });
    const body = await res.json();
    assert.strictEqual(body.result.isError, false);
    const last = fakeIde.calls.filter((c) => c[0] === 'diffDecision').pop();
    assert.deepStrictEqual(last[1].hunks, [1, 3]);
    agentApproveOn = false;
  });

  await checkAsync('show_diff → diff_decision 串起来（人工已放行）', async () => {
    agentApproveOn = true;
    const a = await (await rpc({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'show_diff', arguments: { path: 'C:/demo/src/app.ts', newText: 'x' } }
    })).json();
    const diffId = JSON.parse(a.result.content[0].text).diffId;
    assert.strictEqual(diffId, 'diff-1');
    const b = await (await rpc({
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'diff_decision', arguments: { diffId, decision: 'accept' } }
    })).json();
    const decided = JSON.parse(b.result.content[0].text);
    assert.strictEqual(decided.decision, 'accept');
    assert.strictEqual(decided.wroteFile, true);
    agentApproveOn = false;
  });

  await checkAsync('get_review_status 只读回报审核队列状态', async () => {
    const before = fakeIde.calls.filter((c) => c[0] === 'diffDecision').length;
    const res = await rpc({
      jsonrpc: '2.0', id: 70, method: 'tools/call',
      params: { name: 'get_review_status', arguments: {} }
    });
    const body = await res.json();
    assert.strictEqual(body.result.isError, false);
    const data = JSON.parse(body.result.content[0].text);
    assert.strictEqual(data.stats.pending, 3);
    assert.strictEqual(data.files[0].summary[0].status, 'accepted');
    assert.strictEqual(data.files[0].summary[0].startLine, 3);
    // 只读：不该新增任何决定（前面的用例可能已经调用过，所以比较差值）
    assert.strictEqual(
      fakeIde.calls.filter((c) => c[0] === 'diffDecision').length,
      before,
      '只读查询不该触发决定'
    );
  });

  await checkAsync('默认：agent 不能批准自己提出的提案（accept 被拒）', async () => {
    agentApproveOn = false;
    fakeIde.calls.length = 0;
    const res = await rpc({
      jsonrpc: '2.0', id: 60, method: 'tools/call',
      params: { name: 'diff_decision', arguments: { diffId: 'diff-1', decision: 'accept' } }
    });
    const body = await res.json();
    assert.strictEqual(body.result.isError, true, '默认必须拒绝 agent 的 accept');
    assert.match(body.result.content[0].text, /只能由人/);
    assert.strictEqual(
      fakeIde.calls.filter((c) => c[0] === 'diffDecision').length,
      0,
      '被拒后不该走到 IDE 的决定层'
    );
  });

  await checkAsync('默认：reject 仍然允许（撤回自己的提案无害）', async () => {
    agentApproveOn = false;
    const res = await rpc({
      jsonrpc: '2.0', id: 61, method: 'tools/call',
      params: { name: 'diff_decision', arguments: { diffId: 'diff-1', decision: 'reject' } }
    });
    const body = await res.json();
    assert.strictEqual(body.result.isError, false);
  });

  await checkAsync('放行后（agentCanApprove=true）accept 才透传', async () => {
    agentApproveOn = true;
    const res = await rpc({
      jsonrpc: '2.0', id: 62, method: 'tools/call',
      params: { name: 'diff_decision', arguments: { diffId: 'diff-1', decision: 'accept' } }
    });
    const body = await res.json();
    assert.strictEqual(body.result.isError, false);
    agentApproveOn = false;
  });

  console.log('\n[3] 错误分支');
  await checkAsync('未知工具 -> isError=true（不是 JSON-RPC 错误）', async () => {
    const res = await rpc({
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'nope', arguments: {} }
    });
    const body = await res.json();
    assert.strictEqual(body.result.isError, true);
    assert.match(body.result.content[0].text, /未知工具/);
  });

  await checkAsync('缺必填参数 -> isError=true', async () => {
    const res = await rpc({
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'open_file', arguments: {} }
    });
    const body = await res.json();
    assert.strictEqual(body.result.isError, true);
    assert.match(body.result.content[0].text, /path/);
  });

  await checkAsync('未知方法 -> -32601', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 9, method: 'resources/list' });
    const body = await res.json();
    assert.strictEqual(body.error.code, -32601);
  });

  await checkAsync('非法 JSON -> 400 + -32700', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: '{not json'
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).error.code, -32700);
  });

  console.log('\n[4] 传输与鉴权');
  await checkAsync('错误令牌 -> 401', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 10, method: 'tools/list' }, { token: 'wrong' });
    assert.strictEqual(res.status, 401);
  });

  await checkAsync('无令牌 -> 401', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 11, method: 'tools/list' }, { token: null });
    assert.strictEqual(res.status, 401);
  });

  await checkAsync('GET /mcp -> 405', async () => {
    const res = await rpc(null, { method: 'GET' });
    assert.strictEqual(res.status, 405);
  });

  await checkAsync('其他路径 -> 404', async () => {
    const res = await rpc(null, { method: 'GET', path: '/other' });
    assert.strictEqual(res.status, 404);
  });

  await checkAsync('batch 请求返回数组', async () => {
    const res = await rpc([
      { jsonrpc: '2.0', id: 'a', method: 'ping' },
      { jsonrpc: '2.0', id: 'b', method: 'tools/list' }
    ]);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.strictEqual(body.length, 2);
    assert.strictEqual(body[0].id, 'a');
  });

  await new Promise((resolve) => server.close(resolve));

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    console.log('失败项:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('测试运行器自身出错:', err);
  process.exit(2);
});
