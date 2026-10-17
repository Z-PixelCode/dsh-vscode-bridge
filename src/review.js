'use strict';
/**
 * 审核批次模型：多文件 × 逐块。
 *
 * 纯逻辑、零依赖、不碰 vscode —— 因此可以被单测钉死（见 test/review-test.cjs）。
 *
 * 关键设计：**决定与应用分离**
 *  - 「接受这块 / 忽略这块」只记录状态，不写盘
 *  - 只有当一批里所有块都有结论时（或显式调用 applyBatch），才按
 *    applyHunks(原文本, 全部块, 已接受的下标) **一次性**算出每个文件的最终文本
 *  - 这样做的原因：如果逐块增量写盘，后续块的行号会因前面的写入而偏移，
 *    基于原始行号的 hunk 索引就失效了。一次性应用可证正确。
 */

const { diffLines, applyHunks, describeHunk } = require('./diff');

const PENDING = 'pending';
const ACCEPTED = 'accepted';
const REJECTED = 'rejected';

/** 建一个空批次 */
function createBatch(id) {
  return { id, createdAt: Date.now(), files: [] };
}

/**
 * 往批次里加一个文件改动。
 * @param {object} batch
 * @param {{path:string, oldText:string, newText:string, existed:boolean, title?:string, diffId?:string}} change
 * @returns {object} entry
 */
function addChange(batch, change) {
  const hunks = diffLines(change.oldText, change.newText).map((h, index) => ({
    index,
    aStart: h.aStart,
    aEnd: h.aEnd,
    bStart: h.bStart,
    bEnd: h.bEnd,
    aLines: h.aLines,
    bLines: h.bLines,
    status: PENDING
  }));

  // 同一文件重复提案：替换掉旧条目，避免同批里两份互相矛盾
  batch.files = batch.files.filter((f) => f.path !== change.path);

  const entry = {
    path: change.path,
    oldText: change.oldText,
    newText: change.newText,
    existed: !!change.existed,
    title: change.title,
    diffId: change.diffId,
    hunks
  };
  batch.files.push(entry);
  return entry;
}

/** 找出批次里的条目（按路径） */
function findEntry(batch, filePath) {
  return batch.files.find((f) => f.path === filePath);
}

/**
 * 给一块下结论。
 * @param {object} entry
 * @param {number} hunkIndex
 * @param {'accept'|'reject'} decision
 */
function decideHunk(entry, hunkIndex, decision) {
  const hunk = entry.hunks[hunkIndex];
  if (!hunk) throw new Error(`块不存在: ${hunkIndex}`);
  hunk.status = decision === 'accept' ? ACCEPTED : REJECTED;
  return hunk;
}

/** 给一个文件的所有块下同一结论，返回受影响的块数 */
function decideFile(entry, decision) {
  let n = 0;
  for (const hunk of entry.hunks) {
    if (hunk.status === PENDING) {
      hunk.status = decision === 'accept' ? ACCEPTED : REJECTED;
      n += 1;
    }
  }
  return n;
}

/** 给整批下同一结论，返回受影响的块数 */
function decideBatch(batch, decision) {
  let n = 0;
  for (const entry of batch.files) n += decideFile(entry, decision);
  return n;
}

/** 该文件是否有待决定的块 */
function hasPending(entry) {
  return entry.hunks.some((h) => h.status === PENDING);
}

/** 整批是否都已决定（空批视为已决定） */
function isSettled(batch) {
  return batch.files.every((f) => !hasPending(f));
}

/** 统计 */
function stats(batch) {
  let pending = 0;
  let accepted = 0;
  let rejected = 0;
  for (const f of batch.files) {
    for (const h of f.hunks) {
      if (h.status === PENDING) pending += 1;
      else if (h.status === ACCEPTED) accepted += 1;
      else rejected += 1;
    }
  }
  return { files: batch.files.length, pending, accepted, rejected };
}

/**
 * 算出某个文件"按当前决定"应该写成的最终文本。
 * @returns {{text:string, changed:boolean, accepted:number[]}}
 */
function finalText(entry) {
  const accepted = entry.hunks.filter((h) => h.status === ACCEPTED).map((h) => h.index);
  if (accepted.length === 0) return { text: entry.oldText, changed: false, accepted };
  return { text: applyHunks(entry.oldText, entry.hunks, accepted), changed: true, accepted };
}

/** 从批次里移除一个文件条目 */
function removeEntry(batch, filePath) {
  batch.files = batch.files.filter((f) => f.path !== filePath);
}

/** 给界面用的条目摘要 */
function describeEntry(entry) {
  return {
    path: entry.path,
    existed: entry.existed,
    hunks: entry.hunks.length,
    summary: entry.hunks.map((h) => {
      const d = describeHunk(h);
      return { ...d, index: h.index, status: h.status };
    })
  };
}

module.exports = {
  PENDING,
  ACCEPTED,
  REJECTED,
  createBatch,
  addChange,
  findEntry,
  decideHunk,
  decideFile,
  decideBatch,
  hasPending,
  isSettled,
  stats,
  finalText,
  removeEntry,
  describeEntry
};
