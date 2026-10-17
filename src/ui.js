'use strict';
/**
 * 交互界面：
 *  1) 状态栏常驻项 —— 一眼看到桥在不在、端口是多少；点击弹菜单
 *  2) 调用日志 webview —— 实时显示每一次 MCP 工具调用，可逐条展开/复制完整内容
 *
 * 刻意做得很小：这个扩展是"管道"，界面只需要让人确认它在工作、并看到我调了什么。
 */
const vscode = require('vscode');

const MAX_ENTRIES = 300;
/** 单条参数/结果的字符上限；超出则截断并标注（面板里可展开查看） */
const MAX_TEXT = 20000;

function html() {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 8px 14px 24px; }
  h2 { font-size: 13px; margin: 4px 0 6px; font-weight: 600; }
  #meta { font-size: 12px; opacity: .8; margin-bottom: 8px; font-family: var(--vscode-editor-font-family); white-space: pre-wrap; }
  #bar { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
  #bar button {
    font-family: var(--vscode-font-family); font-size: 11px; padding: 2px 8px; cursor: pointer;
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.2));
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); border-radius: 3px;
  }
  #bar button:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.3)); }
  #list { list-style: none; margin: 0; padding: 0; }
  li { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); padding: 6px 0; }
  .row { display: flex; gap: 8px; align-items: baseline; font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .t { opacity: .55; }
  .tool { font-weight: 600; }
  .ok { color: var(--vscode-charts-green, #3fb950); }
  .err { color: var(--vscode-charts-red, #f85149); }
  .ms { opacity: .55; }
  .spacer { margin-left: auto; }
  .mini {
    font-size: 11px; padding: 0 6px; cursor: pointer; opacity: .75;
    background: transparent; color: inherit;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); border-radius: 3px;
  }
  .mini:hover { opacity: 1; }
  pre {
    font-family: var(--vscode-editor-font-family); font-size: 12px; margin: 3px 0 0;
    white-space: pre-wrap; word-break: break-all; opacity: .9;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; overflow: hidden;
  }
  pre.res { opacity: .7; }
  li.expanded pre { display: block; -webkit-line-clamp: unset; overflow: visible; }
  .trunc { font-size: 11px; opacity: .6; margin-top: 2px; }
  .empty { opacity: .55; padding: 8px 0; }
</style>
</head>
<body>
<h2>DSH Bridge 调用日志</h2>
<div id="meta">等待数据…</div>
<div id="bar">
  <button id="expandAll">全部展开</button>
  <button id="collapseAll">全部收起</button>
  <button id="clear">清空</button>
</div>
<ul id="list"></ul>
<script>
  const vscode = acquireVsCodeApi();
  const list = document.getElementById('list');
  const meta = document.getElementById('meta');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;';
    });
  }
  function render(e) {
    const li = document.createElement('li');
    const head = document.createElement('div');
    head.className = 'row';
    head.innerHTML =
      '<span class="t">' + esc(e.time) + '</span>' +
      '<span class="tool">' + esc(e.tool) + '</span>' +
      '<span class="' + (e.ok ? 'ok' : 'err') + '">' + (e.ok ? '✓' : '✗') + '</span>' +
      '<span class="ms">' + e.ms + ' ms</span>' +
      '<span class="spacer"></span>';
    const toggle = document.createElement('button');
    toggle.className = 'mini';
    toggle.textContent = '展开';
    const copy = document.createElement('button');
    copy.className = 'mini';
    copy.textContent = '复制';
    head.appendChild(toggle);
    head.appendChild(copy);
    li.appendChild(head);

    const args = document.createElement('pre');
    args.textContent = '参数: ' + e.args;
    const res = document.createElement('pre');
    res.className = 'res';
    res.textContent = '结果: ' + e.result;
    li.appendChild(args);
    li.appendChild(res);

    if (e.truncated) {
      const t = document.createElement('div');
      t.className = 'trunc';
      t.textContent = '（内容超过 ' + e.truncated + ' 字符，已截断）';
      li.appendChild(t);
    }

    toggle.addEventListener('click', function () {
      li.classList.toggle('expanded');
      toggle.textContent = li.classList.contains('expanded') ? '收起' : '展开';
    });
    copy.addEventListener('click', function () {
      vscode.postMessage({ type: 'copy', text: '工具: ' + e.tool + '\\n参数: ' + e.args + '\\n结果: ' + e.result });
      copy.textContent = '已复制';
      setTimeout(function () { copy.textContent = '复制'; }, 1200);
    });
    return li;
  }

  function setAll(expanded) {
    Array.prototype.forEach.call(list.children, function (li) {
      li.classList.toggle('expanded', expanded);
      const btn = li.querySelector('.mini');
      if (btn) btn.textContent = expanded ? '收起' : '展开';
    });
  }

  document.getElementById('expandAll').addEventListener('click', function () { setAll(true); });
  document.getElementById('collapseAll').addEventListener('click', function () { setAll(false); });
  document.getElementById('clear').addEventListener('click', function () { vscode.postMessage({ type: 'clear' }); });

  window.addEventListener('message', function (ev) {
    const m = ev.data || {};
    if (m.type === 'meta') { meta.textContent = m.text; }
    if (m.type === 'reset') { list.innerHTML = ''; }
    if (m.type === 'call') { list.insertBefore(render(m.entry), list.firstChild); }
    if (m.type === 'snapshot') {
      list.innerHTML = '';
      (m.entries || []).slice().reverse().forEach(function (e) { list.appendChild(render(e)); });
    }
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

/**
 * @param {object} deps
 * @param {() => ({url: string, token: string, port: number} | null)} deps.getInfo
 */
function createBridgeUi(deps) {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'dsh-bridge.menu';
  status.name = 'DSH Bridge';

  /** @type {import('vscode').WebviewPanel | null} */
  let panel = null;
  /** 新条目在前 */
  const entries = [];
  let callCount = 0;

  function metaText() {
    const info = deps.getInfo();
    if (!info) return '服务端未运行。';
    const toolCount = typeof deps.getToolCount === 'function' ? deps.getToolCount() : '?';
    return 'MCP 端点: ' + info.url + '\n工具数: ' + toolCount + '    已服务调用: ' + callCount + (entries.length < callCount ? '（面板保留最近 ' + MAX_ENTRIES + ' 条）' : '');
  }

  function stateText() {
    const info = deps.getInfo();
    if (info) {
      status.text = '$(plug) DSH:' + info.port + (callCount ? ' · ' + callCount : '');
      const md = new vscode.MarkdownString();
      md.appendMarkdown('**DSH Bridge 运行中**\n\n');
      md.appendMarkdown('- MCP: `' + info.url + '`\n');
      md.appendMarkdown('- 令牌长度: ' + info.token.length + '\n');
      md.appendMarkdown('- 已服务调用: ' + callCount + '\n\n');
      md.appendMarkdown('点击查看菜单');
      status.tooltip = md;
      status.backgroundColor = undefined;
    } else {
      status.text = '$(debug-disconnect) DSH:已停止';
      status.tooltip = 'DSH Bridge 未运行，点击可启动';
      status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    status.show();
    pushMeta();
  }

  function pushMeta() {
    if (panel) panel.webview.postMessage({ type: 'meta', text: metaText() });
  }

  function ensurePanel() {
    if (panel) return panel;
    panel = vscode.window.createWebviewPanel(
      'dshBridgeLog',
      'DSH Bridge 调用日志',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.webview.html = html();
    panel.onDidDispose(() => { panel = null; });
    panel.webview.onDidReceiveMessage((m) => {
      if (!m) return;
      if (m.type === 'ready') {
        panel.webview.postMessage({ type: 'meta', text: metaText() });
        panel.webview.postMessage({ type: 'snapshot', entries });
      }
      if (m.type === 'clear') {
        entries.length = 0;
        panel.webview.postMessage({ type: 'reset' });
        pushMeta();
      }
      if (m.type === 'copy' && typeof m.text === 'string') {
        vscode.env.clipboard.writeText(m.text);
      }
    });
    return panel;
  }

  return {
    status,
    show() {
      ensurePanel().reveal(undefined, true);
    },
    reset() {
      entries.length = 0;
      callCount = 0;
      if (panel) panel.webview.postMessage({ type: 'reset' });
      stateText();
    },
    /** 记录一次工具调用 */
    logCall(evt) {
      const argsText = JSON.stringify(evt.args || {}, null, 2);
      const resultText = evt.text || '';
      const truncated = argsText.length > MAX_TEXT || resultText.length > MAX_TEXT ? MAX_TEXT : 0;
      const entry = {
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        tool: evt.tool,
        ok: !!evt.ok,
        ms: evt.ms,
        args: argsText.slice(0, MAX_TEXT),
        result: resultText.slice(0, MAX_TEXT),
        truncated
      };
      entries.unshift(entry);
      if (entries.length > MAX_ENTRIES) entries.pop();
      callCount += 1;
      if (panel) panel.webview.postMessage({ type: 'call', entry });
      const info = deps.getInfo();
      if (info) status.text = '$(plug) DSH:' + info.port + ' · ' + callCount;
      pushMeta();
    },
    refresh() {
      stateText();
    },
    dispose() {
      status.dispose();
      if (panel) panel.dispose();
    }
  };
}

module.exports = { createBridgeUi };
