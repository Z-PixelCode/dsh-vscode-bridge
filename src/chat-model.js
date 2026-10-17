'use strict';
/**
 * 会话事件 → 界面条目 的映射（纯逻辑，零依赖，可单测）。
 *
 * 事件词汇来自 DSH 的持久会话日志，形状是我用探针实测 `dsh --profile sdk` 抓到的：
 *   user/message      { data: { content:[{type:'text',text}], source:{kind}, role, id } }
 *   assistant/message { data: { message:{ content:[{type:'reasoning'|'text',text}] },
 *                              usage:{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens} } }
 *   tool/call         { data: { name, arguments, callId } }
 *   tool/result       { data: { message:{ toolCallId, content:[{type:'text',text}], isError } } }
 *   turn/end          { data: { reason:{kind} } }
 */

/** 把事件参数规范化成事件对象（协议里可能是 { event } 也可能是事件本身） */
function unwrap(params) {
  if (!params || typeof params !== 'object') return {};
  return params.event && typeof params.event === 'object' ? params.event : params;
}

function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text')
    .map((c) => c.text || '')
    .join('\n');
}

function reasoningOf(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'reasoning' && c.text)
    .map((c) => c.text)
    .join('\n');
}

/**
 * 映射一个 session.event。
 * @returns {{kind:string, entry?:object, callId?:string, patch?:object, reason?:string}}
 *   kind: 'user' | 'assistant' | 'tool-call' | 'tool-result' | 'turn-end' | 'ignore'
 */
function mapSessionEvent(params) {
  const ev = unwrap(params);
  const d = ev.data || {};
  const seq = ev.seq === undefined ? 'x' : ev.seq;

  switch (ev.type) {
    case 'user/message': {
      const kind = d.source && d.source.kind;
      if (kind && kind !== 'user') {
        // 运行时上下文快照、技能提醒等由运行时自己注入，不当作"用户说话"渲染
        return { kind: 'ignore', reason: `user/message(${kind})` };
      }
      const text = textOf(d.content);
      if (!text) return { kind: 'ignore', reason: '空的 user/message' };
      return { kind: 'user', entry: { id: `u-${seq}`, role: 'user', text } };
    }

    case 'assistant/message': {
      const message = d.message || {};
      const content = message.content;
      const text = textOf(content);
      const reasoning = reasoningOf(content);
      if (!text && !reasoning) return { kind: 'ignore', reason: '空的 assistant/message' };
      return {
        kind: 'assistant',
        entry: { id: `a-${seq}`, role: 'assistant', text, reasoning: reasoning || undefined, usage: d.usage },
        // 完成的消息里带着**增量流记录**（文本/思考分块 + 每块间隔），可据此回放成"边想边出"
        stream: Array.isArray(d.stream) ? d.stream : []
      };
    }

    case 'tool/call': {
      const name = d.name || d.tool || d.toolName || 'tool';
      const callId = d.callId || d.id || d.toolCallId;
      // 实测：SDK 事件里的 arguments 是 **JSON 字符串**（例如 "{}"），不是对象。
      // 直接 stringify 会多出一对引号，所以字符串原样用。
      let args;
      if (d.arguments !== undefined && d.arguments !== null) {
        args = typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments, null, 2);
      }
      return {
        kind: 'tool-call',
        callId,
        entry: {
          id: `t-${seq}`,
          role: 'tool',
          callId,
          name,
          args
          // open 默认 false，工具调用详情默认收起
        }
      };
    }

    case 'tool/result': {
      const message = d.message || {};
      const callId = message.toolCallId || d.callId;
      const text = textOf(message.content);
      // 读文件结果太长，截断只显示前 3 行
      let displayText = text;
      if (text && text.split('\n').length > 5) {
        const lines = text.split('\n');
        displayText = lines.slice(0, 3).join('\n') + '\n... (共 ' + lines.length + ' 行)';
      }
      return {
        kind: 'tool-result',
        callId,
        patch: { result: displayText, ok: !message.isError, summary: text ? text.split('\n')[0] : '' }
      };
    }

    case 'turn/end':
      return { kind: 'turn-end' };

    case 'turn/start':
      return { kind: 'turn-start', turn: d.turn };

    case 'step/start':
      return { kind: 'step-start', step: d.step };

    case 'request/context':
      // 实测载荷里有 contextWindow（用于算"上下文占用"），顺带带出 provider/model
      return {
        kind: 'request-context',
        contextWindow: d.contextWindow,
        provider: d.provider,
        model: d.model
      };

    default:
      return { kind: 'ignore', reason: ev.type || '(无 type)' };
  }
}

// ---------------------------------------------------------------------------
// 统计（对应桌面 app 底部那行：轮/步 · tok/s · 总tok+缓存命中 · 上下文占用）
// ---------------------------------------------------------------------------

/** 模型目录：取自出厂适配器的 DEFAULT_MODELS（SDK 协议没有"列模型"的方法） */
const MODEL_CATALOG = [
  { id: 'deepseek-flash', name: 'DeepSeek-V41-Flash', provider: 'deepseek-official' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', provider: 'deepseek-official' }
];

const REASONING_EFFORTS = [
  { id: '', name: '默认' },
  { id: 'low', name: '低' },
  { id: 'medium', name: '中' },
  { id: 'high', name: '高' }
];

const PERMISSION_MODES = [
  { id: '', name: '随 profile 默认（通常工作区内直写·不审核）' },
  { id: 'read-only', name: '只读：改文件必须审核' },
  { id: 'workspace-write', name: '工作区内直写（不审核）' },
  { id: 'danger-full-access', name: '完全访问（不审核）' }
];

/** 这个沙箱模式是否允许 agent 直接写文件（即"不经过审核"） */
function isDirectWriteMode(mode) {
  return String(mode || '') !== 'read-only';
}

function emptyStats() {
  return {
    turns: 0,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    contextWindow: 0,
    contextUsed: 0,
    cacheHitRate: 0,
    contextRatio: 0,
    tps: 0,
    lastTurnOutput: 0,
    turnStartedAt: 0,
    turnMs: 0
  };
}

/**
 * 把一条已映射的事件累积进统计（纯函数：返回新对象，不改入参）。
 * @param {object} stats
 * @param {object} mapped mapSessionEvent 的返回值
 * @param {number} now    当前时间（注入以便测试）
 */
function reduceStats(stats, mapped, now) {
  const s = Object.assign({}, emptyStats(), stats);
  switch (mapped && mapped.kind) {
    case 'turn-start':
      s.turns += 1;
      s.turnStartedAt = now;
      s.lastTurnOutput = 0;
      break;
    case 'step-start':
      s.steps += 1;
      break;
    case 'assistant': {
      const u = mapped.entry && mapped.entry.usage;
      if (u) {
        const input = u.inputTokens || 0;
        const output = u.outputTokens || 0;
        const cacheRead = u.cacheReadTokens || 0;
        s.inputTokens += input;
        s.outputTokens += output;
        s.cacheReadTokens += cacheRead;
        s.cacheWriteTokens += u.cacheWriteTokens || 0;
        s.totalTokens += u.totalTokens || input + output + cacheRead;
        // 当前上下文占用 = 最近一次请求的 totalTokens
        s.contextUsed = u.totalTokens || input + output + cacheRead;
        s.lastTurnOutput += output;
      }
      break;
    }
    case 'request-context':
      if (mapped.contextWindow) s.contextWindow = mapped.contextWindow;
      break;
    case 'turn-end':
      s.turnMs = Math.max(1, now - (s.turnStartedAt || now));
      s.tps = Math.round((s.lastTurnOutput / s.turnMs) * 1000);
      break;
    default:
      break;
  }
  const denom = s.inputTokens + s.cacheReadTokens;
  s.cacheHitRate = denom > 0 ? s.cacheReadTokens / denom : 0;
  s.contextRatio = s.contextWindow > 0 ? s.contextUsed / s.contextWindow : 0;
  return s;
}

/** 时长：3 分 36 秒 / 12 秒 / 1 小时 5 分 */
function formatDuration(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  if (total < 60) return `${total} 秒`;
  const min = Math.floor(total / 60);
  const sec = total % 60;
  if (min < 60) return `${min} 分 ${sec} 秒`;
  const hour = Math.floor(min / 60);
  return `${hour} 小时 ${min % 60} 分`;
}

/** token 数：147M / 12.3k / 568 */
function formatTokens(n) {
  const v = Math.max(0, n || 0);
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${Math.round(v / 1e6)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

function formatPercent(ratio) {
  return `${Math.round((ratio || 0) * 100)}%`;
}

/** 组装成界面用的三段文本（空的部分返回空串） */
function statsLines(stats) {
  const s = Object.assign({}, emptyStats(), stats);
  const hasAny = s.turns > 0 || s.steps > 0 || s.totalTokens > 0;
  if (!hasAny) return { progress: '', tokens: '', context: '' };
  return {
    progress: `${s.turns} 轮 ${s.steps} 步${s.tps ? ` · ${s.tps} tok/s` : ''}`,
    tokens: `${formatTokens(s.totalTokens)} tok · 缓存命中 ${formatPercent(s.cacheHitRate)}`,
    context: s.contextWindow ? formatPercent(s.contextRatio) : ''
  };
}

/** 汇总 token 用量（含缓存命中，这在 DeepSeek 路由上直接对应成本） */
function summarizeUsage(entries) {
  const acc = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0 };
  for (const e of entries || []) {
    if (e && e.usage) {
      acc.inputTokens += e.usage.inputTokens || 0;
      acc.outputTokens += e.usage.outputTokens || 0;
      acc.cacheReadTokens += e.usage.cacheReadTokens || 0;
      acc.cacheWriteTokens += e.usage.cacheWriteTokens || 0;
      acc.turns += 1;
    }
  }
  return acc;
}

/**
 * 把 assistant/message 里记录的增量流展开成"回放计划"。
 *
 * 为什么需要它：SDK 协议**没有**增量事件（实测 `assistant/delta` 等类型出现 0 次），
 * 思考与正文都在这一步才整段到达；但消息里带了 `AssistantStreamRecord[]`，
 * 记录了每段文本和它们之间的间隔 —— 于是可以按录制时间轴回放，
 * 视觉上和桌面 app 的"边想边出"一致（内容是真的，只是到达后才播）。
 *
 * @param {Array} stream  AssistantStreamRecord[]
 * @param {{maxTotalMs?:number, minStepMs?:number, maxSteps?:number}} [opts]
 * @returns {Array<{waitMs:number, target:'reasoning'|'text', delta:string}>}
 */
function replayPlan(stream, opts) {
  const o = opts || {};
  const maxTotalMs = o.maxTotalMs === undefined ? 2500 : o.maxTotalMs;
  const minStepMs = o.minStepMs === undefined ? 6 : o.minStepMs;
  const maxSteps = o.maxSteps === undefined ? 160 : o.maxSteps;

  const steps = [];
  for (const rec of Array.isArray(stream) ? stream : []) {
    if (!rec || typeof rec !== 'object') continue;
    if (rec.type === 'reasoning-chunks' || rec.type === 'text-chunks') {
      const target = rec.type === 'reasoning-chunks' ? 'reasoning' : 'text';
      const dts = Array.isArray(rec.dt) ? rec.dt : [];
      const texts = Array.isArray(rec.texts) ? rec.texts : [];
      for (let i = 0; i < texts.length; i += 1) {
        if (!texts[i]) continue;
        steps.push({ waitMs: Number(dts[i]) || 0, target, delta: texts[i] });
      }
    } else if (rec.type === 'chunk' && rec.chunk) {
      const c = rec.chunk;
      if (c.type === 'reasoning-delta' && c.text) steps.push({ waitMs: 0, target: 'reasoning', delta: c.text });
      else if (c.type === 'text-delta' && c.text) steps.push({ waitMs: 0, target: 'text', delta: c.text });
    }
  }
  if (!steps.length) return [];

  // 压缩时间轴：初始间隔缺失（chunk 变体没有 dt）时给个均匀值，
  // 总时长超过 maxTotalMs 就等比缩放，保证不会让界面落后于真实进度。
  const zeroCount = steps.filter((s) => !s.waitMs).length;
  const uniform = zeroCount ? Math.max(minStepMs, Math.round(maxTotalMs / steps.length)) : 0;
  for (const s of steps) if (!s.waitMs) s.waitMs = uniform;

  const total = steps.reduce((a, s) => a + s.waitMs, 0);
  const scale = total > maxTotalMs ? maxTotalMs / total : 1;
  let planned = steps.map((s) => ({ ...s, waitMs: Math.max(minStepMs, Math.round(s.waitMs * scale)) }));

  // 步数过多时按固定间隔抽样合并（避免每几毫秒推一次消息）
  if (planned.length > maxSteps) {
    const group = Math.ceil(planned.length / maxSteps);
    const merged = [];
    for (let i = 0; i < planned.length; i += group) {
      const slice = planned.slice(i, i + group);
      const first = slice[0];
      merged.push({
        waitMs: first.waitMs,
        target: first.target,
        delta: slice.filter((s) => s.target === first.target).map((s) => s.delta).join('')
      });
      // 跨 target 的残余单独补一步，避免丢字
      for (const s of slice) {
        if (s.target !== first.target) merged.push({ waitMs: minStepMs, target: s.target, delta: s.delta });
      }
    }
    planned = merged;
  }
  return planned;
}

/**
 * 工具参数的摘要。
 *
 * 为什么需要：`propose_changes` 的参数里带着**整份文件内容**，`write_file` 也一样。
 * 直接把参数 JSON 铺在对话里，用户得滚过几百行代码才能看到下一句回答。
 * 摘要放在卡片头行，完整参数仍然折叠在卡片里（信息不丢，只是不占地方）。
 */
/**
 * 工具是否在"隐藏名单"里。
 * patterns 支持 `*` 通配：`*get_review_status*`、`read`、`*`（全部隐藏）。
 * 用于把桥自己的记账类调用（例如批次查询）从对话里去掉，只留状态行播报。
 */
function toolHidden(name, patterns) {
  const n = String(name == null ? '' : name).toLowerCase();
  for (const raw of patterns || []) {
    const p = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!p) continue;
    if (p === '*') return true;
    const body = p
      .split('*')
      .map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    if (new RegExp('^' + body + '$').test(n)) return true;
  }
  return false;
}

/** 由文件扩展名猜高亮语言 */
function langOf(p) {
  const ext = String(p || '').split('.').pop().toLowerCase();
  const map = {
    py: 'python', js: 'js', mjs: 'js', cjs: 'js', ts: 'ts', tsx: 'ts', jsx: 'js',
    json: 'json', md: 'md', ps1: 'ps1', sh: 'sh', bash: 'sh', yml: 'yml', yaml: 'yml',
    html: 'html', css: 'css', java: 'java', c: 'c', cpp: 'cpp', go: 'go', rs: 'rs', sql: 'sql', toml: 'toml', ini: 'ini'
  };
  return map[ext] || '';
}

function summarizeToolArgs(name, argsRaw) {
  const n = String(name == null ? '' : name);
  let a = null;
  if (typeof argsRaw === 'string') {
    try {
      a = argsRaw.trim() ? JSON.parse(argsRaw) : {};
    } catch {
      a = null;
    }
  } else if (argsRaw && typeof argsRaw === 'object') {
    a = argsRaw;
  }
  const raw = typeof argsRaw === 'string' ? argsRaw : JSON.stringify(argsRaw || {}, null, 2);

  if (a === null) {
    return { summary: raw.length > 80 ? `${raw.slice(0, 80)}…` : raw, body: raw };
  }

  if (/propose_changes$/.test(n)) {
    const files = Array.isArray(a.changes) ? a.changes : [];
    const names = files.map((c) => baseName(c && c.path)).filter(Boolean);
    const head = names.slice(0, 4).join(', ');
    const more = names.length > 4 ? ` 等 ${names.length} 个` : '';
    // 摘要已经列了文件名，再铺 6KB 的 JSON 纯属噪音
    return { summary: `${names.length} 个文件 · ${head}${more}`, body: JSON.stringify(a, null, 2), showArgs: false };
  }

  // 有 pattern 的搜索类工具：pattern 才是目标，path 只是搜索范围
  if (a.pattern && /^(grep|glob)$/.test(n)) {
    return { summary: String(a.pattern), body: JSON.stringify(a, null, 2), showArgs: false };
  }

  if (a.file_path || a.path) {
    const target = a.file_path || a.path;
    const body = typeof a.content === 'string' ? a.content : typeof a.newText === 'string' ? a.newText : '';
    const lines = body ? countLines(body) : 0;
    const detail = lines ? ` · ${lines} 行` : '';
    return {
      summary: `${baseName(target)}${detail}`,
      body: JSON.stringify(a, null, 2),
      // 路径已在头行、内容（若有）已用代码块呈现 → 原始 JSON 没有额外信息
      showArgs: false,
      code: body ? { lang: langOf(target), text: body, path: target } : null
    };
  }

  if (typeof a.command === 'string') {
    const head = a.description ? String(a.description) : String(a.command).slice(0, 60);
    // 命令本身最有用：用代码块展示（而不是让人读 JSON 里的 \n 转义），参数 JSON 就不必再铺
    return {
      summary: head,
      body: JSON.stringify(a, null, 2),
      code: { lang: 'ps1', text: String(a.command), path: '' },
      showArgs: false
    };
  }

  if (a.pattern) return { summary: String(a.pattern), body: JSON.stringify(a, null, 2), showArgs: true };

  const keys = Object.keys(a);
  return { summary: keys.length ? `{${keys.join(', ')}}` : '无参数', body: JSON.stringify(a, null, 2), showArgs: true };
}

/**
 * 合并"本次对话改动了哪些文件"的统计。
 *
 * list 形如 [{path, added, removed, line}]；同一文件多次改动会累加。
 * 数据来源：审核批次里每个已接受 hunk 的增删行数（落盘时收集）。
 */
function mergeChanges(existing, list, turn) {
  const t = Number(turn) || 1;
  const key = (c) => `${Number(c.turn) || 1}\u0000${c.path}`;
  const map = new Map();
  for (const c of existing || []) {
    if (c && c.path) {
      map.set(key(c), Object.assign({ added: 0, removed: 0, line: 1, turn: Number(c.turn) || 1 }, c));
    }
  }
  for (const c of list || []) {
    if (!c || !c.path) continue;
    // **按"轮次 + 路径"**归并：同一轮里同一文件累加，不同轮各自成行
    // （第二轮又改了同一个文件时，第二轮那张卡片要单独列出这个文件）
    const row = { path: c.path, added: c.added || 0, removed: c.removed || 0, line: c.line || 1, turn: t };
    if (c.changeId) row.changeId = c.changeId; // 只有真有快照时才带，避免多出 undefined 字段
    const prev = map.get(key(row));
    if (prev) {
      prev.added += row.added;
      prev.removed += row.removed;
      if (c.line) prev.line = c.line;
      if (c.changeId) prev.changeId = c.changeId; // 用最新的快照 id
    } else {
      map.set(key(row), row);
    }
  }
  return Array.from(map.values());
}

/** 取出某一轮的改动（每轮一张卡片，随历史往上走） */
function changesForTurn(changes, turn) {
  const t = Number(turn) || 1;
  return (Array.isArray(changes) ? changes : []).filter((c) => (Number(c.turn) || 1) === t);
}

/** 汇总一串改动：文件数 + 总增删 */
function changeTotals(changes) {
  const acc = { files: 0, added: 0, removed: 0 };
  for (const c of changes || []) {
    if (!c || !c.path) continue;
    acc.files += 1;
    acc.added += c.added || 0;
    acc.removed += c.removed || 0;
  }
  return acc;
}

/**
 * 从条目的已接受块算出某文件的增删行数与首个改动行（供"点击跳到改动处"）。
 */
function entryChangeStats(entry) {
  const accepted = (entry && entry.hunks ? entry.hunks : []).filter((h) => h.status === 'accepted');
  let added = 0;
  let removed = 0;
  let line = 0;
  for (const h of accepted) {
    added += (h.bLines || []).length;
    removed += (h.aLines || []).length;
    if (!line) line = (h.aStart || 0) + 1;
  }
  return { added, removed, line: line || 1 };
}

/** 工具名 -> [人类可读动作, 取哪个参数当细节] */
const TOOL_LABELS = {
  pwsh: ['正在运行命令', 'description'],
  read: ['正在读取文件', 'file_path'],
  write: ['正在写入文件', 'file_path'],
  edit: ['正在修改文件', 'file_path'],
  apply_patch: ['正在应用补丁', 'file_path'],
  read_image: ['正在查看图片', 'file_path'],
  grep: ['正在搜索内容', 'pattern'],
  glob: ['正在查找文件', 'pattern'],
  list_dir: ['正在列出目录', 'path'],
  skill: ['正在加载技能', 'name'],
  create_goal: ['正在创建目标', 'objective'],
  request_user_input: ['正在向你提问', null]
};

function baseName(p) {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
}

/** 行数：末尾换行不算额外一行（'a\nb\nc\n' 是 3 行，不是 4） */
function countLines(s) {
  const t = String(s == null ? '' : s).replace(/\n$/, '');
  return t ? t.split('\n').length : 0;
}

/**
 * 把一次工具调用描述成"正在做什么"（对应桌面 app 的那行活动提示）。
 * 数据一直都在工具参数里，之前只是没拿出来显示。
 */
function describeToolCall(name, argsRaw) {
  const n = String(name == null ? '' : name) || 'tool';
  let args = {};
  if (typeof argsRaw === 'string') {
    try {
      args = argsRaw.trim() ? JSON.parse(argsRaw) : {};
    } catch {
      args = {};
    }
  } else if (argsRaw && typeof argsRaw === 'object') {
    args = argsRaw;
  }

  const mcp = /^mcp__vscode__(.+)$/.exec(n);
  if (mcp) return `正在调用 VS Code 工具 · ${mcp[1]}`;

  const hit = TOOL_LABELS[n];
  if (!hit) return `正在调用 ${n}`;
  const [label, key] = hit;
  let detail = '';
  if (key && args[key]) {
    detail = key === 'file_path' || key === 'path' ? baseName(args[key]) : String(args[key]);
  } else if (args.description) {
    detail = String(args.description);
  }
  if (detail.length > 80) detail = `${detail.slice(0, 80)}…`;
  return detail ? `${label} · ${detail}` : label;
}

/**
 * 从可能**被截断**的 JSON 文本里"捞"字段。
 *
 * 为什么需要：工具的返回会被截断（例如 `… (共 12 行)`），于是 JSON.parse 必然失败、
 * 摘要只能退化成首行 `{`。这里用正则直接捞关键字段，不依赖整段 JSON 合法。
 */
function salvageFields(text, keys) {
  const out = {};
  for (const k of keys) {
    const m = new RegExp(`"${k}"\\s*:\\s*(?:"([^"]*)"|(true|false)|(-?\\d+(?:\\.\\d+)?))`).exec(text);
    if (!m) continue;
    if (m[1] !== undefined) out[k] = m[1];
    else if (m[2] !== undefined) out[k] = m[2] === 'true';
    else if (m[3] !== undefined) out[k] = Number(m[3]);
  }
  return out;
}

/**
 * 把工具结果里 XML 风格的包装抽成人类可读摘要。
 * 例：DSH 的 read 工具返回 `<path>…</path><type>file</type><content>…</content>`，
 * 直接吐原始 XML 很难看，也不像桌面 app 的做法。
 */
function summarizeToolResult(name, text) {
  const s = String(text == null ? '' : text);
  const pathHit = /<path>([^<]*)<\/path>/.exec(s);
  if (pathHit) {
    const base = pathHit[1].split(/[\\/]/).pop() || pathHit[1];
    const closed = /<content>\n?([\s\S]*?)\n?<\/content>/.exec(s);
    if (closed) {
      return { summary: `${base} · ${countLines(closed[1])} 行`, body: closed[1], raw: s };
    }
    // <content> 没闭合 = 结果被截断了（长文件很常见）。别把 XML 当摘要吐给用户。
    const open = /<content>\n?([\s\S]*)$/.exec(s);
    if (open) {
      const marker = /[（(]共 (\d+) 行[)）]/.exec(s);
      const body = open[1].replace(/\s*(?:\.\.\.\s*)?[（(]共 \d+ 行[)）]\s*$/, '');
      const lines = body.trim() ? countLines(body) : 0;
      // 内容被整段截掉时（body 为空）用标记里的真实行数，否则会出现"已截断（约 0 行）"
      if (lines > 0) return { summary: `${base} · 已截断（约 ${lines} 行）`, body, raw: s };
      if (marker) return { summary: `${base} · 已截断（共 ${marker[1]} 行）`, body: null, raw: s };
      return { summary: `${base} · 已截断`, body: null, raw: s };
    }
    return { summary: base, body: null, raw: s };
  }
  // JSON 结果（例如 get_editor_state / get_diagnostics）：给一行紧凑摘要，正文仍是格式化 JSON
  const t = s.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      const parsed = JSON.parse(t);
      const flat = JSON.stringify(parsed);
      return {
        summary: flat.length > 140 ? `${flat.slice(0, 140)}…` : flat,
        body: JSON.stringify(parsed, null, 2),
        raw: s
      };
    } catch {
      /* 不是合法 JSON，走下面的普通文本分支 */
    }
  }
  // 截断的 JSON（长结果会被截断，parse 不了）→ 捞关键字段凑一行摘要
  const salv = salvageFields(s, [
    'gated', 'forcedPreview', 'diffId', 'batchId', 'pending', 'accepted', 'rejected',
    'files', 'path', 'created', 'written', 'bytes', 'error', 'message'
  ]);
  if (Object.keys(salv).length) {
    const parts = [];
    if (salv.gated) parts.push('已转成提案');
    if (salv.forcedPreview) parts.push('强制预览');
    if (salv.batchId) parts.push(`批次 ${String(salv.batchId).slice(0, 10)}`);
    if (typeof salv.files === 'number') parts.push(`${salv.files} 个文件`);
    if (typeof salv.pending === 'number') parts.push(`待决 ${salv.pending}`);
    if (typeof salv.accepted === 'number' && salv.accepted) parts.push(`已接受 ${salv.accepted}`);
    if (typeof salv.rejected === 'number' && salv.rejected) parts.push(`已忽略 ${salv.rejected}`);
    if (salv.path) parts.push(baseName(salv.path));
    else if (salv.diffId) parts.push(String(salv.diffId).slice(0, 8));
    if (typeof salv.created === 'boolean' && salv.created) parts.push('新建');
    if (typeof salv.written === 'boolean' && salv.written) parts.push('已写入');
    if (typeof salv.bytes === 'number') parts.push(`${salv.bytes} 字节`);
    if (salv.error) parts.push(String(salv.error).slice(0, 60));
    if (parts.length) return { summary: parts.join(' · '), body: null, raw: s };
  }
  // 命令类工具的纯文本输出：说"多少行输出"比"取首行"清楚得多
  // （取首行会让人以为那行是描述的一部分，例如 "… · Python 3.13.9"）
  const isCmd = /pwsh|powershell|bash|shell|run_command|terminal/i.test(String(name == null ? '' : name));
  if (isCmd) {
    const text = s.trim();
    // 结果被截断时正文里有 "… (共 N 行)"：摘要直接用这个 N，别和正文里的数字打架
    const marker = /[（(]共 (\d+) 行[)）]/.exec(text);
    const lines = marker ? Number(marker[1]) : text ? countLines(text) : 0;
    const suffix = marker ? '（已截断）' : '';
    if (lines > 1) return { summary: `${lines} 行输出${suffix}`, body: null, raw: s };
    if (lines === 1) return { summary: text.slice(0, 80), body: null, raw: s };
    return { summary: '无输出', body: null, raw: s };
  }

  // 看着像 JSON 但 parse 不了（被截断/拼接）：别退化成一个光秃秃的 `{`
  const head = s.trim();
  if (head.startsWith('{') || head.startsWith('[')) {
    return { summary: `JSON（${countLines(head)} 行，已截断）`, body: null, raw: s };
  }

  return { summary: s.split('\n')[0] || '', body: null, raw: s };
}

/** 给界面顶部用的一行用量文本 */
function usageLine(entries) {
  const u = summarizeUsage(entries);
  if (!u.turns) return '';
  const cache = u.cacheReadTokens ? ` · 缓存命中 ${u.cacheReadTokens}` : '';
  return `输入 ${u.inputTokens} · 输出 ${u.outputTokens}${cache}`;
}

// ---------------------------------------------------------------------------
// 会话列表（多对话 + 持久化）
// ---------------------------------------------------------------------------

const MAX_SESSIONS = 20;
const MAX_ENTRIES_PER_SESSION = 200;
const MAX_ENTRY_CHARS = 8000;

function makeSessionId(seed) {
  return `s-${(seed || Date.now()).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 用首条用户消息生成标题 */
function titleFromText(text, max = 24) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '新对话';
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 空状态 */
function emptyState() {
  return { activeId: null, sessions: [] };
}

/** 规范化（容错：从 workspaceState 读回来的可能是旧结构或被截断的） */
function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sessions)) return emptyState();
  const sessions = raw.sessions
    .filter((s) => s && typeof s.id === 'string')
    .slice(0, MAX_SESSIONS)
    .map((s) => ({
      id: s.id,
      title: typeof s.title === 'string' && s.title ? s.title : '新对话',
      createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
      // 本次对话改动过的文件（供"已编辑 N 个文件"卡片）
      turn: Number(s.turn) || 1,
      changes: (Array.isArray(s.changes) ? s.changes : []).map((c) =>
        Object.assign({}, c, { turn: Number(c.turn) || 1 })
      ),
      entries: Array.isArray(s.entries) ? s.entries.slice(-MAX_ENTRIES_PER_SESSION).map(migrateEntry) : []
    }));
  const activeId = sessions.some((s) => s.id === raw.activeId) ? raw.activeId : (sessions[0] && sessions[0].id) || null;
  return { activeId, sessions };
}

/**
 * 迁移旧版本持久化的条目。
 *
 * 背景：摘要/默认折叠这些是后来才加的，旧的 workspaceState 里存着老字段：
 *   - `open: true`（早期版本写的）→ 重载后工具卡一直展开
 *   - `summary` 还是结果文本的第一行（例如 `{`），而不是压缩后的摘要
 *   - `args`/`result` 是整份原文
 * 光改渲染器不够，因为渲染读的是"存下来的字段"；这里在加载时重算一遍。
 */
function migrateEntry(e) {
  const out = Object.assign({}, e);
  delete out.open; // 旧字段：会导致工具卡一直展开
  delete out.streaming; // 半途回放标记，重载后无需保留
  if (out.role === 'user' || out.role === 'assistant') {
    // 按**当前**渲染器重算 html：老条目的 html 是更早版本算出来的（那时可能还没有
    // 代码块/语法高亮），不重算的话"旧对话里代码块不出现"这类问题永远修不掉。
    out.html = miniMarkdown(out.text || '');
    return out;
  }
  if (out.role === 'changes') {
    // 老版本只有一张累积卡片：当作第一轮的卡片，免得升级后又多出一张
    if (!out.turn) out.turn = 1;
    if (!out.id || out.id === 'changes-summary') out.id = `changes-${out.turn}`;
    return out;
  }
  if (out.role !== 'tool') return out;
  if (out.args != null) {
    const sa = summarizeToolArgs(out.name, out.args);
    if (!out.argSummary) out.argSummary = sa.summary;
    // 旧条目没有 showArgs 字段：补上（false 表示"原始参数没有额外信息，别铺"）
    if (out.showArgs === undefined) out.showArgs = sa.showArgs !== false;
    // 代码块回填**不能**写在 `!argSummary` 分支里 —— 已有摘要的条目（0.10.1~0.11.1 建的）
    // 会因此永远补不上代码块，于是照旧把原始 JSON 铺在对话里。
    if (sa.code && !out.codeHtml) {
      out.codeHtml = miniMarkdown('```' + (sa.code.lang || '') + '\n' + sa.code.text + '\n```');
    }
  }
  if (out.result != null) {
    const r = summarizeToolResult(out.name, out.result);
    out.summary = r.summary;
    if (r.body !== null) out.result = r.body;
  }
  return out;
}

function findSession(state, id) {
  return (state.sessions || []).find((s) => s.id === id) || null;
}

function activeSession(state) {
  return findSession(state, state.activeId);
}

/** 新建会话并切过去；返回新会话 */
function addSession(state, id) {
  const session = { id: id || makeSessionId(), title: '新对话', createdAt: Date.now(), entries: [], turn: 1 };
  state.sessions.unshift(session);
  if (state.sessions.length > MAX_SESSIONS) state.sessions.length = MAX_SESSIONS;
  state.activeId = session.id;
  return session;
}

/** 切到某个会话；不存在则返回 null */
function switchSession(state, id) {
  const s = findSession(state, id);
  if (!s) return null;
  state.activeId = s.id;
  return s;
}

function removeSession(state, id) {
  state.sessions = state.sessions.filter((s) => s.id !== id);
  if (state.activeId === id) state.activeId = state.sessions.length ? state.sessions[0].id : null;
  return state;
}

/** 往当前会话追加条目；首条用户消息顺便当标题 */
function appendEntry(state, entry) {
  const s = activeSession(state);
  if (!s) return null;
  s.entries.push(entry);
  if (s.entries.length > MAX_ENTRIES_PER_SESSION) s.entries = s.entries.slice(-MAX_ENTRIES_PER_SESSION);
  if (entry.role === 'user' && (s.title === '新对话' || !s.title)) s.title = titleFromText(entry.text);
  return s;
}

/** 更新当前会话里的某条（工具结果回填用） */
function patchEntry(state, entryId, patch) {
  const s = activeSession(state);
  if (!s) return null;
  const e = s.entries.find((x) => x.id === entryId);
  if (!e) return null;
  Object.assign(e, patch);
  return e;
}

/**
 * 算出传给 SDK 的 sessionId。
 *
 * 服务端的 `agents.create` 要求 sessionId 在持久存储里**全局唯一**：
 * 拿同一个 id 在新进程里再创建会抛 `session "x" already exists`
 * （实测：`dsh --profile sdk` 二次使用同一 id 时就是这样）。
 * 所以拼上"会话纪元"：同一子进程内同一对话 id 不变（模型记忆连续），换进程自动换 id。
 */
function dshSessionIdFor(uiSessionId, epoch) {
  if (!uiSessionId) return null;
  return `${uiSessionId}-p${epoch || 'x'}`;
}

/**
 * 服务端把用户消息回吐（user/message 事件）时，决定是"确认本地乐观条目"还是"新增一条"。
 * 不这么做的话，发送方会看到自己的消息出现两次。
 *
 * @param {Array<object>} entryList 当前会话的条目
 * @param {{text:string}} incoming  服务端回声
 * @returns {{action:'confirm', id:string} | {action:'append'}}
 */
function resolveUserEcho(entryList, incoming) {
  const list = Array.isArray(entryList) ? entryList : [];
  const text = incoming ? incoming.text : undefined;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i] && list[i].role === 'user') {
      const last = list[i];
      if (last.local && last.text === text) return { action: 'confirm', id: last.id };
      return { action: 'append' }; // 最近一条用户消息已确认过（或内容不同）→ 这是新的一条
    }
  }
  return { action: 'append' };
}

/** 落盘前瘦身：截断超长文本，避免 workspaceState 无限膨胀 */
function forStorage(state) {
  const clone = {
    activeId: state.activeId,
    sessions: (state.sessions || []).slice(0, MAX_SESSIONS).map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      stats: s.stats,
      changes: s.changes,
      entries: s.entries.slice(-MAX_ENTRIES_PER_SESSION).map((e) => {
        const out = Object.assign({}, e);
        // 这里只是**持久化**时的保护（避免 workspaceState 被撞大），
        // 不影响界面：界面拿到的是原文（见 postEntry）。
        for (const k of ['text', 'result', 'args', 'reasoning', 'summary']) {
          if (typeof out[k] === 'string' && out[k].length > MAX_ENTRY_CHARS) {
            out[k] = `${out[k].slice(0, MAX_ENTRY_CHARS)}…（已截断）`;
          }
        }
        return out;
      })
    }))
  };
  return clone;
}

// ---------------------------------------------------------------------------
// 极简 Markdown 渲染（先转义，再套结构 —— 绝不产生可注入的 HTML）
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 简单的语法高亮（关键字着色）。
 * 支持常见编程语言的关键字、字符串、注释、数字。
 */
function highlightCode(code, lang) {
  const KEYWORDS = {
    js: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'extends', 'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'throw', 'new', 'this', 'true', 'false', 'null', 'undefined'],
    javascript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'extends', 'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'throw', 'new', 'this', 'true', 'false', 'null', 'undefined'],
    py: ['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'as', 'try', 'except', 'raise', 'with', 'True', 'False', 'None', 'and', 'or', 'not', 'in', 'is'],
    python: ['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'as', 'try', 'except', 'raise', 'with', 'True', 'False', 'None', 'and', 'or', 'not', 'in', 'is'],
    java: ['public', 'private', 'protected', 'class', 'interface', 'extends', 'implements', 'return', 'if', 'else', 'for', 'while', 'new', 'this', 'true', 'false', 'null', 'static', 'final', 'void', 'int', 'String'],
    ts: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'extends', 'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'throw', 'new', 'this', 'true', 'false', 'null', 'undefined', 'interface', 'type', 'enum'],
    typescript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'extends', 'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'throw', 'new', 'this', 'true', 'false', 'null', 'undefined', 'interface', 'type', 'enum']
  };

  const langKey = (lang || '').toLowerCase();
  const kwSet = new Set(KEYWORDS[langKey] || KEYWORDS.js);
  // `#` 注释只在这几种语言里成立：否则 CSS 的 #fff、C 的 #include 会被误判
  const hashComment = ['py', 'python', 'rb', 'ruby', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'ini', ''].includes(langKey);

  const src = String(code == null ? '' : code);
  // 单遍扫描：注释 | 字符串 | 数字 | 标识符。边切边转义，
  // 绝不回头去扫自己刚生成的标记 —— 否则 "class" 会命中 class="kw" 里的 class。
  const commentAlt = hashComment ? '\\/\\/[^\\n]*|#[^\\n]*' : '\\/\\/[^\\n]*';
  const re = new RegExp(
    `(\\/\\*[\\s\\S]*?\\*\\/|${commentAlt})` + // 1 注释
      `|('(?:[^'\\\\\\n]|\\\\.)*'|"(?:[^"\\\\\\n]|\\\\.)*"|\`(?:[^\`\\\\]|\\\\.)*\`)` + // 2 字符串
      `|\\b(\\d+(?:\\.\\d+)?)\\b` + // 3 数字
      `|([A-Za-z_$][\\w$]*)`, // 4 标识符
    'g'
  );

  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    out += escapeHtml(src.slice(last, m.index));
    last = re.lastIndex;
    if (m[1]) out += `<span class="cmt">${escapeHtml(m[1])}</span>`;
    else if (m[2]) out += `<span class="str">${escapeHtml(m[2])}</span>`;
    else if (m[3]) out += `<span class="num">${escapeHtml(m[3])}</span>`;
    else if (kwSet.has(m[4])) out += `<span class="kw">${escapeHtml(m[4])}</span>`;
    else out += escapeHtml(m[0]);
  }
  out += escapeHtml(src.slice(last));
  return out;
}

/**
 * 把模型输出渲染成安全 HTML。支持：围栏代码块（带语法高亮+复制按钮）、行内代码、
 * 粗体、斜体、无序/有序列表、标题、http(s) 链接、段落。
 */
function miniMarkdown(text, opts) {
  const options = Object.assign({ codeHighlight: true, showLineNumbers: false }, opts);
  let src = String(text == null ? '' : text);

  // 1) 先把围栏代码块挖出来，避免里面的内容被后续规则改写
  const blocks = [];
  src = src.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = blocks.length;
    const langTrim = (lang || '').trim();
    const langCls = langTrim && /^[\w+#.-]{1,20}$/.test(langTrim) ? ` data-lang="${langTrim}"` : '';
    
    // 语法高亮
    const highlighted = options.codeHighlight ? highlightCode(code.replace(/\n$/, ''), langTrim) : escapeHtml(code.replace(/\n$/, ''));
    
    // 行号
    let codeHtml = highlighted;
    if (options.showLineNumbers) {
      const lines = highlighted.split('\n');
      codeHtml = lines.map((line, i) => `<span class="ln">${i + 1}</span>${line}`).join('\n');
    }
    
    // 代码块结构：语言标签 + 复制按钮 + 代码
    const header = langTrim ? `<div class="code-header"><span class="lang-label">${escapeHtml(langTrim)}</span><button class="copy-btn" data-code="${escapeHtml(code)}">复制</button></div>` : '';
    blocks.push(`<div class="code-block"${langCls}>${header}<pre class="code"><code>${codeHtml}</code></pre></div>`);
    return `\u0000BLOCK${idx}\u0000`;
  });

  // 2) 转义剩余文本
  src = escapeHtml(src);

  // 3) 行内规则
  src = src
    .replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>')
    .replace(/\*\*([^\n*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^\n*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noreferrer noopener">$1</a>');

  // 4) 分块成行，识别标题 / 列表 / 段落
  // 3.5) Markdown 表格 -> 真表格
  // 长回答里表格很常见；以前按普通文本处理，`|` 分隔符整片原样显示，读起来就是"一大堆内容"
  const tables = [];
  {
    const raw = src.split('\n');
    const outLines = [];
    const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
    const isSep = (l) => /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(l);
    const cells = (l) =>
      l
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim());
    for (let i = 0; i < raw.length; i += 1) {
      if (isRow(raw[i]) && i + 1 < raw.length && isSep(raw[i + 1])) {
        const head = cells(raw[i]);
        const body = [];
        let k = i + 2;
        while (k < raw.length && isRow(raw[k])) {
          body.push(cells(raw[k]));
          k += 1;
        }
        const th = head.map((c) => `<th>${c}</th>`).join('');
        const trs = body
          .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
          .join('');
        const idx = tables.length;
        tables.push(
          `<div class="table-wrap"><table class="md-table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`
        );
        outLines.push(`\u0000TBL${idx}\u0000`);
        i = k - 1;
        continue;
      }
      outLines.push(raw[i]);
    }
    src = outLines.join('\n');
  }

  const lines = src.split('\n');
  const out = [];
  let listType = null;
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const line of lines) {
    if (/^\u0000BLOCK\d+\u0000$/.test(line.trim())) {
      closeList();
      out.push(line.trim());
      continue;
    }
    const tbl = /^\u0000TBL(\d+)\u0000$/.exec(line.trim());
    if (tbl) {
      closeList();
      out.push(tables[Number(tbl[1])]);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = Math.min(4, heading[1].length) + 2; // # -> h3
      out.push(`<h${level}>${heading[2]}</h${level}>`);
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      if (listType !== 'ul') {
        closeList();
        out.push('<ul>');
        listType = 'ul';
      }
      out.push(`<li>${ul[1]}</li>`);
      continue;
    }
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      if (listType !== 'ol') {
        closeList();
        out.push('<ol>');
        listType = 'ol';
      }
      out.push(`<li>${ol[1]}</li>`);
      continue;
    }
    closeList();
    if (line.trim() === '') {
      out.push('<div class="gap"></div>');
    } else {
      out.push(`<p>${line}</p>`);
    }
  }
  closeList();

  // 5) 还原代码块
  let html = out.join('\n');
  html = html.replace(/\u0000BLOCK(\d+)\u0000/g, (_m, i) => blocks[Number(i)] || '');
  return html;
}

module.exports = {
  mapSessionEvent,
  summarizeUsage,
  usageLine,
  textOf,
  reasoningOf,
  unwrap,
  // 会话列表
  emptyState,
  normalizeState,
  migrateEntry,
  findSession,
  activeSession,
  addSession,
  switchSession,
  removeSession,
  appendEntry,
  patchEntry,
  resolveUserEcho,
  dshSessionIdFor,
  forStorage,
  titleFromText,
  makeSessionId,
  MAX_SESSIONS,
  MAX_ENTRIES_PER_SESSION,
  // 渲染
  miniMarkdown,
  escapeHtml,
  replayPlan,
  summarizeToolResult,
  summarizeToolArgs,
  toolHidden,
  describeToolCall,
  mergeChanges,
  changesForTurn,
  changeTotals,
  entryChangeStats,
  // 统计与目录
  MODEL_CATALOG,
  REASONING_EFFORTS,
  PERMISSION_MODES,
  isDirectWriteMode,
  emptyStats,
  reduceStats,
  formatDuration,
  formatTokens,
  formatPercent,
  statsLines
};
