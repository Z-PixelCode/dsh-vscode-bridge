'use strict';
/**
 * 会话事件 → 界面条目 映射的单测。
 * 事件形状取自实测抓到的 `dsh --profile sdk` 输出（不是编的）。
 *
 * 运行：node test/chat-model-test.cjs
 */
const assert = require('node:assert');
const { mapSessionEvent, summarizeUsage, usageLine } = require('../src/chat-model');

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

// ---- 实测抓到的真实形状 ----
const realUser = {
  type: 'user/message',
  seq: 8,
  data: {
    content: [{ type: 'text', text: '只回复两个字：收到' }],
    source: { kind: 'user' },
    role: 'user',
    id: '40aeb8d2-8537-4e18-8739-728ab9777bda'
  }
};

const realRuntimeContext = {
  type: 'user/message',
  seq: 9,
  data: {
    content: [{ type: 'text', text: 'Current runtime context. …' }],
    source: { kind: 'runtime-context', form: 'snapshot', sections: [] },
    role: 'user'
  }
};

const realAssistant = {
  type: 'assistant/message',
  seq: 15,
  data: {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '' },
        { type: 'text', text: '收到' }
      ],
      source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
      id: 'bc7b4ba1-c012-4c33-a72d-9e4f32d54759'
    },
    usage: { inputTokens: 6013, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 6015 }
  }
};

console.log('\n[1] 用户消息');

t('source.kind=user -> 渲染成用户条目', () => {
  const r = mapSessionEvent(realUser);
  assert.strictEqual(r.kind, 'user');
  assert.strictEqual(r.entry.role, 'user');
  assert.strictEqual(r.entry.text, '只回复两个字：收到');
  assert.strictEqual(r.entry.id, 'u-8');
});

t('运行时上下文（runtime-context）-> 不渲染', () => {
  const r = mapSessionEvent(realRuntimeContext);
  assert.strictEqual(r.kind, 'ignore');
  assert.match(r.reason, /runtime-context/);
});

t('没有 kind 的 user/message -> 仍当用户消息', () => {
  const r = mapSessionEvent({ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'hi' }] } });
  assert.strictEqual(r.kind, 'user');
});

t('只有图片没有文字 -> 忽略（避免空白气泡）', () => {
  const r = mapSessionEvent({ type: 'user/message', seq: 2, data: { content: [{ type: 'image' }], source: { kind: 'user' } } });
  assert.strictEqual(r.kind, 'ignore');
});

console.log('\n[2] 助手消息');

t('assistant/message -> 文本 + 用量都保留', () => {
  const r = mapSessionEvent(realAssistant);
  assert.strictEqual(r.kind, 'assistant');
  assert.strictEqual(r.entry.text, '收到');
  assert.strictEqual(r.entry.usage.inputTokens, 6013);
  assert.strictEqual(r.entry.id, 'a-15');
});

t('有 reasoning 时单独带出（供折叠显示）', () => {
  const r = mapSessionEvent({
    type: 'assistant/message',
    seq: 3,
    data: { message: { content: [{ type: 'reasoning', text: '我在想…' }, { type: 'text', text: '答' }] } }
  });
  assert.strictEqual(r.entry.reasoning, '我在想…');
  assert.strictEqual(r.entry.text, '答');
});

t('只有 reasoning 没有正文 -> 仍出条目', () => {
  const r = mapSessionEvent({ type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'reasoning', text: 'x' }] } } });
  assert.strictEqual(r.kind, 'assistant');
  assert.strictEqual(r.entry.text, '');
});

t('全空 message -> 忽略', () => {
  assert.strictEqual(mapSessionEvent({ type: 'assistant/message', seq: 5, data: { message: { content: [] } } }).kind, 'ignore');
});

console.log('\n[3] 工具调用');

t('tool/call -> 名称 + 参数 JSON + callId', () => {
  const r = mapSessionEvent({
    type: 'tool/call',
    seq: 20,
    data: { name: 'read', arguments: { file_path: 'D:\\a.ts' }, callId: 'call_1' }
  });
  assert.strictEqual(r.kind, 'tool-call');
  assert.strictEqual(r.callId, 'call_1');
  assert.strictEqual(r.entry.name, 'read');
  assert.match(r.entry.args, /file_path/);
});

t('tool/call 的 arguments 是字符串时不额外加引号（实测形状）', () => {
  const r = mapSessionEvent({
    type: 'tool/call',
    seq: 21,
    data: { name: 'mcp__vscode__get_editor_state', arguments: '{}', callId: 'call_2' }
  });
  assert.strictEqual(r.entry.args, '{}', `实际: ${r.entry.args}`);
  const r2 = mapSessionEvent({
    type: 'tool/call',
    seq: 22,
    data: { name: 'x', arguments: '{"a":1}', callId: 'c' }
  });
  assert.strictEqual(r2.entry.args, '{"a":1}');
});

t('tool/result 通过 callId 关联，产出 patch', () => {
  const r = mapSessionEvent({
    type: 'tool/result',
    seq: 21,
    data: { message: { toolCallId: 'call_1', content: [{ type: 'text', text: '第一行\n第二行' }] } }
  });
  assert.strictEqual(r.kind, 'tool-result');
  assert.strictEqual(r.callId, 'call_1');
  assert.strictEqual(r.patch.ok, true);
  assert.strictEqual(r.patch.summary, '第一行');
  assert.match(r.patch.result, /第二行/);
});

t('isError 的 tool/result -> ok=false', () => {
  const r = mapSessionEvent({
    type: 'tool/result',
    seq: 22,
    data: { message: { toolCallId: 'c', content: [{ type: 'text', text: '错误: 拒绝' }], isError: true } }
  });
  assert.strictEqual(r.patch.ok, false);
});

t('通过 SDK 的 notice 包裹（{event}）也能解出', () => {
  const r = mapSessionEvent({ event: realUser });
  assert.strictEqual(r.kind, 'user');
});

console.log('\n[4] 其它');

t('turn/end -> 结束信号', () => {
  assert.strictEqual(mapSessionEvent({ type: 'turn/end', seq: 17, data: { turn: 1 } }).kind, 'turn-end');
});

t('未知类型 -> ignore 且带原因', () => {
  const r = mapSessionEvent({ type: 'request/header', seq: 12, data: {} });
  assert.strictEqual(r.kind, 'ignore');
  assert.strictEqual(r.reason, 'request/header');
});

t('用量汇总（含缓存命中）', () => {
  const u = summarizeUsage([
    { usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 60, cacheWriteTokens: 5 } },
    { usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 150 } },
    { text: '没有用量的条目' }
  ]);
  assert.strictEqual(u.inputTokens, 300);
  assert.strictEqual(u.outputTokens, 30);
  assert.strictEqual(u.cacheReadTokens, 210);
  assert.strictEqual(u.cacheWriteTokens, 5);
  assert.strictEqual(u.turns, 2);
});

t('usageLine：无用量时为空串', () => {
  assert.strictEqual(usageLine([]), '');
  assert.match(usageLine([{ usage: { inputTokens: 5, outputTokens: 1 } }]), /输入 5 · 输出 1/);
  assert.match(usageLine([{ usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 4 } }]), /缓存命中 4/);
});

console.log('\n[5] 会话列表');

const S = require('../src/chat-model');

t('空状态', () => {
  const st = S.emptyState();
  assert.deepStrictEqual(st, { activeId: null, sessions: [] });
  assert.strictEqual(S.activeSession(st), null);
});

t('新建会话 -> 置为当前、默认标题', () => {
  const st = S.emptyState();
  const s = S.addSession(st, 'a');
  assert.strictEqual(st.activeId, 'a');
  assert.strictEqual(s.title, '新对话');
  assert.strictEqual(S.activeSession(st).id, 'a');
});

t('首条用户消息顺便当标题（换行压平、超长截断）', () => {
  const st = S.emptyState();
  S.addSession(st, 'a');
  S.appendEntry(st, { id: 'u1', role: 'user', text: '第一行\n第二行 还有很多字很多字很多字很多字很多字' });
  assert.match(S.activeSession(st).title, /^第一行 第二行/);
  assert.ok(S.activeSession(st).title.length <= 25);
});

t('新会话不会清掉老会话（这就是之前那个 bug）', () => {
  const st = S.emptyState();
  S.addSession(st, 'a');
  S.appendEntry(st, { id: 'u1', role: 'user', text: '老对话内容' });
  S.addSession(st, 'b');
  S.appendEntry(st, { id: 'u2', role: 'user', text: '新对话内容' });
  assert.strictEqual(st.sessions.length, 2);
  assert.strictEqual(S.findSession(st, 'a').entries.length, 1);
  assert.strictEqual(S.findSession(st, 'a').entries[0].text, '老对话内容');
  assert.strictEqual(st.activeId, 'b');
});

t('切换会话拿回各自的记录', () => {
  const st = S.emptyState();
  S.addSession(st, 'a');
  S.appendEntry(st, { id: 'u1', role: 'user', text: 'A' });
  S.addSession(st, 'b');
  S.appendEntry(st, { id: 'u2', role: 'user', text: 'B' });
  assert.strictEqual(S.switchSession(st, 'a').entries[0].text, 'A');
  assert.strictEqual(S.switchSession(st, 'nope'), null);
  assert.strictEqual(st.activeId, 'a', '切换失败不该改当前');
});

t('删除当前会话 -> 回落到第一个', () => {
  const st = S.emptyState();
  S.addSession(st, 'a');
  S.addSession(st, 'b');
  S.removeSession(st, 'b');
  assert.strictEqual(st.activeId, 'a');
  S.removeSession(st, 'a');
  assert.strictEqual(st.activeId, null);
});

t('会话数与条目数都有上限', () => {
  const st = S.emptyState();
  for (let i = 0; i < S.MAX_SESSIONS + 5; i += 1) S.addSession(st, `s${i}`);
  assert.strictEqual(st.sessions.length, S.MAX_SESSIONS);
  const cur = S.activeSession(st);
  for (let i = 0; i < S.MAX_ENTRIES_PER_SESSION + 10; i += 1) {
    S.appendEntry(st, { id: `e${i}`, role: 'assistant', text: 'x' });
  }
  assert.strictEqual(cur.entries.length, S.MAX_ENTRIES_PER_SESSION);
});

t('patchEntry 回填工具结果', () => {
  const st = S.emptyState();
  S.addSession(st, 'a');
  S.appendEntry(st, { id: 't1', role: 'tool', name: 'read' });
  S.patchEntry(st, 't1', { ok: true, result: '内容' });
  assert.strictEqual(S.activeSession(st).entries[0].result, '内容');
  assert.strictEqual(S.patchEntry(st, 'nope', {}), null);
});

t('normalizeState 容错：垃圾输入 -> 空状态，合法输入保留', () => {
  assert.deepStrictEqual(S.normalizeState(null), S.emptyState());
  assert.deepStrictEqual(S.normalizeState({ sessions: 'nope' }), S.emptyState());
  const good = S.normalizeState({ activeId: 'zz', sessions: [{ id: 'a', entries: [{ id: 'e' }] }] });
  assert.strictEqual(good.activeId, 'a', 'activeId 无效时回落到第一个');
  assert.strictEqual(good.sessions[0].title, '新对话');
});

t('forStorage 截断超长文本', () => {
  const st = S.emptyState();
  S.addSession(st, 'a');
  S.appendEntry(st, { id: 'u1', role: 'user', text: 'x'.repeat(20000) });
  const stored = S.forStorage(st);
  assert.ok(stored.sessions[0].entries[0].text.length < 20000);
  assert.match(stored.sessions[0].entries[0].text, /已截断/);
});

console.log('\n[6] Markdown 渲染（安全第一）');

t('转义 HTML 标签', () => {
  const out = S.miniMarkdown('<script>alert(1)</script>');
  assert.ok(!out.includes('<script>'));
  assert.ok(out.includes('&lt;script&gt;'));
});

t('围栏代码块：结构 + 内部转义', () => {
  const out = S.miniMarkdown('前言\n```ts\nconst a = 1 < 2;\n```\n后记');
  assert.ok(out.includes('<pre class="code">'), 'pre.code 结构');
  assert.ok(out.includes('data-lang="ts"'), '语言标记');
  assert.ok(out.includes('&lt;'), '< 被转义');
  assert.ok(!out.includes('< 2;'), '不能出现裸 <');
  assert.ok(!/\n```/.test(out), '围栏标记应被消化掉');
});

t('回归：高亮不能污染自己生成的标记', () => {
  // 曾经的 bug：关键字逐个 replace，第 2 轮会命中第 1 轮插入的 class="kw" 里的 class，
  // 产出 <span <span class="kw">class</span>="kw">const</span> 这种坏 HTML
  const out = S.miniMarkdown('```js\nclass A { const x = 1; }\n```');
  assert.ok(!/<\w+[^>]*<span/.test(out), `出现自嵌套标记:\n${out}`);
  assert.ok(!/class<\/span>="kw"/.test(out), `关键字被打断:\n${out}`);
  const open = (out.match(/<span/g) || []).length;
  const close = (out.match(/<\/span>/g) || []).length;
  assert.strictEqual(open, close, 'span 必须成对');
});

t('回归：数字高亮不能打断 HTML 实体', () => {
  // 曾经的 bug：\b\d+\b 会命中 &#39; 里的 39，产出 &#<span class="num">39</span>;
  const out = S.miniMarkdown("```js\nconst s = 'a';\n```");
  assert.ok(!out.includes('&#<span'), `实体被破坏:\n${out}`);
  assert.ok(out.includes('&#39;'), '单引号应保留为实体');
});

t('hash 注释只在 hash 类语言里生效', () => {
  const css = S.miniMarkdown('```css\n.a { color: #fff; }\n```');
  assert.ok(!css.includes('class="cmt"'), `CSS 的 #fff 被误判成注释:\n${css}`);
  const py = S.miniMarkdown('```py\ndef f():  # 注释\n    pass\n```');
  assert.ok(py.includes('class="cmt"'), 'py 的 # 注释应当高亮');
  assert.ok(py.includes('class="kw"'), 'py 关键字应当高亮');
});

t('行内代码 / 粗体 / 斜体', () => {
  const out = S.miniMarkdown('这是 `code` 和 **粗** 与 *斜*');
  assert.ok(out.includes('<code class="inline">code</code>'));
  assert.ok(out.includes('<strong>粗</strong>'));
  assert.ok(out.includes('<em>斜</em>'));
});

t('列表与标题', () => {
  const out = S.miniMarkdown('## 标题\n- 一\n- 二\n1. 甲\n2. 乙');
  assert.ok(out.includes('<h4>标题</h4>'));
  assert.ok(out.includes('<ul>') && out.includes('<li>一</li>'));
  assert.ok(out.includes('<ol>') && out.includes('<li>甲</li>'));
});

t('只把 http(s) 变链接，javascript: 不会', () => {
  const ok = S.miniMarkdown('[点我](https://example.com)');
  assert.ok(ok.includes('<a href="https://example.com"'));
  const bad = S.miniMarkdown('[坏](javascript:alert(1))');
  assert.ok(!bad.includes('<a '), 'javascript: 不该变成链接');
});

t('代码块里的伪标签不会被当 HTML 执行', () => {
  const out = S.miniMarkdown('```\n<img src=x onerror=alert(1)>\n```');
  assert.ok(!out.includes('<img'));
  assert.ok(out.includes('&lt;img'));
});

console.log('\n[7] 发送回声去重（消息重复显示的根因）');

t('没有本地用户消息 -> 直接新增', () => {
  assert.deepStrictEqual(S.resolveUserEcho([], { text: 'hi' }), { action: 'append' });
  assert.deepStrictEqual(
    S.resolveUserEcho([{ id: 'a1', role: 'assistant', text: 'x' }], { text: 'hi' }),
    { action: 'append' }
  );
});

t('最近一条本地乐观条目且文本相同 -> 确认（不再插一条）', () => {
  const list = [
    { id: 'u1', role: 'user', text: '你好', local: true },
    { id: 'a1', role: 'assistant', text: '收到' }
  ];
  assert.deepStrictEqual(S.resolveUserEcho(list, { text: '你好' }), { action: 'confirm', id: 'u1' });
});

t('已确认过的同文本再来 -> 当作新消息（用户真的又发了一遍）', () => {
  const list = [{ id: 'u1', role: 'user', text: '你好', local: false }];
  assert.deepStrictEqual(S.resolveUserEcho(list, { text: '你好' }), { action: 'append' });
});

t('文本不同 -> 新增（例如从别的客户端发来的）', () => {
  const list = [{ id: 'u1', role: 'user', text: 'A', local: true }];
  assert.deepStrictEqual(S.resolveUserEcho(list, { text: 'B' }), { action: 'append' });
});

console.log('\n[8] SDK 会话 id（必须全局唯一，否则重载后报 already exists）');

t('同一纪元内同一个对话 -> 同一个 id（模型记忆连续）', () => {
  assert.strictEqual(S.dshSessionIdFor('s-abc', 'e1'), 's-abc-pe1');
  assert.strictEqual(S.dshSessionIdFor('s-abc', 'e1'), S.dshSessionIdFor('s-abc', 'e1'));
});

t('换纪元 -> 换 id（换子进程不会撞已存在的会话）', () => {
  assert.notStrictEqual(S.dshSessionIdFor('s-abc', 'e1'), S.dshSessionIdFor('s-abc', 'e2'));
});

t('不同对话 -> 不同 id', () => {
  assert.notStrictEqual(S.dshSessionIdFor('s-1', 'e1'), S.dshSessionIdFor('s-2', 'e1'));
});

t('没有当前对话 -> null', () => {
  assert.strictEqual(S.dshSessionIdFor(null, 'e1'), null);
  assert.strictEqual(S.dshSessionIdFor('', 'e1'), null);
});

t('纪元缺失也有确定值（不会出现 undefined 拼进 id）', () => {
  assert.strictEqual(S.dshSessionIdFor('s-abc', null), 's-abc-px');
  assert.ok(!S.dshSessionIdFor('s-abc', null).includes('undefined'));
});

console.log('\n[9] 统计（对齐桌面 app 底部那行数字）');

t('新事件类型被正确映射', () => {
  assert.strictEqual(S.mapSessionEvent({ type: 'turn/start', seq: 4, data: { turn: 1 } }).kind, 'turn-start');
  assert.strictEqual(S.mapSessionEvent({ type: 'step/start', seq: 6, data: { step: 1 } }).kind, 'step-start');
  const rc = S.mapSessionEvent({
    type: 'request/context',
    seq: 12,
    data: { contextWindow: 1000000, provider: 'deepseek-official', model: 'deepseek-flash' }
  });
  assert.strictEqual(rc.kind, 'request-context');
  assert.strictEqual(rc.contextWindow, 1000000);
  assert.strictEqual(rc.model, 'deepseek-flash');
});

t('用量累积 + 缓存命中率（用实测数字：input 568 / cacheRead 7296）', () => {
  let st = S.emptyStats();
  st = S.reduceStats(st, S.mapSessionEvent(realAssistant), 1000);
  assert.strictEqual(st.inputTokens, 6013);
  assert.strictEqual(st.outputTokens, 2);
  assert.strictEqual(st.totalTokens, 6015);
  assert.strictEqual(st.contextUsed, 6015, '上下文占用取最近一次的 totalTokens');
  st = S.reduceStats(st, { kind: 'request-context', contextWindow: 1000000 }, 1000);
  assert.strictEqual(st.contextWindow, 1000000);
  assert.strictEqual(Math.round(st.contextRatio * 100), 1, '6015/1000000 ≈ 1%');
});

t('缓存命中率 = cacheRead / (input + cacheRead)，且逐轮累积', () => {
  let st = S.emptyStats();
  st = S.reduceStats(st, { kind: 'assistant', entry: { usage: { inputTokens: 568, cacheReadTokens: 7296, outputTokens: 2 } } }, 0);
  assert.strictEqual(Math.round(st.cacheHitRate * 100), 93);
  st = S.reduceStats(st, { kind: 'assistant', entry: { usage: { inputTokens: 432, cacheReadTokens: 0, outputTokens: 10 } } }, 0);
  assert.strictEqual(st.inputTokens, 1000);
  assert.strictEqual(st.cacheReadTokens, 7296);
  assert.strictEqual(Math.round(st.cacheHitRate * 100), 88);
});

t('turn/step 计数与 tok/s', () => {
  let st = S.emptyStats();
  st = S.reduceStats(st, { kind: 'turn-start' }, 10_000);
  st = S.reduceStats(st, { kind: 'step-start' }, 10_000);
  st = S.reduceStats(st, { kind: 'step-start' }, 10_500);
  st = S.reduceStats(st, { kind: 'assistant', entry: { usage: { outputTokens: 200, inputTokens: 0, cacheReadTokens: 0 } } }, 10_800);
  st = S.reduceStats(st, { kind: 'turn-end' }, 11_000);
  assert.strictEqual(st.turns, 1);
  assert.strictEqual(st.steps, 2);
  assert.strictEqual(st.turnMs, 1000);
  assert.strictEqual(st.tps, 200, '200 token / 1 秒');
});

t('reduceStats 是纯函数（不改入参）', () => {
  const before = S.emptyStats();
  const snapshot = JSON.stringify(before);
  S.reduceStats(before, { kind: 'step-start' }, 0);
  assert.strictEqual(JSON.stringify(before), snapshot);
});

t('时长格式化：3 分 36 秒 / 12 秒 / 1 小时 5 分', () => {
  assert.strictEqual(S.formatDuration(216_000), '3 分 36 秒');
  assert.strictEqual(S.formatDuration(12_000), '12 秒');
  assert.strictEqual(S.formatDuration(3_900_000), '1 小时 5 分');
  assert.strictEqual(S.formatDuration(0), '0 秒');
});

t('token 格式化：147M / 12.3k / 568', () => {
  assert.strictEqual(S.formatTokens(147_000_000), '147M');
  assert.strictEqual(S.formatTokens(12_345), '12.3k');
  assert.strictEqual(S.formatTokens(568), '568');
  assert.strictEqual(S.formatTokens(0), '0');
});

t('statsLines 组装三段文本；没数据时全空', () => {
  assert.deepStrictEqual(S.statsLines(S.emptyStats()), { progress: '', tokens: '', context: '' });
  let st = S.emptyStats();
  st = S.reduceStats(st, { kind: 'turn-start' }, 0);
  st = S.reduceStats(st, { kind: 'step-start' }, 0);
  st = S.reduceStats(st, { kind: 'assistant', entry: { usage: { inputTokens: 568, cacheReadTokens: 7296, outputTokens: 2 } } }, 900);
  st = S.reduceStats(st, { kind: 'turn-end' }, 1000);
  st = S.reduceStats(st, { kind: 'request-context', contextWindow: 1000000 }, 1000);
  const lines = S.statsLines(st);
  assert.match(lines.progress, /^1 轮 1 步 · \d+ tok\/s$/);
  assert.match(lines.tokens, /^7\.9k tok · 缓存命中 93%$/);
  assert.strictEqual(lines.context, '1%');
});

t('选择器的目录来自出厂定义', () => {
  assert.deepStrictEqual(S.MODEL_CATALOG.map((m) => m.id), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.strictEqual(S.MODEL_CATALOG[0].name, 'DeepSeek-V41-Flash');
  assert.deepStrictEqual(S.REASONING_EFFORTS.map((e) => e.id), ['', 'low', 'medium', 'high']);
  const modes = S.PERMISSION_MODES.map((m) => m.id);
  assert.ok(modes.includes('read-only') && modes.includes('workspace-write') && modes.includes(''));
});

console.log('\n[10] 思考/正文回放（对齐 app 的"边想边出"）');

t('assistant/message 会带出 stream 记录', () => {
  const r = S.mapSessionEvent({
    type: 'assistant/message',
    seq: 9,
    data: { message: { content: [{ type: 'text', text: 'hi' }] }, stream: [{ type: 'chunk', time: 1, chunk: { type: 'text-delta', text: 'h' } }] }
  });
  assert.strictEqual(r.stream.length, 1);
});

t('reasoning-chunks / text-chunks 展开成带间隔的步骤', () => {
  const plan = S.replayPlan([
    { type: 'reasoning-chunks', time0: 0, index: 0, dt: [10, 20], texts: ['先想', '再想'] },
    { type: 'text-chunks', time0: 0, index: 1, dt: [30], texts: ['答案'] }
  ], { maxTotalMs: 10000 });
  assert.deepStrictEqual(plan.map((s) => [s.target, s.delta]), [
    ['reasoning', '先想'],
    ['reasoning', '再想'],
    ['text', '答案']
  ]);
  assert.deepStrictEqual(plan.map((s) => s.waitMs), [10, 20, 30]);
});

t('chunk 变体（block-start / *-delta）也能解出增量', () => {
  const plan = S.replayPlan([
    { type: 'chunk', time: 1, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
    { type: 'chunk', time: 2, chunk: { type: 'reasoning-delta', text: '思考中' } },
    { type: 'chunk', time: 3, chunk: { type: 'text-delta', text: '正文' } }
  ]);
  assert.deepStrictEqual(plan.map((s) => [s.target, s.delta]), [['reasoning', '思考中'], ['text', '正文']]);
});

t('时间轴会被压缩到上限内（不让界面落后于真实进度）', () => {
  const plan = S.replayPlan([{ type: 'text-chunks', time0: 0, index: 0, dt: [30000, 30000], texts: ['a', 'b'] }], {
    maxTotalMs: 2000
  });
  const total = plan.reduce((a, s) => a + s.waitMs, 0);
  assert.ok(total <= 2100, `总时长应被压缩，实际 ${total}`);
  assert.ok(plan.every((s) => s.waitMs >= 6));
});

t('步数过多时抽样合并，且不丢字', () => {
  const texts = Array.from({ length: 400 }, (_, i) => `x${i}`);
  const plan = S.replayPlan([{ type: 'text-chunks', time0: 0, index: 0, dt: texts.map(() => 1), texts }], { maxSteps: 50 });
  assert.ok(plan.length <= 100, `实际 ${plan.length}`);
  const joined = plan.map((s) => s.delta).join('');
  assert.strictEqual(joined, texts.join(''), '合并后内容必须完整');
});

t('没有 stream 或全是空块 -> 空计划（走"直接显示"路径）', () => {
  assert.deepStrictEqual(S.replayPlan([]), []);
  assert.deepStrictEqual(S.replayPlan(undefined), []);
  assert.deepStrictEqual(S.replayPlan([{ type: 'chunk', time: 1, chunk: { type: 'block-start' } }]), []);
  assert.deepStrictEqual(S.replayPlan([{ type: 'text-chunks', dt: [1], texts: [''] }]), []);
});

console.log('\n[11] 工具结果摘要（别把原始 XML 吐给用户）');

t('read 工具的 XML 包装被抽成"文件名 · N 行"', () => {
  const r = S.summarizeToolResult('read', '<path>d:\\work\\hello.py</path>\n<type>file</type>\n<content>\nline1\nline2\n</content>');
  assert.strictEqual(r.summary, 'hello.py · 2 行');
  assert.strictEqual(r.body, 'line1\nline2');
});

t('普通文本结果 -> 首行当摘要，body 为 null（非命令类工具）', () => {
  const r = S.summarizeToolResult('some_tool', 'Hello, World!\n第二行');
  assert.strictEqual(r.summary, 'Hello, World!');
  assert.strictEqual(r.body, null);
});

t('空结果不炸', () => {
  assert.strictEqual(S.summarizeToolResult('x', '').summary, '');
  assert.strictEqual(S.summarizeToolResult('x', null).summary, '');
});

t('JSON 结果 -> 一行紧凑摘要 + 格式化正文（翻译 transcript 里那坨原始 JSON）', () => {
  const big = JSON.stringify({ focusInEditor: true, hasEditor: true, workspaceFolders: ['d:\\work'], openEditors: [] });
  const r = S.summarizeToolResult('mcp__vscode__get_editor_state', big);
  assert.strictEqual(r.summary.includes('\n'), false, '摘要必须是一行');
  assert.ok(r.summary.length <= 141, `摘要过长: ${r.summary.length}`);
  assert.match(r.body, /\n {2}"hasEditor": true/, '正文应是格式化 JSON');
});

t('超长 JSON 摘要被截断并带省略号', () => {
  const r = S.summarizeToolResult('x', JSON.stringify({ a: 'y'.repeat(500) }));
  assert.match(r.summary, /…$/);
});

t('长得像 JSON 但解析失败的 -> 说"JSON（N 行，已截断）"，不是首行 `{`', () => {
  const r = S.summarizeToolResult('x', '{不是合法 JSON');
  assert.match(r.summary, /^JSON（\d+ 行，已截断）$/, `实际: ${r.summary}`);
  assert.strictEqual(r.body, null);
});

console.log('\n[12] "正在做什么"（对齐 app 的活动提示行）');

t('pwsh 取 description 当细节', () => {
  const d = S.describeToolCall('pwsh', JSON.stringify({ command: 'Get-ChildItem', description: 'Check for streaming delta events' }));
  assert.strictEqual(d, '正在运行命令 · Check for streaming delta events');
});

t('read 取文件路径的basename', () => {
  assert.strictEqual(S.describeToolCall('read', JSON.stringify({ file_path: 'd:\\work\\hello.py' })), '正在读取文件 · hello.py');
  assert.strictEqual(S.describeToolCall('read', JSON.stringify({ file_path: '/a/b/c.md' })), '正在读取文件 · c.md');
});

t('grep / glob / list_dir', () => {
  assert.strictEqual(S.describeToolCall('grep', JSON.stringify({ pattern: 'TODO' })), '正在搜索内容 · TODO');
  assert.strictEqual(S.describeToolCall('glob', JSON.stringify({ pattern: '**/*.ts' })), '正在查找文件 · **/*.ts');
  assert.strictEqual(S.describeToolCall('list_dir', JSON.stringify({ path: 'D:/x/y' })), '正在列出目录 · y');
});

t('桥的工具单独成一类', () => {
  assert.strictEqual(S.describeToolCall('mcp__vscode__get_editor_state', '{}'), '正在调用 VS Code 工具 · get_editor_state');
  assert.strictEqual(S.describeToolCall('mcp__vscode__propose_changes', '{}'), '正在调用 VS Code 工具 · propose_changes');
});

t('未知工具 / 参数缺失 / 参数不是 JSON 都不炸', () => {
  assert.strictEqual(S.describeToolCall('whatever', '{}'), '正在调用 whatever');
  assert.strictEqual(S.describeToolCall('read', '{}'), '正在读取文件');
  assert.strictEqual(S.describeToolCall('read', '这不是 JSON'), '正在读取文件');
  assert.strictEqual(S.describeToolCall('read'), '正在读取文件');
  assert.strictEqual(S.describeToolCall(null), '正在调用 tool');
});

t('参数是对象（不是字符串）时同样可用', () => {
  assert.strictEqual(S.describeToolCall('edit', { file_path: 'D:\\a\\b.py' }), '正在修改文件 · b.py');
});

t('超长细节被截断', () => {
  const d = S.describeToolCall('pwsh', JSON.stringify({ description: 'x'.repeat(200) }));
  assert.ok(d.length < 100, `实际 ${d.length}`);
  assert.match(d, /…$/);
});

console.log('\n[13] 工具参数摘要（别把整份文件内容铺在对话里）');

t('propose_changes -> "N 个文件 · 前几个名字"', () => {
  const args = JSON.stringify({
    changes: [
      { path: 'd:\\work\\calc.py', content: 'x'.repeat(300) },
      { path: 'd:\\work\\grade.py', content: 'y' },
      { path: 'd:\\work\\config.json', content: 'z' },
      { path: 'd:\\work\\NOTES.md', content: 'w' },
      { path: 'd:\\work\\scripts\\run.ps1', content: 'v' }
    ]
  });
  const r = S.summarizeToolArgs('mcp__vscode__propose_changes', args);
  assert.strictEqual(r.summary, '5 个文件 · calc.py, grade.py, config.json, NOTES.md 等 5 个');
  assert.ok(r.body.includes('x'.repeat(50)), '完整参数必须保留在 body 里（信息不丢）');
});

t('propose_changes 少于 5 个不带"等 N 个"', () => {
  const r = S.summarizeToolArgs('propose_changes', JSON.stringify({ changes: [{ path: 'a.py', content: '1' }, { path: 'b.py', content: '2' }] }));
  assert.strictEqual(r.summary, '2 个文件 · a.py, b.py');
});

t('write_file 带内容 -> 文件名 · N 行 + 抽出代码块', () => {
  const r = S.summarizeToolArgs('write_file', JSON.stringify({ path: 'd:\\work\\math_utils.py', content: 'def add(a, b):\n    return a + b\n' }));
  assert.strictEqual(r.summary, 'math_utils.py · 2 行');
  assert.ok(r.code, '应当抽出 code');
  assert.strictEqual(r.code.lang, 'python', '按扩展名推语言');
  assert.match(r.code.text, /def add/);
  const r2 = S.summarizeToolArgs('apply_edit', JSON.stringify({ path: 'a.ts', oldText: 'a', newText: 'const x = 1;\n' }));
  assert.strictEqual(r2.code.lang, 'ts');
  assert.strictEqual(r2.summary, 'a.ts · 1 行');
});

t('apply_edit 用 newText 长度说明改动量', () => {
  const r = S.summarizeToolArgs('apply_edit', JSON.stringify({ path: 'd:\\x\\a.txt', oldText: 'old', newText: 'newtext' }));
  assert.strictEqual(r.summary, 'a.txt · 1 行');
  assert.strictEqual(r.code.text, 'newtext');
});

t('read 只有路径 -> 只显示文件名', () => {
  assert.strictEqual(S.summarizeToolArgs('read', JSON.stringify({ file_path: 'd:\\a\\b\\c.py' })).summary, 'c.py');
});

t('pwsh 用 description；grep 用 pattern', () => {
  assert.strictEqual(S.summarizeToolArgs('pwsh', JSON.stringify({ command: 'ls', description: '列出文件' })).summary, '列出文件');
  assert.strictEqual(S.summarizeToolArgs('pwsh', JSON.stringify({ command: 'Get-ChildItem -Force' })).summary, 'Get-ChildItem -Force');
  assert.strictEqual(S.summarizeToolArgs('grep', JSON.stringify({ pattern: 'TODO', path: 'x' })).summary, 'TODO');
});

t('未知结构 -> 只列键名；空对象 -> 无参数', () => {
  assert.strictEqual(S.summarizeToolArgs('whatever', JSON.stringify({ a: 1, b: 2 })).summary, '{a, b}');
  assert.strictEqual(S.summarizeToolArgs('whatever', '{}').summary, '无参数');
});

t('参数不是 JSON 时退化成截断原文，不炸', () => {
  const r = S.summarizeToolArgs('x', '这不是 JSON 但很长'.repeat(20));
  assert.ok(r.summary.endsWith('…'));
  assert.ok(S.summarizeToolArgs('x', null).summary.length >= 0);
});

console.log('\n[14] 旧记录迁移（重载后老工具卡不再展开、摘要重算）');

t('旧工具条目：open 被删、摘要从 args/result 重算', () => {
  const big = JSON.stringify({ changes: [{ path: 'd:\\work\\calc.py', content: 'def a()...' }, { path: 'd:\\work\\grade.py', content: 'x' }] });
  const st = S.normalizeState({
    activeId: 'a',
    sessions: [{
      id: 'a',
      entries: [{
        id: 't1', role: 'tool', name: 'mcp__vscode__propose_changes',
        args: big, open: true, streaming: true, summary: '{',
        result: '{\n  "batchId": "b",\n  "stats": {"pending":2}\n}'
      }]
    }]
  });
  const e = st.sessions[0].entries[0];
  assert.strictEqual(e.open, undefined, 'open 字段必须被删');
  assert.strictEqual(e.streaming, undefined, 'streaming 字段必须被删');
  assert.strictEqual(e.argSummary, '2 个文件 · calc.py, grade.py', 'argSummary 应重算');
  assert.notStrictEqual(e.summary, '{', 'summary 不该再是结果首行');
  assert.ok(e.summary.includes('batchId') || e.summary.includes('pending'), `summary 应是压缩 JSON: ${e.summary}`);
  assert.match(e.result, /\n {2}"batchId"/, 'result 应被格式化成漂亮 JSON');
});

t('非工具条目原样保留，不误伤', () => {
  const st = S.normalizeState({ activeId: 'a', sessions: [{ id: 'a', entries: [{ id: 'u1', role: 'user', text: 'hi', open: true }] }] });
  const e = st.sessions[0].entries[0];
  assert.strictEqual(e.text, 'hi');
  assert.strictEqual(e.open, undefined, 'user 条目上的 open 也应被清理');
});

t('空状态 / 无 entries 不炸', () => {
  assert.deepStrictEqual(S.normalizeState(null), S.emptyState());
  const st = S.normalizeState({ activeId: 'a', sessions: [{ id: 'a', entries: null }] });
  assert.deepStrictEqual(st.sessions[0].entries, []);
});

console.log('\n[15] 本次对话改动汇总（「已编辑 N 个文件」卡片）');

t('mergeChanges：新文件直接加入', () => {
  const out = S.mergeChanges([], [{ path: 'a.py', added: 3, removed: 1, line: 5 }]);
  assert.deepStrictEqual(out, [{ path: 'a.py', added: 3, removed: 1, line: 5, turn: 1 }]);
});

t('mergeChanges：同一文件多次改动累加，line 取最新', () => {
  let out = S.mergeChanges([], [{ path: 'a.py', added: 3, removed: 1, line: 5 }]);
  out = S.mergeChanges(out, [{ path: 'a.py', added: 2, removed: 4, line: 20 }]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].added, 5);
  assert.strictEqual(out[0].removed, 5);
  assert.strictEqual(out[0].line, 20);
});

t('mergeChanges：已有条目保留、非法输入忽略', () => {
  const out = S.mergeChanges([{ path: 'keep.py', added: 1, removed: 0 }], [null, {}, { path: '' }, { path: 'new.py', added: 2 }]);
  assert.strictEqual(out.length, 2);
  assert.ok(out.some((c) => c.path === 'keep.py' && c.added === 1));
  assert.ok(out.some((c) => c.path === 'new.py' && c.added === 2));
});

t('changeTotals：文件数与总增删', () => {
  assert.deepStrictEqual(
    S.changeTotals([{ path: 'a', added: 3, removed: 1 }, { path: 'b', added: 10, removed: 2 }, null]),
    { files: 2, added: 13, removed: 3 }
  );
  assert.deepStrictEqual(S.changeTotals([]), { files: 0, added: 0, removed: 0 });
});

t('entryChangeStats：只统计已接受的块，行号取首个改动处', () => {
  const entry = {
    hunks: [
      { status: 'accepted', aStart: 9, aLines: ['x'], bLines: ['y', 'z'] },
      { status: 'rejected', aStart: 2, aLines: ['q'], bLines: ['w'] },
      { status: 'accepted', aStart: 20, aLines: [], bLines: ['new'] }
    ]
  };
  assert.deepStrictEqual(S.entryChangeStats(entry), { added: 3, removed: 1, line: 10 });
});

t('entryChangeStats：没有接受任何块 -> 全 0、行号兜底 1', () => {
  assert.deepStrictEqual(S.entryChangeStats({ hunks: [{ status: 'rejected', aStart: 3, aLines: ['a'], bLines: ['b'] }] }), {
    added: 0,
    removed: 0,
    line: 1
  });
  assert.deepStrictEqual(S.entryChangeStats(null), { added: 0, removed: 0, line: 1 });
});

t('normalizeState / forStorage 保留 changes', () => {
  const st = S.normalizeState({ activeId: 'a', sessions: [{ id: 'a', changes: [{ path: 'x', added: 1, removed: 1, line: 2 }] }] });
  assert.strictEqual(st.sessions[0].changes.length, 1);
  assert.strictEqual(S.forStorage(st).sessions[0].changes.length, 1);
});

console.log('\n[16] 旧条目 html 重算（老对话里的代码块也要出来）');

t('助手条目的 html 按当前渲染器重算（含代码块的才能出现）', () => {
  const st = S.normalizeState({
    activeId: 'a',
    sessions: [{ id: 'a', entries: [{ id: 'a1', role: 'assistant', text: '看这个：\n\n```py\nprint(1)\n```\n', html: '<p>老版本渲染结果</p>' }] }]
  });
  const e = st.sessions[0].entries[0];
  assert.ok(e.html.includes('code-block'), `应重算出代码块: ${e.html.slice(0, 120)}`);
  assert.ok(!e.html.includes('老版本渲染结果'), '旧 html 应被替换');
});

t('用户条目的 html 同样重算', () => {
  const st = S.normalizeState({ activeId: 'a', sessions: [{ id: 'a', entries: [{ id: 'u1', role: 'user', text: 'hi' }] }] });
  assert.match(st.sessions[0].entries[0].html, /<p>hi<\/p>/);
});

t('工具条目顺带补出 codeHtml（写入类工具的内容用代码块展示）', () => {
  const st = S.normalizeState({
    activeId: 'a',
    sessions: [{
      id: 'a',
      entries: [{
        id: 't1', role: 'tool', name: 'write_file',
        args: JSON.stringify({ path: 'x.py', content: 'y = 1\n' })
      }]
    }]
  });
  const e = st.sessions[0].entries[0];
  assert.strictEqual(e.argSummary, 'x.py · 1 行');
  assert.ok(e.codeHtml && e.codeHtml.includes('code-block'), '应当生成代码块 html');
});

t('被截断的 JSON 结果也能给出摘要（回归：摘要退化成 `{`）', () => {
  const truncated = '{\n  "gated": true,\n  "forcedPreview": true,\n  "diffId": "3d69ae0a-20a0-402d-a06c-74a2680d8d30",\n... (共 12 行)';
  const r = S.summarizeToolResult('mcp__vscode__write_file', truncated);
  assert.notStrictEqual(r.summary, '{', '不该退化成首行');
  assert.match(r.summary, /已转成提案/);
  assert.match(r.summary, /3d69ae0a/);

  const batch = '{\n  "batchId": "b-mvamo8iy",\n  "stats": {\n    "files": 3,\n    "pending": 3,\n    "accepted": 0\n  },\n... (共 47 行)';
  const r2 = S.summarizeToolResult('mcp__vscode__propose_changes', batch);
  assert.match(r2.summary, /批次 b-mvamo8iy/);
  assert.match(r2.summary, /3 个文件/);
  assert.match(r2.summary, /待决 3/);
});

t('完整 JSON 仍走格式化分支（不受捞字段影响）', () => {
  const r = S.summarizeToolResult('x', '{"a":1,"b":"two"}');
  assert.match(r.summary, /"a":1/);
  assert.ok(r.body && r.body.includes('\n'), 'body 应是格式化 JSON');
});

t('回归：已有 argSummary 的老条目也要补出 codeHtml', () => {
  const st = S.normalizeState({
    activeId: 'a',
    sessions: [{
      id: 'a',
      entries: [{
        id: 't1', role: 'tool', name: 'mcp__vscode__write_file',
        argSummary: 'math_utils.py · 61 行', // ← 已有摘要（0.10.1~0.11.1 建的）
        args: JSON.stringify({ path: 'd:\\work\\mypkg\\math_utils.py', content: 'def add(a, b):\n    return a + b\n' }),
        result: '{\n  "gated": true,\n... (共 12 行)',
        summary: '{'
      }]
    }]
  });
  const e = st.sessions[0].entries[0];
  assert.ok(e.codeHtml && e.codeHtml.includes('code-block'), '必须补出代码块');
  assert.strictEqual(e.argSummary, 'math_utils.py · 61 行', '已有摘要保持不变');
  assert.notStrictEqual(e.summary, '{', '结果摘要也要重算');
});

t('read 结果被截断（<content> 未闭合）-> 别把 XML 当摘要', () => {
  const truncated = '<path>d:\\work\\mypkg\\math_utils.py</path>\n<type>file</type>\n<content>\nline1\nline2\nline3\n... (共 85 行)';
  const r = S.summarizeToolResult('read', truncated);
  assert.strictEqual(r.summary, 'math_utils.py · 已截断（约 3 行）', `实际: ${r.summary}`);
  assert.ok(!r.summary.includes('<path>'), '摘要里不该再有 XML');
  assert.ok(r.body && !r.body.includes('共 85 行'), '截断标记应被剥掉');
});

t('read 结果完整时仍是"N 行"', () => {
  const ok = '<path>d:\\a\\b.py</path>\n<type>file</type>\n<content>\nline1\nline2\n</content>';
  assert.strictEqual(S.summarizeToolResult('read', ok).summary, 'b.py · 2 行');
});

t('只给 path 没给 content -> 至少显示文件名', () => {
  assert.strictEqual(S.summarizeToolResult('read', '<path>d:\\a\\only.py</path>\n<type>file</type>').summary, 'only.py');
});

t('showArgs：路径/文件列表类不再铺原始 JSON；命令类用代码块展示命令', () => {
  assert.strictEqual(S.summarizeToolArgs('mcp__vscode__read_file', JSON.stringify({ file_path: 'd:\\a\\b.py' })).showArgs, false);
  assert.strictEqual(S.summarizeToolArgs('write_file', JSON.stringify({ path: 'a.py', content: 'x' })).showArgs, false);
  assert.strictEqual(S.summarizeToolArgs('propose_changes', JSON.stringify({ changes: [{ path: 'a.py', content: 'x' }] })).showArgs, false);
  assert.strictEqual(S.summarizeToolArgs('grep', JSON.stringify({ pattern: 'TODO', path: 'src' })).showArgs, false);
  const pw = S.summarizeToolArgs('pwsh', JSON.stringify({ command: 'ls -Force', description: '列目录' }));
  assert.strictEqual(pw.summary, '列目录');
  assert.strictEqual(pw.showArgs, false, '命令用代码块展示，不再铺 JSON');
  assert.ok(pw.code && pw.code.text === 'ls -Force', '命令要抽出来当代码块');
  assert.strictEqual(pw.code.lang, 'ps1');
});

t('命令类结果：说"N 行输出"而不是"取首行"（回归：… · Python 3.13.9）', () => {
  const out = 'Python 3.13.9\nPython 3.14.0\n\n    Directory: D:\\work\n';
  const r = S.summarizeToolResult('pwsh', out);
  assert.strictEqual(r.summary, '4 行输出', `实际: ${r.summary}`);
  assert.ok(!r.summary.includes('3.13.9'), '首行不该混进摘要');
  assert.strictEqual(S.summarizeToolResult('pwsh', 'done').summary, 'done');
  assert.strictEqual(S.summarizeToolResult('pwsh', '').summary, '无输出');
  // 截断标记里的行数优先（否则摘要说 4 行、正文说 24 行，自相矛盾）
  const cut = 'Python 3.13.9\nPython 3.14.0\n\n    Directory: D:\\work\n... (共 24 行)';
  assert.strictEqual(S.summarizeToolResult('pwsh', cut).summary, '24 行输出（已截断）');
  // 非命令类工具仍取首行（避免误伤通用工具）
  assert.strictEqual(S.summarizeToolResult('other', 'Hello, World!\n第二行').summary, 'Hello, World!');
});

console.log('\n[17] Markdown 表格渲染');

t('管道表格 -> 真表格', () => {
  const html = S.miniMarkdown('| 文件 | 状态 |\n|---|---|\n| a.py | 新增 |\n| b.py | 修改 |\n');
  assert.ok(html.includes('<table class="md-table">'), `应渲染成表格: ${html.slice(0, 120)}`);
  assert.ok(html.includes('<th>文件</th>') && html.includes('<th>状态</th>'), '表头');
  assert.ok(html.includes('<td>a.py</td>') && html.includes('<td>b.py</td>'), '表体');
  assert.ok(!html.includes('|---|'), '分隔行不该留在输出里');
  assert.ok(!/^\s*\|/.test(html.replace(/<[^>]+>/g, '')), '不该再有裸管道行');
});

t('对齐分隔行（:-- / --:）也认；表格前后文字不受影响', () => {
  const html = S.miniMarkdown('前\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n\n后');
  assert.ok(html.includes('<table class="md-table">'), '带冒号的对齐行');
  assert.ok(html.includes('<p>前</p>') && html.includes('<p>后</p>'), '前后段落保留');
});

t('单元格里的行内格式仍然生效；无分隔行的管道文本不算表格', () => {
  const t1 = S.miniMarkdown('| x |\n|---|\n| `code` |\n');
  assert.ok(t1.includes('<code class="inline">code</code>'), '单元格内行内代码');
  const t2 = S.miniMarkdown('a | b | c\n');
  assert.ok(!t2.includes('<table'), '没有分隔行就不是表格');
});

t('read 内容被整段截掉 -> 用标记里的真实行数（回归：已截断（约 0 行））', () => {
  const cut = '<path>d:\\work\\example.py</path>\n<type>file</type>\n<content>\n... (共 163 行)';
  const r = S.summarizeToolResult('read', cut);
  assert.strictEqual(r.summary, 'example.py · 已截断（共 163 行）', `实际: ${r.summary}`);
  assert.ok(!r.summary.includes('约 0 行'), '不该出现"约 0 行"');
});

t('截断的 JSON 结果 -> "JSON（N 行，已截断）"，不是一个光秃秃的 {', () => {
  const r = S.summarizeToolResult('mcp__vscode__get_editor_state', '{\n  "file": "example.py",\n... (共 12 行)');
  assert.notStrictEqual(r.summary, '{', '不该退化成 {');
  assert.match(r.summary, /JSON（\d+ 行，已截断）/);
});

console.log('\n[18] 改动按轮次归并（每轮一张卡片）');

t('同一轮累加、跨轮分开', () => {
  let c = S.mergeChanges([], [{ path: 'a.py', added: 5, removed: 1 }], 1);
  c = S.mergeChanges(c, [{ path: 'a.py', added: 3, removed: 0 }], 1);
  assert.strictEqual(c.length, 1, '同一轮同一文件应累加');
  assert.strictEqual(c[0].added, 8);
  c = S.mergeChanges(c, [{ path: 'a.py', added: 7, removed: 2 }], 2);
  assert.strictEqual(c.length, 2, '第二轮改同一文件要单独成行');
  assert.deepStrictEqual(S.changesForTurn(c, 1).map((x) => x.added), [8]);
  assert.deepStrictEqual(S.changesForTurn(c, 2).map((x) => x.added), [7]);
  assert.deepStrictEqual(S.changesForTurn(c, 3), []);
});

t('normalizeState 保留会话轮次；旧改动默认归第一轮', () => {
  const st = S.normalizeState({
    activeId: 'a',
    sessions: [{ id: 'a', turn: 3, changes: [{ path: 'x', added: 1, removed: 0 }], entries: [] }]
  });
  assert.strictEqual(st.sessions[0].turn, 3);
  assert.strictEqual(st.sessions[0].changes[0].turn, 1);
});

t('旧版累积卡片迁移成第一轮的卡片', () => {
  const st = S.normalizeState({
    activeId: 'a',
    sessions: [{ id: 'a', entries: [{ id: 'changes-summary', role: 'changes', appliedFiles: 2, files: [] }] }]
  });
  const e = st.sessions[0].entries[0];
  assert.strictEqual(e.turn, 1);
  assert.strictEqual(e.id, 'changes-1');
});

console.log('\n[19] 工具隐藏名单');

t('toolHidden：通配 / 精确 / 全隐藏 / 不匹配', () => {
  assert.strictEqual(S.toolHidden('mcp__vscode__get_review_status', ['*get_review_status*']), true);
  assert.strictEqual(S.toolHidden('read', ['*get_review_status*']), false);
  assert.strictEqual(S.toolHidden('read', ['read']), true);
  assert.strictEqual(S.toolHidden('READ', ['read']), true, '大小写不敏感');
  assert.strictEqual(S.toolHidden('anything', ['*']), true);
  assert.strictEqual(S.toolHidden('glob', []), false);
  assert.strictEqual(S.toolHidden('glob', null), false);
  assert.strictEqual(S.toolHidden(null, ['*']), true);
  assert.strictEqual(S.toolHidden('a.b', ['a.b']), true, '点号不当正则用');
  assert.strictEqual(S.toolHidden('axb', ['a.b']), false);
  assert.strictEqual(S.toolHidden('x', ['', '  ']), false, '空模式忽略');
});

console.log(`\n结果: ${passed} 通过, ${failures.length} 失败`);
if (failures.length) {
  console.log('失败项:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
