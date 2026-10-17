'use strict';
/**
 * 跑全部测试。CI 与本机共用这个入口，避免"我本地过了"和 CI 不一致。
 *
 * 用法：node build/run-tests.cjs
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'test');
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('-test.cjs'))
  .sort();

let failed = 0;
let total = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' });
  const out = r.stdout ? '' : '';
  void out;
  if (r.status !== 0) failed += 1;
  total += 1;
  if (r.status !== 0) console.log(`  !! ${f} 失败（exit ${r.status}）`);
}
console.log(`\n${total} 个测试文件，${failed} 个失败`);
process.exit(failed ? 1 : 0);
