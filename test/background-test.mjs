/*
 * 后台服务自测：用假的 chrome.* API + 本地假 OpenAI 服务，验证
 *  - 设置读取 / 端点拼接
 *  - 流式 SSE 解析（content + reasoning_content，[DONE]，\r\n）
 *  - 非流式回退
 *  - HTTP 错误映射
 *  - 跨 frame 取题挑选
 * 运行：node test/background-test.mjs
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS ' + name);
  else { failures++; console.log('FAIL ' + name + (detail ? '  ← ' + detail : '')); }
}

/* ------------------------- 假 OpenAI 服务 ------------------------- */

const ANSWER = ['【题型】单选题\n', '【答案】C\n', '【解析】第三阶段在线粒体内膜上进行。'];

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    if (req.url.startsWith('/bad')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
      return;
    }
    let body = {};
    try { body = JSON.parse(raw); } catch (e) { /* ignore */ }

    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '可用' } }] }));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    // 先来一段思考内容，再分片输出正文，末尾 [DONE]
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: '先分析题干。' } }] }) + '\r\n\r\n');
    let i = 0;
    const timer = setInterval(() => {
      if (i >= ANSWER.length) {
        clearInterval(timer);
        res.write('data: [DONE]\r\n\r\n');
        res.end();
        return;
      }
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: ANSWER[i] } }] }) + '\n\n');
      i++;
    }, 8);
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

/* ------------------------- 假 chrome API ------------------------- */

const state = {
  settings: {},
  executed: [],
  extractResults: []
};

const listeners = { message: [], connect: [], command: [], installed: [] };

const chrome = {
  storage: {
    local: {
      get: async () => ({ ...state.settings }),
      set: async () => {},
      remove: async () => {}
    }
  },
  runtime: {
    lastError: undefined,
    onMessage: { addListener: (f) => listeners.message.push(f) },
    onConnect: { addListener: (f) => listeners.connect.push(f) },
    onInstalled: { addListener: (f) => listeners.installed.push(f) },
    openOptionsPage: () => {}
  },
  commands: { onCommand: { addListener: (f) => listeners.command.push(f) } },
  tabs: {
    query: async () => [{ id: 1, windowId: 1 }],
    sendMessage: async () => ({ ok: true }),
    captureVisibleTab: async () => 'data:image/png;base64,AAAA'
  },
  scripting: {
    executeScript: async (opts) => {
      state.executed.push(opts);
      return state.extractResults;
    }
  }
};

// 在函数作用域里执行 background.js（它本身是经典脚本）
const factory = new Function('chrome', SRC + '\nreturn { getSettings, endpointOf, publicSettings, callChat, buildMessages };');
const bg = factory(chrome);

/* ------------------------- 工具 ------------------------- */

function sendMessage(msg, sender) {
  return new Promise((resolve) => {
    let async = false;
    let settled = false;
    const respond = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    for (const fn of listeners.message) {
      try {
        if (fn(msg, sender || { tab: { id: 1 } }, respond) === true) async = true;
      } catch (e) {
        console.log('  (listener threw: ' + e.message + ')');
      }
    }
    if (!async) {
      setTimeout(() => respond(undefined), 0);
    } else {
      setTimeout(() => respond(undefined), 4000); // 兜底，避免测试挂死
    }
  });
}

function makePort(name = 'aiqa') {
  const messages = [];
  const msgListeners = [];
  const discListeners = [];
  return {
    name,
    messages,
    postMessage: (m) => messages.push(m),
    onMessage: { addListener: (f) => msgListeners.push(f) },
    onDisconnect: { addListener: (f) => discListeners.push(f) },
    disconnect: () => discListeners.forEach((f) => f()),
    receive: (m) => msgListeners.forEach((f) => f(m))
  };
}

function waitFor(fn, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (fn()) { clearInterval(timer); resolve(); }
      else if (Date.now() - t0 > timeout) { clearInterval(timer); reject(new Error('timeout')); }
    }, 15);
  });
}

/* ------------------------- 1. 默认设置 + 端点 ------------------------- */

state.settings = {};
const s0 = await bg.getSettings();
check('默认设置已合并', s0.baseUrl === 'https://api.deepseek.com/v1' && s0.model === 'deepseek-chat',
  JSON.stringify({ baseUrl: s0.baseUrl, model: s0.model }));

check('端点拼接 /v1', bg.endpointOf('https://api.deepseek.com/v1') === 'https://api.deepseek.com/v1/chat/completions');
check('端点拼接 带斜杠', bg.endpointOf('https://x.com/v1/') === 'https://x.com/v1/chat/completions');
check('端点拼接 完整地址不重复',
  bg.endpointOf('https://x.com/v1/chat/completions') === 'https://x.com/v1/chat/completions');
check('端点拼接 空值抛错', (() => { try { bg.endpointOf(''); return false; } catch (e) { return true; } })());

const pub = bg.publicSettings({ ...s0, apiKey: 'sk-abcdef1234' });
check('publicSettings 不泄露 Key', pub.apiKey === undefined && pub.hasApiKey === true && pub.apiKeyTail === '1234');

/* ------------------------- 2. GET_SETTINGS 消息 ------------------------- */

state.settings = { baseUrl: 'http://127.0.0.1:' + PORT + '/v1', apiKey: 'sk-test', model: 'mock-model' };
const settingsResp = await sendMessage({ type: 'GET_SETTINGS' });
check('GET_SETTINGS 走消息通道', settingsResp && settingsResp.ok && settingsResp.settings.hasApiKey === true);

const defaultsResp = await sendMessage({ type: 'GET_DEFAULTS' });
check('GET_DEFAULTS 返回默认提示词', defaultsResp && defaultsResp.systemPrompt.includes('解题助手'));

/* ------------------------- 3. 非流式（测试连接） ------------------------- */

const testResp = await sendMessage({ type: 'TEST_CONNECTION', settings: { baseUrl: 'http://127.0.0.1:' + PORT + '/v1', apiKey: 'sk-test', model: 'mock-model' } });
check('TEST_CONNECTION 成功', testResp && testResp.ok && testResp.text === '可用', JSON.stringify(testResp));

/* ------------------------- 4. 流式作答（端口协议） ------------------------- */

const port = makePort();
listeners.connect.forEach((f) => f(port));
port.receive({ type: 'ASK', question: '下列关于细胞呼吸的叙述，正确的是（）', pageTitle: '练习', kind: '单选题' });
await waitFor(() => port.messages.some((m) => m.type === 'done' || m.type === 'error'));

const done = port.messages.find((m) => m.type === 'done');
const deltas = port.messages.filter((m) => m.type === 'delta').map((m) => m.text).join('');
const reasons = port.messages.filter((m) => m.type === 'reason').map((m) => m.text).join('');

check('流式请求没有报错', port.messages.every((m) => m.type !== 'error'),
  JSON.stringify(port.messages.find((m) => m.type === 'error')));
check('流式正文拼接正确', deltas === ANSWER.join(''), JSON.stringify(deltas));
check('done 事件带回全文', done && done.text === ANSWER.join('') && done.elapsed >= 0);
check('reasoning_content 被单独上报', reasons === '先分析题干。', JSON.stringify(reasons));

/* ------------------------- 5. HTTP 错误映射 ------------------------- */

const badPort = makePort();
listeners.connect.forEach((f) => f(badPort));
state.settings = { baseUrl: 'http://127.0.0.1:' + PORT + '/bad', apiKey: 'sk-test', model: 'm' };
badPort.receive({ type: 'ASK', question: '测试' });
await waitFor(() => badPort.messages.some((m) => m.type === 'error'));
const errMsg = (badPort.messages.find((m) => m.type === 'error') || {}).error || '';
check('401 映射为 Key 无效', errMsg.includes('API Key 无效'), errMsg);

/* ------------------------- 6. 缺 Key 的短路 ------------------------- */

state.settings = { baseUrl: 'http://127.0.0.1:' + PORT + '/v1', apiKey: '', model: 'm' };
const noKeyPort = makePort();
listeners.connect.forEach((f) => f(noKeyPort));
noKeyPort.receive({ type: 'ASK', question: '测试' });
await waitFor(() => noKeyPort.messages.length > 0);
const noKeyErr = noKeyPort.messages[0] || {};
check('缺 Key 给出 NO_KEY', noKeyErr.type === 'error' && noKeyErr.code === 'NO_KEY');

/* ------------------------- 7. 跨 frame 取题 ------------------------- */

state.settings = { baseUrl: 'http://127.0.0.1:' + PORT + '/v1', apiKey: 'sk-test', model: 'm' };
state.extractResults = [
  { frameId: 0, result: { ok: true, text: '页头导航', score: 3 } },
  { frameId: 3, result: { ok: true, text: '1. 下列……\nA. 甲\nB. 乙', score: 88 } },
  { frameId: 4, result: null }
];
const exResp = await sendMessage({ type: 'EXTRACT' });
check('EXTRACT 选中分数最高的 frame', exResp && exResp.ok && exResp.frameId === 3 && exResp.snapshot.score === 88,
  JSON.stringify(exResp));

state.extractResults = [{ frameId: 0, result: null }, { frameId: 2, result: { ok: false } }];
const exEmpty = await sendMessage({ type: 'EXTRACT' });
check('EXTRACT 无题时返回失败', exEmpty && exEmpty.ok === false);
check('EXTRACT 无题时会补注入脚本',
  state.executed.filter((o) => Array.isArray(o.files)).length >= 1);

/* ------------------------- 8. 消息构造 ------------------------- */

const withImage = bg.buildMessages({ systemPrompt: 'SYS' }, { question: 'Q', image: 'data:image/png;base64,AA', pageTitle: 'T', kind: '单选题' });
const userContent = withImage[1].content;
check('buildMessages 带图片时用多模态结构',
  Array.isArray(userContent) && userContent[0].type === 'text' && userContent[1].type === 'image_url');
const noImage = bg.buildMessages({ systemPrompt: 'SYS' }, { question: 'Q' });
check('buildMessages 无图片时是纯文本', typeof noImage[1].content === 'string' && noImage[1].content.includes('【题目】'));

server.close();
server.closeAllConnections?.();

console.log('\nRESULT ' + (failures === 0 ? 'ALL PASS' : failures + ' FAILED'));
process.exit(failures === 0 ? 0 : 1);