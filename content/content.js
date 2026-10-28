/*!
 * AI 答题助手 · 内容脚本
 * 顶层 frame：悬浮球 + 答题面板；所有 frame：题目识别 API + 手动框选。
 */
(function () {
  'use strict';

  if (globalThis.__AIQA_CONTENT__) return;
  globalThis.__AIQA_CONTENT__ = true;

  const Ext = globalThis.AIQAExtract;
  if (!Ext) return;

  const IS_TOP = (function () {
    try { return window.top === window; } catch (e) { return false; }
  })();

  const Z_INDEX = 2147483000;
  const DEMO = globalThis.__AIQA_DEMO__ || null;

  /* ------------------------------ 后台连接 ------------------------------ */

  const backend = (function () {
    if (DEMO) return DEMO;
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return null;

    const send = (msg) => new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          swallowLastError();
          resolve(resp || null);
        });
      } catch (e) { resolve(null); }
    });

    return {
      name: 'chrome',
      getSettings: () => send({ type: 'GET_SETTINGS' }).then((r) => (r && r.ok ? r.settings : null)),
      extract: () => send({ type: 'EXTRACT' }),
      capture: (rect, dpr) => send({ type: 'CAPTURE', rect: rect, dpr: dpr }),
      openOptions: () => send({ type: 'OPEN_OPTIONS' }),
      startPick: () => send({ type: 'PICK_START' }),
      stopPick: () => send({ type: 'PICK_STOP' }),
      relayPick: (snapshot) => send({ type: 'PICK_RESULT', snapshot: snapshot }),
      ask: function (payload, h) {
        let port;
        try {
          port = chrome.runtime.connect({ name: 'aiqa' });
        } catch (e) {
          h.onError({ error: '扩展后台还没就绪，请刷新页面后再试。' });
          return { abort: function () {} };
        }
        let settled = false;
        port.onMessage.addListener(function (msg) {
          if (!msg) return;
          if (msg.type === 'delta') h.onDelta(msg.text || '');
          else if (msg.type === 'reason') { if (h.onReason) h.onReason(msg.text || ''); }
          else if (msg.type === 'start') { if (h.onStart) h.onStart(msg); }
          else if (msg.type === 'done') { settled = true; h.onDone(msg); try { port.disconnect(); } catch (e) {} }
          else if (msg.type === 'aborted') { settled = true; if (h.onAbort) h.onAbort(msg); try { port.disconnect(); } catch (e) {} }
          else if (msg.type === 'error') { settled = true; h.onError(msg); try { port.disconnect(); } catch (e) {} }
        });
        port.onDisconnect.addListener(function () {
          if (!settled) {
            settled = true;
            h.onError({ error: '与扩展后台的连接中断了，请重试。' });
          }
        });
        try {
          port.postMessage({
            type: 'ASK',
            question: payload.question,
            image: payload.image,
            pageTitle: payload.pageTitle,
            kind: payload.kind
          });
        } catch (e) {
          h.onError({ error: '发送请求失败：' + (e && e.message ? e.message : e) });
        }
        return {
          abort: function () {
            try { port.postMessage({ type: 'ABORT' }); } catch (e) {}
            setTimeout(function () { try { port.disconnect(); } catch (e) {} }, 400);
          }
        };
      }
    };
  })();

  /* ------------------------------ 状态 ------------------------------ */

  const state = {
    open: false,
    running: false,
    question: '',
    kind: '',
    snapshot: null,
    frameId: 0,
    answer: '',
    reason: '',
    settings: null,
    handle: null,
    edited: false,
    lastElapsed: 0
  };

  /* ------------------------------ 工具 ------------------------------ */

  /** 安全读取 chrome.runtime.lastError（某些环境没有 chrome.runtime） */
  function swallowLastError() {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime) void chrome.runtime.lastError;
    } catch (e) { /* ignore */ }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function inlineMd(s) {
    let t = escapeHtml(s);
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|\s)__([^_]+)__(?=\s|$)/g, '$1<strong>$2</strong>');
    return t;
  }

  /** 极简 Markdown 渲染（答案排版够用，不引第三方库） */
  function renderMarkdown(text, streaming) {
    const lines = String(text || '').split('\n');
    let html = '';
    let inList = false;
    let inCode = false;
    let codeBuf = [];

    function closeList() {
      if (inList) { html += '</ul>'; inList = false; }
    }

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.replace(/\s+$/, '');
      const trimmed = line.trim();

      if (/^```/.test(trimmed)) {
        if (inCode) {
          html += '<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>';
          codeBuf = [];
          inCode = false;
        } else {
          closeList();
          inCode = true;
        }
        continue;
      }
      if (inCode) { codeBuf.push(raw); continue; }

      if (!trimmed) { closeList(); continue; }

      const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
      if (heading) {
        closeList();
        const level = Math.min(4, heading[1].length + 2);
        html += '<h' + level + '>' + inlineMd(heading[2]) + '</h' + level + '>';
        continue;
      }

      const tag = /^【([^】]{1,10})】(.*)$/.exec(trimmed);
      if (tag) {
        closeList();
        const label = tag[1];
        const cls = /答案|结论/.test(label) ? 'hl answer-line'
          : /解析|分析|理由/.test(label) ? 'hl parse-line'
            : 'hl';
        html += '<div class="' + cls + '"><b>' + escapeHtml(label) + '：</b>' +
          (tag[2].trim() ? inlineMd(tag[2].trim()) : '') + '</div>';
        continue;
      }

      if (/^(\s*)([-*•]|\d{1,2}[.、)]|[（(]\d{1,2}[)）])\s+/.test(line) || /^\s*[-*•]\s*/.test(line)) {
        if (!inList) { html += '<ul>'; inList = true; }
        html += '<li>' + inlineMd(trimmed.replace(/^([-*•]|\d{1,2}[.、)]|[（(]\d{1,2}[)）])\s*/, '')) + '</li>';
        continue;
      }

      closeList();
      const opt = /^([A-Ha-h])\s*[.、．:：)）]\s*(.+)$/.exec(trimmed);
      if (opt) {
        html += '<div class="opt"><b>' + opt[1].toUpperCase() + '</b><span>' + inlineMd(opt[2]) + '</span></div>';
        continue;
      }

      html += '<p>' + inlineMd(trimmed) + '</p>';
    }

    if (inCode && codeBuf.length) {
      html += '<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>';
    }
    closeList();
    if (streaming) html += '<span class="caret"></span>';
    return html || '';
  }

  function toast(text, ms) {
    if (!refs.toast) return;
    refs.toast.textContent = text;
    refs.toast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { refs.toast.classList.remove('show'); }, ms || 2000);
  }

  /* ------------------------------ 样式 ------------------------------ */

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
[hidden] { display: none !important; }

.root {
  position: fixed; left: 0; top: 0; width: 0; height: 0;
  z-index: ${Z_INDEX};
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif;
  font-size: 13px; line-height: 1.6; color: #0f172a;
  -webkit-font-smoothing: antialiased;
}
.root * { box-sizing: border-box; }

.fab {
  position: fixed; right: 20px; bottom: 20px;
  width: 46px; height: 46px; border-radius: 50%;
  border: none; padding: 0; cursor: pointer;
  background: linear-gradient(135deg, #4f7cff 0%, #7c5cff 55%, #a855f7 100%);
  box-shadow: 0 8px 22px rgba(79, 124, 255, .38), 0 2px 6px rgba(15, 23, 42, .18);
  display: flex; align-items: center; justify-content: center;
  color: #fff; transition: transform .16s ease, box-shadow .16s ease, opacity .16s ease;
  touch-action: none; user-select: none;
}
.fab:hover { transform: translateY(-2px) scale(1.04); box-shadow: 0 12px 28px rgba(79,124,255,.48); }
.fab:active { transform: scale(.96); }
.fab svg { width: 24px; height: 24px; display: block; pointer-events: none; }
.fab.dragging { transition: none; cursor: grabbing; }
.fab[hidden] { display: none; }

.panel {
  position: fixed; width: 400px; max-width: calc(100vw - 24px);
  display: flex; flex-direction: column; overflow: hidden;
  background: #ffffff;
  border: 1px solid rgba(15, 23, 42, .08);
  border-radius: 16px;
  box-shadow: 0 18px 50px rgba(15, 23, 42, .18), 0 2px 8px rgba(15, 23, 42, .06);
  outline: none;
  animation: aiqa-pop .16s ease-out;
}
.panel[hidden] { display: none; }
@keyframes aiqa-pop { from { opacity: 0; transform: translateY(6px) scale(.985); } to { opacity: 1; transform: none; } }

.head {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; border-bottom: 1px solid #eef2f7;
  background: linear-gradient(180deg, #fbfcff 0%, #ffffff 100%);
}
.brand { display: flex; align-items: center; gap: 7px; font-weight: 650; font-size: 13px; letter-spacing: .2px; }
.brand-dot {
  width: 18px; height: 18px; border-radius: 6px; flex: none;
  background: linear-gradient(135deg, #4f7cff, #a855f7);
  color: #fff; font-size: 11px; display: flex; align-items: center; justify-content: center;
}
.model-chip {
  font-weight: 500; font-size: 11px; color: #64748b; background: #f1f5f9;
  padding: 1px 7px; border-radius: 999px; max-width: 150px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.spacer { flex: 1; }

.icon-btn {
  width: 26px; height: 26px; border-radius: 8px; border: none; cursor: pointer;
  background: transparent; color: #64748b; display: flex; align-items: center; justify-content: center;
  font-size: 14px; line-height: 1; transition: background .12s, color .12s;
}
.icon-btn:hover { background: #f1f5f9; color: #0f172a; }

.qbox { padding: 10px 12px 8px; border-bottom: 1px solid #f1f5f9; background: #fafbfe; }
.qbox-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.tag {
  font-size: 11px; color: #4f7cff; background: #eef3ff; border: 1px solid #dbe6ff;
  padding: 0 7px; border-radius: 999px; line-height: 18px; font-weight: 600; white-space: nowrap;
  cursor: pointer; user-select: none; transition: background .12s, border-color .12s;
}
.tag:hover { background: #e3ecff; border-color: #c3d5ff; }
.tag.manual { color: #7c3aed; background: #f5f0ff; border-color: #e6dcff; }
.tag.idle { color: #94a3b8; background: #f8fafc; border-color: #e8edf4; }
.link-btn {
  border: none; background: transparent; color: #64748b; cursor: pointer;
  font-size: 11.5px; padding: 2px 5px; border-radius: 6px;
}
.link-btn:hover { background: #eef2f7; color: #334155; }

.qtext {
  max-height: 150px; overflow: auto; white-space: pre-wrap; word-break: break-word;
  font-size: 12.5px; line-height: 1.62; color: #334155;
  padding-right: 4px; overscroll-behavior: contain;
}
.qtext.muted { color: #94a3b8; }
.qtext::-webkit-scrollbar, .answer::-webkit-scrollbar { width: 6px; }
.qtext::-webkit-scrollbar-thumb, .answer::-webkit-scrollbar-thumb { background: #dbe3ee; border-radius: 3px; }

textarea.qedit {
  width: 100%; min-height: 92px; max-height: 200px; resize: vertical;
  border: 1px solid #dbe3ee; border-radius: 8px; padding: 8px; font: inherit;
  font-size: 12.5px; line-height: 1.6; color: #0f172a; background: #fff; outline: none;
}
textarea.qedit:focus { border-color: #9db4ff; box-shadow: 0 0 0 3px rgba(79,124,255,.12); }

.toolbar { display: flex; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #f1f5f9; flex-wrap: wrap; }
.btn {
  appearance: none; border: 1px solid #e2e8f2; background: #fff; color: #334155;
  height: 32px; padding: 0 13px; border-radius: 9px; cursor: pointer;
  font-size: 12.5px; font-weight: 500; font-family: inherit;
  transition: background .12s, border-color .12s, transform .1s;
  display: inline-flex; align-items: center; gap: 6px;
}
.btn:hover { background: #f8fafc; border-color: #d3dcea; }
.btn:active { transform: translateY(1px); }
.btn:disabled { opacity: .5; cursor: not-allowed; transform: none; }
.btn.primary {
  color: #fff; border-color: transparent;
  background: linear-gradient(135deg, #4f7cff 0%, #7c5cff 100%);
  box-shadow: 0 3px 10px rgba(79,124,255,.28); padding: 0 16px;
}
.btn.primary:hover { background: linear-gradient(135deg, #416ef0 0%, #6f4ff0 100%); }
.btn.ghost { background: #fff5f5; border-color: #ffd9d9; color: #dc2626; }
.btn.ghost:hover { background: #ffeded; }

.answer {
  flex: 1 1 auto; min-height: 96px; max-height: 46vh; overflow: auto;
  padding: 12px 14px; font-size: 13px; line-height: 1.72; color: #1e293b;
  overscroll-behavior: contain;
}
.answer .empty { color: #94a3b8; font-size: 12.5px; line-height: 1.7; padding: 6px 2px; }
.answer p { margin: 0 0 8px; }
.answer p:last-child { margin-bottom: 0; }
.answer h3, .answer h4, .answer h5, .answer h6 { margin: 12px 0 6px; font-size: 13.5px; font-weight: 650; }
.answer ul { margin: 4px 0 8px; padding-left: 18px; }
.answer li { margin: 2px 0; }
.answer code {
  background: #f1f5f9; border-radius: 4px; padding: 1px 4px;
  font-family: ui-monospace, Consolas, monospace; font-size: 12px;
}
.answer pre {
  background: #f8fafc; border: 1px solid #eef2f7; border-radius: 8px;
  padding: 8px 10px; overflow: auto; margin: 8px 0;
}
.answer .hl {
  background: #f4f8ff; border-left: 3px solid #4f7cff;
  padding: 7px 10px; border-radius: 0 8px 8px 0; margin: 8px 0;
  white-space: pre-wrap; word-break: break-word;
}
.answer .hl b { color: #4f7cff; font-weight: 650; }
.answer .hl b + * { margin-left: 2px; }
.answer .answer-line { background: #f0f7ff; border-left-color: #2563eb; font-size: 13.5px; }
.answer .answer-line b { color: #2563eb; }
.answer .parse-line { background: #fbfaff; border-left-color: #a855f7; }
.answer .parse-line b { color: #9333ea; }
.answer .opt { display: flex; gap: 6px; margin: 3px 0; padding-left: 2px; }
.answer .opt b { color: #64748b; flex: none; min-width: 14px; }
.answer .opt.correct b { color: #16a34a; }
.answer .caret {
  display: inline-block; width: 7px; height: 15px; margin-left: 2px;
  background: #4f7cff; vertical-align: -2px; border-radius: 1px;
  animation: aiqa-blink 1s steps(2, start) infinite;
}
@keyframes aiqa-blink { to { visibility: hidden; } }

.note { font-size: 12px; color: #64748b; padding: 2px 0 6px; }
.err {
  background: #fff5f5; border: 1px solid #ffd9d9; color: #b91c1c;
  border-radius: 10px; padding: 9px 11px; font-size: 12.5px; white-space: pre-wrap; word-break: break-word;
}
.err .row { display: flex; gap: 8px; margin-top: 8px; }
.thinking {
  font-size: 12px; color: #7c3aed; background: #faf7ff; border: 1px dashed #e5d9ff;
  border-radius: 9px; padding: 7px 10px; margin-bottom: 10px; white-space: pre-wrap;
  max-height: 96px; overflow: auto;
}
.thinking summary { cursor: pointer; color: #7c3aed; font-weight: 600; outline: none; }

.foot {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px; border-top: 1px solid #f1f5f9; background: #fcfdff;
  font-size: 11px; color: #94a3b8; min-height: 27px;
}
.foot .grow { flex: 1; }
.foot-btn { font-size: 11px; padding: 1px 6px; color: #94a3b8; }
.foot-btn:hover { color: #dc2626; background: #fff1f1; }

.toast {
  position: fixed; left: 50%; transform: translateX(-50%) translateY(8px);
  background: rgba(15, 23, 42, .92); color: #fff; font-size: 12px;
  padding: 7px 14px; border-radius: 999px; opacity: 0; pointer-events: none;
  transition: opacity .2s, transform .2s; white-space: nowrap; max-width: 80vw;
  overflow: hidden; text-overflow: ellipsis;
}
.toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

@media (prefers-color-scheme: dark) {
  .panel { background: #16181d; border-color: #2a2d35; box-shadow: 0 18px 50px rgba(0,0,0,.6); }
  .head { background: #191c22; border-bottom-color: #262a32; }
  .brand { color: #e8ecf3; }
  .qbox { background: #14161b; border-bottom-color: #23262d; }
  .qtext { color: #c7cedb; }
  .answer { color: #dbe2ec; }
  .btn { background: #1d2027; border-color: #2c3039; color: #cfd6e2; }
  .btn:hover { background: #23272f; }
  .toolbar { border-bottom-color: #23262d; }
  .foot { background: #171a1f; border-top-color: #23262d; }
  textarea.qedit { background: #14161b; border-color: #2c3039; color: #e8ecf3; }
  .answer .hl { background: #1a2136; }
  .answer .answer-line { background: #17233c; }
  .answer .parse-line { background: #211a33; }
  .answer code { background: #23272f; }
  .answer pre { background: #14161b; border-color: #262a32; }
  .err { background: #2a1a1c; border-color: #4c2326; color: #fca5a5; }
  .err .btn { background: #2f2024; border-color: #4c2326; color: #fecaca; }
  .err .btn.primary { background: linear-gradient(135deg, #4f7cff, #7c5cff); color: #fff; }
  .thinking { background: #1c1830; border-color: #3a2d5e; color: #c4b5fd; }
}

@media print { .root { display: none !important; } }
`;

  /* ------------------------------ DOM ------------------------------ */

  const refs = {};

  function buildUI() {
    const host = document.createElement('div');
    host.id = 'aiqa-shadow-host';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${CSS}</style>
      <div class="root">
        <button class="fab" title="AI 答题助手（Alt+Q）" aria-label="AI 答题助手">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 2.6l1.72 5.1 5.1 1.72-5.1 1.72L12 16.24l-1.72-5.1-5.1-1.72 5.1-1.72L12 2.6z" fill="currentColor"/>
            <path d="M18.6 14.4l.86 2.55 2.55.86-2.55.86-.86 2.55-.86-2.55-2.55-.86 2.55-.86.86-2.55z" fill="currentColor" opacity=".85"/>
          </svg>
        </button>
        <section class="panel" hidden tabindex="-1" aria-label="AI 答题面板">
          <header class="head">
            <div class="brand"><span class="brand-dot">✦</span>AI 答题</div>
            <span class="model-chip" data-role="model" hidden></span>
            <span class="spacer"></span>
            <button class="icon-btn" data-act="options" title="设置">⚙</button>
            <button class="icon-btn" data-act="close" title="关闭（Esc）">✕</button>
          </header>

          <div class="qbox">
            <div class="qbox-head">
              <span class="tag idle" data-role="kind" data-act="kind" title="点一下切换题型（单选 / 多选 / 判断 / 填空 / 简答）">识别中…</span>
              <span class="spacer"></span>
              <button class="link-btn" data-act="pick">手动选中</button>
              <button class="link-btn" data-act="rescan">重新识别</button>
              <button class="link-btn" data-act="edit">编辑</button>
            </div>
            <div class="qtext" data-role="qtext"></div>
            <textarea class="qedit" data-role="qedit" placeholder="在这里修改题目文本…" hidden></textarea>
          </div>

          <div class="toolbar">
            <button class="btn primary" data-act="ask"><span data-role="asklabel">开始作答</span></button>
            <button class="btn" data-act="shot">截图问 AI</button>
            <button class="btn" data-act="copy" hidden data-role="copy">复制答案</button>
            <button class="btn ghost" data-act="stop" hidden>停止</button>
          </div>

          <div class="answer" data-role="answer">
            <div class="empty">点「开始作答」，AI 会读取上方题目并给出答案与解析。</div>
          </div>

          <footer class="foot">
            <span class="grow" data-role="status"></span>
            <button class="link-btn foot-btn" data-act="site-off" title="在本网站隐藏悬浮球，可随时恢复">本站隐藏</button>
            <span data-role="shortcut">Alt + Q</span>
          </footer>
        </section>
        <div class="toast" data-role="toast"></div>
      </div>
    `;

    document.documentElement.appendChild(host);

    refs.host = host;
    refs.shadow = shadow;
    refs.fab = shadow.querySelector('.fab');
    refs.panel = shadow.querySelector('.panel');
    refs.model = shadow.querySelector('[data-role="model"]');
    refs.kind = shadow.querySelector('[data-role="kind"]');
    refs.qtext = shadow.querySelector('[data-role="qtext"]');
    refs.qedit = shadow.querySelector('[data-role="qedit"]');
    refs.answer = shadow.querySelector('[data-role="answer"]');
    refs.status = shadow.querySelector('[data-role="status"]');
    refs.toast = shadow.querySelector('[data-role="toast"]');
    refs.askBtn = shadow.querySelector('[data-act="ask"]');
    refs.askLabel = shadow.querySelector('[data-role="asklabel"]');
    refs.stopBtn = shadow.querySelector('[data-act="stop"]');
    refs.copyBtn = shadow.querySelector('[data-act="copy"]');
    refs.editBtn = shadow.querySelector('[data-act="edit"]');
    refs.shortcut = shadow.querySelector('[data-role="shortcut"]');

    bindEvents();
    restoreFabPosition();
  }

  /* ------------------------------ 面板行为 ------------------------------ */

  function isOpen() { return state.open; }

  function positionPanel() {
    if (!refs.panel) return;
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    const fab = refs.fab.getBoundingClientRect();
    const width = Math.min(400, vw - 24);
    const left = Math.min(Math.max(12, fab.right - width), Math.max(12, vw - width - 12));

    refs.panel.style.width = width + 'px';
    refs.panel.style.left = left + 'px';

    if (fab.top > vh * 0.46) {
      refs.panel.style.bottom = Math.max(12, vh - fab.top + 12) + 'px';
      refs.panel.style.top = 'auto';
    } else {
      refs.panel.style.top = Math.max(12, fab.bottom + 12) + 'px';
      refs.panel.style.bottom = 'auto';
    }
    refs.panel.style.maxHeight = Math.min(vh - 24, 640) + 'px';
  }

  function openPanel() {
    if (!refs.panel) return;
    if (state.open) return;
    state.open = true;
    refs.panel.hidden = false;
    positionPanel();
    refreshQuestion();
    try { refs.panel.focus({ preventScroll: true }); } catch (e) {}
    loadSettings();
  }

  function closePanel() {
    if (!state.open) return;
    state.open = false;
    refs.panel.hidden = true;
  }

  function togglePanel() {
    if (state.open) closePanel(); else openPanel();
  }

  function loadSettings() {
    if (!backend || !backend.getSettings) return Promise.resolve(null);
    return backend.getSettings().then(function (s) {
      state.settings = s;
      if (!s) return null;
      if (s.model) {
        refs.model.textContent = s.model;
        refs.model.hidden = false;
      }
      if (!s.hasApiKey) {
        refs.status.textContent = '尚未填写 API Key';
        showNeedKey();
      } else if (!state.answer && refs.answer.querySelector('[data-act="open-options"]')) {
        // 刚在设置页填好 Key 回来，把提示卡片换回待作答状态
        refs.answer.innerHTML = '<div class="empty">点「开始作答」，AI 会读取上方题目并给出答案与解析。</div>';
        refs.status.textContent = '';
      }
      return s;
    }).catch(function () { return null; });
  }

  function showNeedKey() {
    if (state.running || state.answer) return;
    refs.status.textContent = '尚未填写 API Key';
    refs.answer.innerHTML =
      '<div class="err">还没有配置 AI 接口。<br>点右上角 ⚙ 填写 API Key（支持 DeepSeek / OpenAI / 通义 / Kimi / 智谱 / Ollama 等任意 OpenAI 兼容接口）。' +
      '<div class="row"><button class="btn primary" data-act="open-options">去设置</button></div></div>';
    const btn = refs.answer.querySelector('[data-act="open-options"]');
    if (btn) btn.addEventListener('click', openOptions);
    refs.copyBtn.hidden = true;
  }

  function openOptions() {
    if (backend && backend.openOptions) backend.openOptions();
    else {
      refs.answer.innerHTML = '<div class="err">请在浏览器右上角的扩展图标里打开「设置」。</div>';
    }
  }

  function refreshQuestion() {
    refs.kind.className = 'tag idle';
    refs.kind.textContent = '识别中…';
    refs.qtext.classList.add('muted');
    refs.qtext.textContent = '正在读取页面题目…';

    const fallback = function () {
      const snap = Ext.snapshot();
      applySnapshot(snap, 0);
    };

    if (!backend || !backend.extract) { fallback(); return; }

    backend.extract().then(function (resp) {
      if (resp && resp.ok && resp.snapshot) {
        applySnapshot(resp.snapshot, resp.frameId || 0);
      } else {
        fallback();
      }
    }).catch(fallback);
  }

  function applySnapshot(snap, frameId) {
    if (!snap || !snap.ok || !snap.text) {
      state.question = '';
      state.kind = '';
      state.snapshot = null;
      refs.kind.className = 'tag idle';
      refs.kind.textContent = '未识别';
      refs.qtext.classList.add('muted');
      refs.qtext.textContent = '没找到题目。可以点「手动选中」在页面上框选题目，或直接「截图问 AI」。';
      return;
    }
    const changed = snap.text !== state.question;
    state.question = snap.text;
    state.kind = snap.kind || '';
    state.snapshot = snap;
    state.frameId = frameId || 0;
    state.edited = false;

    if (changed) {
      state.answer = '';
      state.reason = '';
      state.lastElapsed = 0;
      refs.copyBtn.hidden = true;
      refs.askLabel.textContent = '开始作答';
      if (state.settings && !state.settings.hasApiKey) {
        showNeedKey();
      } else {
        refs.answer.innerHTML = '<div class="empty">点「开始作答」，AI 会读取上方题目并给出答案与解析。</div>';
      }
    }

    refs.kind.className = 'tag';
    refs.kind.textContent = snap.kind || '题目';
    refs.qtext.classList.remove('muted');
    refs.qtext.textContent = snap.text;
    refs.qedit.value = snap.text;
    refs.qedit.hidden = true;
    refs.qtext.hidden = false;
    if (refs.editBtn) refs.editBtn.textContent = '编辑';

    if (snap.title) refs.status.textContent = snap.title.slice(0, 60);
  }

  /* ------------------------------ 作答 ------------------------------ */

  function setRunning(running) {
    state.running = running;
    refs.askBtn.disabled = running;
    refs.stopBtn.hidden = !running;
    refs.askLabel.textContent = running ? '作答中…' : (state.answer ? '重新作答' : '开始作答');
  }

  function renderAnswer() {
    const nearBottom = refs.answer.scrollHeight - refs.answer.scrollTop - refs.answer.clientHeight < 60;
    let html = '';
    if (state.reason) {
      html += '<details class="thinking"' + (state.answer ? '' : ' open') + '><summary>深度思考过程</summary>' +
        escapeHtml(state.reason).slice(0, 4000) + '</details>';
    }
    html += renderMarkdown(state.answer, state.running);
    refs.answer.innerHTML = html || '<div class="empty">正在等待模型响应…</div>';
    if (nearBottom) refs.answer.scrollTop = refs.answer.scrollHeight;
  }

  // 流式增量很密，合并到每帧渲染一次即可
  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    (window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); })(function () {
      renderQueued = false;
      renderAnswer();
    });
  }

  function askCurrent() {
    if (state.running) return;
    if (!backend) {
      refs.answer.innerHTML = '<div class="err">扩展后台未连接，请刷新页面后重试。</div>';
      return;
    }
    if (!state.question.trim()) {
      toast('没有题目文本，请先「手动选中」或「截图问 AI」');
      return;
    }
    if (state.settings && !state.settings.hasApiKey) {
      loadSettings().then(function (s) {
        if (s && s.hasApiKey) askCurrent();
        else showNeedKey();
      });
      return;
    }

    startAsk({ question: state.question, kind: state.kind, image: '' });
  }

  function startAsk(payload) {
    // 限流：防止误触或页面脚本合成点击疯狂刷接口、烧掉额度
    const now = Date.now();
    if (now - state.lastAskAt < 1500) {
      toast('刚发过请求，请稍等一下');
      return;
    }
    state.lastAskAt = now;

    state.answer = '';
    state.reason = '';
    state.lastElapsed = 0;
    refs.copyBtn.hidden = true;
    refs.answer.innerHTML = '<div class="empty">正在请求模型…</div>';
    setRunning(true);
    refs.status.textContent = '请求中…';

    const startedAt = Date.now();
    const snapshot = state.snapshot || {};

    state.handle = backend.ask({
      question: payload.question || '',
      kind: payload.kind || '',
      image: payload.image || '',
      pageTitle: (snapshot.title || document.title || '').slice(0, 160)
    }, {
      onStart: function (m) {
        if (m && m.model) {
          refs.model.textContent = m.model;
          refs.model.hidden = false;
        }
        refs.status.textContent = '生成中…';
      },
      onReason: function (text) {
        state.reason += text;
        scheduleRender();
      },
      onDelta: function (text) {
        state.answer += text;
        scheduleRender();
      },
      onDone: function (m) {
        setRunning(false);
        state.handle = null;
        renderAnswer();
        const elapsed = m && m.elapsed ? m.elapsed : Date.now() - startedAt;
        state.lastElapsed = elapsed;
        refs.status.textContent = (m && m.model ? m.model + ' · ' : '') + (elapsed / 1000).toFixed(1) + 's';
        refs.copyBtn.hidden = !state.answer;
        refs.askLabel.textContent = '重新作答';
      },
      onAbort: function () {
        setRunning(false);
        state.handle = null;
        renderAnswer();
        refs.status.textContent = '已停止';
        refs.copyBtn.hidden = !state.answer;
      },
      onError: function (err) {
        setRunning(false);
        state.handle = null;
        const message = (err && (err.error || err.message)) || '未知错误';
        const partial = err && err.partial ? err.partial : state.answer;
        refs.answer.innerHTML = (partial ? renderMarkdown(partial, false) : '') +
          '<div class="err">' + escapeHtml(message) +
          '<div class="row"><button class="btn" data-act="retry">重试</button>' +
          (err && err.code === 'NO_KEY' ? '<button class="btn primary" data-act="open-options">去设置</button>' : '') +
          '</div></div>';
        const retry = refs.answer.querySelector('[data-act="retry"]');
        if (retry) retry.addEventListener('click', function () { askCurrent(); });
        const opt = refs.answer.querySelector('[data-act="open-options"]');
        if (opt) opt.addEventListener('click', openOptions);
        refs.status.textContent = '出错了';
      }
    });
  }

  function shotAsk() {
    if (state.running) return;
    if (!backend || !backend.capture) { toast('截图功能不可用'); return; }
    refs.status.textContent = '正在截图…';
    const useRect = state.snapshot && state.snapshot.rect && state.frameId === 0 ? state.snapshot.rect : null;
    const rect = useRect ? { x: useRect.vx, y: useRect.vy, w: useRect.w, h: useRect.h } : null;

    backend.capture(rect, window.devicePixelRatio || 1).then(function (r) {
      if (!r || !r.ok || !r.dataUrl) {
        refs.status.textContent = '';
        toast((r && r.error) || '截图失败，请重试');
        return;
      }
      startAsk({ question: state.question, kind: state.kind, image: r.dataUrl });
    }).catch(function () {
      refs.status.textContent = '';
      toast('截图失败，请重试');
    });
  }

  function copyAnswer() {
    if (!state.answer) return;
    const text = state.answer;
    const done = function () { toast('答案已复制'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else fallback();

    function fallback() {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done();
      } catch (e) { toast('复制失败，请手动选择文本'); }
    }
  }

  /* ------------------------------ 手动框选 ------------------------------ */

  const pick = { active: false, host: null, box: null, hint: null };

  const PICK_CSS = `
    .box { position: fixed; pointer-events: none; border: 2px solid #4f7cff;
      background: rgba(79,124,255,.10); border-radius: 4px; }
    .hint { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); pointer-events: none;
      background: rgba(79,124,255,.96); color: #fff; padding: 8px 16px; border-radius: 999px;
      box-shadow: 0 8px 24px rgba(79,124,255,.4); white-space: nowrap;
      font: 500 12.5px/1.4 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  `;

  function startPick() {
    if (pick.active) return;
    if (!document.documentElement) return;
    pick.active = true;

    const host = document.createElement('div');
    host.id = 'aiqa-pick-host';
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:' + (Z_INDEX + 5) + ';';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>' + PICK_CSS + '</style>' +
      '<div class="box" hidden></div><div class="hint">点击要识别的题目区域 · Esc 取消</div>';
    document.documentElement.appendChild(host);

    pick.host = host;
    pick.box = shadow.querySelector('.box');
    pick.hint = shadow.querySelector('.hint');

    if (IS_TOP && refs.fab) refs.fab.hidden = true;
    if (IS_TOP && refs.panel) refs.panel.hidden = true;

    window.addEventListener('mousemove', onPickMove, true);
    window.addEventListener('click', onPickClick, true);
    window.addEventListener('keydown', onPickKey, true);
  }

  function endPick(cancelled) {
    if (!pick.active) return;
    pick.active = false;
    window.removeEventListener('mousemove', onPickMove, true);
    window.removeEventListener('click', onPickClick, true);
    window.removeEventListener('keydown', onPickKey, true);
    if (pick.host && pick.host.parentNode) pick.host.parentNode.removeChild(pick.host);
    pick.host = null;
    pick.box = null;
    pick.hint = null;

    if (IS_TOP) {
      if (refs.fab) refs.fab.hidden = false;
      if (state.open && refs.panel) {
        refs.panel.hidden = false;
        positionPanel();
      }
    }
  }

  function onPickMove(e) {
    if (!pick.active || !pick.box) return;
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    pick.box.style.left = r.left + 'px';
    pick.box.style.top = r.top + 'px';
    pick.box.style.width = r.width + 'px';
    pick.box.style.height = r.height + 'px';
    pick.box.hidden = false;
  }

  function onPickClick(e) {
    if (!pick.active) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    let snap = null;
    try { snap = Ext.extractElement(el); } catch (err) { snap = null; }
    endPick(false);

    if (!snap || !snap.ok) {
      if (IS_TOP) {
        toast('这个区域没有文字，换一个位置试试');
        if (state.open) refs.panel.hidden = false;
      }
      return;
    }

    if (IS_TOP) {
      if (backend && backend.stopPick) backend.stopPick();
      applySnapshot(snap, 0);
      state.open = true;
      refs.panel.hidden = false;
      positionPanel();
      loadSettings();
      toast('已选中题目');
    } else if (backend && backend.relayPick) {
      backend.relayPick(snap);
    }
  }

  function onPickKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      endPick(true);
    }
  }

  /* ------------------------------ 悬浮球拖动 ------------------------------ */

  function saveFabPosition(pos) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ 'aiqa:fabPos': pos });
      }
    } catch (e) { /* ignore */ }
  }

  function applyFabPosition(pos) {
    if (!pos) return;
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    const left = Math.min(Math.max(8, pos.left), vw - 54);
    const top = Math.min(Math.max(8, pos.top), vh - 54);
    refs.fab.style.left = left + 'px';
    refs.fab.style.top = top + 'px';
    refs.fab.style.right = 'auto';
    refs.fab.style.bottom = 'auto';
  }

  function restoreFabPosition() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get('aiqa:fabPos', function (r) {
          swallowLastError();
          if (r && r['aiqa:fabPos']) applyFabPosition(r['aiqa:fabPos']);
        });
      }
    } catch (e) { /* ignore */ }
  }

  function enableDrag() {
    const fab = refs.fab;
    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0, originLeft = 0, originTop = 0;

    fab.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      const r = fab.getBoundingClientRect();
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      originLeft = r.left;
      originTop = r.top;
      fab.classList.add('dragging');
      fab.setPointerCapture(e.pointerId);
    });

    fab.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 5) return;
      moved = true;
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 800;
      const left = Math.min(Math.max(4, originLeft + dx), vw - 50);
      const top = Math.min(Math.max(4, originTop + dy), vh - 50);
      fab.style.left = left + 'px';
      fab.style.top = top + 'px';
      fab.style.right = 'auto';
      fab.style.bottom = 'auto';
    });

    fab.addEventListener('pointerup', function (e) {
      if (!dragging) return;
      dragging = false;
      fab.classList.remove('dragging');
      try { fab.releasePointerCapture(e.pointerId); } catch (err) {}
      if (moved) {
        const r = fab.getBoundingClientRect();
        saveFabPosition({ left: Math.round(r.left), top: Math.round(r.top) });
        if (state.open) positionPanel();
      } else {
        togglePanel();
      }
    });

    fab.addEventListener('pointercancel', function () {
      dragging = false;
      fab.classList.remove('dragging');
    });
  }

  /* ------------------------------ 事件绑定 ------------------------------ */

  function bindEvents() {
    refs.fab.addEventListener('click', function (e) {
      // 拖动结束时已在 pointerup 里处理，这里只兜底键盘触发的 click
      if (e.detail === 0) togglePanel();
    });

    refs.panel.addEventListener('click', function (e) {
      const btn = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!btn) return;
      const act = btn.getAttribute('data-act');

      // 「开始作答」和「截图问 AI」会调用付费接口，只认真实用户操作。
      // 页面脚本用 element.click() 合成的事件 isTrusted === false，直接忽略，
      // 避免恶意页面刷请求消耗额度。
      if (!DEMO && !e.isTrusted && (act === 'ask' || act === 'shot')) {
        return;
      }

      if (act === 'close') closePanel();
      else if (act === 'options') openOptions();
      else if (act === 'ask') askCurrent();
      else if (act === 'stop') { if (state.handle) state.handle.abort(); }
      else if (act === 'rescan') { state.answer = ''; refreshQuestion(); }
      else if (act === 'shot') shotAsk();
      else if (act === 'copy') copyAnswer();
      else if (act === 'edit') toggleEdit();
      else if (act === 'kind') cycleKind();
      else if (act === 'site-off') {
        toast('已在本站隐藏悬浮球');
        setTimeout(hideOnThisSite, 700);
      }
      else if (act === 'pick') {
        closePanel();
        if (IS_TOP) {
          startPick();
          if (backend && backend.startPick) backend.startPick();
        }
      }
    });

    refs.panel.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); closePanel(); }
    });

    refs.qedit.addEventListener('input', function () {
      state.question = refs.qedit.value;
      state.edited = true;
    });

    window.addEventListener('resize', function () {
      if (state.open) positionPanel();
      const pos = refs.fab.style.left ? { left: parseFloat(refs.fab.style.left), top: parseFloat(refs.fab.style.top) } : null;
      if (pos) applyFabPosition(pos);
    });

    enableDrag();
  }

  const KIND_CYCLE = ['单选题', '多选题', '判断题', '填空题', '简答题', '题目'];

  function cycleKind() {
    if (!state.question) {
      toast('还没有识别到题目');
      return;
    }
    const idx = KIND_CYCLE.indexOf(state.kind);
    state.kind = KIND_CYCLE[(idx + 1) % KIND_CYCLE.length];
    refs.kind.className = 'tag manual';
    refs.kind.textContent = state.kind;
    toast('题型已设为 ' + state.kind + '，再次点击可继续切换');
  }

  function toggleEdit() {
    const editing = !refs.qedit.hidden;
    if (editing) {
      state.question = refs.qedit.value.trim();
      refs.qtext.textContent = state.question;
      refs.qedit.hidden = true;
      refs.qtext.hidden = false;
      refs.editBtn.textContent = '编辑';
      if (state.question && refs.kind.classList.contains('idle')) {
        refs.kind.className = 'tag';
        refs.kind.textContent = '自定义';
      }
    } else {
      refs.qtext.hidden = true;
      refs.qedit.hidden = false;
      refs.qedit.value = state.question;
      refs.qedit.focus();
      refs.editBtn.textContent = '完成';
    }
  }

  /* ------------------------------ 消息（来自后台） ------------------------------ */

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || !msg.type) return;

      if (msg.type === 'AIQA_PICK_START') {
        startPick();
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'AIQA_PICK_STOP') {
        endPick(true);
        sendResponse({ ok: true });
        return;
      }
      if (!IS_TOP) return;

      if (msg.type === 'AIQA_OPEN') {
        openPanel();
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'AIQA_SHOT') {
        openPanel();
        setTimeout(function () { shotAsk(); }, 320);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'AIQA_TOGGLE') {
        togglePanel();
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'AIQA_PICK_RESULT' && msg.snapshot) {
        endPick(true);
        if (backend && backend.stopPick) backend.stopPick();
        applySnapshot(msg.snapshot, -1);
        state.open = true;
        refs.panel.hidden = false;
        positionPanel();
        loadSettings();
        toast('已从页面中选中题目');
        sendResponse({ ok: true });
        return;
      }
    });
  }

  /* ------------------------------ 开关：全局暂停 / 本站隐藏 ------------------------------ */

  const PREF_PAUSED = 'aiqa:paused';
  const PREF_SITES = 'aiqa:disabledSites';

  let uiAlive = false;

  function currentHost() {
    try { return String(location.hostname || '').toLowerCase(); } catch (e) { return ''; }
  }

  function hostMatches(host, rule) {
    const r = String(rule || '').toLowerCase();
    if (!host || !r) return false;
    return host === r || host.slice(-(r.length + 1)) === '.' + r;
  }

  function readPrefs(cb) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      cb({ paused: false, sites: [] });
      return;
    }
    try {
      chrome.storage.local.get([PREF_PAUSED, PREF_SITES], function (r) {
        swallowLastError();
        cb({
          paused: !!(r && r[PREF_PAUSED]),
          sites: (r && Array.isArray(r[PREF_SITES])) ? r[PREF_SITES] : []
        });
      });
    } catch (e) {
      cb({ paused: false, sites: [] });
    }
  }

  function isBlocked(prefs) {
    if (!prefs) return false;
    if (prefs.paused) return true;
    const host = currentHost();
    if (!host) return false;
    for (let i = 0; i < prefs.sites.length; i++) {
      if (hostMatches(host, prefs.sites[i])) return true;
    }
    return false;
  }

  function destroyUI() {
    if (state.running && state.handle) {
      try { state.handle.abort(); } catch (e) { /* ignore */ }
    }
    state.running = false;
    state.handle = null;
    state.open = false;
    state.answer = '';
    state.reason = '';
    state.question = '';
    state.kind = '';
    state.snapshot = null;

    try {
      if (refs.host && refs.host.parentNode) refs.host.parentNode.removeChild(refs.host);
    } catch (e) { /* ignore */ }

    uiAlive = false;
    refs.host = null;
    refs.shadow = null;
    refs.fab = null;
    refs.panel = null;
    refs.answer = null;
    refs.status = null;
    refs.toast = null;
  }

  function applyPrefs(prefs) {
    const run = function (p) {
      if (isBlocked(p)) {
        if (uiAlive) destroyUI();
        return;
      }
      if (!uiAlive) {
        try {
          buildUI();
          uiAlive = true;
        } catch (e) {
          uiAlive = false;
        }
      }
    };
    if (prefs) run(prefs); else readPrefs(run);
  }

  /** 把当前站点加入黑名单，然后销毁 UI */
  function hideOnThisSite() {
    const host = currentHost();
    if (!host || typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      destroyUI();
      return;
    }
    try {
      chrome.storage.local.get(PREF_SITES, function (r) {
        swallowLastError();
        const list = (r && Array.isArray(r[PREF_SITES])) ? r[PREF_SITES].slice() : [];
        if (!list.some(function (s) { return hostMatches(host, s) || String(s).toLowerCase() === host; })) {
          list.push(host);
        }
        chrome.storage.local.set({ [PREF_SITES]: list }, function () {
          swallowLastError();
          destroyUI();
        });
      });
    } catch (e) {
      destroyUI();
    }
  }

  /* ------------------------------ 启动 ------------------------------ */

  function boot() {
    if (!document.documentElement) {
      window.addEventListener('DOMContentLoaded', boot, { once: true });
      return;
    }
    if (!IS_TOP) return;

    readPrefs(function (prefs) {
      applyPrefs(prefs);
    });

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      try {
        chrome.storage.onChanged.addListener(function (changes, area) {
          if (area !== 'local') return;
          if (changes[PREF_PAUSED] || changes[PREF_SITES]) applyPrefs();
        });
      } catch (e) { /* ignore */ }
    }
  }

  if (IS_TOP) {
    boot();
  }

  // 暴露给后台 executeScript 使用
  globalThis.__AIQA__ = { snapshot: function () { return Ext.snapshot(); } };
})();