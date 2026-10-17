'use strict';
/**
 * 侧栏对话界面（原生 webview 视图，不嵌网页）。
 *
 * 数据来自 SdkClient 的 session.event / session.status —— 用的是 DSH 的持久事件词汇。
 * 每个 VS Code 窗口各自持有：一个 SdkClient 子进程 + 多个会话（会话列表持久化在 workspaceState）。
 *
 * 安全：助手/用户文本一律经 chat-model 的 miniMarkdown 渲染成**已转义**的 HTML，
 * 本文件只把结果塞进 innerHTML，webview 里不做任何 Markdown 解析。
 */
const vscode = require('vscode');
const { SdkClient } = require('./sdk-client');
const {
  mapSessionEvent,
  usageLine,
  miniMarkdown,
  normalizeState,
  addSession,
  switchSession,
  removeSession,
  activeSession,
  appendEntry,
  patchEntry,
  resolveUserEcho,
  dshSessionIdFor,
  forStorage,
  MODEL_CATALOG,
  REASONING_EFFORTS,
  PERMISSION_MODES,
  isDirectWriteMode,
  replayPlan,
  summarizeToolResult,
  summarizeToolArgs,
  toolHidden,
  describeToolCall,
  mergeChanges,
  changesForTurn,
  changeTotals,
  emptyStats,
  reduceStats,
  statsLines
} = require('./chat-model');

const VIEW_ID = 'dshBridge.chat';
const STATE_KEY = 'dshBridge.chatState';

function nonce() {
  let s = '';
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 24; i += 1) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function html(cspSource, nonceValue) {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonceValue}';">
<style>
  :root {
    --dsh-radius: 8px;
    --dsh-gap: 10px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column;
    font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, transparent);
  }

  /* ---------- 顶栏 ---------- */
  header {
    padding: 8px 10px 6px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.22));
    background: var(--vscode-sideBarSectionHeader-background, transparent);
    display: flex; flex-direction: column; gap: 6px;
  }
  .row { display: flex; gap: 6px; align-items: center; }
  select#sessions {
    flex: 1; min-width: 0; font-size: 12px; padding: 3px 6px; border-radius: 6px;
    color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
    background: var(--vscode-dropdown-background, transparent);
    border: 1px solid var(--vscode-dropdown-border, rgba(128,128,128,.3));
  }
  .iconbtn {
    flex: none; cursor: pointer; font-size: 12px; line-height: 1; padding: 4px 7px;
    border-radius: 6px; color: var(--vscode-icon-foreground, var(--vscode-foreground));
    background: transparent; border: 1px solid transparent;
  }
  .iconbtn:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.18));
    border-color: var(--vscode-panel-border, rgba(128,128,128,.25));
  }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .chip {
    font-size: 10px; padding: 1px 7px; border-radius: 999px; white-space: nowrap;
    background: var(--vscode-badge-background, rgba(128,128,128,.2));
    color: var(--vscode-badge-foreground, var(--vscode-foreground));
    max-width: 100%; overflow: hidden; text-overflow: ellipsis;
  }
  .chip.plain { background: transparent; opacity: .7; padding-left: 0; }
.chip.hidden { display: none; }
  .chip.running { background: var(--vscode-charts-blue, #4daafc); color: #fff; }
  .chip.running::before {
    content: ''; display: inline-block; width: 5px; height: 5px; margin-right: 4px;
    border-radius: 50%; background: #fff; animation: pulse 1s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .25 } }

  /* ---------- 消息区 ---------- */
  #list { flex: 1; overflow-y: auto; padding: 12px 10px 4px; scroll-behavior: smooth; }
  #list::-webkit-scrollbar { width: 8px; }
  #list::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,.4)); border-radius: 4px;
  }
  .msg { display: flex; gap: 8px; margin-bottom: 16px; align-items: flex-start; }
  .msg.user { flex-direction: row-reverse; }
  .avatar {
    flex: none; width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center;
    font-size: 10px; font-weight: 700; letter-spacing: .02em;
    background: var(--vscode-badge-background, rgba(128,128,128,.25));
  }
  .msg.user .avatar { background: var(--vscode-charts-blue, #4daafc); color: #fff; }
  .msg.assistant .avatar { background: var(--vscode-charts-purple, #b180d7); color: #fff; }
  .content { display: flex; flex-direction: column; min-width: 0; max-width: 86%; }
  .msg.user .content { align-items: flex-end; }
  .msg.assistant .content { max-width: 100%; }
  /* 用户消息：右侧气泡 */
  .bubble {
    padding: 7px 12px; max-width: 100%;
    background: var(--vscode-input-background, #2d2d2d);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35));
    border-radius: 10px;
  }
  /* 消息时间戳 */
  .msg-time {
    font-size: 10px; opacity: .45; margin-bottom: 3px;
    white-space: nowrap;
  }
  .msg.user .msg-time { text-align: right; }
  .body { line-height: 1.55; word-break: break-word; }
  .body p { margin: 0 0 6px; }
  .body p:last-child { margin-bottom: 0; }
  .body .gap { height: 6px; }
  .body h3, .body h4, .body h5, .body h6 { margin: 10px 0 4px; font-size: 12px; }
  .body ul, .body ol { margin: 4px 0 6px; padding-left: 20px; }
  .body li { margin: 1px 0; }
  .body a { color: var(--vscode-textLink-foreground, #3794ff); }
  code.inline {
    font-family: var(--vscode-editor-font-family); font-size: 11px; padding: 1px 4px;
    border-radius: 4px; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.16));
  }
  pre.code {
    margin: 6px 0; padding: 8px 10px; overflow-x: auto; border-radius: 6px;
    font-family: var(--vscode-editor-font-family); font-size: 11px; line-height: 1.45;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.16));
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2));
    white-space: pre;
  }
  pre.code code { font-family: inherit; }
  
  /* ---------- 代码块增强 ---------- */
  .code-block {
    margin: 6px 0; border-radius: 6px; overflow: hidden;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2));
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.16));
  }
  .code-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 4px 10px; font-size: 10px;
    background: rgba(128,128,128,.08); border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.15));
  }
  .lang-label { opacity: .6; font-family: var(--vscode-editor-font-family); }
  .copy-btn {
    cursor: pointer; font-size: 10px; padding: 2px 8px; border-radius: 4px;
    color: var(--vscode-foreground); background: transparent;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3));
  }
  .copy-btn:hover { background: rgba(128,128,128,.15); }
  .code-block pre.code {
    margin: 0; border: none; border-radius: 0;
  }
  /* 语法高亮颜色 */
  .kw { color: var(--vscode-charts-purple, #b180d7); font-weight: 600; }
  .str { color: var(--vscode-charts-green, #3fb950); }
  .num { color: var(--vscode-charts-orange, #e5a04c); }
  .cmt { color: var(--vscode-descriptionForeground, #888); font-style: italic; }
  .ln {
    display: inline-block; width: 30px; text-align: right; margin-right: 10px;
    opacity: .4; user-select: none;
  }

  /* ---------- 斜杠命令 ---------- */
  #cmd-picker {
    position: absolute; bottom: 100%; left: 10px; right: 10px; max-height: 200px;
    overflow-y: auto; background: var(--vscode-dropdown-background, #252526);
    border: 1px solid var(--vscode-dropdown-border, rgba(128,128,128,.4));
    border-radius: 6px; box-shadow: 0 -2px 8px rgba(0,0,0,.3); display: none; z-index: 100;
  }
  #cmd-picker.show { display: block; }
  .cmd-item {
    padding: 6px 10px; cursor: pointer; font-size: 12px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.15));
  }
  .cmd-item:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.1)); }
  .cmd-item:last-child { border-bottom: none; }
  .cmd-name { font-weight: 600; color: var(--vscode-charts-blue, #4daafc); }
  .cmd-desc { opacity: .7; margin-left: 8px; font-size: 11px; }

  /* ---------- 思考中动画 ---------- */
  .thinking {
    display: flex; gap: 4px; align-items: center; padding: 8px 0;
    font-size: 11px; opacity: .6; font-style: italic;
  }
  .thinking::before {
    content: ''; width: 6px; height: 6px; border-radius: 50%;
    background: var(--vscode-charts-purple, #b180d7);
    animation: think-pulse 1.4s ease-in-out infinite;
  }
  @keyframes think-pulse {
    0%, 100% { opacity: .3; transform: scale(.8); }
    50% { opacity: 1; transform: scale(1.2); }
  }

  /* ---------- 思考 / 工具 ---------- */
  details.think, details.tool {
    margin: 6px 0; border-radius: 6px; overflow: hidden;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.22));
    background: var(--vscode-textBlockQuote-background, rgba(128,128,128,.07));
  }
  details summary {
    cursor: pointer; list-style: none; padding: 5px 8px; font-size: 11px;
    display: flex; gap: 6px; align-items: center;
  }
  details summary::-webkit-details-marker { display: none; }
  details summary::before { content: '▸'; opacity: .5; font-size: 9px; }
  details[open] summary::before { content: '▾'; }
  details .inner { padding: 2px 10px 8px; }
  details pre {
    margin: 4px 0 0; padding: 6px 8px; border-radius: 4px; font-size: 11px;
    font-family: var(--vscode-editor-font-family); white-space: pre-wrap; word-break: break-all;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.14));
  }
  .think summary { color: var(--vscode-descriptionForeground, var(--vscode-foreground)); opacity: .85; }
  .tool .tname { font-weight: 600; color: var(--vscode-charts-purple, #b180d7); }
  .tool .tstat.ok { color: var(--vscode-charts-green, #3fb950); }
  .tool .tstat.err { color: var(--vscode-charts-red, #f85149); }
  .tool .tstat { margin-left: auto; }
  .tool .tsum { opacity: .6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 45%; }

  .sys { font-size: 11px; opacity: .6; font-style: italic; padding: 2px 0 10px; text-align: center; }

  #empty { text-align: center; opacity: .6; padding: 28px 16px; line-height: 1.7; }
  #empty .big { font-size: 20px; margin-bottom: 8px; opacity: .8; }
  #empty code { font-family: var(--vscode-editor-font-family); }

  /* ---------- 输入区 ---------- */
  footer {
    position: relative; padding: 8px 10px 10px;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.22));
  }
  #input {
    width: 100%; resize: none; overflow-y: auto;
    min-height: 30px; max-height: 200px; padding: 6px 9px;
    font-family: var(--vscode-font-family); font-size: 12px; line-height: 1.45;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,.3)); border-radius: var(--dsh-radius);
  }
  #input:focus { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px; }
  .actions { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
  /* 设置按钮（点击展开/收回） */
  .ctrl-btn {
    position: relative; font-size: 11px; padding: 3px 10px; border-radius: 12px; cursor: pointer;
    color: var(--vscode-foreground); background: var(--vscode-badge-background, rgba(128,128,128,.15));
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); white-space: nowrap;
  }
  .ctrl-btn:hover { background: var(--vscode-badge-background, rgba(128,128,128,.3)); }
  .ctrl-btn .label { opacity: .5; margin-right: 3px; }
  .ctrl-btn.active { background: var(--vscode-charts-blue, #4daafc); color: #fff; border-color: var(--vscode-charts-blue, #4daafc); }
  /* 下拉选项 */
  .ctrl-dropdown {
    position: absolute; bottom: 100%; left: 0; margin-bottom: 4px;
    min-width: 120px; background: var(--vscode-dropdown-background, #252526);
    border: 1px solid var(--vscode-dropdown-border, rgba(128,128,128,.4));
    border-radius: 6px; box-shadow: 0 -2px 8px rgba(0,0,0,.3); display: none; z-index: 100;
  }
  .ctrl-dropdown.show { display: block; }
  .stats {
    display: flex; gap: 10px; flex-wrap: wrap; margin-top: 5px;
    font-size: 10px; opacity: .65;
  }
  .stats span:empty { display: none; }
  .stats #st-context { margin-left: auto; }
  /* 「正在做什么」活动行（对齐桌面 app） */
  .activity {
    display: none; align-items: center; gap: 6px; margin-bottom: 6px;
    font-size: 11px; padding: 4px 8px; border-radius: 6px; opacity: .85;
    background: var(--vscode-textBlockQuote-background, rgba(128,128,128,.10));
    border-left: 2px solid var(--vscode-charts-blue, #4daafc);
  }
  .activity.show { display: flex; }
  .activity .spin { animation: pulse 1.1s ease-in-out infinite; opacity: .7; }
  .activity #activity-time { margin-left: auto; opacity: .6; }

  /* Markdown 表格 */
  .table-wrap { overflow-x: auto; margin: 6px 0; }
  table.md-table { border-collapse: collapse; font-size: 11.5px; width: 100%; }
  table.md-table th, table.md-table td {
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3));
    padding: 3px 7px; text-align: left; vertical-align: top;
  }
  table.md-table th {
    background: var(--vscode-textBlockQuote-background, rgba(128,128,128,.12));
    font-weight: 600;
  }
  table.md-table tbody tr:nth-child(even) { background: rgba(128,128,128,.05); }
  table.md-table code.inline { white-space: nowrap; }

  /* 「待审 N 个文件」条：按钮放在对话面板里，不依赖视图标题栏的 … 菜单 */
  .reviewbar {
    display: none; flex-direction: column; gap: 4px; margin-bottom: 6px;
    padding: 5px 8px; border-radius: 6px; font-size: 11px;
    background: var(--vscode-inputValidation-infoBackground, rgba(77,170,252,.12));
    border-left: 2px solid var(--vscode-charts-blue, #4daafc);
  }
  .reviewbar.show { display: flex; }
  .reviewbar .rbhead { display: flex; align-items: center; gap: 6px; }
  .reviewbar .rbtoggle { cursor: pointer; opacity: .7; width: 9px; flex: none; }
  .reviewbar .rbtext { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rblist {
    display: flex; flex-direction: column; margin: 2px 0 1px 14px;
    border-left: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3));
  }
  .rbrow {
    display: flex; align-items: center; gap: 8px; padding: 3px 6px; cursor: pointer;
    border-radius: 4px; font-size: 11px;
  }
  .rbrow:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.18)); }
  .rbpath {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: var(--vscode-editor-font-family);
  }
  .openfile {
    margin: 4px 0 2px; font-size: 11px; opacity: .75; cursor: pointer;
    text-decoration: underline; text-underline-offset: 2px;
  }
  .openfile:hover { opacity: 1; }

  /* 并进思考区的工具卡：收一点，别比正文还重 */
  details.think .inner details.tool { margin: 4px 0; }
  details.think .inner details.tool + details.tool { margin-top: 3px; }

  .rbtag { flex: none; opacity: .6; }
  .rbdelta { flex: none; font-family: var(--vscode-editor-font-family); font-size: 11px; opacity: .8; }
  .rbrow.pending .rbpath { opacity: .75; }
  .reviewbar .rbbtn {
    flex: none; cursor: pointer; font-size: 11px; padding: 2px 9px; border-radius: 5px;
    border: 1px solid transparent;
  }
  .reviewbar .rbbtn.ok {
    color: var(--vscode-button-foreground); background: var(--vscode-button-background);
  }
  .reviewbar .rbbtn.ok:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
  .reviewbar .rbbtn.no {
    color: var(--vscode-foreground);
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.2));
  }

  /* 「已编辑 N 个文件」卡片 */
  .chgcard {
    margin: 4px 0 14px; border-radius: 8px; overflow: hidden;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
    background: var(--vscode-textBlockQuote-background, rgba(128,128,128,.07));
  }
  .chghead {
    display: flex; align-items: center; gap: 8px; padding: 7px 10px;
    font-size: 12px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2));
  }
  .chghead::before { content: '✎'; opacity: .6; }
  .chgtitle { font-weight: 600; }
  .chgstat { margin-left: auto; font-size: 11px; color: var(--vscode-charts-green, #3fb950); }
  .chgrow {
    display: flex; align-items: center; gap: 8px; padding: 4px 10px; cursor: pointer;
    font-size: 11px; font-family: var(--vscode-editor-font-family);
  }
  .chgrow:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.15)); }
  .chgrow + .chgrow { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.12)); }
  .chgpath { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chgdelta { margin-left: auto; display: flex; gap: 6px; flex: none; }
  .chgdelta .add { color: var(--vscode-charts-green, #3fb950); }
  .chgdelta .del { color: var(--vscode-charts-red, #f85149); }
  .chgmore { justify-content: center; opacity: .6; font-family: var(--vscode-font-family); }
  /* 待审（尚未落盘）的行：灰一点 + 一个"待审"标记 */
  .chgpending { font-size: 11px; opacity: .65; margin-left: 8px; color: var(--vscode-charts-orange, #e5a04c); }
  .chgrow.pending .chgpath { opacity: .75; }
  .chgrow.pending .chgdelta { opacity: .7; }
  .chgtag {
    flex: none; font-size: 10px; padding: 0 5px; border-radius: 4px; opacity: .8;
    border: 1px solid var(--vscode-charts-orange, #e5a04c);
    color: var(--vscode-charts-orange, #e5a04c);
  }
  .ctrl-option {
    padding: 5px 10px; cursor: pointer; font-size: 11px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.15));
  }
  .ctrl-option:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.15)); }
  .ctrl-option:last-child { border-bottom: none; }
  .ctrl-option.selected { background: var(--vscode-list-activeSelectionBackground, rgba(77,170,252,.2)); color: var(--vscode-charts-blue, #4daafc); }
  #send {
    margin-left: auto; padding: 4px 14px; font-size: 12px; cursor: pointer; border: none; border-radius: 6px;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background);
  }
  #send:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
  #send:disabled { opacity: .45; cursor: default; }
  #stop {
    display: none; margin-left: auto; padding: 4px 14px; font-size: 12px; cursor: pointer;
    border: none; border-radius: 6px; color: #fff; background: var(--vscode-charts-red, #f85149);
  }
  #stop:hover { background: var(--vscode-charts-red, #da3633); }
  #stop.show { display: block; }
  #send.hide { display: none; }
  .hint { font-size: 10px; opacity: .5; }
</style>
</head>
<body>
  <header>
    <div class="row">
      <select id="sessions" title="切换会话"></select>
      <button class="iconbtn" id="new" title="新建对话">＋</button>
      <button class="iconbtn" id="del" title="删除当前对话">🗑</button>
    </div>
    <div class="chips">
      <span class="chip plain" id="model">—</span>
      <span class="chip plain" id="cwd" title=""></span>
      <span class="chip plain" id="ver" title="扩展版本（用来确认装的是哪一版）"></span>
      <span class="chip plain hidden" id="changed" title=""></span>
      <span class="chip plain" id="usage"></span>
    </div>
  </header>

  <div id="list"></div>
  <div id="empty">
    <div class="big">🐳</div>
    <div>在这个窗口里与 DSH 对话。</div>
    <div>会话根 = 本窗口文件夹，因此多窗口互不干扰。</div>
  </div>

  <footer>
    <div id="review-bar" class="reviewbar"></div>
    <div id="activity" class="activity"></div>
    <div id="cmd-picker"></div>
    <textarea id="input" rows="1" placeholder="输入消息…（Enter 发送 / Shift+Enter 换行 / 输入 / 查看命令）"></textarea>
    <div class="actions">
      <button class="ctrl-btn" id="ctrl-model"><span class="label">模型</span><span id="ctrl-model-val">deepseek-flash</span><div class="ctrl-dropdown" id="ctrl-model-dd"></div></button>
      <button class="ctrl-btn" id="ctrl-thinking"><span class="label">思考</span><span id="ctrl-thinking-val">off</span><div class="ctrl-dropdown" id="ctrl-thinking-dd"></div></button>
      <button class="ctrl-btn" id="ctrl-mode"><span class="label">编辑</span><span id="ctrl-mode-val">自动</span><div class="ctrl-dropdown" id="ctrl-mode-dd"></div></button>
      <button id="send">发送</button>
      <button id="stop">停止</button>
      <span class="hint" id="hint"></span>
    </div>
    <div class="stats">
      <span id="st-progress"></span>
      <span id="st-tokens"></span>
      <span id="st-context"></span>
    </div>
  </footer>

<script nonce="${nonceValue}">
  const vscode = acquireVsCodeApi();
  const list = document.getElementById('list');
  const emptyEl = document.getElementById('empty');
  // 状态不再用顶部芯片，全部由输入框上面的活动行显示（见 renderActivity）
  var statusKind = 'idle';
  const modelEl = document.getElementById('model');
  const cwdEl = document.getElementById('cwd');
  const usageEl = document.getElementById('usage');
  const sessionsEl = document.getElementById('sessions');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const hintEl = document.getElementById('hint');
  const nodes = new Map();

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  // 批量重建期间不要自动滚到底，否则滚动位置会被反复拉扯
  var bulkRender = false;
  function scrollDown() {
    if (bulkRender) return;
    list.scrollTop = list.scrollHeight;
  }

  function render(entry) {
    if (entry.role === 'system') return el('div', 'sys', entry.text);

    // 「本次对话改了哪些文件」卡片：每行可点击跳到改动处
    if (entry.role === 'changes') {
      const card = el('div', 'chgcard');
      const head = el('div', 'chghead');
      head.appendChild(el('span', 'chgtitle', entry.appliedFiles ? '已编辑 ' + entry.appliedFiles + ' 个文件' : '本次对话改动'));
      head.appendChild(el('span', 'chgstat', '+' + entry.added + ' -' + entry.removed));
      if (entry.pendingFiles) {
        head.appendChild(
          el('span', 'chgpending', '待审 ' + entry.pendingFiles + ' +' + entry.pendingAdded + ' -' + entry.pendingRemoved)
        );
      }
      card.appendChild(head);

      const MAX_ROWS = 5;
      const addRow = (f) => {
        const row = el('div', 'chgrow' + (f.pending ? ' pending' : ''));
        row.title = (f.pending ? '待审（尚未落盘），点击打开 diff：' : '点击跳到改动处：') + f.path;
        row.appendChild(el('span', 'chgpath', f.path));
        if (f.pending) row.appendChild(el('span', 'chgtag', '待审'));
        const d = el('span', 'chgdelta');
        d.appendChild(el('span', 'add', '+' + f.added));
        d.appendChild(el('span', 'del', '-' + f.removed));
        row.appendChild(d);
        row.addEventListener('click', () =>
          f.pending
            ? vscode.postMessage({ type: 'openReviewDiff', path: f.path })
            : vscode.postMessage({ type: 'openChange', path: f.path, line: f.line, added: f.added, changeId: f.changeId })
        );
        card.appendChild(row);
      };
      entry.files.slice(0, MAX_ROWS).forEach(addRow);
      const rest = entry.files.slice(MAX_ROWS);
      if (rest.length) {
        const more = el('div', 'chgrow chgmore', '全部 ' + entry.files.length + ' 个文件 ⌄');
        more.addEventListener('click', (e) => {
          e.stopPropagation();
          rest.forEach(addRow);
          more.remove();
        });
        card.appendChild(more);
      }
      return card;
    }

    if (entry.role === 'tool') {
      const d = el('details', 'tool');
      const s = el('summary');
      s.appendChild(el('span', 'tname', entry.name || 'tool'));
      // 头行只放摘要：参数摘要（例如「5 个文件 · calc.py, grade.py…」）+ 结果摘要
      // 摘要 = 参数摘要 + 结果摘要；两边都带文件名时**去掉重复**（曾出现 "example.py · example.py · …"）
      const bits = [];
      if (entry.argSummary) bits.push(entry.argSummary);
      if (entry.summary) {
        let extra = entry.summary;
        if (entry.argSummary && extra.indexOf(entry.argSummary) === 0) {
          extra = extra.slice(entry.argSummary.length).replace(/^\\s*·\\s*/, '');
        }
        if (extra) bits.push(extra);
      }
      if (bits.length) s.appendChild(el('span', 'tsum', bits.join(' · ')));
      const stat = el('span', 'tstat ' + (entry.ok === false ? 'err' : entry.ok === true ? 'ok' : ''));
      stat.textContent = entry.ok === false ? '✗' : entry.ok === true ? '✓' : '…';
      s.appendChild(stat);
      d.appendChild(s);
      const inner = el('div', 'inner');
      // 写入/编辑类工具：先把内容以**代码块**呈现（比原始 JSON 清楚得多）
      if (entry.codeHtml) {
        inner.appendChild(el('div', 'who', '内容'));
        const codeWrap = el('div', 'body');
        codeWrap.innerHTML = entry.codeHtml;
        inner.appendChild(codeWrap);
      }
      // 完整参数仍留在折叠里；已经有代码块时就不必再把 JSON 铺一遍
      // \u6709\u8def\u5f84\u5c31\u7ed9\u4e2a\u5165\u53e3\uff1a\u5b8c\u6574\u5185\u5bb9\u5c31\u5728\u78c1\u76d8\u4e0a\uff08\u5de5\u5177\u7ed3\u679c\u53ef\u80fd\u5df2\u88ab\u4e0a\u6e38\u622a\u65ad\uff09
      var filePath = '';
      try {
        var parsedArgs = entry.args ? JSON.parse(entry.args) : null;
        if (parsedArgs) filePath = parsedArgs.file_path || parsedArgs.path || '';
      } catch (err) {
        filePath = '';
      }
      if (filePath) {
        var openBtn = el('div', 'openfile', '\u6253\u5f00\u6587\u4ef6\uff1a' + filePath);
        openBtn.title = '\u5728\u7f16\u8f91\u5668\u91cc\u6253\u5f00\uff08\u8fd9\u662f\u5b8c\u6574\u5185\u5bb9\uff1b\u5de5\u5177\u7ed3\u679c\u53ef\u80fd\u5df2\u88ab\u622a\u65ad\uff09';
        openBtn.addEventListener('click', function () {
          vscode.postMessage({ type: 'openPath', path: filePath });
        });
        inner.appendChild(openBtn);
      }
      if (entry.showArgs !== false && !entry.codeHtml && entry.args && entry.args.length > (entry.argSummary || '').length + 4) {
        inner.appendChild(el('div', 'who', '参数'));
        inner.appendChild(el('pre', null, entry.args));
      }
      if (entry.result) {
        inner.appendChild(el('div', 'who', '结果'));
        inner.appendChild(el('pre', null, entry.result));
      }
      d.appendChild(inner);
      // 工具卡一律默认收起：旧记录里可能带着 open:true（早期版本写的），不再沿用
      return d;
    }

    const msg = el('div', 'msg ' + entry.role);
    msg.appendChild(el('div', 'avatar', entry.role === 'user' ? '你' : 'AI'));
    const content = el('div', 'content');

    if (entry.reasoning) {
      const d = el('details', 'think');
      // 标题行只放字数（+ 完成后的用时）：生成中不再往这行塞内容，免得整行抖动/换行
      const extra = !entry.streaming && entry.durationMs ? ' · 用时 ' + fmtDur(entry.durationMs) : '';
      const s = el('summary', null, '思考过程 · ' + entry.reasoning.length + ' 字' + extra);
      d.appendChild(s);
      const inner = el('div', 'inner');
      inner.appendChild(el('pre', null, entry.reasoning));
      d.appendChild(inner);
      // 生成中自动展开、生成完自动折叠（见 upsert 的 applyThinkRule）：
      // 想的时候能看见内容，想完就收起来，不占对话空间
      d.open = !!entry.streaming;
      d.addEventListener('toggle', function () {
        if (d.open) delete thinkUserClosed[entry.id];
        else thinkUserClosed[entry.id] = true;
      });
      content.appendChild(d);
    }

    const body = el('div', 'body');
    // 服务端已渲染并转义的 HTML（chat-model.miniMarkdown）
    body.innerHTML = entry.html !== undefined ? entry.html : '';
    if (entry.role === 'user') {
      // 时间戳
      const timeEl = el('div', 'msg-time', entry.time || '');
      content.appendChild(timeEl);
      const bubble = el('div', 'bubble');
      bubble.appendChild(body);
      content.appendChild(bubble);
    } else {
      content.appendChild(body);
    }
    msg.appendChild(content);
    return msg;
  }

  /** 生成中的思考块自动展开；这一轮刚结束（streaming 由 true 变 false）自动折叠。 */
  function applyThinkRule(node, entry, wasStreaming) {
    if (!entry.reasoning) return;
    const d = node.querySelector('details.think');
    if (!d) return;
    if (entry.streaming) {
      if (!thinkUserClosed[entry.id]) d.open = true; // 正在想：展开给人看
    } else if (wasStreaming && !thinkUserClosed[entry.id]) {
      d.open = false; // 想完了：折叠，别占地方
    }
  }

  // ---------- 步骤分组 ----------
  // 工具卡一张张铺在对话里非常吵；把它们**并进上一条 AI 气泡的「思考过程」折叠区**，
  // 气泡头上补一句「N 次工具调用（read ×3, glob）」，展开才看得到细节。
  var stepHosts = {}; // assistantEntryId -> { body, summary, baseText, tools }
  var openStepId = ''; // 当前可吸收工具卡的气泡

  function toolLabel(e) {
    return String((e && e.name) || '').replace(/^mcp__vscode__/, '') || 'tool';
  }

  function toolSummaryText(tools) {
    var counts = {};
    for (var i = 0; i < tools.length; i += 1) counts[tools[i]] = (counts[tools[i]] || 0) + 1;
    var parts = Object.keys(counts).map(function (k) {
      return counts[k] > 1 ? k + ' ×' + counts[k] : k;
    });
    return ' · ' + tools.length + ' 次工具调用（' + parts.slice(0, 5).join(', ') + (parts.length > 5 ? ' 等' : '') + '）';
  }

  function refreshStepSummary(host) {
    if (!host || !host.summary) return;
    host.summary.textContent = host.baseText + (host.tools.length ? toolSummaryText(host.tools) : '');
  }

  function makeStepHost(entry, node) {
    var d = node.querySelector('details.think');
    var inner;
    if (d) {
      inner = d.querySelector('.inner');
      if (!inner) {
        inner = el('div', 'inner');
        d.appendChild(inner);
      }
    } else {
      // 这条气泡没有思考内容：给它加一个折叠区专门放工具卡
      d = el('details', 'think');
      var sum = el('summary', null, '工具调用');
      inner = el('div', 'inner');
      d.append(sum, inner);
      (node.querySelector('.body') || node).appendChild(d);
    }
    var summary = d.querySelector('summary');
    return {
      body: inner,
      summary: summary,
      baseText: summary ? summary.textContent : '',
      tools: [],
      ids: [] // 已并进来的工具条目 id（气泡节点被重建时要按这个挂回去）
    };
  }

  function upsert(entry) {
    const fresh = render(entry);
    const old = nodes.get(entry.id);
    // 只有"本来就贴着底"时才自动跟随，免得你在翻历史时被拽回底部
    const wasAtBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    if (old) {
      // 流式更新会重建节点：把用户手动展开的折叠面板状态带过去，
      // 否则"思考过程"一点开，下一次增量更新就用一个新的收起态把它盖掉。
      const oldOpen = Array.from(old.querySelectorAll('details')).map((d) => d.open);
      Array.from(fresh.querySelectorAll('details')).forEach((d, i) => {
        if (oldOpen[i]) d.open = true;
      });
      applyThinkRule(fresh, entry, old.dataset.streaming === '1');
      fresh.dataset.streaming = entry.streaming ? '1' : '0';
      old.replaceWith(fresh);
      // 气泡被重建后，它的折叠区/摘要引用要跟着换（否则工具计数会写在旧节点上）
      if (stepHosts[entry.id]) {
        const host = stepHosts[entry.id];
        const sum = fresh.querySelector('details.think > summary') || fresh.querySelector('summary');
        const freshBody = fresh.querySelector('details.think .inner');
        if (freshBody) host.body = freshBody;
        host.summary = sum;
        host.baseText = sum ? sum.textContent : '';
        // 气泡节点整块被换掉了 -> 新节点里的 .inner 是空的，
        // 必须把已经并进来的工具卡**重新挂回去**，否则流式更新一次执行日志就全没了
        for (const toolId of host.ids) {
          const toolNode = nodes.get(toolId);
          if (toolNode) host.body.appendChild(toolNode);
        }
        refreshStepSummary(host);
      }
    } else if (entry.role === 'tool' && openStepId && stepHosts[openStepId]) {
      // 并进上一条 AI 气泡，而不是铺在对话里
      const host = stepHosts[openStepId];
      host.body.appendChild(fresh);
      host.tools.push(toolLabel(entry));
      host.ids.push(entry.id);
      refreshStepSummary(host);
      // 并进来的工具卡**默认展开**：展开思考区时直接能看到"执行了什么"，
      // 不用再点一次（整个思考区收起来时它会一起收起）
      const nested = fresh.querySelector('details');
      if (nested) nested.open = true;
    } else {
      applyThinkRule(fresh, entry, false);
      fresh.dataset.streaming = entry.streaming ? '1' : '0';
      list.appendChild(fresh);
    }
    nodes.set(entry.id, fresh);
    if (!old) {
      if (entry.role === 'assistant') {
        const host = makeStepHost(entry, fresh);
        stepHosts[entry.id] = host;
        openStepId = entry.id;
      } else if (entry.role !== 'tool') {
        openStepId = ''; // 用户消息/系统提示会打断这一步
      }
    }
    emptyEl.style.display = 'none';
    if (wasAtBottom) scrollDown();
  }

  function applyMeta(meta) {
    if (!meta) return;
    if (meta.status) {
      statusKind = meta.status;
      const isRunning = meta.status === 'running';
      sendBtn.disabled = isRunning || meta.status === 'starting';
      // 停止/发送按钮切换
      var stopBtn = document.getElementById('stop');
      if (isRunning) {
        stopBtn.classList.add('show');
        sendBtn.classList.add('hide');
      } else {
        stopBtn.classList.remove('show');
        sendBtn.classList.remove('hide');
      }
      hintEl.textContent = isRunning ? '生成中…' : '';
    }
    if (meta.model) modelEl.textContent = meta.model;
    if (meta.cwd) { cwdEl.textContent = meta.cwd; cwdEl.title = meta.cwd; }
    if (meta.version) {
      const verEl = document.getElementById('ver');
      if (verEl) verEl.textContent = 'v' + meta.version;
    }
    const chgEl = document.getElementById('changed');
    if (chgEl) {
      chgEl.classList.toggle('hidden', !meta.changed);
      if (meta.changed) {
        chgEl.textContent =
          '本次改动 ' + meta.changed.files + ' 个文件 +' + meta.changed.added + ' -' + meta.changed.removed;
        chgEl.title = (meta.changed.paths || []).join('\\n');
      }
    }
    usageEl.textContent = meta.usage || '';

    // 三个选择器：目录与当前值都以**后端**为准（真源是 workspace 设置）
    if (meta.catalogs) catalogs = meta.catalogs;
    if (meta.prefs) { prefs = meta.prefs; updateCtrlUI(); }

    // 统计三段（对应桌面 app 底部那行：轮/步·tok/s | 总tok·缓存命中 | 上下文占用）
    if (meta.stats) {
      document.getElementById('st-progress').textContent = meta.stats.progress || '';
      document.getElementById('st-tokens').textContent = meta.stats.tokens || '';
      document.getElementById('st-context').textContent = meta.stats.context || '';
    }
    // 运行中时状态显示"深度求索中，用时 X"（由定时器刷新）
    runningSince = meta.status === 'running' ? (meta.runningSince || runningSince || Date.now()) : 0;
    // 本轮耗时与状态都在输入框上面的活动行显示（见 renderActivity）
    lastTurnMs = meta.lastTurnMs || 0;
    childState = meta.child || '';

    // 「正在做什么」活动行
    activityText = meta.activity || '';
    activitySince = meta.activitySince || 0;
    renderActivity();
    renderReviewBar(meta.review);

    if (Array.isArray(meta.sessions)) {
      const current = sessionsEl.value;
      sessionsEl.innerHTML = '';
      meta.sessions.forEach((s) => {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = s.title + (s.entries ? ' · ' + s.entries : '');
        sessionsEl.appendChild(o);
      });
      sessionsEl.value = meta.activeId || current || '';
    }
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.type === 'reset') {
      // 重建前记下滚动位置：本来贴着底就继续贴着底，否则停在原处 ——
      // 以前直接重建会让视图"跳回几轮之前，再一路滑到底"。
      var atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
      var prevTop = list.scrollTop;
      stepHosts = {};
      openStepId = '';
      bulkRender = true;
      list.innerHTML = '';
      nodes.clear();
      (m.entries || []).forEach(upsert);
      bulkRender = false;
      list.scrollTop = atBottom ? list.scrollHeight : prevTop;
      applyMeta(m.meta);
      emptyEl.style.display = (m.entries || []).length ? 'none' : 'block';
      return;
    }
    if (m.type === 'move') {
      // 只把某个节点挪到末尾（例如把本轮改动卡片挪到对话最后）：不重建，滚动位置不动
      var moved = nodes.get(m.id);
      if (moved) list.appendChild(moved);
      return;
    }
    if (m.type === 'entry') { upsert(m.entry); return; }
    if (m.type === 'meta') { applyMeta(m.meta); return; }
  });

  // 输入框从 1 行开始，随内容长高（最高 200px），发完缩回。
  // 注意：<textarea> 默认 rows=2，所以必须显式 rows="1"，否则 scrollHeight 起点就是两行。
  const MAX_INPUT_H = 200;
  const inputCs = getComputedStyle(input);
  const ONE_LINE_H = Math.ceil(
    (parseFloat(inputCs.lineHeight) || 18) + (parseFloat(inputCs.paddingTop) || 0) + (parseFloat(inputCs.paddingBottom) || 0)
  );
  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.max(ONE_LINE_H, Math.min(input.scrollHeight, MAX_INPUT_H)) + 'px';
  }
  input.addEventListener('input', autoGrow);

  // ---------- 底部控制栏（点击展开/收回） ----------
  // 选项来自后端下发的真实目录（出厂适配器的 DEFAULT_MODELS / reasoning efforts / 沙箱模式），
  // 当前值也以后端为准 —— 之前前端写死了一份并不存在的模型清单，
  // 选完会让 initialize 失败、子进程 exit 1；而且 UI 从来不反映设置里的真实值。
  var catalogs = { models: [], efforts: [], modes: [] };
  var prefs = { model: '', thinking: '', mode: '' };
  var openDropdown = null; // 当前展开的下拉

  function labelOf(list, id) {
    var hit = (list || []).find(function (x) { return x.id === id; });
    return hit ? hit.name : (id === '' ? '默认' : id || '—');
  }

  function updateCtrlUI() {
    document.getElementById('ctrl-model-val').textContent = labelOf(catalogs.models, prefs.model);
    document.getElementById('ctrl-thinking-val').textContent = labelOf(catalogs.efforts, prefs.thinking);
    document.getElementById('ctrl-mode-val').textContent = labelOf(catalogs.modes, prefs.mode);
  }

  function buildDropdown(ddEl, items, key) {
    ddEl.innerHTML = '';
    (items || []).forEach(function (item) {
      var opt = document.createElement('div');
      opt.className = 'ctrl-option' + (item.id === prefs[key] ? ' selected' : '');
      opt.textContent = item.id ? item.name + '  (' + item.id + ')' : item.name;
      opt.addEventListener('click', function (e) {
        e.stopPropagation();
        closeAllDropdowns();
        // 值立刻回填，真实状态等后端的 meta 回来再校正
        prefs[key] = item.id;
        updateCtrlUI();
        vscode.postMessage({ type: 'ctrlChange', key: key, value: item.id });
      });
      ddEl.appendChild(opt);
    });
  }

  function toggleDropdown(btnId, ddId, items, key) {
    var dd = document.getElementById(ddId);
    if (openDropdown === ddId) {
      closeAllDropdowns();
    } else {
      closeAllDropdowns();
      buildDropdown(dd, items, key);
      dd.classList.add('show');
      document.getElementById(btnId).classList.add('active');
      openDropdown = ddId;
    }
  }

  function closeAllDropdowns() {
    document.querySelectorAll('.ctrl-dropdown').forEach(function(d) { d.classList.remove('show'); });
    document.querySelectorAll('.ctrl-btn').forEach(function(b) { b.classList.remove('active'); });
    openDropdown = null;
  }

  // ---------- 运行计时（"深度求索中，用时 X"） ----------
  var runningSince = 0;
  function fmtDur(ms) {
    var t = Math.max(0, Math.round(ms / 1000));
    if (t < 60) return t + ' 秒';
    var m = Math.floor(t / 60);
    if (m < 60) return m + ' 分 ' + (t % 60) + ' 秒';
    return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
  }
  setInterval(function () {
    if (!runningSince) return; // 空闲/完成后是静态文本，不用刷
    renderActivity();
  }, 1000);

  // 「待审」框（输入框上方）：**只放还没进历史的待审提案**。
  // 已落盘的改动在对话里有按轮次的「已编辑 N 个文件」卡片，这里再列一遍是重复；
  // 所以接受完这个框自然消失。
  var reviewListOpen = true;
  function renderReviewBar(review) {
    var el0 = document.getElementById('review-bar');
    if (!el0) return;
    var list = (review && review.list) || [];
    if (!list.length) {
      el0.classList.remove('show');
      el0.textContent = '';
      return;
    }
    el0.classList.add('show');
    el0.textContent = '';

    var head = document.createElement('div');
    head.className = 'rbhead';

    var toggle = document.createElement('span');
    toggle.className = 'rbtoggle';
    toggle.textContent = reviewListOpen ? '▾' : '▸';
    toggle.title = reviewListOpen ? '收起文件清单' : '展开文件清单';

    var tx = document.createElement('span');
    tx.className = 'rbtext';
    tx.textContent = '待审 ' + review.pendingFiles + ' 个 · +' + review.pendingAdded + ' -' + review.pendingRemoved;

    var ok = document.createElement('button');
    ok.className = 'rbbtn ok';
    ok.textContent = '全部接受';
    ok.addEventListener('click', function () {
      vscode.postMessage({ type: 'acceptAllReview' });
    });
    var no = document.createElement('button');
    no.className = 'rbbtn no';
    no.textContent = '全部忽略';
    no.addEventListener('click', function () {
      vscode.postMessage({ type: 'rejectAllReview' });
    });

    head.append(toggle, tx, ok, no);
    el0.appendChild(head);

    if (reviewListOpen) {
      var box = document.createElement('div');
      box.className = 'rblist';
      list.forEach(function (f) {
        var row = document.createElement('div');
        row.className = 'rbrow pending';
        row.title = '待审（尚未落盘），点击打开 diff：' + f.path;
        var name = document.createElement('span');
        name.className = 'rbpath';
        name.textContent = f.path;
        var tag = document.createElement('span');
        tag.className = 'rbtag';
        tag.textContent = '待审 ' + (f.hunks || '') + (f.existed ? '' : ' · 新建');
        var delta = document.createElement('span');
        delta.className = 'rbdelta';
        delta.textContent = '+' + f.added + ' -' + f.removed;
        row.append(name, tag, delta);
        row.addEventListener('click', function () {
          vscode.postMessage({ type: 'openReviewDiff', path: f.path });
        });
        box.appendChild(row);
      });
      el0.appendChild(box);
    }

    toggle.addEventListener('click', function () {
      reviewListOpen = !reviewListOpen;
      renderReviewBar(review);
    });
  }

  // 输入框上面的这一行**就是状态行**：空闲 / 启动中 / 深度求索中（带用时）/ 已完成（带本轮用时）
  var activityText = '';
  var childState = '';
  /** 用户手动关掉的思考块（生成中也不强行展开） */
  var thinkUserClosed = {};
  var activitySince = 0;
  var lastTurnMs = 0;
  function renderActivity() {
    var el = document.getElementById('activity');
    el.classList.add('show');
    el.textContent = '';
    var ic = document.createElement('span');
    ic.className = 'spin';
    var tx = document.createElement('span');
    var tm = document.createElement('span');
    tm.id = 'activity-time';
    if (statusKind === 'starting') {
      ic.textContent = '◐';
      tx.textContent = '启动中…';
    } else if (runningSince) {
      ic.textContent = '◐';
      if (activityText) {
        tx.textContent = activityText;
        tm.textContent = ' · 用时 ' + fmtDur(Date.now() - runningSince);
      } else {
        tx.textContent = '深度求索中，用时 ' + fmtDur(Date.now() - runningSince);
      }
    } else if (lastTurnMs) {
      ic.textContent = '✓';
      tx.textContent = '已完成 · 本轮用时 ' + fmtDur(lastTurnMs);
    } else {
      ic.textContent = '○';
      tx.textContent =
        childState === 'off'
          ? '空闲 · 子进程未启动'
          : childState === 'starting'
            ? '空闲 · 子进程启动中'
            : '空闲';
    }
    el.append(ic, tx, tm);
  }

  document.getElementById('ctrl-model').addEventListener('click', function(e) {
    e.stopPropagation();
    toggleDropdown('ctrl-model', 'ctrl-model-dd', catalogs.models, 'model');
  });
  document.getElementById('ctrl-thinking').addEventListener('click', function(e) {
    e.stopPropagation();
    toggleDropdown('ctrl-thinking', 'ctrl-thinking-dd', catalogs.efforts, 'thinking');
  });
  document.getElementById('ctrl-mode').addEventListener('click', function(e) {
    e.stopPropagation();
    toggleDropdown('ctrl-mode', 'ctrl-mode-dd', catalogs.modes, 'mode');
  });

  // 点击外部关闭下拉
  document.addEventListener('click', function() { closeAllDropdowns(); });

  // ---------- 斜杠命令 ----------
  const SLASH_COMMANDS = [
    { name: '/commit', desc: '生成提交信息并提交当前改动' },
    { name: '/review', desc: '审核当前工作区的改动' },
    { name: '/test', desc: '运行项目测试' },
    { name: '/explain', desc: '解释选中的代码' },
    { name: '/fix', desc: '修复当前文件的问题' },
    { name: '/refactor', desc: '重构建议' }
  ];
  const cmdPicker = document.getElementById('cmd-picker');
  let cmdSelectedIndex = -1;

  function renderCmdPicker(filter) {
    const filtered = filter
      ? SLASH_COMMANDS.filter(c => c.name.startsWith(filter))
      : SLASH_COMMANDS;
    if (!filtered.length) {
      cmdPicker.classList.remove('show');
      return;
    }
    cmdPicker.innerHTML = filtered.map(function(c) {
      return '<div class="cmd-item" data-cmd="' + c.name + '"><span class="cmd-name">' + c.name + '</span><span class="cmd-desc">' + c.desc + '</span></div>';
    }).join('');
    cmdPicker.classList.add('show');
    cmdSelectedIndex = 0;
    highlightCmd(0);
  }

  function highlightCmd(index) {
    const items = cmdPicker.querySelectorAll('.cmd-item');
    items.forEach((item, i) => {
      item.style.background = i === index ? 'var(--vscode-list-activeSelectionBackground, rgba(128,128,128,.2))' : '';
    });
  }

  function selectCmd(cmd) {
    input.value = cmd + ' ';
    cmdPicker.classList.remove('show');
    input.focus();
  }

  cmdPicker.addEventListener('click', (e) => {
    const item = e.target.closest('.cmd-item');
    if (item) selectCmd(item.dataset.cmd);
  });

  input.addEventListener('input', (e) => {
    autoGrow();
    const val = input.value;
    if (val.startsWith('/')) {
      renderCmdPicker(val.split(' ')[0]);
    } else {
      cmdPicker.classList.remove('show');
    }
  });

  input.addEventListener('keydown', (e) => {
    if (cmdPicker.classList.contains('show')) {
      const items = cmdPicker.querySelectorAll('.cmd-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        cmdSelectedIndex = Math.min(cmdSelectedIndex + 1, items.length - 1);
        highlightCmd(cmdSelectedIndex);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        cmdSelectedIndex = Math.max(cmdSelectedIndex - 1, 0);
        highlightCmd(cmdSelectedIndex);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (cmdSelectedIndex >= 0 && items[cmdSelectedIndex]) {
          e.preventDefault();
          selectCmd(items[cmdSelectedIndex].dataset.cmd);
        }
      } else if (e.key === 'Escape') {
        cmdPicker.classList.remove('show');
      }
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#cmd-picker') && e.target !== input) {
      cmdPicker.classList.remove('show');
    }
  });

  // ---------- 复制按钮（事件委托） ----------
  list.addEventListener('click', (e) => {
    if (e.target.classList.contains('copy-btn')) {
      const code = e.target.dataset.code || '';
      // 解码 HTML 实体
      const textarea = document.createElement('textarea');
      textarea.innerHTML = code;
      const decoded = textarea.value;
      
      // 复制到剪贴板
      if (navigator.clipboard) {
        navigator.clipboard.writeText(decoded).then(() => {
          e.target.textContent = '已复制';
          setTimeout(() => { e.target.textContent = '复制'; }, 1200);
        });
      } else {
        // 降级方案
        const temp = document.createElement('textarea');
        temp.value = decoded;
        document.body.appendChild(temp);
        temp.select();
        document.execCommand('copy');
        document.body.removeChild(temp);
        e.target.textContent = '已复制';
        setTimeout(() => { e.target.textContent = '复制'; }, 1200);
      }
    }
  });

  function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    autoGrow();
    vscode.postMessage({ type: 'send', text });
  }

  sendBtn.addEventListener('click', send);
  document.getElementById('stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  sessionsEl.addEventListener('change', () => vscode.postMessage({ type: 'switch', id: sessionsEl.value }));
  document.getElementById('new').addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
  document.getElementById('del').addEventListener('click', () => vscode.postMessage({ type: 'deleteSession' }));

  autoGrow();
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

/**
 * @param {object} deps
 * @param {import('vscode').ExtensionContext} deps.context
 * @param {(msg: string) => void} deps.log
 * @param {() => string|undefined} deps.getWorkspaceRoot
 */
function createChatUi(deps) {
  const { context, log } = deps;
  /** @type {import('vscode').WebviewView|null} */
  let view = null;
  /** @type {SdkClient|null} */
  let client = null;
  let starting = null;
  let running = false;
  /** 本轮开始时间（界面据此显示"深度求索中，用时 X"） */
  let runningSince = 0;
  /** 当前正在做什么（工具描述），对应桌面 app 的活动行 */
  let activity = null;
  let activitySince = 0;

  function setActivity(text) {
    activity = text;
    activitySince = Date.now();
    postMeta();
  }

  function clearActivity() {
    activity = null;
    activitySince = 0;
  }
  /**
   * 会话纪元：每次子进程启动都会换一个新值。
   * 存在的理由：服务端的 `agents.create` 要求 sessionId 在持久存储里**全局唯一**，
   * 重载窗口后复用同一个 id 会直接抛 `session "x" already exists`。
   * 所以传给 SDK 的 id 是 `UI会话id-p纪元`：同一进程内同一对话保持同一个 id（模型记忆连续），
   * 换进程则自动换新 id（不会撞）。UI 侧的会话与记录完全不受影响。
   */
  let epoch = null;

  function newEpoch() {
    epoch = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    return epoch;
  }

  function dshSessionId() {
    return dshSessionIdFor(state.activeId, epoch);
  }

  let state = normalizeState(context.workspaceState.get(STATE_KEY));

  function entries() {
    const s = activeSession(state);
    return s ? s.entries : [];
  }

  function persist() {
    return context.workspaceState.update(STATE_KEY, forStorage(state));
  }

  function chatModel() {
    const cfg = vscode.workspace.getConfiguration('dsh-bridge');
    return cfg.get('chat.model', 'deepseek-flash');
  }

  function chatProvider() {
    return vscode.workspace.getConfiguration('dsh-bridge').get('chat.provider', 'deepseek-official');
  }

  /** 不在对话里显示的工具（支持 * 通配；填 ["*"] 则全部隐藏） */
  function chatHideTools() {
    const v = vscode.workspace.getConfiguration('dsh-bridge').get('chat.hideTools');
    if (Array.isArray(v)) return v;
    return ['*get_review_status*'];
  }

  /** dsh 启动器路径（设置留空则自动探测） */
  function chatLauncher() {
    const v = vscode.workspace.getConfiguration('dsh-bridge').get('launcher');
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  }

  /** 子进程用的 profile（默认 sdk） */
  function chatProfile() {
    const v = vscode.workspace.getConfiguration('dsh-bridge').get('profile');
    return typeof v === 'string' && v.trim() ? v.trim() : 'sdk';
  }

  function chatPermissionMode() {
    return vscode.workspace.getConfiguration('dsh-bridge').get('chat.permissionMode', '') || '';
  }

  function chatReasoningEffort() {
    return vscode.workspace.getConfiguration('dsh-bridge').get('chat.reasoningEffort', '') || undefined;
  }

  function chatCodeHighlight() {
    return vscode.workspace.getConfiguration('dsh-bridge').get('chat.codeHighlight', true);
  }

  function chatShowLineNumbers() {
    return vscode.workspace.getConfiguration('dsh-bridge').get('chat.showLineNumbers', false);
  }

  function chatStreamReplay() {
    return vscode.workspace.getConfiguration('dsh-bridge').get('chat.streamReplay', true);
  }

  /**
   * 助手消息的显示。
   *
   * SDK 协议**没有**增量事件（实测 delta 类型出现 0 次），思考与正文都在消息完成时才整段到达；
   * 但消息里带着 `AssistantStreamRecord[]`（每段文本 + 间隔毫秒），于是可以按录制时间轴回放，
   * 视觉上和桌面 app 的"边想边出"一致 —— 内容是真的，只是到达后才播。
   */
  function addAssistant(mapped) {
    const plan = chatStreamReplay() ? replayPlan(mapped.stream) : [];
    if (!plan.length) {
      add(mapped.entry);
      return;
    }
    const entry = add(Object.assign({}, mapped.entry, { text: '', reasoning: undefined, html: '' }));
    entry.streaming = true;
    let i = 0;
    const step = () => {
      if (!entries().includes(entry) || i >= plan.length) {
        entry.streaming = false;
        patch(entry.id, { text: entry.text, reasoning: entry.reasoning, streaming: false }); // 收尾并落盘
        return;
      }
      const s = plan[i];
      i += 1;
      if (s.target === 'reasoning') entry.reasoning = (entry.reasoning || '') + s.delta;
      else entry.text = (entry.text || '') + s.delta;
      entry.html = miniMarkdown(entry.text || '');
      postEntry(entry);
      setTimeout(step, s.waitMs);
    };
    setTimeout(step, 0);
  }

  function metaPayload() {
    const s = activeSession(state);
    return {
      status: starting ? 'starting' : running ? 'running' : 'idle',
      model: chatModel(),
      cwd: (client && client.cwd) || deps.getWorkspaceRoot() || '(无工作区)',
      usage: usageLine(entries()),
      sessions: state.sessions.map((s2) => ({ id: s2.id, title: s2.title, entries: s2.entries.length })),
      activeId: state.activeId,
      // 三个选择器：目录 + 当前真实值，UI 只负责显示
      prefs: currentPrefs(),
      catalogs: { models: MODEL_CATALOG, efforts: REASONING_EFFORTS, modes: PERMISSION_MODES },
      stats: statsLines(s && s.stats),
      runningSince: runningSince || 0,
      // 子进程状态：让状态行直接告诉用户卡在哪里
      child: client ? 'connected' : starting ? 'starting' : 'off',
      // 「正在做什么」+ 本轮耗时（对齐 app 的两条信息）
      activity: activity || '',
      activitySince: activitySince || 0,
      lastTurnMs: (s && s.stats && s.stats.turnMs) || 0,
      // 常驻的「本次改动」记录：审核完（待审条隐藏）之后仍然看得见改过什么
      changed: (() => {
        const s = activeSession(state);
        const list = changesForTurn(s && s.changes, currentTurn(s));
        if (!list.length) return null;
        let added = 0;
        let removed = 0;
        for (const c of list) {
          added += c.added || 0;
          removed += c.removed || 0;
        }
        return { files: list.length, added, removed, paths: list.map((c) => c.path) };
      })(),
      // 运行中的扩展版本（装在 VS Code 里的那一版），用来快速确认"我改的有没有装上"
      version: (context.extension && context.extension.packageJSON && context.extension.packageJSON.version) || '',
      // 输入框上方的「待审」框：**只放还没进历史的**（待审提案）。
      // 已落盘的改动在对话里有按轮次的「已编辑 N 个文件」卡片了，
      // 这里再列一遍是重复信息（接受完就该消失，而不是一直挂着）。
      review: (() => {
        const r = deps.getReviewStatus ? deps.getReviewStatus() : null;
        const pending = [];
        for (const f of (r && r.files) || []) {
          let added = 0;
          let removed = 0;
          let n = 0;
          for (const h of f.summary || []) {
            if (h.status !== 'pending') continue;
            n += 1;
            added += h.added || 0;
            removed += h.removed || 0;
          }
          if (n) pending.push({ path: f.path, added, removed, line: 1, pending: true, hunks: n, existed: !!f.existed });
        }
        if (!pending.length) return null; // 没有待审就整框隐藏（历史里那张卡片已记录）
        const pt = changeTotals(pending);
        return {
          pendingFiles: pt.files,
          pendingAdded: pt.added,
          pendingRemoved: pt.removed,
          list: pending
        };
      })()
    };
  }

  /** 选择器的真源：workspace 设置（用户在设置面板里手改也会反映到 UI） */
  function currentPrefs() {
    const cfg = vscode.workspace.getConfiguration('dsh-bridge');
    return {
      model: cfg.get('chat.model', 'deepseek-flash'),
      thinking: cfg.get('chat.reasoningEffort', '') || '',
      mode: cfg.get('chat.permissionMode', '') || ''
    };
  }

  /**
   * 「模型 / 思考 / 编辑」三个选择器。
   *
   * 这三个值都只在**子进程启动时**被读取（模型与思考级别走 initialize，编辑模式走
   * DSH_PERMISSION_MODE 环境变量），所以改完必须让子进程重启才对下一句话生效。
   * 之前这里的问题是：前端给的是编造的值，且把 workspace-write
   * 这类真实模式映射成了空串 —— 于是"改了等于没改"。
   */
  async function handleCtrlChange(key, value) {
    const settingByKey = { model: 'chat.model', thinking: 'chat.reasoningEffort', mode: 'chat.permissionMode' };
    const labelByKey = { model: '模型', thinking: '思考级别', mode: '编辑模式' };
    const setting = settingByKey[key];
    if (!setting) return;
    const next = String(value == null ? '' : value);
    const cfg = vscode.workspace.getConfiguration('dsh-bridge');
    try {
      await cfg.update(setting, next, vscode.ConfigurationTarget.Workspace);
    } catch (err) {
      log(`写 workspace 设置失败（${err.message}），改写到用户设置`);
      await cfg.update(setting, next, vscode.ConfigurationTarget.Global);
    }
    log(`选择器变更: ${key}=${next || '(默认)'} → ${setting}`);

    if (running) {
      const pick = await vscode.window.showWarningMessage(
        `正在生成中，切换${labelByKey[key] || key}会中断当前轮次。`,
        { modal: true },
        '中断并切换'
      );
      if (pick !== '中断并切换') return; // 不切了：调用方随后 postMeta() 会把显示校正回真实值
    }
    if (client) {
      try {
        await client.shutdown();
      } catch {
        /* ignore */
      }
      client = null;
    }
    running = false;
    runningSince = 0;
    add({
      id: `sys-${Date.now()}`,
      role: 'system',
      text: `${labelByKey[key] || key}已切换为「${next || '默认'}」，子进程已重启：下一句话就按新设置执行（本对话的模型记忆会重置，历史仍在上方）。`
    });
  }

  /**
   * 卡片数据 = **已落盘**改动 + **待审**改动（分开统计、分开标记）。
   *
   * 之前只统计已落盘的，于是"第二批提案还没接受"时卡片毫无变化，看起来像坏了。
   */
  /** 被隐藏的工具调用（callId）：结果到达时不要再多出一张卡 */
  const hiddenCalls = new Set();

  /** 当前是第几轮（每轮对话一张改动卡片） */
  function currentTurn(s) {
    return Number(s && s.turn) || 1;
  }

  function buildChangesCard() {
    const s = activeSession(state);
    if (!s) return null;
    const turn = currentTurn(s);
    // **只统计本轮的改动**：第二轮那张卡片只显示第二轮改了什么，
    // 第一轮的卡片留在原处随历史往上走。
    const applied = changesForTurn(s.changes, turn).map((c) => ({
      path: c.path,
      added: c.added || 0,
      removed: c.removed || 0,
      line: c.line || 1,
      pending: false
    }));

    const pendingRows = [];
    const status = deps.getReviewStatus ? deps.getReviewStatus() : null;
    for (const f of (status && status.files) || []) {
      let added = 0;
      let removed = 0;
      let line = 0;
      let pend = 0;
      for (const h of f.summary || []) {
        if (h.status !== 'pending') continue;
        pend += 1;
        added += h.added || 0;
        removed += h.removed || 0;
        if (!line) line = h.startLine || 1;
      }
      if (pend) pendingRows.push({ path: f.path, added, removed, line: line || 1, pending: true });
    }

    if (!applied.length && !pendingRows.length) return null;
    const at = changeTotals(applied);
    const pt = changeTotals(pendingRows);
    return {
      id: 'changes-summary',
      role: 'changes',
      files: applied.concat(pendingRows).sort((a, b) => b.added + b.removed - (a.added + a.removed)),
      added: at.added,
      removed: at.removed,
      appliedFiles: at.files,
      pendingAdded: pt.added,
      pendingRemoved: pt.removed,
      pendingFiles: pt.files
    };
  }

  /** 重建/更新那张卡片（已落盘 + 待审） */
  function refreshChangesCard(forceEnd) {
    const s = activeSession(state);
    if (!s) return;
    const turn = currentTurn(s);
    const card = buildChangesCard();
    // 每轮一张：按 (role=changes, turn=turn) 定位本轮的卡片
    const existing = s.entries.find((e) => e.role === 'changes' && (Number(e.turn) || 1) === turn);
    if (!card) {
      if (existing) {
        s.entries = s.entries.filter((e) => e !== existing);
        postReset();
        void persist();
        postMeta();
      }
      return;
    }
    card.turn = turn;
    card.id = `changes-${turn}`;
    if (existing) {
      Object.assign(existing, card);
      // 本轮结束时把它挪到末尾 —— 也就是"本轮对话的最后"
      if (forceEnd) {
        s.entries = s.entries.filter((e) => e !== existing).concat(existing);
        // 只让 webview 挪节点，**不要 postReset**（重建会把滚动位置拉回去）
        if (view) view.webview.postMessage({ type: 'move', id: existing.id });
      } else {
        postEntry(existing);
      }
      void persist();
      postMeta();
    } else {
      add(card);
    }
  }

  /**
   * 落盘后累计「本次对话改动了哪些文件」。
   * 对应桌面 app 的「已编辑 N 个文件 +63 -9」卡片；点击某一行跳到改动处。
   */
  function noteChanges(list) {
    const s = activeSession(state);
    if (!s) return;
    s.changes = mergeChanges(s.changes, list, currentTurn(s));
    refreshChangesCard();
    return currentTurn(s); // 给时间线做标签用
  }

  /** 临时高亮用的装饰类型（改动落盘后，点一下就能看见"改了哪几行"） */
  let changeHighlight = null;
  let changeHighlightTimer = null;

  /**
   * 点击改动卡片里的某一行 → 打开该文件，**选中并高亮这次改动的行**。
   * 之前只是把光标放到首行，看不出改了哪些内容（对齐桌面 app 的行为）。
   */
  async function openChangeAt(filePath, line, added, changeId) {
    // 有快照就走「改动前 ↔ 改动后」的原生 diff（隔离、不受行号漂移影响）
    if (changeId) {
      try {
        await vscode.commands.executeCommand('dsh-bridge.showChange', filePath, changeId);
        return;
      } catch (err) {
        log(`打开改动 diff 失败，退回跳行高亮：${err.message}`);
      }
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const first = Math.max(0, (Number(line) || 1) - 1);
    const count = Math.max(1, Number(added) || 1);
    const last = Math.min(Math.max(0, doc.lineCount - 1), first + count - 1);
    const range = new vscode.Range(first, 0, last, doc.lineAt(last).text.length);
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

    // 高亮这几行，几秒后自动淡出（不写进文件，纯视觉）
    try {
      if (changeHighlight) changeHighlight.dispose();
      if (changeHighlightTimer) clearTimeout(changeHighlightTimer);
      changeHighlight = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: 'rgba(255, 214, 102, 0.28)',
        overviewRulerColor: 'rgba(255, 214, 102, 0.9)',
        overviewRulerLane: vscode.OverviewRulerLane ? vscode.OverviewRulerLane.Right : undefined
      });
      editor.setDecorations(changeHighlight, [range]);
      changeHighlightTimer = setTimeout(() => {
        if (changeHighlight) changeHighlight.dispose();
        changeHighlight = null;
        changeHighlightTimer = null;
      }, 6000);
    } catch (err) {
      log(`改动高亮失败（不影响跳转）：${err.message}`);
    }
  }

  /** 统计累积进当前会话记录（随状态一起落盘，重载后不丢） */
  function applyStats(mapped) {
    const s = activeSession(state);
    if (!s) return;
    s.stats = reduceStats(s.stats || emptyStats(), mapped, Date.now());
    if (mapped.kind === 'turn-end' || mapped.kind === 'request-context') void persist();
  }

  function postMeta() {
    if (view) view.webview.postMessage({ type: 'meta', meta: metaPayload() });
  }

  /** 审核队列变化时（接受/忽略/新提案）刷新聊天面板上的待审提示与改动卡片 */
  function noteBatchChanged() {
    refreshChangesCard();
    postMeta();
  }

  function postEntry(entry) {
    if (view) view.webview.postMessage({ type: 'entry', entry });
  }

  function postReset() {
    if (view) view.webview.postMessage({ type: 'reset', entries: entries(), meta: metaPayload() });
  }

  /** 追加条目（渲染好 HTML 再送出去），并落盘 */
  function add(entry) {
    const enriched = Object.assign({}, entry);
    if (!enriched.html && (enriched.role === 'user' || enriched.role === 'assistant')) {
      enriched.html = miniMarkdown(enriched.text || '', {
        codeHighlight: chatCodeHighlight(),
        showLineNumbers: chatShowLineNumbers()
      });
    }
    appendEntry(state, enriched);
    postEntry(enriched);
    void persist();
    postMeta();
    return enriched;
  }

  function patch(entryId, fields) {
    const e = patchEntry(state, entryId, fields);
    if (e) {
      postEntry(e);
      void persist();
    }
    return e;
  }

  function findToolEntry(callId) {
    for (let i = entries().length - 1; i >= 0; i -= 1) {
      const e = entries()[i];
      if (e.role === 'tool' && e.callId === callId) return e;
    }
    return null;
  }

  /** 把一个 session.event 映射成界面条目（映射逻辑在已单测的 chat-model 里） */
  function onEvent(params) {
    const mapped = mapSessionEvent(params);
    applyStats(mapped);
    switch (mapped.kind) {
      case 'user': {
        // 去重：发送时本地已经乐观加过这条，服务端的回声只用来"确认"，不再插一条
        const verdict = resolveUserEcho(entries(), mapped.entry);
        if (verdict.action === 'confirm') {
          patch(verdict.id, { local: false });
          return;
        }
        if (!mapped.entry.time) mapped.entry.time = formatTime();
        add(mapped.entry);
        return;
      }
      case 'assistant': {
        // 记下这条回答花了多久（从本轮开始算），界面把它显示在「思考过程」那一行
        if (runningSince) mapped.entry.durationMs = Date.now() - runningSince;
        addAssistant(mapped);
        return;
      }
      case 'tool-call': {
        // 隐藏名单：桥自己的记账类调用（例如批次查询）不往对话里放卡片，但状态行照样告诉你它在干什么
        if (toolHidden(mapped.entry.name, chatHideTools())) {
          if (mapped.callId) hiddenCalls.add(mapped.callId);
          setActivity(describeToolCall(mapped.entry.name, mapped.entry.args));
          return;
        }
        // 参数里可能带着整份文件内容（propose_changes / write_file），头行只放摘要
        const sa = summarizeToolArgs(mapped.entry.name, mapped.entry.args);
        mapped.entry.argSummary = sa.summary;
        mapped.entry.showArgs = sa.showArgs !== false;
        if (sa.body) mapped.entry.args = sa.body;
        // 单文件写入/编辑：把内容渲染成代码块放进折叠区（比看原始 JSON 强）
        if (sa.code) {
          mapped.entry.codeHtml = miniMarkdown('```' + (sa.code.lang || '') + '\n' + sa.code.text + '\n```');
        }
        add(mapped.entry);
        setActivity(describeToolCall(mapped.entry.name, mapped.entry.args));
        return;
      }
      case 'tool-result': {
        // 被隐藏的调用：结果也不要变成一张卡片
        if (mapped.callId && hiddenCalls.has(mapped.callId)) {
          hiddenCalls.delete(mapped.callId);
          clearActivity();
          return;
        }
        // 别把工具自己的 XML 包装吐给用户（例如 read 工具返回 <path>/<content>）
        const s = summarizeToolResult(mapped.entry && mapped.entry.name, mapped.patch && mapped.patch.result);
        const patch2 = Object.assign({}, mapped.patch, { summary: s.summary });
        if (s.body !== null) patch2.result = s.body;
        const found = findToolEntry(mapped.callId);
        if (found) patch(found.id, patch2);
        else add(Object.assign({ id: `tr-${Date.now()}`, role: 'tool', name: 'tool result' }, patch2));
        clearActivity();
        postMeta();
        return;
      }
      case 'turn-end':
        running = false;
        clearActivity();
        postMeta();
        return;
      default:
        return;
    }
  }

  function onStatus(params) {
    running = !!(params && params.status === 'running');
    runningSince = running ? runningSince || Date.now() : 0;
    // 状态只改状态与计时；界面渲染由 webview 自己负责（这里曾误留 document/list 操作，导致通知链抛错）
    // 本轮结束：把本轮的改动卡片挪到对话末尾（"本轮聊天的最后"），历史轮次的卡片留在原处往上走
    if (!running) refreshChangesCard(true);
    postMeta();
  }

  async function ensureClient() {
    if (client && client.initialized) return client;
    if (starting) return starting;
    starting = (async () => {
      const cwd = deps.getWorkspaceRoot();
      if (!cwd) throw new Error('当前窗口没有打开文件夹，无法确定工作目录');
      const mode = chatPermissionMode();
      const env = mode ? { DSH_PERMISSION_MODE: mode } : undefined;
      const reasoningEffort = chatReasoningEffort();
      // 叠层：用 --patch 把 VS Code 桥挂进 sdk profile。
      // 没有它的话，只读沙箱会让 agent 既写不了文件、又没有"提案改文件"的工具可用，
      // 表现就是"要么什么都不写，要么直接落盘"。
      const overlay = deps.getOverlayPath ? deps.getOverlayPath() : undefined;
      const c = new SdkClient({
        launcher: chatLauncher(),
        profile: chatProfile(),
        cwd,
        model: chatModel(),
        provider: chatProvider(),
        timeoutMs: 120000,
        env,
        reasoningEffort,
        patchPaths: overlay ? [overlay] : []
      });
      c.on('event', onEvent);
      c.on('status', onStatus);
      c.on('stderr', (l) => log(`sdk stderr: ${l}`));
      c.on('exit', ({ code }) => {
        log(`sdk 退出 code=${code}`);
        add({ id: `sys-${Date.now()}`, role: 'system', text: `DSH 进程已退出（code=${code}）` });
        client = null;
        running = false;
        postMeta();
      });
      log(`启动 SDK 子进程 cwd=${cwd} model=${chatModel()} perm=${mode || '(默认)'} 叠层=${overlay ? '有' : '无'}`);
      await c.start();
      client = c;
      newEpoch();
      log(`SDK 就绪 ${JSON.stringify(c.serverInfo)} 会话纪元=${epoch}`);
      // 直写模式必须明确告知：这种模式下 agent 自己就能写文件，不经过审核
      if (isDirectWriteMode(mode)) {
        const label = (PERMISSION_MODES.find((m) => m.id === mode) || {}).name || mode || '默认';
        add({
          id: `sys-${Date.now()}`,
          role: 'system',
          text: `注意：编辑模式是「${label}」——agent 可以直接写文件，不经过审核阶段。想要每处改动都由你点接受，请把下方「编辑」切到「只读：改文件必须审核」。`
        });
      }
      return c;
    })();
    try {
      return await starting;
    } finally {
      starting = null;
      postMeta();
    }
  }

  function formatTime(ts) {
    const d = new Date(ts || Date.now());
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return y + '-' + mo + '-' + da + ' ' + h + ':' + m;
  }

  async function handleSend(text) {
    log(`handleSend 开始：${text.slice(0, 40)}`);
    let sess = activeSession(state);
    if (!sess) {
      sess = addSession(state); // 新会话 turn 已初始化为 1
    } else if ((sess.entries || []).length) {
      sess.turn = currentTurn(sess) + 1; // 又一轮对话
      log(`进入第 ${sess.turn} 轮`);
    }
    await persist();
    add({ id: `u-local-${Date.now()}`, role: 'user', text, local: true, time: formatTime() });
    running = true;
    postMeta();
    try {
      const c = await ensureClient();
      await c.prompt(dshSessionId(), text);
    } catch (err) {
      running = false;
      // 兜底：服务端的 agents.create 要求 sessionId 在持久存储里全局唯一，
      // 万一还是撞上（例如同工作区的另一个窗口用掉了同一个 id），
      // 就换一个纪元、在**同一个对话里**重试 —— 而不是静默新建一个会话。
      if (err.message && err.message.includes('already exists')) {
        newEpoch();
        log(`会话 id 冲突，换纪元重试=${epoch}`);
        try {
          const c = await ensureClient();
          await c.prompt(dshSessionId(), text);
          return;
        } catch (retryErr) {
          add({ id: `err-${Date.now()}`, role: 'system', text: `发送失败：${retryErr.message}` });
          postMeta();
          return;
        }
      }
      add({ id: `err-${Date.now()}`, role: 'system', text: `发送失败：${err.message}` });
      postMeta();
    }
  }

  const provider = {
    async resolveWebviewView(webviewView) {
    log('对话视图已解析（webview 即将加载）');
      view = webviewView;
      webviewView.webview.options = { enableScripts: true };
      // nonce 必须是随机值：cspSource 是 URL（含 : 和 .），当 nonce 用会让整条 CSP 失效
      webviewView.webview.html = html(webviewView.webview.cspSource, nonce());

      webviewView.webview.onDidReceiveMessage(async (m) => {
        if (!m) return;
        if (m.type === 'ready') {
          log(`webview ready：会话数=${state.sessions.length} 活动会话=${state.activeId || '(无)'}`);
          postReset();
          if (!activeSession(state)) {
            addSession(state);
            await persist();
            postMeta();
          }
          if (!entries().length) {
            add({
              id: `welcome-${Date.now()}`,
              role: 'system',
              text: '会话根 = 本窗口文件夹。首次发送时会启动 DSH 子进程。'
            });
          }
          ensureClient().catch((err) =>
            add({ id: `err-${Date.now()}`, role: 'system', text: `启动失败：${err.message}` })
          );
          return;
        }
        if (m.type === 'send') {
          log(`webview send：${String(m.text || '').slice(0, 40)}`);
          handleSend(m.text).catch((err) =>
            add({ id: `err-${Date.now()}`, role: 'system', text: `发送失败：${err.message}` })
          );
          return;
        }
        if (m.type === 'stop') {
          // 中断当前对话
          if (client) {
            try { client.shutdown(); } catch { /* ignore */ }
            client = null;
          }
          running = false;
          add({ id: `sys-${Date.now()}`, role: 'system', text: '已停止生成' });
          postMeta();
          return;
        }
        if (m.type === 'switch') {
          if (switchSession(state, m.id)) {
            await persist();
            postReset();
          }
          return;
        }
        if (m.type === 'newSession') {
          addSession(state);
          await persist();
          postReset();
          return;
        }
        if (m.type === 'deleteSession') {
          if (state.activeId) removeSession(state, state.activeId);
          if (!state.sessions.length) addSession(state);
          await persist();
          postReset();
          return;
        }
        if (m.type === 'openReviewDiff') {
          // 点待审条里的一行 -> 打开该文件的 diff 预览
          const b = deps.getBatch ? deps.getBatch() : null;
          const entry = b && b.files ? b.files.find((f) => f.path === m.path) : null;
          if (entry && deps.reviewActions) await deps.reviewActions.openDiff(entry);
          return;
        }
        if (m.type === 'acceptAllReview') {
          if (deps.reviewActions) await deps.reviewActions.acceptAll();
          postMeta();
          return;
        }
        if (m.type === 'rejectAllReview') {
          if (deps.reviewActions) await deps.reviewActions.rejectAll();
          postMeta();
          return;
        }
        if (m.type === 'openPath') {
          try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(m.path));
            await vscode.window.showTextDocument(doc, { preview: false });
          } catch (err) {
            vscode.window.showWarningMessage(`\u6253\u4e0d\u5f00\u8be5\u6587\u4ef6\uff1a${err.message}`);
          }
          return;
        }
        if (m.type === 'openChange') {
          try {
            await openChangeAt(m.path, m.line, m.added, m.changeId);
          } catch (err) {
            vscode.window.showWarningMessage(`打不开该文件：${err.message}`);
          }
          return;
        }
        if (m.type === 'focusReview') {
          await vscode.commands.executeCommand('dsh-bridge.focusReview');
          return;
        }
        if (m.type === 'ctrlChange') {
          await handleCtrlChange(m.key, m.value);
          postMeta();
          return;
        }
      });

      webviewView.onDidDispose(() => {
        view = null;
      });
    }
  };

  return {
    VIEW_ID,
    provider,
    noteChanges,
    noteBatchChanged,
    async dispose() {
      await persist();
      if (client) {
        try {
          await client.shutdown();
        } catch {
          /* ignore */
        }
        client = null;
      }
    }
  };
}

module.exports = { createChatUi, VIEW_ID, html };
