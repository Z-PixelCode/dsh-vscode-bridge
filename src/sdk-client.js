'use strict';
/**
 * DSH SDK stdio 客户端。
 *
 * 协议（已实测确认）：
 *   分帧：每条消息一行 JSON-RPC 2.0（`\n` 结尾）；stdout 只承载帧，诊断走 stderr
 *   client→server： initialize / session/prompt / shutdown
 *   server→client： session.event / session.status / subagent.started / subagent.finished
 *
 *   实测字段名（文档没写，是从服务端实现里读出来的）：
 *     initialize     { cwd, provider, model, reasoningEffort?, maxTokens? } → { serverInfo }
 *     session/prompt { sessionId, contentBlocks: [{type:'text', text}] }    → { messageId }
 *
 * 设计：spawn 可注入（`spawnImpl`），因此协议层可以在没有真实子进程的情况下被单测。
 */
const { EventEmitter } = require('node:events');
const readline = require('node:readline');
const { spawn: nodeSpawn } = require('node:child_process');

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

/**
 * dsh 启动器的候选位置（按平台）。
 *
 * 以前这里硬编码了作者机器上的绝对路径 —— 别人装上根本起不来。
 * 顺序：环境变量 DSH_LAUNCHER -> 常见安装目录 -> PATH 上的 dsh。
 */
function candidateLaunchers(opts) {
  const env = (opts && opts.env) || process.env;
  const platform = (opts && opts.platform) || process.platform;
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const list = [];
  if (env.DSH_LAUNCHER) list.push(env.DSH_LAUNCHER);
  const rel = 'resources/runtime/cli/bin/dsh';
  if (platform === 'win32') {
    const roots = [
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs/DeepSeek Harness'),
      env.ProgramFiles && path.join(env.ProgramFiles, 'DeepSeek Harness'),
      env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'DeepSeek Harness'),
      'C:/DeepSeek Harness',
      'D:/DeepSeek Harness'
    ].filter(Boolean);
    for (const r of roots) list.push(path.join(r, rel + '.cmd').replace(/\\/g, '/'));
  } else if (platform === 'darwin') {
    list.push('/Applications/DeepSeek Harness.app/Contents/' + rel);
    list.push(path.join(home, 'Applications/DeepSeek Harness.app/Contents/' + rel));
    list.push('/usr/local/bin/dsh');
  } else {
    list.push('/opt/DeepSeek Harness/' + rel);
    list.push(path.join(home, '.local/bin/dsh'));
    list.push('/usr/local/bin/dsh');
  }
  return list;
}

/** 找一个真实存在的启动器；都没有就返回 'dsh'（交给 PATH/shell 解析） */
function detectLauncher(opts) {
  const exists = (opts && opts.exists) || ((p) => {
    try {
      return fs.existsSync(p);
    } catch (err) {
      return false;
    }
  });
  for (const c of candidateLaunchers(opts)) {
    if (exists(c)) return c;
  }
  return 'dsh';
}

const DEFAULT_LAUNCHER = detectLauncher();
const PROTOCOL_NAME = 'deepseek-harness-sdk-runtime';
const DEFAULT_TIMEOUT = 30_000;

/**
 * 拼出 dsh 的启动命令行（纯函数，便于测试）。
 * `--patch` 可重复，用于在 profile 之上再叠一层补丁（例如把 VS Code 桥挂进 sdk profile）。
 */
function buildSpawnCommand({ launcher, profile, patchPaths }) {
  const parts = [`"${launcher}"`, '--profile', profile];
  for (const p of patchPaths || []) parts.push('--patch', `"${p}"`);
  return parts.join(' ');
}

class SdkError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SdkError';
    this.rpcCode = code;
  }
}

class SdkClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.cwd              会话根 = 该 VS Code 窗口的工作区文件夹
   * @param {string} [opts.launcher]       dsh 启动器路径
   * @param {string} [opts.profile]        默认 'sdk'
   * @param {string} [opts.provider]       默认 'deepseek-official'
   * @param {string} [opts.model]          默认 'deepseek-flash'
   * @param {string} [opts.reasoningEffort]
   * @param {number} [opts.maxTokens]
   * @param {number} [opts.timeoutMs]      单请求超时
   * @param {string[]} [opts.patchPaths]   额外的 --patch 叠层（例如把 VS Code 桥挂进 sdk profile）
   * @param {Function} [opts.spawnImpl]    注入 spawn（测试用）
   */
  constructor(opts) {
    super();
    this.opts = opts || {};
    if (!this.opts.cwd) throw new Error('SdkClient 需要 cwd（会话根）');
    this.cwd = this.opts.cwd;
    // 设置里没填就用探测结果（探测不到退化为 'dsh'，走 PATH）
    this.launcher = this.opts.launcher || DEFAULT_LAUNCHER;
    this.profile = this.opts.profile || 'sdk';
    this.provider = this.opts.provider || 'deepseek-official';
    this.model = this.opts.model || 'deepseek-flash';
    this.reasoningEffort = this.opts.reasoningEffort;
    this.maxTokens = this.opts.maxTokens;
    this.timeoutMs = this.opts.timeoutMs || DEFAULT_TIMEOUT;
    this.patchPaths = Array.isArray(this.opts.patchPaths) ? this.opts.patchPaths.filter(Boolean) : [];
    this._spawn = this.opts.spawnImpl || nodeSpawn;

    this.child = null;
    this.serverInfo = null;
    this._initialized = false;
    this._nextId = 1;
    /** id -> {resolve, reject, timer} */
    this._pending = new Map();
    this._closing = false;
  }

  get initialized() {
    return this._initialized;
  }

  // ---------- 生命周期 ----------

  async start() {
    if (this.child) throw new Error('SdkClient 已经启动');
    // shell:true 是为了让 .cmd 能跑起来；路径含空格所以整体加引号
    const spawnOpts = {
      cwd: this.cwd,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsVerbatimArguments: true
    };
    // 附加环境变量：例如 DSH_PERMISSION_MODE=read-only 让这个子进程默认只读
    if (this.opts.env && Object.keys(this.opts.env).length) {
      spawnOpts.env = Object.assign({}, process.env, this.opts.env);
    }
    this.command = buildSpawnCommand({
      launcher: this.launcher,
      profile: this.profile,
      patchPaths: this.patchPaths
    });
    this.emit('spawn', { command: this.command });
    this.child = this._spawn(this.command, spawnOpts);

    const out = readline.createInterface({ input: this.child.stdout });
    out.on('line', (line) => this._onLine(line));
    this._outRl = out;

    if (this.child.stderr) {
      const err = readline.createInterface({ input: this.child.stderr });
      err.on('line', (line) => {
        if (line.trim()) this.emit('stderr', line);
      });
      this._errRl = err;
    }

    this.child.on('exit', (code, signal) => this._onExit(code, signal));
    this.child.on('error', (err) => this.emit('error', err));

    const params = { cwd: this.cwd, provider: this.provider, model: this.model };
    if (this.reasoningEffort !== undefined) params.reasoningEffort = this.reasoningEffort;
    if (this.maxTokens !== undefined) params.maxTokens = this.maxTokens;

    const result = await this.request('initialize', params, this.timeoutMs);
    this.serverInfo = (result && result.serverInfo) || null;
    if (!this.serverInfo || this.serverInfo.name !== PROTOCOL_NAME) {
      throw new SdkError(`握手返回了意外的身份: ${JSON.stringify(this.serverInfo)}`);
    }
    this._initialized = true;
    this.emit('ready', this.serverInfo);
    return this.serverInfo;
  }

  /** 发一条用户消息；返回持久入队回执 { messageId } */
  async prompt(sessionId, text, timeoutMs) {
    if (!this._initialized) throw new SdkError('SDK 尚未初始化');
    if (!sessionId) throw new Error('prompt 需要 sessionId');
    return this.request(
      'session/prompt',
      { sessionId, contentBlocks: [{ type: 'text', text: String(text) }] },
      timeoutMs === undefined ? this.timeoutMs : timeoutMs
    );
  }

  async shutdown() {
    if (!this.child) return;
    this._closing = true;
    try {
      await this.request('shutdown', undefined, 10_000);
    } catch {
      /* 关不掉也要收尾 */
    }
    this.dispose();
  }

  dispose() {
    this._rejectAll(new SdkError('客户端已关闭'));
    try {
      this._outRl && this._outRl.close();
      this._errRl && this._errRl.close();
    } catch {
      /* ignore */
    }
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        /* ignore */
      }
      this.child = null;
    }
    this._initialized = false;
  }

  // ---------- 协议 ----------

  /** 发一个 JSON-RPC 请求并等响应 */
  request(method, params, timeoutMs) {
    if (!this.child || !this.child.stdin) {
      return Promise.reject(new SdkError('子进程不可用'));
    }
    const id = this._nextId++;
    const frame = { jsonrpc: '2.0', id, method };
    if (params !== undefined) frame.params = params;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new SdkError(`请求超时: ${method}（${timeoutMs}ms）`));
      }, timeoutMs || this.timeoutMs);
      this._pending.set(id, { resolve, reject, timer, method });
      this.emit('send', { method, id });
      this.child.stdin.write(JSON.stringify(frame) + '\n');
    });
  }

  _settle(id, err, result) {
    const entry = this._pending.get(id);
    if (!entry) return;
    this._pending.delete(id);
    clearTimeout(entry.timer);
    if (err) entry.reject(err);
    else entry.resolve(result);
  }

  _rejectAll(err) {
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this._pending.clear();
  }

  _onLine(line) {
    const text = String(line).trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      this.emit('malformed', text); // 协议要求：格式错误的行忽略
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    const hasId = msg.id !== undefined && msg.id !== null;
    const hasMethod = typeof msg.method === 'string';

    if (hasId && !hasMethod) {
      if (msg.error) {
        this._settle(msg.id, new SdkError(msg.error.message || '未知错误', msg.error.code));
      } else {
        this._settle(msg.id, null, msg.result);
      }
      return;
    }
    if (hasMethod && !hasId) {
      this._onNotification(msg.method, msg.params);
      return;
    }
    if (hasMethod && hasId) {
      // 服务端反向请求：本客户端不支持，按协议回 -32601
      this.emit('serverRequest', msg);
      try {
        this.child.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }) + '\n'
        );
      } catch {
        /* ignore */
      }
      return;
    }
    this.emit('malformed', text);
  }

  _onNotification(method, params) {
    if (method === 'session.event') {
      this.emit('event', params);
      return;
    }
    if (method === 'session.status') {
      this.emit('status', params);
      return;
    }
    this.emit('notification', { method, params });
  }

  _onExit(code, signal) {
    this._rejectAll(new SdkError(`SDK 子进程退出（code=${code} signal=${signal}）`));
    this._initialized = false;
    this.child = null;
    this.emit('exit', { code, signal });
  }
}

module.exports = { SdkClient, SdkError, DEFAULT_LAUNCHER, PROTOCOL_NAME, DEFAULT_TIMEOUT, buildSpawnCommand, detectLauncher, candidateLaunchers };
