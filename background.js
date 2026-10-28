/*!
 * AI 答题助手 · 后台服务（Manifest V3 Service Worker）
 * 负责：读取配置、调用 OpenAI 兼容接口（流式）、跨 frame 取题、截图裁切、消息路由。
 */
'use strict';

const DEFAULT_SYSTEM_PROMPT = [
  '你是一位严谨、高效的解题助手。用户会给你一道从网页里抓取到的题目，文本可能夹带导航栏残留、换行错乱或排版符号。',
  '',
  '请按下面步骤处理：',
  '1. 先在心里还原题目：补全被折行打断的题干和选项，忽略与题目无关的页面文字。',
  '2. 自己判断题型：单选题、多选题、判断题、填空题、简答题、计算题或其他。页面若给了题型线索，只当参考。',
  '3. 给出最终答案。选择题只输出选项字母（多选按字母顺序连写，如 ABD）；判断题输出「正确」或「错误」；其余题型给出完整答案。',
  '4. 用两三句话说明关键理由。',
  '5. 如果是选择题，再逐项用一行简述每个选项对/错的原因。',
  '',
  '输出格式（务必遵守）：',
  '【题型】……',
  '【答案】……',
  '【解析】……（关键理由）',
  '【选项分析】',
  'A. ……',
  'B. ……',
  '（非选择题可省略【选项分析】）',
  '',
  '硬性规则：',
  '- 题目信息不足或无法确定答案时，直接输出「【答案】题目信息不足」，并说明缺少什么，绝不编造。',
  '- 只要有多个选项同时正确，就必须按多选题作答、把所有正确选项都列出来，绝不能因为线索写着「单选题」就只给一个字母。',
  '- 题干里出现「哪些 / 多选 / 至少 / 都有 / 全部」等措辞时，优先按多选处理。',
  '- 不要重复题目原文，不要输出寒暄或道歉。',
  '- 数学公式用纯文本或 LaTeX 行内格式书写。'
].join('\n');

const DEFAULT_SETTINGS = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  visionModel: '',
  temperature: 0.2,
  maxTokens: 1600,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  stream: true
};

const PRESET_HINT_KEY = 'aiqa:lastPreset';

/* ------------------------------ 配置 ------------------------------ */

async function getSettings() {
  let stored = {};
  try {
    stored = (await chrome.storage.local.get(null)) || {};
  } catch (e) {
    stored = {};
  }
  const s = Object.assign({}, DEFAULT_SETTINGS);
  Object.keys(DEFAULT_SETTINGS).forEach((k) => {
    if (stored[k] !== undefined && stored[k] !== null && stored[k] !== '') s[k] = stored[k];
  });
  s.maxTokens = Number(s.maxTokens) || DEFAULT_SETTINGS.maxTokens;
  s.temperature = s.temperature === 0 || s.temperature === '0' ? 0 : Number(s.temperature) || 0.2;
  s.stream = s.stream !== false;
  s.baseUrl = String(s.baseUrl || '').trim();
  s.model = String(s.model || '').trim();
  return s;
}

function publicSettings(s) {
  return {
    baseUrl: s.baseUrl,
    model: s.model,
    visionModel: s.visionModel || '',
    temperature: s.temperature,
    maxTokens: s.maxTokens,
    stream: s.stream,
    hasApiKey: !!s.apiKey,
    apiKeyTail: s.apiKey ? s.apiKey.slice(-4) : '',
    systemPrompt: s.systemPrompt,
    presetKey: ''
  };
}

/* ------------------------------ 工具 ------------------------------ */

function endpointOf(baseUrl) {
  let u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!u) throw new Error('还没有填写接口地址（Base URL），请到设置页配置。');
  if (/\/chat\/completions$/i.test(u)) return u;
  if (/\/v\d+$/i.test(u) || /\/api\/paas\/v\d+$/i.test(u) || /\/compatible-mode\/v\d+$/i.test(u)) {
    return u + '/chat/completions';
  }
  return u + '/chat/completions';
}

function friendlyHttpError(status, body) {
  const snippet = String(body || '').replace(/\s+/g, ' ').slice(0, 240);
  let msg;
  if (status === 401 || status === 403) msg = 'API Key 无效或没有访问权限（HTTP ' + status + '）';
  else if (status === 402) msg = '账户余额不足（HTTP 402）';
  else if (status === 404) msg = '接口地址或模型名称不对（HTTP 404）';
  else if (status === 429) msg = '请求太频繁或额度用完了（HTTP 429），请稍后再试';
  else if (status >= 500) msg = '服务端出错了（HTTP ' + status + '），请稍后重试';
  else msg = '请求失败（HTTP ' + status + '）';
  return snippet ? msg + '\n' + snippet : msg;
}

function extractTextFromMessage(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : p && p.text ? p.text : '')).join('');
  }
  return '';
}

/* ------------------------------ 调用大模型 ------------------------------ */

async function callChat(opts) {
  const settings = opts.settings;
  const url = endpointOf(settings.baseUrl);
  const headers = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers.Authorization = 'Bearer ' + settings.apiKey;

  const body = { model: settings.model, messages: opts.messages, stream: settings.stream !== false };
  const modern = /^(o1|o3|o4|gpt-5|gpt-4\.1)/i.test(settings.model || '');
  const maxTokens = Number(settings.maxTokens) || 0;
  if (maxTokens > 0) body[modern ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;
  if (!modern) body.temperature = Number(settings.temperature);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
      signal: opts.signal
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new Error('网络请求失败：' + (e && e.message ? e.message : e) +
      '\n请检查网络/代理，或确认该接口允许浏览器直连。');
  }

  if (!res.ok) {
    let text = '';
    try { text = await res.text(); } catch (e) { text = ''; }
    throw new Error(friendlyHttpError(res.status, text));
  }

  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  const isSse = ctype.indexOf('event-stream') >= 0;
  const useStream = body.stream && isSse && res.body;

  if (!useStream) {
    let raw = '';
    try { raw = await res.text(); } catch (e) { throw new Error('读取响应失败：' + e.message); }
    let data;
    try { data = JSON.parse(raw); } catch (e) {
      throw new Error('返回内容不是合法 JSON：' + raw.replace(/\s+/g, ' ').slice(0, 200));
    }
    if (data && data.error) throw new Error('接口返回错误：' + (data.error.message || JSON.stringify(data.error)));
    const text = extractTextFromMessage(data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content);
    if (!text) throw new Error('接口没有返回内容：' + raw.replace(/\s+/g, ' ').slice(0, 200));
    if (opts.onDelta) opts.onDelta(text);
    return { text: text };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let full = '';
  let finished = false;

  while (!finished) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      if (line.charAt(line.length - 1) === '\r') line = line.slice(0, -1);
      line = line.trim();
      if (!line || line.charAt(0) === ':') continue;
      if (line.indexOf('data:') !== 0) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') { finished = true; break; }

      let json;
      try { json = JSON.parse(payload); } catch (e) { continue; }
      if (json && json.error) {
        throw new Error('接口返回错误：' + (json.error.message || JSON.stringify(json.error)));
      }
      const choice = json && json.choices && json.choices[0];
      if (!choice) continue;
      const delta = choice.delta || choice.message || {};
      const reason = delta.reasoning_content || delta.reasoning || '';
      if (reason && opts.onReason) opts.onReason(String(reason));
      const piece = extractTextFromMessage(delta.content);
      if (piece) {
        full += piece;
        if (opts.onDelta) opts.onDelta(piece);
      }
    }
  }

  if (!full.trim()) throw new Error('模型没有返回任何内容，请检查模型名称是否正确。');
  return { text: full };
}

/* ------------------------------ 取题 ------------------------------ */

const EXTRACT_FN_SRC = function () {
  try {
    return globalThis.AIQAExtract ? globalThis.AIQAExtract.snapshot() : null;
  } catch (e) {
    return null;
  }
};

async function extractEverywhere(tabId) {
  let results = null;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: true },
      func: EXTRACT_FN_SRC
    });
  } catch (e) {
    results = null;
  }

  let snaps = collect(results);

  if (!snaps.length) {
    // 页面在安装扩展之前就打开了：补注入后再试一次
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId, allFrames: true },
        files: ['lib/extract.js']
      });
      const again = await chrome.scripting.executeScript({
        target: { tabId: tabId, allFrames: true },
        func: EXTRACT_FN_SRC
      });
      snaps = collect(again);
    } catch (e) {
      // ignore
    }
  }

  snaps.sort((a, b) => (b.snapshot.score || 0) - (a.snapshot.score || 0));
  return snaps;
}

function collect(results) {
  const out = [];
  (results || []).forEach((r) => {
    if (!r || !r.result || !r.result.ok || !r.result.text) return;
    out.push({ frameId: r.frameId, snapshot: r.result });
  });
  return out;
}

async function extractBest(tabId) {
  const all = await extractEverywhere(tabId);
  if (!all.length) return { ok: false, error: '页面上没有找到可以识别的题目文本。' };
  return { ok: true, snapshot: all[0].snapshot, frameId: all[0].frameId };
}

/* ------------------------------ 截图 ------------------------------ */

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function captureTab(rect, dpr) {
  const tab = await getActiveTab();
  if (!tab || tab.id === undefined) throw new Error('找不到当前标签页。');
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (e) {
    throw new Error('截图失败：' + (e && e.message ? e.message : e));
  }
  if (!rect || !rect.w || !rect.h) return { dataUrl: dataUrl };

  try {
    const scale = Number(dpr) || 1;
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const pad = 12 * scale;
    const sx = Math.max(0, Math.round(rect.x * scale - pad));
    const sy = Math.max(0, Math.round(rect.y * scale - pad));
    const sw = Math.min(bmp.width - sx, Math.round(rect.w * scale + pad * 2));
    const sh = Math.min(bmp.height - sy, Math.round(rect.h * scale + pad * 2));
    if (sw < 40 || sh < 20) return { dataUrl: dataUrl };

    const maxW = 1400;
    const ratio = Math.min(1, maxW / sw);
    const canvas = new OffscreenCanvas(Math.round(sw * ratio), Math.round(sh * ratio));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    const buf = await out.arrayBuffer();
    return { dataUrl: 'data:image/jpeg;base64,' + bufferToBase64(buf), cropped: true };
  } catch (e) {
    return { dataUrl: dataUrl };
  }
}

/* ------------------------------ 标签页 ------------------------------ */

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}

async function sendToFrame(tabId, message, frameId) {
  const opts = frameId === undefined ? undefined : { frameId: frameId };
  return await chrome.tabs.sendMessage(tabId, message, opts);
}

async function ensureContent(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: false },
      files: ['lib/extract.js', 'content/content.js']
    });
    return true;
  } catch (e) {
    return false;
  }
}

async function togglePanel(tabId, action) {
  const map = { open: 'AIQA_OPEN', toggle: 'AIQA_TOGGLE', shot: 'AIQA_SHOT' };
  const message = { type: map[action] || 'AIQA_OPEN' };
  try {
    await sendToFrame(tabId, message, 0);
    return { ok: true };
  } catch (e) {
    const injected = await ensureContent(tabId);
    if (!injected) return { ok: false, error: '当前页面不允许注入脚本（例如浏览器内置页面或应用商店）。' };
    await new Promise((r) => setTimeout(r, 120));
    try {
      await sendToFrame(tabId, message, 0);
      return { ok: true };
    } catch (e2) {
      return { ok: false, error: '注入失败：' + (e2 && e2.message ? e2.message : e2) };
    }
  }
}

/* ------------------------------ 消息路由 ------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return undefined;

  if (msg.type === 'GET_SETTINGS') {
    getSettings().then((s) => sendResponse({ ok: true, settings: publicSettings(s) }));
    return true;
  }

  if (msg.type === 'GET_DEFAULTS') {
    sendResponse({ ok: true, systemPrompt: DEFAULT_SYSTEM_PROMPT });
    return undefined;
  }

  if (msg.type === 'EXTRACT') {
    const tabId = sender.tab ? sender.tab.id : msg.tabId;
    extractBest(tabId)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }

  if (msg.type === 'OPEN_PANEL' || msg.type === 'TOGGLE_PANEL') {
    const action = msg.action || (msg.type === 'OPEN_PANEL' ? 'open' : 'toggle');
    getActiveTab()
      .then((tab) => togglePanel(tab.id, action))
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }

  if (msg.type === 'CAPTURE') {
    captureTab(msg.rect, msg.dpr)
      .then((r) => sendResponse({ ok: true, dataUrl: r.dataUrl, cropped: !!r.cropped }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }

  if (msg.type === 'TEST_CONNECTION') {
    const settings = Object.assign({}, msg.settings || {});
    settings.stream = false;
    callChat({
      settings: settings,
      messages: [
        { role: 'system', content: '只回复两个字：可用' },
        { role: 'user', content: '连接测试' }
      ]
    })
      .then((r) => sendResponse({ ok: true, text: r.text.slice(0, 120) }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }

  if (msg.type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return undefined;
  }

  if (msg.type === 'PICK_RESULT') {
    // 子 frame 里手动框选的题目 → 转交给顶层 frame 的面板
    if (sender.tab && sender.tab.id !== undefined) {
      sendToFrame(sender.tab.id, { type: 'AIQA_PICK_RESULT', snapshot: msg.snapshot }, 0).catch(() => {});
    }
    sendResponse({ ok: true });
    return undefined;
  }

  if (msg.type === 'PICK_START' || msg.type === 'PICK_STOP') {
    const tabId = sender.tab ? sender.tab.id : msg.tabId;
    chrome.tabs.sendMessage(tabId, { type: msg.type === 'PICK_START' ? 'AIQA_PICK_START' : 'AIQA_PICK_STOP' })
      .catch(() => {});
    sendResponse({ ok: true });
    return undefined;
  }

  return undefined;
});

/* ------------------------------ 流式端口 ------------------------------ */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'aiqa') return;

  let controller = null;
  let closed = false;

  const post = (payload) => {
    if (closed) return;
    try { port.postMessage(payload); } catch (e) { closed = true; }
  };

  port.onDisconnect.addListener(() => {
    closed = true;
    if (controller) {
      try { controller.abort(); } catch (e) { /* ignore */ }
    }
  });

  port.onMessage.addListener(async (msg) => {
    if (!msg || !msg.type) return;

    if (msg.type === 'ABORT') {
      if (controller) {
        try { controller.abort(); } catch (e) { /* ignore */ }
      }
      return;
    }

    if (msg.type !== 'ASK') return;

    const started = Date.now();
    const answerParts = [];
    let reasonParts = '';

    try {
      const settings = await getSettings();
      if (!settings.apiKey) {
        post({ type: 'error', error: '还没有填写 API Key。点右上角 ⚙ 打开设置，填入任意 OpenAI 兼容服务的 Key。', code: 'NO_KEY' });
        return;
      }
      if (!settings.model) throw new Error('还没有填写模型名称，请到设置页配置。');

      const messages = buildMessages(settings, msg);
      controller = new AbortController();

      let firstChunk = false;
      await callChat({
        settings: settings,
        messages: messages,
        signal: controller.signal,
        onDelta: (text) => {
          if (!firstChunk) {
            firstChunk = true;
            post({ type: 'start', model: settings.model });
          }
          answerParts.push(text);
          post({ type: 'delta', text: text });
        },
        onReason: (text) => {
          reasonParts += text;
          post({ type: 'reason', text: text });
        }
      });

      post({
        type: 'done',
        text: answerParts.join(''),
        elapsed: Date.now() - started,
        model: settings.model
      });
    } catch (e) {
      const aborted = e && e.name === 'AbortError';
      if (aborted) {
        post({ type: 'aborted', text: answerParts.join('') });
      } else {
        post({
          type: 'error',
          error: String(e && e.message ? e.message : e),
          partial: answerParts.join('')
        });
      }
    }
  });
});

function buildMessages(settings, msg) {
  const system = (settings.systemPrompt || DEFAULT_SYSTEM_PROMPT).trim();
  const messages = [{ role: 'system', content: system }];

  const lines = [];
  if (msg.pageTitle) lines.push('【网页标题】' + String(msg.pageTitle).slice(0, 160));
  if (msg.kind) {
    lines.push('【题型线索】' + msg.kind +
      '（来自页面，可能不准；请以题目本身为准。如果多个选项都正确，必须给出全部正确选项）');
  }
  if (msg.question) lines.push('【题目】\n' + String(msg.question).slice(0, 8000));
  if (msg.image) lines.push('【题目截图】见下方图片，请先看清图片里的题干和选项再作答。');
  if (!lines.length) lines.push('【题目】\n（用户没有提供题目文字，请从截图中识别）');

  const text = lines.join('\n\n');
  const hasImage = !!msg.image;

  if (hasImage) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: text },
        { type: 'image_url', image_url: { url: msg.image, detail: 'high' } }
      ]
    });
  } else {
    messages.push({ role: 'user', content: text });
  }
  return messages;
}

/* ------------------------------ 快捷键 / 安装 ------------------------------ */

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-panel') return;
  try {
    const tab = await getActiveTab();
    if (tab && tab.id !== undefined) await togglePanel(tab.id, 'toggle');
  } catch (e) {
    // ignore
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    try { await chrome.runtime.openOptionsPage(); } catch (e) { /* ignore */ }
  }
});