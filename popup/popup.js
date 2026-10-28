/* AI 答题助手 · 工具栏弹窗 */
'use strict';

const $ = function (id) { return document.getElementById(id); };

function call(message) {
  return new Promise(function (resolve) {
    try {
      chrome.runtime.sendMessage(message, function (resp) {
        void chrome.runtime.lastError;
        resolve(resp || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function setHint(text, cls) {
  const el = $('hint');
  el.className = 'hint' + (cls ? ' ' + cls : '');
  el.innerHTML = text;
}

async function init() {
  const resp = await call({ type: 'GET_SETTINGS' });
  const s = resp && resp.ok ? resp.settings : null;

  if (!s) {
    $('status').textContent = '无法读取配置';
    setHint('扩展后台暂时不可用，点「设置」重新打开配置页试试。', 'warn');
    return;
  }

  if (!s.hasApiKey) {
    $('status').textContent = '尚未填写 API Key';
    setHint('还没配置 AI 接口。点「设置」选择服务商并填入 API Key（DeepSeek / OpenAI / 通义 / Kimi 等都能用）。', 'warn');
    $('tail').textContent = s.model ? '当前模型：' + s.model : '';
  } else {
    $('status').innerHTML = '已连接 <b>' + escapeHtml(s.model || '') + '</b>';
    setHint('在题目页面按 <kbd>Alt</kbd> + <kbd>Q</kbd>，或点右下角悬浮球。识别不准时可用「手动选中」。', 'ok');
    $('tail').textContent = 'Key 尾号 ' + (s.apiKeyTail || '****');
  }

  if (!s.visionModel) {
    $('shot').title = '当前未配置视觉模型，图片题可能失败';
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

async function openPanel(action) {
  const resp = await call({ type: 'OPEN_PANEL', action: action || 'open' });
  if (resp && resp.ok === false) {
    setHint(escapeHtml(resp.error || '打开失败'), 'warn');
    return;
  }
  window.close();
}

$('open').addEventListener('click', function () { openPanel('open'); });
$('shot').addEventListener('click', function () { openPanel('shot'); });
$('opt').addEventListener('click', function () { chrome.runtime.openOptionsPage(); window.close(); });
$('opt2').addEventListener('click', function () { chrome.runtime.openOptionsPage(); window.close(); });

init();