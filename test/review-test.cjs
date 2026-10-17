'use strict';
/**
 * 审核批次模型的单测（纯逻辑，不需要 VS Code）。
 * 运行：node test/review-test.cjs
 */
const assert = require('node:assert');
const review = require('../src/review');

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

const j = (...lines) => lines.join('\n');
const OLD = j(
  'def a():', '    return 1', '',
  'def b():', '    return 2', '',
  'def c():', '    return 3', ''
);
const NEW = j(
  'def a():', '    return 10', '',
  'def b():', '    return 20', '',
  'def c():', '    return 30', ''
);

console.log('\n[1] 批次与条目');

t('新建批次 -> 空', () => {
  const b = review.createBatch('b1');
  assert.strictEqual(b.id, 'b1');
  assert.deepStrictEqual(b.files, []);
  assert.strictEqual(review.isSettled(b), true, '空批视为已决定');
});

t('加一个改动 -> 算出 hunk', () => {
  const b = review.createBatch('b1');
  const e = review.addChange(b, { path: 'a.py', oldText: OLD, newText: NEW, existed: true });
  assert.strictEqual(b.files.length, 1);
  assert.strictEqual(e.hunks.length, 3, `应为 3 块，实际 ${e.hunks.length}`);
  assert.ok(e.hunks.every((h) => h.status === 'pending'));
});

t('同一路径重复提案 -> 替换而不是新增', () => {
  const b = review.createBatch('b1');
  review.addChange(b, { path: 'a.py', oldText: OLD, newText: NEW, existed: true });
  review.addChange(b, { path: 'a.py', oldText: OLD, newText: OLD, existed: true });
  assert.strictEqual(b.files.length, 1);
  assert.strictEqual(b.files[0].hunks.length, 0, '第二次没改动 -> 0 块');
});

t('新建文件（oldText 为空）也能加', () => {
  const b = review.createBatch('b1');
  const e = review.addChange(b, { path: 'new.py', oldText: '', newText: j('x', 'y'), existed: false });
  assert.strictEqual(e.existed, false);
  assert.ok(e.hunks.length >= 1);
});

console.log('\n[2] 决定');

t('decideHunk 只影响那一块', () => {
  const b = review.createBatch('b1');
  const e = review.addChange(b, { path: 'a.py', oldText: OLD, newText: NEW, existed: true });
  review.decideHunk(e, 1, 'accept');
  assert.deepStrictEqual(e.hunks.map((h) => h.status), ['pending', 'accepted', 'pending']);
});

t('decideFile 只处理 pending，返回处理数', () => {
  const b = review.createBatch('b1');
  const e = review.addChange(b, { path: 'a.py', oldText: OLD, newText: NEW, existed: true });
  review.decideHunk(e, 0, 'reject');
  const n = review.decideFile(e, 'accept');
  assert.strictEqual(n, 2, '已有结论的块不该被改');
  assert.deepStrictEqual(e.hunks.map((h) => h.status), ['rejected', 'accepted', 'accepted']);
});

t('decideBatch 跨文件统计', () => {
  const b = review.createBatch('b1');
  review.addChange(b, { path: 'a.py', oldText: OLD, newText: NEW, existed: true });
  review.addChange(b, { path: 'c.py', oldText: 'p\n', newText: 'q\n', existed: true });
  const n = review.decideBatch(b, 'accept');
  assert.strictEqual(n, 4, '3 块 + 1 块');
  assert.strictEqual(review.isSettled(b), true);
});

t('isSettled / stats', () => {
  const b = review.createBatch('b1');
  const e = review.addChange(b, { path: 'a.py', oldText: OLD, newText: NEW, existed: true });
  assert.strictEqual(review.isSettled(b), false);
  assert.deepStrictEqual(review.stats(b), { files: 1, pending: 3, accepted: 0, rejected: 0 });
  review.decideHunk(e, 0, 'accept');
  review.decideHunk(e, 1, 'reject');
  assert.deepStrictEqual(review.stats(b), { files: 1, pending: 1, accepted: 1, rejected: 1 });
});

console.log('\n[3] 应用（关键：一次性、基于原始行号）');

t('全不接受 -> 文本不变、changed=false', () => {
  const b = review.createBatch('b1');
  const e = review.addChange(b, { path: 'a.py', oldText: OLD, newText: NEW, existed: true });
  review.decideBatch(b, 'reject');
  const r = review.finalText(e);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.text, OLD);
});

t('全接受 -> 等于提案文本', () => {
  const b = review.createBatch('b1');
  const e = review.addChange(b, { path: 'a.py', oldText: OLD, newText: NEW, existed: true });
  review.decideBatch(b, 'accept');
  assert.strictEqual(review.finalText(e).text, NEW);
});

t('只接受第 2 块 -> 只有它生效（其余保持原值）', () => {
  const b = review.createBatch('b1');
  const e = review.addChange(b, { path: 'a.py', oldText: OLD, newText: NEW, existed: true });
  review.decideHunk(e, 1, 'accept');
  review.decideFile(e, 'reject'); // 剩下的（0 和 2）全忽略
  const r = review.finalText(e);
  assert.strictEqual(r.changed, true);
  assert.ok(r.text.includes('return 1'), '第 1 块不该变');
  assert.ok(r.text.includes('return 20'), '第 2 块应变');
  assert.ok(r.text.includes('return 3'), '第 3 块不该变');
  assert.ok(!r.text.includes('return 10') && !r.text.includes('return 30'));
  assert.deepStrictEqual(r.accepted, [1]);
});

t('接受第 1、3 块 -> 两块都生效且行号没串', () => {
  const b = review.createBatch('b1');
  const e = review.addChange(b, { path: 'a.py', oldText: OLD, newText: NEW, existed: true });
  review.decideHunk(e, 0, 'accept');
  review.decideHunk(e, 1, 'reject');
  review.decideHunk(e, 2, 'accept');
  const r = review.finalText(e);
  assert.strictEqual(r.text, j(
    'def a():', '    return 10', '',
    'def b():', '    return 2', '',
    'def c():', '    return 30', ''
  ));
});

t('多文件各自独立应用', () => {
  const b = review.createBatch('b1');
  const e1 = review.addChange(b, { path: 'a.py', oldText: OLD, newText: NEW, existed: true });
  const e2 = review.addChange(b, { path: 'z.txt', oldText: 'k\n', newText: 'K\n', existed: true });
  review.decideFile(e1, 'reject');
  review.decideFile(e2, 'accept');
  assert.strictEqual(review.finalText(e1).changed, false);
  assert.strictEqual(review.finalText(e2).text, 'K\n');
});

t('移除条目', () => {
  const b = review.createBatch('b1');
  review.addChange(b, { path: 'a.py', oldText: OLD, newText: NEW, existed: true });
  review.removeEntry(b, 'a.py');
  assert.strictEqual(b.files.length, 0);
});

console.log('\n[4] 界面摘要');

t('describeEntry 给出每块的行号/增删/状态', () => {
  const b = review.createBatch('b1');
  const e = review.addChange(b, { path: 'a.py', oldText: OLD, newText: NEW, existed: true });
  review.decideHunk(e, 0, 'accept');
  const d = review.describeEntry(e);
  assert.strictEqual(d.path, 'a.py');
  assert.strictEqual(d.summary.length, 3);
  assert.strictEqual(d.summary[0].status, 'accepted');
  assert.strictEqual(d.summary[0].kind, 'replace');
  assert.strictEqual(typeof d.summary[0].startLine, 'number');
});

console.log(`\n结果: ${passed} 通过, ${failures.length} 失败`);
if (failures.length) {
  console.log('失败项:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
