'use strict';
/**
 * webview HTML 的静态断言。
 *
 * 为什么需要它：我踩过两个只有真机能发现的 bug，而它们其实都能在这里抓到——
 *   1) CSP 里把 cspSource（URL，含 : 和 .）当 nonce 用 -> 整条 script-src 失效 -> 脚本全被阻止
 *   2) <textarea> 没写 rows -> 浏览器默认 rows=2 -> 输入框天生两行高
 * 这两类都是"生成的 HTML 本身写错了"，不需要真机就能断言。
 *
 * 运行：node test/webview-html-test.cjs
 */
const assert = require('node:assert');
const Module = require('node:module');
const vm = require('node:vm');

// 注入一个最小 vscode stub：chat-ui.js 只在函数体内用 vscode，模块加载期不碰它
const stub = {};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return stub;
  return originalLoad.call(this, request, ...rest);
};
const { html } = require('../src/chat-ui');
Module._load = originalLoad;

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

const CSP_SOURCE = 'https://file+.vscode-resource.vscode-cdn.net';
const NONCE = 'abc123def456';
const OUT = html(CSP_SOURCE, NONCE);

console.log('\n[1] CSP / nonce（bug #1 的防线）');

t('webview 脚本本身必须是合法 JS（回归：模板字符串把 \\n 变成真换行 -> 整段脚本语法错）', () => {
  // 惨痛教训：webview 脚本嵌在 JS 模板字符串里，`'\n'` 会被**求值成真实换行**，
  // 生成的脚本于是含跨行字符串 → SyntaxError → 浏览器整段拒绝执行 →
  // 所有按钮全死、连 ready 都发不出去。静态字符串断言查不出这种错，必须真的解析它。
  const m = /<script[^>]*>([\s\S]*?)<\/script>/.exec(OUT);
  assert.ok(m, 'HTML 里应当有 <script> 块');
  new vm.Script(m[1], { filename: 'webview.js' }); // 不合法会抛 SyntaxError
});

t('script-src 用的是随机 nonce，不是 cspSource', () => {
  assert.ok(OUT.includes(`script-src 'nonce-${NONCE}'`), '应当出现 nonce-NONCE');
  assert.ok(!OUT.includes(`nonce-${CSP_SOURCE}`), '绝不能把 cspSource 当 nonce');
});

t('script 标签的 nonce 与 CSP 里的完全一致', () => {
  assert.ok(OUT.includes(`<script nonce="${NONCE}">`), 'script 标签必须带同一个 nonce');
});

t('nonce 里不含 URL 字符（: / . 会让整条 CSP 被丢弃）', () => {
  assert.ok(!/[:\/.]/.test(NONCE));
  assert.ok(!OUT.includes(`'nonce-${CSP_SOURCE}'`));
});

t('style-src 用 cspSource、且允许内联样式', () => {
  assert.ok(OUT.includes(`style-src ${CSP_SOURCE} 'unsafe-inline'`));
});

t('default-src 收紧为 none', () => {
  assert.ok(OUT.includes("default-src 'none'"));
});

console.log('\n[2] 输入框高度（bug #2 的防线）');

t('textarea 显式写 rows="1"（默认是 2，会让输入框天生两行高）', () => {
  const m = /<textarea[^>]*>/.exec(OUT);
  assert.ok(m, '应当有 textarea');
  assert.ok(/rows="1"/.test(m[0]), `textarea 必须带 rows="1"，实际：${m[0]}`);
});

t('autoGrow 以"一行高度"为下限，而不是只信 scrollHeight', () => {
  assert.ok(OUT.includes('Math.max(ONE_LINE_H'), '应当用 ONE_LINE_H 当下限');
  assert.ok(OUT.includes('getComputedStyle(input)'), '应当从计算样式算一行高度');
});

t('#input 不再有 min-height: 56px 那种两行的固定值', () => {
  const block = /#input\s*\{[^}]*\}/.exec(OUT);
  assert.ok(block, '应当有 #input 规则');
  assert.ok(!/min-height:\s*56px/.test(block[0]));
  assert.ok(/min-height:\s*30px/.test(block[0]), '1 行的高度');
});

console.log('\n[3] 界面骨架');

t('关键元素都在', () => {
  for (const id of ['sessions', 'new', 'del', 'model', 'cwd', 'usage', 'list', 'input', 'send', 'empty',
                    // 统计三段 + 三个选择器
                    'st-progress', 'st-tokens', 'st-context', 'ctrl-model', 'ctrl-thinking', 'ctrl-mode']) {
    assert.ok(OUT.includes(`id="${id}"`), `缺少 #${id}`);
  }
});

t('选择器不再用前端编造的清单（回归：deepseek-v3 / deepseek-r1 并不存在）', () => {
  assert.ok(!OUT.includes('deepseek-v3'), '不该出现不存在的模型 id');
  assert.ok(!OUT.includes('deepseek-r1'), '不该出现不存在的模型 id');
  assert.ok(!/var MODELS = \[/.test(OUT), '不该再写死模型数组');
  assert.ok(OUT.includes('catalogs.models'), '模型选项应来自后端下发的 catalogs');
  assert.ok(OUT.includes('catalogs.efforts') && OUT.includes('catalogs.modes'), '思考/编辑选项同理');
});

t('选择器显示真实当前值（prefs 由后端下发）', () => {
  assert.ok(OUT.includes('prefs = meta.prefs'), '应当以后端 prefs 为准');
  assert.ok(OUT.includes('updateCtrlUI()'), '收到 meta 后刷新显示');
});

t('运行中显示"深度求索中，用时 X"（带每秒刷新的定时器）', () => {
  assert.ok(OUT.includes('深度求索中，用时 '));
  assert.ok(OUT.includes('setInterval'), '需要定时器刷新');
  assert.ok(OUT.includes('runningSince'), '计时起点来自 meta');
});

t('统计行有样式，空项自动隐藏', () => {
  assert.ok(OUT.includes('.stats'), '需要 .stats 样式');
  assert.ok(OUT.includes('.stats span:empty'), '没数据的项应隐藏');
});

t('「正在做什么」活动行（对齐桌面 app）', () => {
  assert.ok(OUT.includes('id="activity"'), '缺少 #activity');
  assert.ok(OUT.includes('activity-time'), '活动行需要显示用时（运行时创建）');
  assert.ok(OUT.includes('.activity'), '需要 .activity 样式');
  assert.ok(OUT.includes('renderActivity'), '需要渲染函数');
  assert.ok(OUT.includes('深度求索中，用时 '), '没有工具在跑时显示"深度求索中，用时 X"');
  assert.ok(OUT.includes('meta.activity'), '活动文案来自后端 meta');
});

t('工具卡默认折叠、头行只放摘要（回归：整份参数铺在对话里）', () => {
  assert.ok(OUT.includes('entry.argSummary'), '头行应显示参数摘要');
  assert.ok(!OUT.includes('if (entry.open)'), '不再沿用旧记录里的 open:true（会导致一直展开）');
  assert.ok(OUT.includes('参数摘要') || OUT.includes('头行只放摘要'), '注释说明用途');
});

t('输入框上面那行就是状态行（顶部状态芯片已移除）', () => {
  assert.ok(!OUT.includes('id="status"'), '顶部不该再有状态芯片');
  assert.ok(!OUT.includes('statusEl.textContent'), '不该再往顶部芯片写状态');
  assert.ok(OUT.includes("statusKind === 'starting'"), '启动中显示在这行');
  assert.ok(OUT.includes("'深度求索中，用时 '"), '运行中显示在这行');
  assert.ok(OUT.includes("'已完成 · 本轮用时 '"), '完成后显示在这行');
  assert.ok(OUT.includes("'空闲'"), '空闲也显示在这行');
  assert.ok(OUT.includes("el.classList.add('show')"), '这行常显（不再"没状态就隐藏"）');
});

t('思考过程：流式更新保留用户展开状态（回归：一点开就被下一次更新盖掉）', () => {
  assert.ok(OUT.includes('oldOpen'), '需要把旧节点的展开状态带过去');
  assert.ok(OUT.includes("querySelectorAll('details')"), '需要遍历折叠面板');
});

t('聊天头不再有没作用的「打开审核面板」按钮', () => {
  assert.ok(!OUT.includes('id="review"'), '不该再有 #review 按钮');
});

t('「已编辑 N 个文件」卡片：渲染 + 点击跳转', () => {
  assert.ok(OUT.includes("entry.role === 'changes'"), '需要 changes 条目的渲染分支');
  assert.ok(OUT.includes('已编辑 '), '卡片标题');
  assert.ok(OUT.includes('.chgcard') && OUT.includes('.chgrow'), '需要卡片样式');
  assert.ok(OUT.includes("type: 'openChange'"), '点击应发送 openChange 消息');
  assert.ok(OUT.includes('.chgdelta .add') && OUT.includes('.chgdelta .del'), '增删需要不同颜色');
});

t('思考过程：生成中带实时尾巴、完成后带用时（回归：只有字数）', () => {
  assert.ok(OUT.includes('思考过程 · '), '摘要格式');
  assert.ok(OUT.includes('entry.streaming'), '生成中要有区别于完成后的显示');
  assert.ok(OUT.includes('entry.durationMs'), '完成后要显示用时');
  assert.ok(OUT.includes('fmtDur(entry.durationMs)'), '用时时长格式化');
});

t('常驻「本次改动」芯片（审完后记录不消失）', () => {
  assert.ok(OUT.includes('id="changed"'), '需要芯片元素');
  assert.ok(OUT.includes('.chip.hidden'), '需要隐藏样式');
  assert.ok(OUT.includes("'本次改动 ' + meta.changed.files"), '显示文件数与增删');
  assert.ok(OUT.includes('meta.changed.paths'), 'tooltip 列出文件');
});

t('webview 脚本里的正则转义没被模板字符串吃掉（回归：\\s -> s）', () => {
  // 模板字符串会把 `\s` 变成 `s`（`\s` 不是合法转义）→ 正则在浏览器里坏掉。
  // 所以源码里必须写 `\\s`，生成的脚本里才是 `\s`。
  // （思考预览已去掉，那条 /\\s+/ 不再存在；只要求保留的正则完整）
  assert.ok(OUT.includes('/^\\s*·\\s*/'), '摘要去重正则要完整');
  assert.ok(!OUT.includes('/s+/g'), '不该出现被吃成 s 的正则');
});

t('工具卡摘要去重（回归：example.py · example.py · 已截断…）', () => {
  assert.ok(OUT.includes('indexOf(entry.argSummary) === 0'), '要把结果摘要里重复的前缀去掉');
  assert.ok(OUT.includes('/^\\s*·\\s*/'), '同时去掉多余的分隔点');
});

t('点改动行要带上 added（用来选中"改了哪几行"）', () => {
  // 回归：曾经待审条那边加了 added、对话里的卡片漏了 -> 历史轮次的行只选中 1 行，看起来像"没高亮"。
  // 现在输入框上方的框只放待审（行点击是 openReviewDiff），所以带 added 的只有卡片这一处。
  const hits = (OUT.match(/added: f\.added/g) || []).length;
  assert.strictEqual(hits, 1, `已接受的行要带 added，实际 ${hits} 处`);
  const ids = (OUT.match(/changeId: f\.changeId/g) || []).length;
  assert.strictEqual(ids, 1, `已接受的行要带 changeId（去开隔离 diff），实际 ${ids} 处`);
});

t('重建时保留滚动位置，且换卡片位置用 move（回归：跳回几轮前又滑到底）', () => {
  assert.ok(OUT.includes('var bulkRender = false'), '批量重建期间要抑制自动滚动');
  assert.ok(OUT.includes('if (bulkRender) return'), 'scrollDown 要看 bulkRender');
  assert.ok(OUT.includes('var atBottom ='), 'reset 前要记住是否贴底');
  assert.ok(OUT.includes('list.scrollTop = atBottom ? list.scrollHeight : prevTop'), '重建后恢复滚动位置');
  assert.ok(OUT.includes("m.type === 'move'"), '需要 move 消息');
});

t('思考块：生成中自动展开、生成完自动折叠（且用户手动关过就尊重）', () => {
  assert.ok(OUT.includes('function applyThinkRule'), '需要展开/折叠规则');
  assert.ok(OUT.includes('d.open = !!entry.streaming'), '生成中默认展开');
  assert.ok(OUT.includes('wasStreaming && !thinkUserClosed'), '刚结束才折叠（用户关过就不强开）');
  assert.ok(OUT.includes('var thinkUserClosed = {}'), '记住用户手动关掉的思考块');
  assert.ok(!OUT.includes('think-live'), '不再有第二行实时预览');
});

t('只在贴底时才自动跟随滚动（翻历史时不被拽走）', () => {
  assert.ok(OUT.includes('const wasAtBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80'), '先判断是否贴底');
  assert.ok(OUT.includes('if (wasAtBottom) scrollDown()'), '贴底才滚');
});

t('工具卡并进 AI 气泡的折叠区（回归：read 卡片铺满对话）', () => {
  assert.ok(OUT.includes('var stepHosts = {}'), '需要步骤分组状态');
  assert.ok(OUT.includes("entry.role === 'tool' && openStepId && stepHosts[openStepId]"), '工具条目要优先并进气泡');
  assert.ok(OUT.includes('host.body.appendChild(fresh)'), '并进去而不是铺在对话里');
  assert.ok(OUT.includes('次工具调用（'), '气泡头上要显示次数与工具名');
  assert.ok(OUT.includes('function makeStepHost'), '没有思考内容的气泡也要能当宿主');
});

t('工具卡折叠区给出打开文件入口（完整内容在磁盘上）', () => {
  assert.ok(OUT.includes('openfile'), '要有打开文件的入口');
  assert.ok(OUT.includes("type: 'openPath'"), '点击要发 openPath');
  assert.ok(OUT.includes('parsedArgs.file_path || parsedArgs.path'), '从参数里取路径');
});

t('并进思考区的工具卡默认展开（展开思考就能看到执行内容）', () => {
  assert.ok(OUT.includes("const nested = fresh.querySelector('details')"), '要找到嵌套的工具卡');
  assert.ok(OUT.includes('if (nested) nested.open = true'), '默认展开');
});

t('气泡重建后把工具卡挂回去（回归：计数在、日志全没了）', () => {
  assert.ok(OUT.includes('ids: []'), '主机要记住已并入的工具 id');
  assert.ok(OUT.includes('host.ids.push(entry.id)'), '并进来时记下 id');
  assert.ok(OUT.includes('for (const toolId of host.ids)'), '重建后遍历这些 id');
  assert.ok(OUT.includes('if (toolNode) host.body.appendChild(toolNode)'), '把工具卡挂回新节点');
});

t('Markdown 表格样式', () => {
  assert.ok(OUT.includes('table.md-table'), '需要表格样式');
  assert.ok(OUT.includes('.table-wrap'), '需要横向滚动容器');
});

t('改动卡片把"待审"和"已落盘"分开显示（回归：第二批提案时卡片毫无变化）', () => {
  assert.ok(OUT.includes("'待审 ' + entry.pendingFiles"), '头部要有待审统计');
  assert.ok(OUT.includes("'待审'"), '行上要有待审标记');
  assert.ok(OUT.includes('.chgpending') && OUT.includes('.chgtag'), '需要待审样式');
  assert.ok(OUT.includes("? vscode.postMessage({ type: 'openReviewDiff'"), '待审行应打开 diff 而不是跳文件');
  assert.ok(OUT.includes(": vscode.postMessage({ type: 'openChange'"), '已接受的行应跳到改动处');
  assert.ok(OUT.includes('entry.appliedFiles'), '标题按已落盘文件数计');
});

t('「待审 N 个文件」条 + 全部接受/忽略按钮在对话面板里', () => {
  assert.ok(OUT.includes('id="review-bar"'), '需要待审条元素');
  assert.ok(OUT.includes('.reviewbar'), '需要样式');
  assert.ok(OUT.includes('全部接受') && OUT.includes('全部忽略'), '两个按钮都要在面板里');
  assert.ok(OUT.includes("type: 'acceptAllReview'") && OUT.includes("type: 'rejectAllReview'"), '按钮要能触发动作');
  assert.ok(OUT.includes('renderReviewBar'), '需要渲染函数');
});

t('输入框上方的框只放待审；已落盘的记录交给历史里的卡片（回归：重复显示）', () => {
  assert.ok(OUT.includes('var reviewListOpen = true'), '默认展开');
  assert.ok(OUT.includes('.rblist') && OUT.includes('.rbrow'), '需要文件清单样式');
  // （“没有待审就隐藏”属于扩展侧代码，在 activation-test 里断言）
  assert.ok(!OUT.includes('appliedFiles: at.files'), '不再往这个框里塞已落盘的改动');
  assert.ok(OUT.includes("type: 'openReviewDiff'"), '待审的行点击打开 diff');
});

t('用户消息靠右、助手无气泡（左右对话布局）', () => {
  assert.ok(/\.msg\.user\s*\{\s*flex-direction:\s*row-reverse/.test(OUT), '用户消息要反向排列');
  assert.ok(OUT.includes('.bubble'), '用户气泡样式存在');
  assert.ok(!/\.msg\.assistant\s*\.content\s*\{[^}]*background/.test(OUT), '助手不应有背景气泡');
});

t('不含外链资源（CSP default-src none 下会加载失败）', () => {
  assert.ok(!/<img|<link|@import|src="http/.test(OUT), '不该有外部资源');
});

t('注入的文本不会被拼进 HTML（只做 innerHTML 赋值）', () => {
  assert.ok(OUT.includes('body.innerHTML = entry.html'), '正文走已转义的 html 字段');
});

console.log(`\n结果: ${passed} 通过, ${failures.length} 失败`);
if (failures.length) {
  console.log('失败项:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
