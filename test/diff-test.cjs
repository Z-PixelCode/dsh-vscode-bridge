'use strict';
/**
 * 行级 diff 引擎的单测（纯逻辑，不需要 VS Code）。
 * 运行：node test/diff-test.cjs
 *
 * 为什么单独测它：扩展里那个 `showDiff is not defined` 是假 IDE 测试覆盖不到的；
 * 凡是纯逻辑，就该在这里被钉死。
 */
const assert = require('node:assert');
const { diffLines, applyHunks, describeHunk } = require('../src/diff');

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

console.log('\n[1] hunk 识别');

t('完全相同 -> 0 个 hunk', () => {
  assert.deepStrictEqual(diffLines(j('a', 'b', 'c'), j('a', 'b', 'c')), []);
});

t('末尾追加一行 -> 1 个 add hunk', () => {
  const h = diffLines(j('a', 'b'), j('a', 'b', 'c'));
  assert.strictEqual(h.length, 1);
  assert.strictEqual(h[0].aLines.length, 0, '不该有删除行');
  assert.deepStrictEqual(h[0].bLines, ['c']);
  assert.strictEqual(h[0].aStart, 2, '插入点在第 2 行之后（0 基）');
  assert.strictEqual(h[0].aEnd, 2, '纯插入不消耗旧行');
});

t('删掉一行 -> 1 个 remove hunk', () => {
  const h = diffLines(j('a', 'b', 'c'), j('a', 'c'));
  assert.strictEqual(h.length, 1);
  assert.deepStrictEqual(h[0].aLines, ['b']);
  assert.strictEqual(h[0].bLines.length, 0);
});

t('改一行 -> 1 个 replace hunk', () => {
  const h = diffLines(j('a', 'b', 'c'), j('a', 'B', 'c'));
  assert.strictEqual(h.length, 1);
  assert.deepStrictEqual(h[0].aLines, ['b']);
  assert.deepStrictEqual(h[0].bLines, ['B']);
  assert.strictEqual(h[0].aStart, 1);
  assert.strictEqual(h[0].aEnd, 2);
});

t('两处相隔较远的改动 -> 2 个独立 hunk', () => {
  const h = diffLines(
    j('1', '2', '3', '4', '5', '6', '7', '8', '9'),
    j('1', 'X', '3', '4', '5', '6', '7', 'Y', '9')
  );
  assert.strictEqual(h.length, 2);
  assert.deepStrictEqual(h[0].bLines, ['X']);
  assert.deepStrictEqual(h[1].bLines, ['Y']);
});

t('空文件 -> 内容 = 1 个 hunk，且往返正确', () => {
  // 注意语义：'' 按 split('\n') 是 ['']（一个空行），所以 hunk 是"用新内容替换
  // 这个空行"。这是 split/join 往返一致的代价，但往返本身是可证的。
  const h = diffLines('', j('a', 'b'));
  assert.strictEqual(h.length, 1);
  assert.strictEqual(h[0].bLines.length, 2);
  assert.strictEqual(applyHunks('', h, [0]), j('a', 'b'), '全接受后必须等于新文本');
});

t('清空文件 -> 往返正确', () => {
  const h = diffLines(j('a', 'b'), '');
  assert.strictEqual(h.length, 1);
  assert.strictEqual(applyHunks(j('a', 'b'), h, [0]), '');
});

console.log('\n[2] 应用');

const oldText = j('def a():', '    return 1', '', 'def b():', '    return 2', '', 'def c():', '    return 3');
const newText = j('def a():', '    return 10', '', 'def b():', '    return 2', '', 'def c():', '    return 30', '');

t('全接受 == 提案文本（往返一致）', () => {
  const hunks = diffLines(oldText, newText);
  const out = applyHunks(oldText, hunks, hunks.map((_, i) => i));
  assert.strictEqual(out, newText);
});

t('只接受第 1 块 -> 第 2 块保持原样', () => {
  const hunks = diffLines(oldText, newText);
  assert.ok(hunks.length >= 2, `应该有 2 块，实际 ${hunks.length}`);
  const out = applyHunks(oldText, hunks, [0]);
  assert.ok(out.includes('return 10'), '第 1 块应生效');
  assert.ok(out.includes('return 3'), '第 2 块应保持原值');
  assert.ok(!out.includes('return 30'));
});

t('只接受第 2 块 -> 第 1 块保持原样', () => {
  const hunks = diffLines(oldText, newText);
  const out = applyHunks(oldText, hunks, [1]);
  assert.ok(out.includes('return 1') && !out.includes('return 10'), '第 1 块不该变');
  assert.ok(out.includes('return 30'), '第 2 块应生效');
});

t('一块都不接受 -> 等于原文', () => {
  const hunks = diffLines(oldText, newText);
  assert.strictEqual(applyHunks(oldText, hunks, []), oldText);
});

t('多块乱序传入也没问题（内部会从后往前应用）', () => {
  const hunks = diffLines(oldText, newText);
  const out = applyHunks(oldText, hunks, [1, 0]);
  assert.strictEqual(out, newText);
});

console.log('\n[3] 行尾与边界');

t('旧文件是 CRLF、提案是 LF -> 插入行归一化成 CRLF', () => {
  const oldCrlf = 'a\r\nb\r\nc\r\n';
  const newLf = 'a\r\nb\r\nNEW\nc\r\n'; // 插入行是 LF（模拟 agent 给的内容）
  const hunks = diffLines(oldCrlf, newLf);
  const out = applyHunks(oldCrlf, hunks, hunks.map((_, i) => i));
  assert.strictEqual(out, 'a\r\nb\r\nNEW\r\nc\r\n');
  assert.ok(!/[^\r]\n(?![^\r])/.test(out.replace(/\r\n/g, '')), '不该残留裸 LF');
});

t('旧文件是 LF -> 保持 LF，不引入 \\r', () => {
  const oldLf = 'a\nb\nc\n';
  const newText2 = 'a\nb\nNEW\nc\n';
  const hunks = diffLines(oldLf, newText2);
  const out = applyHunks(oldLf, hunks, hunks.map((_, i) => i));
  assert.strictEqual(out, newText2);
  assert.ok(!out.includes('\r'));
});

t('整份替换（无公共行）', () => {
  const h = diffLines(j('x', 'y'), j('p', 'q'));
  assert.strictEqual(h.length, 1);
  assert.strictEqual(applyHunks(j('x', 'y'), h, [0]), j('p', 'q'));
});

t('文件末尾换行的增删', () => {
  const h = diffLines(j('a', 'b'), j('a', 'b', ''));
  assert.strictEqual(h.length, 1);
  assert.strictEqual(applyHunks(j('a', 'b'), h, [0]), j('a', 'b', ''));
});

console.log('\n[4] 描述');

t('describeHunk 给出行为与统计', () => {
  const hunks = diffLines(j('a', 'b', 'c'), j('a', 'B', 'c'));
  const d = describeHunk(hunks[0]);
  assert.strictEqual(d.kind, 'replace');
  assert.strictEqual(d.startLine, 2);
  assert.strictEqual(d.added, 1);
  assert.strictEqual(d.removed, 1);
  assert.strictEqual(d.preview, 'B');
});

t('新增块 kind=add、删除块 kind=remove', () => {
  assert.strictEqual(describeHunk(diffLines(j('a'), j('a', 'b'))[0]).kind, 'add');
  assert.strictEqual(describeHunk(diffLines(j('a', 'b'), j('a'))[0]).kind, 'remove');
});

console.log(`\n结果: ${passed} 通过, ${failures.length} 失败`);
if (failures.length) {
  console.log('失败项:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
