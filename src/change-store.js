'use strict';
/**
 * 「本次对话改动」的**快照存储**（纯逻辑，不依赖 vscode，方便单测）。
 *
 * 为什么每个改动要存**改动前 + 改动后**两份内容：
 *   只存"改动前"的话，diff 的右侧只能是**现在的文件**，于是看到的是
 *   "那一刻 vs 现在"——后面几轮对话、以及用户自己的手动修改都会混进 `+` 侧，
 *   根本没法隔离"某一轮改了什么"。
 *   两份都存 → diff 两端都来自快照 → 那一轮的改动就是它本身，与当前文件无关。
 *
 * 代价是体积，所以有条数上限与单份大小上限。
 */

const MAX_PER_FILE = 5;
const MAX_TOTAL = 30;
const MAX_SNAPSHOT_BYTES = 200 * 1024;

/** 归一化路径作为存储键（Windows 上大小写不敏感） */
function normKey(p) {
  return String(p || '').replace(/\\/g, '/').toLowerCase();
}

/** 生成改动 id：时间戳 + 自增 + 随机后缀，够用且可读 */
let seq = 0;
function makeChangeId() {
  seq += 1;
  return `c${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function emptyStore() {
  return {};
}

/** 把任意来源的数据整形成合法 store（容错：读回来可能是旧结构/被截断） */
function normalizeStore(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyStore();
  const out = emptyStore();
  for (const [k, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue;
    const rows = list
      .filter((it) => it && typeof it.id === 'string' && typeof it.before === 'string')
      .map((it) => ({
        id: it.id,
        path: typeof it.path === 'string' ? it.path : '',
        time: Number(it.time) || 0,
        added: Number(it.added) || 0,
        removed: Number(it.removed) || 0,
        turn: Number(it.turn) || 0,
        before: it.before,
        after: typeof it.after === 'string' ? it.after : ''
      }));
    if (rows.length) out[normKey(k)] = rows.slice(-MAX_PER_FILE);
  }
  return out;
}

function countChanges(store) {
  return Object.values(store || {}).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0);
}

/** 全局条数上限：从最旧的开始丢 */
function trimTotal(store) {
  let guard = 0;
  while (countChanges(store) > MAX_TOTAL && guard < 1000) {
    guard += 1;
    let oldest = null;
    let oldestKey = null;
    for (const [k, list] of Object.entries(store)) {
      for (const it of list) {
        if (!oldest || it.time < oldest.time) {
          oldest = it;
          oldestKey = k;
        }
      }
    }
    if (!oldest) break;
    store[oldestKey] = store[oldestKey].filter((x) => x !== oldest);
    if (!store[oldestKey].length) delete store[oldestKey];
  }
  return store;
}

/**
 * 记录一批刚落盘的改动。
 * 每条：{ path, before, after, added, removed, turn, changeId }
 * 没有 before/after 的条目会被跳过 —— 宁可没有记录，也不要一个错的对比。
 */
function recordChanges(store, list, now) {
  const s = store || emptyStore();
  const ts = Number(now) || Date.now();
  const ids = [];
  for (const c of list || []) {
    if (!c || !c.path) continue;
    if (typeof c.before !== 'string' || typeof c.after !== 'string') continue;
    if (c.before.length > MAX_SNAPSHOT_BYTES || c.after.length > MAX_SNAPSHOT_BYTES) continue;
    const key = normKey(c.path);
    const item = {
      id: c.changeId || makeChangeId(),
      path: c.path,
      time: ts,
      added: Number(c.added) || 0,
      removed: Number(c.removed) || 0,
      turn: Number(c.turn) || 0,
      before: c.before,
      after: c.after
    };
    const rows = s[key] || [];
    rows.push(item);
    while (rows.length > MAX_PER_FILE) rows.shift();
    s[key] = rows;
    ids.push(item.id);
  }
  if (ids.length) trimTotal(s);
  return ids;
}

/** 按 id 找某个改动 */
function findChange(store, id) {
  if (!id) return null;
  for (const list of Object.values(store || {})) {
    for (const it of list) {
      if (it.id === id) return it;
    }
  }
  return null;
}

/** 某个文件的历史改动（按时间倒序） */
function changesFor(store, filePath) {
  const rows = (store || {})[normKey(filePath)] || [];
  return rows.slice().sort((a, b) => b.time - a.time);
}

module.exports = {
  MAX_PER_FILE,
  MAX_TOTAL,
  MAX_SNAPSHOT_BYTES,
  normKey,
  makeChangeId,
  emptyStore,
  normalizeStore,
  countChanges,
  trimTotal,
  recordChanges,
  findChange,
  changesFor
};
