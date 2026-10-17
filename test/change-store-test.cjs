'use strict';
/**
 * 改动快照存储的纯逻辑测试。
 *
 * 为什么值得单独测：这里决定了「点开卡片能不能看到**那一轮**改了什么」。
 * 关键契约是 **每个改动必须同时留着 before 和 after** —— 只留一个的话，
 * diff 的另一端就只能取"现在的文件"，于是后面几轮和用户自己的改动会混进来。
 *
 * 运行：node test/change-store-test.cjs
 */
const assert = require('node:assert');
const S = require('../src/change-store');

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

console.log('\n[1] 记录与查找');

t('记录一个改动：before/after 都要留下来', () => {
  const st = S.emptyStore();
  const ids = S.recordChanges(st, [{ path: 'D:\\a\\b.py', before: 'old\n', after: 'new\n', added: 1, removed: 1, turn: 2 }], 1000);
  assert.strictEqual(ids.length, 1);
  const it = S.findChange(st, ids[0]);
  assert.strictEqual(it.before, 'old\n');
  assert.strictEqual(it.after, 'new\n');
  assert.strictEqual(it.turn, 2);
  assert.strictEqual(it.added, 1);
});

t('缺少 before/after 的条目被跳过（宁可不记，也不要错的对比）', () => {
  const st = S.emptyStore();
  const ids = S.recordChanges(st, [{ path: 'a.py', added: 3 }], 1000);
  assert.deepStrictEqual(ids, []);
  assert.strictEqual(S.countChanges(st), 0);
});

t('按 id 查找；不存在的 id 返回 null', () => {
  const st = S.emptyStore();
  const ids = S.recordChanges(st, [{ path: 'a.py', before: '1', after: '2' }], 1000);
  assert.ok(S.findChange(st, ids[0]));
  assert.strictEqual(S.findChange(st, 'nope'), null);
  assert.strictEqual(S.findChange(st, null), null);
});

t('同一个文件多次改动各自独立保存（不同轮次可分别对比）', () => {
  const st = S.emptyStore();
  const id1 = S.recordChanges(st, [{ path: 'a.py', before: 'v0', after: 'v1', turn: 1 }], 1000)[0];
  const id2 = S.recordChanges(st, [{ path: 'a.py', before: 'v1', after: 'v2', turn: 2 }], 2000)[0];
  assert.notStrictEqual(id1, id2);
  assert.strictEqual(S.findChange(st, id1).after, 'v1', '第 1 轮的 after 必须还是 v1，不能被后来的覆盖');
  assert.strictEqual(S.findChange(st, id2).before, 'v1');
  assert.strictEqual(S.findChange(st, id2).after, 'v2');
});

t('changesFor：按文件取，时间倒序', () => {
  const st = S.emptyStore();
  S.recordChanges(st, [{ path: 'a.py', before: '0', after: '1' }], 1000);
  S.recordChanges(st, [{ path: 'a.py', before: '1', after: '2' }], 2000);
  S.recordChanges(st, [{ path: 'other.py', before: 'x', after: 'y' }], 3000);
  const rows = S.changesFor(st, 'a.py');
  assert.strictEqual(rows.length, 2);
  assert.ok(rows[0].time >= rows[1].time, '最新的在前');
  assert.strictEqual(S.changesFor(st, 'missing.py').length, 0);
});

t('路径键归一化：反斜杠/大小写不同也认作同一文件', () => {
  const st = S.emptyStore();
  S.recordChanges(st, [{ path: 'D:\\Test\\A.py', before: '0', after: '1' }], 1000);
  assert.strictEqual(S.changesFor(st, 'd:/test/a.py').length, 1);
  assert.strictEqual(S.countChanges(st), 1);
});

console.log('\n[2] 上限与容错');

t(`单文件最多保留 ${S.MAX_PER_FILE} 条，超出丢最旧`, () => {
  const st = S.emptyStore();
  for (let i = 0; i < S.MAX_PER_FILE + 3; i += 1) {
    S.recordChanges(st, [{ path: 'a.py', before: `v${i}`, after: `v${i + 1}` }], 1000 + i);
  }
  const rows = S.changesFor(st, 'a.py');
  assert.strictEqual(rows.length, S.MAX_PER_FILE);
  assert.strictEqual(rows[rows.length - 1].before, `v3`, '最旧的 v0..v2 应被丢掉');
});

t(`总数最多 ${S.MAX_TOTAL} 条，超出丢最旧（跨文件）`, () => {
  const st = S.emptyStore();
  for (let i = 0; i < S.MAX_TOTAL + 5; i += 1) {
    S.recordChanges(st, [{ path: `f${i}.py`, before: '0', after: '1' }], 1000 + i);
  }
  assert.ok(S.countChanges(st) <= S.MAX_TOTAL, `实际 ${S.countChanges(st)}`);
});

t('超大快照被跳过（不至于把状态写爆）', () => {
  const st = S.emptyStore();
  const big = 'x'.repeat(S.MAX_SNAPSHOT_BYTES + 1);
  const ids = S.recordChanges(st, [{ path: 'big.py', before: big, after: 'small' }], 1000);
  assert.deepStrictEqual(ids, []);
});

t('normalizeStore 容错：垃圾数据不炸，坏条目被剔除', () => {
  assert.deepStrictEqual(S.normalizeStore(null), {});
  assert.deepStrictEqual(S.normalizeStore('nope'), {});
  assert.deepStrictEqual(S.normalizeStore([]), {});
  const st = S.normalizeStore({
    'a.py': [{ id: 'ok', before: 'b', after: 'a', time: 5 }, { id: 'bad' }, null, 'x'],
    'b.py': 'not-an-array'
  });
  assert.strictEqual(S.countChanges(st), 1);
  assert.strictEqual(S.findChange(st, 'ok').after, 'a');
});

t('makeChangeId 不重复', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) ids.add(S.makeChangeId());
  assert.strictEqual(ids.size, 200);
});

console.log(`\n结果: ${passed} 通过, ${failures.length} 失败`);
if (failures.length) {
  console.log('失败项:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
