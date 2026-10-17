'use strict';
/**
 * SdkClient 协议层单测：用假子进程（PassThrough 流）替代真实 spawn，
 * 因此可以完全离线、确定性地钉住分帧、请求/响应关联、通知分发、错误与退出。
 *
 * 运行：node test/sdk-client-test.cjs
 */
const assert = require('node:assert');
const { PassThrough } = require('node:stream');
const { SdkClient, buildSpawnCommand, detectLauncher, candidateLaunchers } = require('../src/sdk-client');

let passed = 0;
const failures = [];

async function t(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  ✗ ${name} -> ${err.message}`);
  }
}

const tick = (n = 3) =>
  new Promise((resolve) => {
    let i = 0;
    const step = () => (++i >= n ? resolve() : setImmediate(step));
    setImmediate(step);
  });

/** 造一个假子进程 + 便于测试的操控面 */
function makeFakeChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const frames = [];
  const handlers = {};

  stdin.on('data', (buf) => {
    for (const line of buf.toString('utf8').split('\n')) {
      if (line.trim()) frames.push(JSON.parse(line));
    }
  });

  const child = {
    stdin,
    stdout,
    stderr,
    killed: false,
    kill() {
      this.killed = true;
    },
    on(ev, fn) {
      handlers[ev] = fn;
    }
  };

  const api = {
    child,
    frames,
    /** 最近一次 spawn 的命令行与选项（用于断言 --patch 等参数） */
    command: null,
    spawnOpts: null,
    /** 客户端发出的最后一帧 */
    lastFrame: () => frames[frames.length - 1],
    /** 找一个方法的帧 */
    findFrame: (method) => frames.find((f) => f.method === method),
    respond(id, result) {
      stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
    },
    respondError(id, code, message) {
      stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
    },
    notify(method, params) {
      stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
    rawLine(text) {
      stdout.write(text + '\n');
    },
    emitExit(code) {
      handlers.exit && handlers.exit(code, null);
    }
  };
  api.spawn = (cmd, opts) => {
    api.command = cmd;
    api.spawnOpts = opts;
    return child;
  };
  return api;
}

/** 起一个已握手的客户端 */
async function readyClient(opts) {
  const fake = makeFakeChild();
  const client = new SdkClient(
    Object.assign({ cwd: 'D:\\demo', spawnImpl: fake.spawn, timeoutMs: 500 }, opts)
  );
  const startPromise = client.start();
  await tick();
  const init = fake.findFrame('initialize');
  assert.ok(init, '应当发出 initialize');
  fake.respond(init.id, { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } });
  const info = await startPromise;
  return { client, fake, info };
}

(async () => {
  console.log('\n[1] 握手');

  await t('initialize 带上 cwd / provider / model', async () => {
    const fake = makeFakeChild();
    const client = new SdkClient({ cwd: 'D:\\proj', spawnImpl: fake.spawn, timeoutMs: 500 });
    const p = client.start();
    await tick();
    const init = fake.findFrame('initialize');
    assert.strictEqual(init.params.cwd, 'D:\\proj');
    assert.strictEqual(init.params.provider, 'deepseek-official');
    assert.strictEqual(init.params.model, 'deepseek-flash');
    assert.strictEqual(init.params.reasoningEffort, undefined, '未传就不该出现');
    fake.respond(init.id, { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } });
    await p;
    assert.strictEqual(client.initialized, true);
  });

  await t('可选的 reasoningEffort / maxTokens 会被带上', async () => {
    const fake = makeFakeChild();
    const client = new SdkClient({
      cwd: 'D:\\proj',
      reasoningEffort: 'high',
      maxTokens: 4096,
      spawnImpl: fake.spawn,
      timeoutMs: 500
    });
    const p = client.start();
    await tick();
    const init = fake.findFrame('initialize');
    assert.strictEqual(init.params.reasoningEffort, 'high');
    assert.strictEqual(init.params.maxTokens, 4096);
    fake.respond(init.id, { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } });
    await p;
  });

  await t('握手身份不符 -> 拒绝', async () => {
    const fake = makeFakeChild();
    const client = new SdkClient({ cwd: 'D:\\proj', spawnImpl: fake.spawn, timeoutMs: 500 });
    const p = client.start();
    await tick();
    fake.respond(fake.findFrame('initialize').id, { serverInfo: { name: 'something-else' } });
    await assert.rejects(p, /意外的身份/);
  });

  await t('没有 cwd 直接抛错', () => {
    assert.throws(() => new SdkClient({}), /需要 cwd/);
  });

  console.log('\n[2] 请求与响应');

  await t('prompt 用 contentBlocks 并返回 messageId', async () => {
    const { client, fake } = await readyClient();
    const p = client.prompt('s1', '你好');
    await tick();
    const frame = fake.findFrame('session/prompt');
    assert.strictEqual(frame.params.sessionId, 's1');
    assert.deepStrictEqual(frame.params.contentBlocks, [{ type: 'text', text: '你好' }]);
    fake.respond(frame.id, { messageId: 'm-1' });
    assert.deepStrictEqual(await p, { messageId: 'm-1' });
  });

  await t('未初始化时 prompt 拒绝', async () => {
    const fake = makeFakeChild();
    const client = new SdkClient({ cwd: 'D:\\p', spawnImpl: fake.spawn, timeoutMs: 300 });
    await assert.rejects(() => client.prompt('s1', 'x'), /尚未初始化/);
  });

  await t('错误响应保留 rpcCode 并 reject', async () => {
    const { client, fake } = await readyClient();
    const p = client.prompt('s1', 'x');
    await tick();
    fake.respondError(fake.findFrame('session/prompt').id, -32603, 'boom');
    await assert.rejects(p, (err) => {
      assert.strictEqual(err.rpcCode, -32603);
      assert.match(err.message, /boom/);
      return true;
    });
  });

  await t('并发请求按 id 正确配对（乱序响应也不串）', async () => {
    const { client, fake } = await readyClient();
    const a = client.prompt('s1', 'A');
    const b = client.prompt('s2', 'B');
    await tick();
    const frames = fake.frames.filter((f) => f.method === 'session/prompt');
    assert.strictEqual(frames.length, 2);
    fake.respond(frames[1].id, { messageId: 'second' }); // 先回第二条
    fake.respond(frames[0].id, { messageId: 'first' });
    assert.strictEqual((await a).messageId, 'first');
    assert.strictEqual((await b).messageId, 'second');
  });

  await t('超时会 reject', async () => {
    const { client } = await readyClient({ timeoutMs: 60 });
    await assert.rejects(() => client.prompt('s1', 'x', 60), /超时/);
  });

  console.log('\n[3] 通知分发');

  await t('session.event / session.status 分别派发', async () => {
    const { client, fake } = await readyClient();
    const got = [];
    client.on('event', (p) => got.push(['event', p]));
    client.on('status', (p) => got.push(['status', p]));
    client.on('notification', (n) => got.push(['other', n.method]));
    fake.notify('session.event', { type: 'assistant/message', seq: 1 });
    fake.notify('session.status', { sessionId: 's1', status: 'idle' });
    fake.notify('subagent.started', { id: 'x' });
    await tick();
    assert.deepStrictEqual(got, [
      ['event', { type: 'assistant/message', seq: 1 }],
      ['status', { sessionId: 's1', status: 'idle' }],
      ['other', 'subagent.started']
    ]);
  });

  await t('格式错误的行被忽略且不崩', async () => {
    const { client, fake } = await readyClient();
    const bad = [];
    client.on('malformed', (l) => bad.push(l));
    fake.rawLine('这不是 JSON');
    fake.rawLine('{"jsonrpc":"2.0","method":"session.status","params":{"status":"running"}}');
    await tick();
    assert.strictEqual(bad.length, 1);
  });

  await t('服务端反向请求 -> 回 -32601', async () => {
    const { client, fake } = await readyClient();
    const seen = [];
    client.on('serverRequest', (m) => seen.push(m.method));
    fake.rawLine(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'fs/read_text_file', params: {} }));
    await tick();
    assert.deepStrictEqual(seen, ['fs/read_text_file']);
    const reply = fake.frames.find((f) => f.id === 99);
    assert.strictEqual(reply.error.code, -32601);
  });

  await t('stderr 透传为诊断事件', async () => {
    const { client, fake } = await readyClient();
    const lines = [];
    client.on('stderr', (l) => lines.push(l));
    fake.child.stderr.write('诊断信息\n');
    await tick();
    assert.deepStrictEqual(lines, ['诊断信息']);
  });

  console.log('\n[4] 退出与关闭');

  await t('子进程退出 -> 挂起请求被拒 + exit 事件 + initialized 归零', async () => {
    const { client, fake } = await readyClient();
    const exits = [];
    client.on('exit', (e) => exits.push(e));
    const p = client.prompt('s1', 'x');
    await tick();
    fake.emitExit(1);
    await assert.rejects(p, /子进程退出/);
    assert.strictEqual(exits.length, 1);
    assert.strictEqual(client.initialized, false);
  });

  await t('shutdown 发帧并 kill 子进程', async () => {
    const { client, fake } = await readyClient();
    const p = client.shutdown();
    await tick();
    const frame = fake.findFrame('shutdown');
    assert.ok(frame, '应当发出 shutdown');
    fake.respond(frame.id, {});
    await p;
    assert.strictEqual(fake.child.killed, true);
  });

  console.log('\n[5] 启动命令行（--patch 叠层）');

  await t('buildSpawnCommand：基础形态', () => {
    const cmd = buildSpawnCommand({ launcher: 'D:\\a b\\dsh.cmd', profile: 'sdk' });
    assert.strictEqual(cmd, '"D:\\a b\\dsh.cmd" --profile sdk');
  });

  await t('buildSpawnCommand：--patch 可重复、路径加引号', () => {
    const cmd = buildSpawnCommand({
      launcher: 'D:\\a b\\dsh.cmd',
      profile: 'sdk',
      patchPaths: ['C:\\x y\\overlay.yml', 'C:\\z.yml']
    });
    assert.strictEqual(cmd, '"D:\\a b\\dsh.cmd" --profile sdk --patch "C:\\x y\\overlay.yml" --patch "C:\\z.yml"');
  });

  await t('buildSpawnCommand：空数组不产生 --patch', () => {
    assert.ok(!buildSpawnCommand({ launcher: 'd', profile: 'sdk', patchPaths: [] }).includes('--patch'));
  });

  await t('真正 spawn 出来的命令里带上 --patch（端到端）', async () => {
    const { fake } = await readyClient({ patchPaths: ['C:\\o.yml'] });
    assert.match(fake.command, /--profile sdk --patch "C:\\o\.yml"$/);
  });

  await t('没配 patchPaths 时命令里没有 --patch', async () => {
    const { fake } = await readyClient();
    assert.ok(!fake.command.includes('--patch'), fake.command);
  });

  await t('patchPaths 里的空值会被过滤', async () => {
    const { fake } = await readyClient({ patchPaths: [null, undefined, '', 'C:\\real.yml'] });
    assert.strictEqual((fake.command.match(/--patch/g) || []).length, 1);
  });

  console.log('\n[启动器探测]');

t('环境变量 DSH_LAUNCHER 优先', () => {
  const got = detectLauncher({ platform: 'linux', env: { DSH_LAUNCHER: '/x/dsh' }, exists: () => true });
  assert.strictEqual(got, '/x/dsh');
});

t('Windows 命中常见安装目录', () => {
  const got = detectLauncher({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:/Users/u/AppData/Local' },
    exists: (p) => p.indexOf('DeepSeek Harness') >= 0
  });
  assert.ok(got.indexOf('DeepSeek Harness') >= 0, got);
  assert.ok(got.slice(-4) === '.cmd', got);
});

t('都找不到时退化为 PATH 上的 dsh', () => {
  assert.strictEqual(detectLauncher({ platform: 'linux', env: {}, exists: () => false }), 'dsh');
});

t('macOS / Linux 也有候选（不会只有硬编码路径）', () => {
  assert.ok(candidateLaunchers({ platform: 'darwin', env: { HOME: '/Users/u' } }).length >= 2);
  assert.ok(candidateLaunchers({ platform: 'linux', env: { HOME: '/home/u' } }).length >= 2);
});

console.log(`\n结果: ${passed} 通过, ${failures.length} 失败`);
  if (failures.length) {
    console.log('失败项:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
})();
