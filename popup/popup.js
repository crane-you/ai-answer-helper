/* AI 答题助手 · 工具栏弹窗 */
'use strict';

const $ = function (id) { return document.getElementById(id); };

const S = { paused: false, siteOff: false };
let tabHost = '';
let normalHint = { html: '在题目页面按 <kbd>Alt</kbd> + <kbd>Q</kbd>，或点右下角悬浮球。', cls: '' };

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

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

function setNormalHint(html, cls) {
  normalHint = { html: html, cls: cls || '' };
  refreshUI();
}

function refreshUI() {
  const blocked = S.paused || S.siteOff;
  $('open').disabled = blocked;
  $('shot').disabled = blocked;
  $('siteRow').classList.toggle('off', S.paused || !tabHost);

  const el = $('hint');
  if (S.paused) {
    el.className = 'hint warn';
    el.textContent = '扩展已暂停：所有页面都不再显示悬浮球，也不会向 AI 接口发起任何请求。';
  } else if (S.siteOff) {
    el.className = 'hint warn';
    el.textContent = '已在本站隐藏悬浮球。打开上面的「在本网站显示」开关即可恢复。';
  } else {
    el.className = 'hint' + (normalHint.cls ? ' ' + normalHint.cls : '');
    el.innerHTML = normalHint.html;
  }
}

/* ------------------------------ 初始化 ------------------------------ */

async function init() {
  const resp = await call({ type: 'GET_SETTINGS' });
  const s = resp && resp.ok ? resp.settings : null;

  if (!s) {
    $('status').textContent = '无法读取配置';
    setNormalHint('扩展后台暂时不可用，点「设置」重新打开配置页试试。', 'warn');
  } else if (!s.hasApiKey) {
    $('status').textContent = '尚未填写 API Key';
    setNormalHint('还没配置 AI 接口。点「设置」选择服务商并填入 API Key（DeepSeek / OpenAI / 通义 / Kimi 等都能用）。', 'warn');
    $('tail').textContent = s.model ? '当前模型：' + s.model : '';
  } else {
    $('status').innerHTML = '已连接 <b>' + escapeHtml(s.model || '') + '</b>';
    setNormalHint('在题目页面按 <kbd>Alt</kbd> + <kbd>Q</kbd>，或点右下角悬浮球。识别不准时可用「手动选中」。', 'ok');
    $('tail').textContent = 'Key 尾号 ' + (s.apiKeyTail || '****');
  }

  if (s && !s.visionModel) $('shot').title = '当前未配置视觉模型，图片题可能失败';

  await loadSwitches();
}

async function loadSwitches() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    const url = (tab && tab.url) || '';
    tabHost = /^https?:/i.test(url) ? new URL(url).hostname.toLowerCase() : '';
  } catch (e) {
    tabHost = '';
  }

  const st = await chrome.storage.local.get(['aiqa:paused', 'aiqa:disabledSites']);
  S.paused = !!st['aiqa:paused'];
  const sites = Array.isArray(st['aiqa:disabledSites'])
    ? st['aiqa:disabledSites'].map(function (x) { return String(x).toLowerCase(); })
    : [];
  S.siteOff = !!tabHost && sites.indexOf(tabHost) >= 0;

  $('enabled').checked = !S.paused;
  $('siteOn').checked = !S.siteOff;
  $('siteRow').classList.toggle('off', !tabHost || S.paused);
  refreshUI();
}

/* ------------------------------ 操作 ------------------------------ */

async function openPanel(action) {
  if (S.paused || S.siteOff) {
    refreshUI();
    return;
  }
  const resp = await call({ type: 'OPEN_PANEL', action: action || 'open' });
  if (resp && resp.ok === false) {
    const el = $('hint');
    el.className = 'hint warn';
    el.textContent = resp.error || '打开失败';
    return;
  }
  window.close();
}

$('enabled').addEventListener('change', async function () {
  S.paused = !this.checked;
  await chrome.storage.local.set({ 'aiqa:paused': S.paused });
  $('siteRow').classList.toggle('off', S.paused || !tabHost);
  refreshUI();
});

$('siteOn').addEventListener('change', async function () {
  if (!tabHost) return;
  const on = this.checked;
  try {
    const st = await chrome.storage.local.get('aiqa:disabledSites');
    let list = Array.isArray(st['aiqa:disabledSites']) ? st['aiqa:disabledSites'].slice() : [];
    list = list.filter(function (x) { return String(x).toLowerCase() !== tabHost; });
    if (!on) list.push(tabHost);
    await chrome.storage.local.set({ 'aiqa:disabledSites': list });
    S.siteOff = !on;
  } catch (e) {
    this.checked = !on;
    return;
  }
  refreshUI();
});

$('open').addEventListener('click', function () { openPanel('open'); });
$('shot').addEventListener('click', function () { openPanel('shot'); });
$('opt').addEventListener('click', function () { chrome.runtime.openOptionsPage(); window.close(); });
$('opt2').addEventListener('click', function () { chrome.runtime.openOptionsPage(); window.close(); });

init();