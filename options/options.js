/* AI 答题助手 · 设置页 */
'use strict';

const $ = function (id) { return document.getElementById(id); };

const PRESETS = [
  {
    key: 'deepseek', label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', vision: '',
    tip: '国内直连、价格低；暂不支持图片'
  },
  {
    key: 'openai', label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', vision: 'gpt-4o-mini',
    tip: '需要能访问 api.openai.com'
  },
  {
    key: 'zhipu', label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', vision: 'glm-4v-flash',
    tip: 'flash 有免费额度'
  },
  {
    key: 'kimi', label: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', vision: 'moonshot-v1-8k-vision-preview',
    tip: '月之暗面'
  },
  {
    key: 'qwen', label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', vision: 'qwen-vl-plus',
    tip: '阿里云百炼'
  },
  {
    key: 'siliconflow', label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct', vision: 'Qwen/Qwen2-VL-7B-Instruct',
    tip: '聚合平台，模型多'
  },
  {
    key: 'ollama', label: 'Ollama 本地',
    baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b', vision: 'llava',
    tip: '本机运行，Key 随便填'
  },
  {
    key: 'custom', label: '自定义',
    baseUrl: '', model: '', vision: '',
    tip: '任何 OpenAI 兼容接口'
  }
];

let serverSettings = null;

function send(message) {
  return new Promise(function (resolve) {
    try {
      chrome.runtime.sendMessage(message, function (resp) {
        void chrome.runtime.lastError;
        resolve(resp || null);
      });
    } catch (e) { resolve(null); }
  });
}

function setStatus(text, cls) {
  const el = $('status');
  el.className = 'status' + (cls ? ' ' + cls : '');
  el.textContent = text;
}

function normalizeUrl(u) {
  return String(u || '').trim().replace(/\/+$/, '').toLowerCase();
}

function renderPresets() {
  const box = $('presets');
  box.innerHTML = '';
  PRESETS.forEach(function (p) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'preset';
    b.textContent = p.label;
    b.title = p.tip;
    b.dataset.key = p.key;
    b.addEventListener('click', function () {
      if (p.key === 'custom') {
        $('baseUrl').value = '';
        $('model').value = '';
        $('visionModel').value = '';
        $('baseUrl').focus();
      } else {
        $('baseUrl').value = p.baseUrl;
        $('model').value = p.model;
        $('visionModel').value = p.vision || '';
      }
      markActivePreset();
      setStatus('已填入 ' + p.label + ' 的默认地址，别忘了填 API Key', 'pending');
    });
    box.appendChild(b);
  });
}

function markActivePreset() {
  const url = normalizeUrl($('baseUrl').value);
  const buttons = document.querySelectorAll('.preset');
  let matched = 'custom';
  buttons.forEach(function (b) {
    const p = PRESETS.find(function (x) { return x.key === b.dataset.key; });
    const on = p && p.key !== 'custom' && normalizeUrl(p.baseUrl) === url;
    b.classList.toggle('active', !!on);
    if (on) matched = p.key;
  });
  if (matched === 'custom') {
    const c = document.querySelector('.preset[data-key="custom"]');
    if (c && ![...buttons].some(function (b) { return b.classList.contains('active'); })) {
      c.classList.add('active');
    }
  }
}

async function load() {
  renderPresets();

  const resp = await send({ type: 'GET_SETTINGS' });
  serverSettings = resp && resp.ok ? resp.settings : null;
  if (!serverSettings) {
    setStatus('读取配置失败，请关闭本页后重新打开', 'err');
    return;
  }

  $('baseUrl').value = serverSettings.baseUrl || '';
  $('model').value = serverSettings.model || '';
  $('visionModel').value = serverSettings.visionModel || '';
  $('temperature').value = serverSettings.temperature != null ? serverSettings.temperature : 0.2;
  $('maxTokens').value = serverSettings.maxTokens || 1600;
  $('systemPrompt').value = serverSettings.systemPrompt || '';
  $('tempVal').textContent = Number($('temperature').value).toFixed(1);

  const stored = await chrome.storage.local.get('apiKey');
  if (stored && stored.apiKey) {
    $('apiKey').placeholder = '已保存（尾号 ' + String(stored.apiKey).slice(-4) + '），留空表示不修改';
  }

  markActivePreset();
  setStatus('配置已加载', 'ok');
}

function collect(withStoredKey) {
  const data = {
    baseUrl: $('baseUrl').value.trim(),
    model: $('model').value.trim(),
    visionModel: $('visionModel').value.trim(),
    temperature: Number($('temperature').value),
    maxTokens: Number($('maxTokens').value) || 1600,
    systemPrompt: $('systemPrompt').value
  };
  const key = $('apiKey').value.trim();
  if (key) data.apiKey = key;
  return data;
}

function validate(data, hasKey) {
  if (!data.baseUrl) return '请填写接口地址（Base URL）';
  if (!/^https?:\/\//i.test(data.baseUrl)) return '接口地址要以 http:// 或 https:// 开头';
  if (!data.model) return '请填写模型名称';
  if (!hasKey) return '请填写 API Key';
  if (!data.maxTokens || data.maxTokens < 128) return '最大输出 tokens 太小了';
  return '';
}

async function save() {
  const data = collect();
  const stored = await chrome.storage.local.get('apiKey');
  const hasKey = !!data.apiKey || !!(stored && stored.apiKey);
  const error = validate(data, hasKey);
  if (error) { setStatus(error, 'err'); return; }

  try {
    await chrome.storage.local.set(data);
    setStatus('已保存 ✓  回到题目页面刷新一下，按 Alt+Q 就能用', 'ok');
    markActivePreset();
    if (data.apiKey) $('apiKey').value = '';
    if (data.apiKey) $('apiKey').placeholder = '已保存（尾号 ' + data.apiKey.slice(-4) + '），留空表示不修改';
  } catch (e) {
    setStatus('保存失败：' + (e && e.message ? e.message : e), 'err');
  }
}

async function test() {
  const data = collect();
  const stored = await chrome.storage.local.get('apiKey');
  if (!data.apiKey && stored && stored.apiKey) data.apiKey = stored.apiKey;
  const error = validate(data, !!data.apiKey);
  if (error) { setStatus(error, 'err'); return; }

  const btn = $('test');
  btn.disabled = true;
  setStatus('正在连接 ' + data.baseUrl + ' …', 'pending');
  try {
    const r = await send({ type: 'TEST_CONNECTION', settings: data });
    if (r && r.ok) {
      setStatus('连接成功 ✓ 模型回复：「' + r.text + '」', 'ok');
    } else {
      setStatus('连接失败：' + ((r && r.error) || '未知错误'), 'err');
    }
  } finally {
    btn.disabled = false;
  }
}

async function resetPrompt() {
  const r = await send({ type: 'GET_DEFAULTS' });
  if (r && r.ok && r.systemPrompt) {
    $('systemPrompt').value = r.systemPrompt;
    setStatus('已恢复默认提示词，记得点「保存设置」', 'pending');
  } else {
    setStatus('读取默认提示词失败', 'err');
  }
}

async function clearKey() {
  await chrome.storage.local.remove('apiKey');
  $('apiKey').value = '';
  $('apiKey').placeholder = '已清除，重新填入即可';
  setStatus('API Key 已从本机删除', 'ok');
}

$('temperature').addEventListener('input', function () {
  $('tempVal').textContent = Number(this.value).toFixed(1);
});
$('baseUrl').addEventListener('change', markActivePreset);
$('save').addEventListener('click', save);
$('test').addEventListener('click', test);
$('resetPrompt').addEventListener('click', resetPrompt);
$('clearKey').addEventListener('click', clearKey);
$('toggleKey').addEventListener('click', function () {
  const input = $('apiKey');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  this.textContent = show ? '隐藏' : '显示';
});
document.addEventListener('keydown', function (e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    save();
  }
});

load();