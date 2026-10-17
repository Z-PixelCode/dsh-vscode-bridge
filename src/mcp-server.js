'use strict';
/**
 * 最小可用的 MCP over HTTP（Streamable HTTP 传输的子集）
 *
 * 只实现 demo 需要的方法：initialize / notifications/* / ping / tools/list / tools/call。
 * 刻意零依赖：不装 @modelcontextprotocol/sdk 也能跑，方便离线验证。
 *
 * 传输细节：
 *  - 只接受 POST /mcp，返回 application/json（协议允许单条 JSON 响应，不强制 SSE）
 *  - GET /mcp 返回 405（本 demo 不做服务端主动推送的 SSE 流）
 *  - DELETE /mcp 返回 200（无会话状态可删）
 *  - 通知类消息（没有 id）返回 202 且无内容
 */
const http = require('node:http');

const DEFAULT_PROTOCOL = '2025-06-18';
const MAX_BODY = 4 * 1024 * 1024;

function rpcError(code, message) {
  const e = new Error(message);
  e.rpcCode = code;
  return e;
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

/**
 * @param {object} opts
 * @param {string} opts.name           serverInfo.name
 * @param {string} opts.version        serverInfo.version
 * @param {Array}  opts.tools          tools/list 返回的工具定义
 * @param {(name: string, args: object) => Promise<any>} opts.callTool
 * @param {string} [opts.token]        Bearer 令牌；为空则不鉴权
 * @param {(msg: string) => void} [opts.onLog]
 * @param {(evt: {tool: string, args: object, ok: boolean, ms: number, text: string}) => void} [opts.onCall]
 */
function createMcpHttpServer(opts) {
  const { name, version, tools, callTool, token } = opts;
  const log = opts.onLog || (() => {});
  const onCall = opts.onCall || (() => {});
  const toolList = Array.isArray(tools) ? tools : [];

  /** UI/日志钩子绝不能影响工具调用本身 */
  function emitCall(evt) {
    try {
      onCall(evt);
    } catch {
      /* 忽略观察者异常 */
    }
  }

  async function handleMessage(msg) {
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    switch (method) {
      case 'initialize': {
        const requested = params && params.protocolVersion;
        return {
          protocolVersion: typeof requested === 'string' && requested ? requested : DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version }
        };
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return undefined; // 通知：不回包
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: toolList };
      case 'tools/call': {
        const toolName = params && params.name;
        const args = (params && params.arguments) || {};
        if (typeof toolName !== 'string' || !toolName) {
          throw rpcError(-32602, 'tools/call 缺少 name');
        }
        const startedAt = Date.now();
        try {
          const out = await callTool(toolName, args);
          const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
          emitCall({ tool: toolName, args, ok: true, ms: Date.now() - startedAt, text });
          return { content: [{ type: 'text', text }], isError: false };
        } catch (err) {
          const text = '错误: ' + (err && err.message ? err.message : String(err));
          log(`tools/call ${toolName} 失败: ${text}`);
          emitCall({ tool: toolName, args, ok: false, ms: Date.now() - startedAt, text });
          return { content: [{ type: 'text', text }], isError: true };
        }
      }
      default:
        if (isNotification) {
          log(`忽略未知通知: ${method}`);
          return undefined;
        }
        throw rpcError(-32601, `Method not found: ${method}`);
    }
  }

  const server = http.createServer(async (req, res) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (pathname !== '/mcp') {
      res.writeHead(404).end('not found');
      return;
    }
    if (token) {
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${token}`) {
        res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end('unauthorized');
        return;
      }
    }
    if (req.method === 'GET') {
      res.writeHead(405, { Allow: 'POST, DELETE' }).end('本 demo 不提供 SSE 流');
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(200).end('ok');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST, DELETE' }).end();
      return;
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      res.writeHead(413).end(err.message);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }

    const batch = Array.isArray(parsed);
    const messages = batch ? parsed : [parsed];
    const replies = [];
    for (const m of messages) {
      if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
        replies.push({
          jsonrpc: '2.0',
          id: m && m.id !== undefined ? m.id : null,
          error: { code: -32600, message: 'Invalid Request' }
        });
        continue;
      }
      try {
        const result = await handleMessage(m);
        if (result !== undefined) {
          replies.push({ jsonrpc: '2.0', id: m.id, result });
        }
      } catch (err) {
        replies.push({
          jsonrpc: '2.0',
          id: m.id !== undefined ? m.id : null,
          error: { code: err.rpcCode || -32603, message: err.message || String(err) }
        });
      }
    }

    if (replies.length === 0) {
      res.writeHead(202).end();
      return;
    }
    sendJson(res, 200, batch ? replies : replies[0]);
  });

  server.mcp = { handleMessage, tools: toolList };
  return server;
}

module.exports = { createMcpHttpServer, DEFAULT_PROTOCOL };
