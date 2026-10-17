'use strict';
/**
 * 行级 diff 引擎：把"旧文本 → 新文本"分解成若干 hunk，并支持只应用其中一部分。
 *
 * 设计要点：
 *  - 纯函数、零依赖 —— 可以脱离 VS Code 单测（假 IDE 测不出真实适配层的错，
 *    但纯逻辑必须自己测干净）。
 *  - 用 text.split('\n') / lines.join('\n') 做往返，因此**原样保留行尾**
 *    （CRLF 的 \r 留在每行末尾）。只应用部分 hunk 时，插入行会按目标文本的
 *    行尾风格归一化，避免混出混合行尾。
 *  - 中间段用 LCS；规模超过上限时退化为"整段替换为一个 hunk"，保证不会卡死。
 */

/** LCS 单元格上限（约 2000×2000 行）；超过就退化成单 hunk */
const MAX_CELLS = 4_000_000;

/**
 * 比较两段文本，返回 hunk 列表。
 * @param {string} oldText
 * @param {string} newText
 * @returns {Array<{aStart:number,aEnd:number,bStart:number,bEnd:number,aLines:string[],bLines:string[]}>}
 *          行号均为 0 基、end 为开区间（与 Array.slice 一致）
 */
function diffLines(oldText, newText) {
  if (oldText === newText) return [];

  const a = String(oldText).split('\n');
  const b = String(newText).split('\n');

  // 1) 剥掉公共前后缀：变化一定落在中间
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length === 0 && midB.length === 0) return [];

  // 2) 中间段求编辑脚本
  let hunks;
  if (midA.length * midB.length > MAX_CELLS) {
    hunks = [
      { aStart: 0, aEnd: midA.length, bStart: 0, bEnd: midB.length, aLines: midA, bLines: midB }
    ];
  } else {
    hunks = lcsHunks(midA, midB);
  }

  // 3) 把索引平移回原文
  for (const h of hunks) {
    h.aStart += start;
    h.aEnd += start;
    h.bStart += start;
    h.bEnd += start;
  }
  return hunks;
}

/**
 * 用 LCS 把 a→b 的编辑脚本切成若干 hunk（连续的增删算一块，等行断开两块）。
 * @returns {Array<object>}
 */
function lcsHunks(a, b) {
  const n = a.length;
  const m = b.length;

  // dp[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // 回溯成操作序列
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push(['eq', i, j]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push(['del', i, j]);
      i += 1;
    } else {
      ops.push(['ins', i, j]);
      j += 1;
    }
  }
  while (i < n) {
    ops.push(['del', i, j]);
    i += 1;
  }
  while (j < m) {
    ops.push(['ins', i, j]);
    j += 1;
  }

  // 连续的非 eq 操作合成一个 hunk
  const hunks = [];
  let cur = null;
  for (const [op, oi, oj] of ops) {
    if (op === 'eq') {
      cur = null;
      continue;
    }
    if (!cur) {
      cur = { aStart: oi, aEnd: oi, bStart: oj, bEnd: oj, aLines: [], bLines: [] };
      hunks.push(cur);
    }
    if (op === 'del') {
      cur.aLines.push(a[oi]);
      cur.aEnd = oi + 1;
    } else {
      cur.bLines.push(b[oj]);
      cur.bEnd = oj + 1;
    }
  }
  return hunks;
}

/**
 * 把指定下标的 hunk 应用到 oldText 上（未选中的 hunk 保持原样）。
 * 从后往前替换，因此前面的行号不会失效。
 * @param {string} oldText
 * @param {Array<object>} hunks diffLines 的结果
 * @param {Iterable<number>} accepted 要应用的下标集合
 * @returns {string}
 */
function applyHunks(oldText, hunks, accepted) {
  const want = new Set(accepted);
  const lines = String(oldText).split('\n');
  const useCRLF = oldText.includes('\r\n');

  const picked = hunks
    .map((h, idx) => ({ h, idx }))
    .filter(({ idx }) => want.has(idx))
    .sort((x, y) => y.h.aStart - x.h.aStart || y.h.aEnd - x.h.aEnd);

  for (const { h } of picked) {
    const insert = h.bLines.map((l) => normalizeEol(l, useCRLF));
    lines.splice(h.aStart, h.aEnd - h.aStart, ...insert);
  }
  return lines.join('\n');
}

/** 按目标文本的行尾风格归一化一行（内容不变，只调整结尾的 \r） */
function normalizeEol(line, useCRLF) {
  const body = line.endsWith('\r') ? line.slice(0, -1) : line;
  return useCRLF ? `${body}\r` : body;
}

/**
 * 给界面用的一句话描述。
 * @param {object} h
 * @param {number} maxPreview 预览的最大字符数
 */
function describeHunk(h, maxPreview = 60) {
  const added = h.bLines.length;
  const removed = h.aLines.length;
  const first = h.bLines[0] !== undefined ? h.bLines[0] : h.aLines[0];
  const preview = first === undefined ? '' : String(first).replace(/\r$/, '').trim();
  const clipped = preview.length > maxPreview ? `${preview.slice(0, maxPreview)}…` : preview;
  return {
    startLine: h.aStart + 1,
    endLine: Math.max(h.aStart + 1, h.aEnd),
    added,
    removed,
    preview: clipped,
    kind: removed === 0 ? 'add' : added === 0 ? 'remove' : 'replace'
  };
}

module.exports = { diffLines, applyHunks, describeHunk, normalizeEol, MAX_CELLS };
