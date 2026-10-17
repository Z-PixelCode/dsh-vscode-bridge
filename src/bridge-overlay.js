'use strict';
/**
 * 把 VS Code Bridge 挂进 DSH profile 的补丁生成器（纯逻辑，零依赖，可单测）。
 *
 * 为什么单独一个模块：这个片段有三处消费者，之前各写一份就出了错 ——
 *   1) 侧栏对话的 SDK 子进程（--patch 叠层）← 之前完全没有，导致"要么不写要么直写"
 *   2) copyConfig 命令给用户手工粘贴的片段
 *   3) 扩展自带的 dsh-bundle/cordis.patch.yml
 *
 * **关键语法（实测确认）**：补丁里裸写 `- id: X` 表示"覆盖已存在的 id"，
 * 目标 profile 里没有 X 时会直接报 `patch: entry "X" not found`。
 * 要新增一行必须包在 `- insert:` 里。之前 2) 和 3) 就是裸写，是错的。
 */

const ROW_ID = 'mcp-vscode-bridge';
const PLUGIN_NAME = '@deepseek-ai/dsh-mcp-client';

/**
 * YAML 标量：只有确实安全才裸写，否则单引号包裹。
 *
 * 这里踩过一次真坑：`@deepseek-ai/dsh-mcp-client` 曾被当成"安全"裸写，
 * 而 `@` 是 YAML 的保留指示符，不能作为裸标量开头 →
 * `YAMLException: bad indentation of a mapping entry` → dsh 启动直接 code=1。
 */
function scalar(value) {
  const s = String(value == null ? '' : value);
  // 裸标量不能以这些指示符开头
  const startsWithIndicator = /^[-?:,[\]{}#&*!|>'"%@`]/;
  // 不能包含「冒号+空格」「空格+井号」，也不能有换行/制表/首尾空白
  const hasUnsafeInside = /[:#]\s|[\n\r\t]/.test(s) || /^\s|\s$/.test(s);
  // 只允许保守的字符集
  const safeChars = /^[A-Za-z0-9._~/@+:-]*$/;
  // 看起来像数字/布尔/null 的也要引号，避免被解析成非字符串
  const looksTyped = /^(true|false|null|yes|no|on|off|~|[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?)$/i.test(s);
  if (s !== '' && safeChars.test(s) && !startsWithIndicator.test(s) && !hasUnsafeInside && !looksTyped) {
    return s;
  }
  return `'${s.replace(/'/g, "''")}'`;
}

/** 一条 bridge 记录（对象形式，便于测试断言） */
function bridgeRow({ url, token, serverName }) {
  return {
    id: ROW_ID,
    name: PLUGIN_NAME,
    config: {
      serverName: serverName || 'vscode',
      transport: 'streamable-http',
      url,
      headers: { Authorization: `Bearer ${token}` },
      failOnStartupError: false
    }
  };
}

/** 把一条记录渲染成 YAML 行（缩进由参数决定） */
function rowLines(row, indent) {
  const pad = ' '.repeat(indent);
  return [
    `${pad}- id: ${scalar(row.id)}`,
    `${pad}  name: ${scalar(row.name)}`,
    `${pad}  config:`,
    `${pad}    serverName: ${scalar(row.config.serverName)}`,
    `${pad}    transport: ${scalar(row.config.transport)}`,
    `${pad}    url: ${scalar(row.config.url)}`,
    `${pad}    headers:`,
    `${pad}      Authorization: ${scalar(row.config.headers.Authorization)}`,
    `${pad}    failOnStartupError: ${row.config.failOnStartupError}`
  ];
}

/**
 * 供用户手工粘贴到 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 的片段。
 * 顶层就是补丁列表，所以必须是 `- insert:` 形态。
 */
function insertSnippet({ url, token, serverName }) {
  const row = bridgeRow({ url, token, serverName });
  return [`- insert:`, ...rowLines(row, 4), ''].join('\n');
}

/**
 * 供 `dsh --profile sdk --patch <file>` 使用的完整补丁文件内容。
 */
function overlayPatchYaml({ url, token, serverName, comment }) {
  const head = comment
    ? comment
        .split('\n')
        .map((l) => `# ${l}`)
        .join('\n') + '\n'
    : '';
  return head + insertSnippet({ url, token, serverName });
}

/** 判断一段补丁文本里是否有"顶层裸 id"（错误形态：会被当成覆盖已有 id） */
function isBareIdPatch(text) {
  return /^-\s+id:\s/m.test(text);
}

module.exports = {
  ROW_ID,
  PLUGIN_NAME,
  scalar,
  bridgeRow,
  insertSnippet,
  overlayPatchYaml,
  isBareIdPatch
};
