'use strict';
/**
 * 桥补丁生成器的单测。
 *
 * 背景（这是实测踩出来的）：
 *   补丁里**顶层裸写 `- id: X` 表示"覆盖已存在的 id"**，目标 profile 里没有 X 时
 *   会直接报 `patch: entry "X" not found`。要新增必须包在 `- insert:` 里。
 *   之前的 copyConfig 片段和 dsh-bundle/cordis.patch.yml 都是裸写 —— 是错的。
 *
 * 运行：node test/bridge-overlay-test.cjs
 */
const assert = require('node:assert');
const ov = require('../src/bridge-overlay');

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

const URL = 'http://127.0.0.1:37251/mcp';
const TOKEN = 'tk-local-abc123';

console.log('\n[1] 补丁形态（关键：必须 - insert:）');

t('片段以 - insert: 开头，项缩进 4 空格', () => {
  const s = ov.insertSnippet({ url: URL, token: TOKEN });
  assert.ok(s.startsWith('- insert:\n'), `实际开头: ${JSON.stringify(s.slice(0, 20))}`);
  assert.ok(s.includes('\n    - id: mcp-vscode-bridge'));
  // 精确断言：@ 开头是 YAML 保留指示符，插件名必须带引号
  assert.ok(s.includes("\n      name: '@deepseek-ai/dsh-mcp-client'"), `插件名必须加引号:\n${s}`);
  assert.ok(s.includes('\n      config:'));
  assert.ok(s.includes('\n        serverName: vscode'));
});

t('没有顶层裸 id（错误形态）', () => {
  const s = ov.insertSnippet({ url: URL, token: TOKEN });
  assert.strictEqual(ov.isBareIdPatch(s), false, '不能出现顶层 - id:');
  assert.ok(!/^- id:/m.test(s));
});

t('overlayPatchYaml 与片段同源，并带注释', () => {
  const y = ov.overlayPatchYaml({ url: URL, token: TOKEN, comment: '第一行\n第二行' });
  assert.ok(y.startsWith('# 第一行\n# 第二行\n- insert:\n'));
  assert.ok(y.includes('mcp-vscode-bridge'));
  assert.strictEqual(ov.isBareIdPatch(y), false);
});

t('url / token / transport 都写进去了', () => {
  const s = ov.insertSnippet({ url: URL, token: TOKEN });
  assert.ok(s.includes(`url: ${URL}`));
  assert.ok(s.includes('transport: streamable-http'));
  assert.ok(s.includes(`Authorization: 'Bearer ${TOKEN}'`), 'Authorization 值含空格，需要引号包裹');
  assert.ok(s.includes('failOnStartupError: false'));
});

t('bridgeRow 是结构化对象（便于测试/复用）', () => {
  const row = ov.bridgeRow({ url: URL, token: TOKEN });
  assert.strictEqual(row.id, 'mcp-vscode-bridge');
  assert.strictEqual(row.name, '@deepseek-ai/dsh-mcp-client');
  assert.strictEqual(row.config.serverName, 'vscode');
  assert.strictEqual(row.config.headers.Authorization, `Bearer ${TOKEN}`);
});

console.log('\n[2] YAML 标量转义');

t('普通值裸写', () => {
  assert.strictEqual(ov.scalar('tk-local-abc123'), 'tk-local-abc123');
  assert.strictEqual(ov.scalar('http://127.0.0.1:37251/mcp'), 'http://127.0.0.1:37251/mcp');
  assert.strictEqual(ov.scalar('mcp-vscode-bridge'), 'mcp-vscode-bridge');
  assert.strictEqual(ov.scalar('streamable-http'), 'streamable-http');
});

t('以保留指示符开头的值必须加引号（回归：@deepseek-ai 曾导致启动 code=1）', () => {
  for (const bad of [
    '@deepseek-ai/dsh-mcp-client',
    '-leading',
    '?question',
    ':colon',
    '#hash',
    '&anchor',
    '*alias',
    '!tag',
    '|pipe',
    '>fold',
    '%percent',
    '`tick',
    '{brace',
    '[bracket',
    "'quote",
    '"dquote',
    ',comma'
  ]) {
    const out = ov.scalar(bad);
    assert.ok(out.startsWith("'") && out.endsWith("'"), `${bad} 应被引号包裹，实际 ${out}`);
  }
});

t('含空格/引号/冒号空白/井号空白的值要加引号并转义', () => {
  assert.strictEqual(ov.scalar('a b'), "'a b'");
  assert.strictEqual(ov.scalar("it's"), "'it''s'");
  assert.strictEqual(ov.scalar('key: value'), "'key: value'");
  assert.strictEqual(ov.scalar('a #b'), "'a #b'");
  assert.strictEqual(ov.scalar(' lead'), "' lead'");
});

t('看起来像数字/布尔的也要加引号（避免被解析成非字符串）', () => {
  for (const typed of ['123', '1.5', 'true', 'false', 'null', '~', 'yes', 'off']) {
    assert.ok(ov.scalar(typed).startsWith("'"), `${typed} 应被引号包裹`);
  }
});

t('空串也会被引号包住（避免变成 null）', () => {
  assert.strictEqual(ov.scalar(''), "''");
});

t('带特殊字符的令牌不会破坏 YAML 结构', () => {
  const s = ov.insertSnippet({ url: URL, token: 'a b:c#d' });
  assert.ok(s.includes("Authorization: 'Bearer a b:c#d'"), s);
  assert.strictEqual(ov.isBareIdPatch(s), false);
});

console.log(`\n结果: ${passed} 通过, ${failures.length} 失败`);
if (failures.length) {
  console.log('失败项:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
