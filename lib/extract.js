/*!
 * AI 答题助手 · 页面题目识别
 * 纯逻辑模块：不依赖任何 chrome.* API，可被内容脚本、预览页、测试页共用。
 * 用法：AIQAExtract.snapshot()  /  AIQAExtract.createExtractor(window)
 */
(function (root) {
  'use strict';

  const VERSION = '1.0.0';
  const MAX_QUESTION_CHARS = 6000;
  const MAX_SCAN_NODES = 9000;
  const MAX_DETAIL_CANDIDATES = 160;

  // 永远不作为候选块（但其文字仍会算进父级）
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT',
    'EMBED', 'VIDEO', 'AUDIO', 'IMG', 'PICTURE', 'SOURCE', 'TRACK', 'INPUT', 'TEXTAREA',
    'SELECT', 'OPTION', 'OPTGROUP', 'BUTTON', 'HEAD', 'META', 'LINK', 'TITLE', 'BR',
    'HR', 'MAP', 'AREA', 'BODY', 'HTML', 'CODE', 'PRE'
  ]);

  // 可作为“题目块”的容器标签
  const CANDIDATE_TAGS = new Set([
    'DIV', 'P', 'SECTION', 'ARTICLE', 'MAIN', 'ASIDE', 'HEADER', 'FOOTER', 'NAV', 'FORM',
    'FIELDSET', 'LEGEND', 'UL', 'OL', 'LI', 'DL', 'DT', 'DD', 'BLOCKQUOTE', 'TABLE',
    'TBODY', 'THEAD', 'TD', 'TH', 'CAPTION', 'FIGURE', 'FIGCAPTION',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6'
  ]);

  // 明显的页面噪音（导航、广告、评论……）
  const NOISE_CLASS_RE = new RegExp(
    '(^|[\\s_-])(' +
      'nav|navbar|menu|sidebar|footer|header|banner|breadcrumb|crumb|comment|comments|' +
      'reply|related|recommend|advert|ads|ad-|toolbar|pagination|pager|copyright|share|' +
      'social|login|signup|search|modal|popup|toast|notice|tips|float|fixed-bar|footer-bar' +
    ')([\\s_-]|$)', 'i'
  );

  // 看起来像题目容器
  const QUESTION_CLASS_RE = /(question|quiz|exam|timu|stem|subject|tiku|topic|problem|q-?item|test-?item|answer-?area|q-?content)/i;

  const STEM_HINT_RE = /(下列|以下|哪一|哪些|哪个|选择|选出|判断|填空|简答|问答|计算|阅读|材料|关于|正确的|错误的|属于|不是|多少|什么|为什么|如何|请|试述|简述|解释|说明|已知|求)/;

  const CHROME_WORDS = ['登录', '注册', '首页', '上一题', '下一题', '提交', '收藏', '客服', '版权',
    '广告', '推荐', '分享', '评论', '举报', '纠错', '全部课程', '退出登录', '扫码'];

  const OPTION_PATTERNS = [
    /^[\s\u3000]*[（(\[【<]\s*([A-Ha-h])\s*[）)\]】>]\s*/,  // （A） (A) [A] <A>
    /^[\s\u3000]*([A-Ha-h])\s*[.、．,，:：)）]\s*/             // A.  A、  A：  A)
  ];

  const OPTION_SCAN_RE = /(?:^|[\s\u3000])[（(\[]?\s*([A-Ha-h])\s*[）)\]]?\s*[.、．,，:：)）](?!\d)\s*\S/g;

  /* ------------------------------ 工具函数 ------------------------------ */

  function matchOption(line) {
    for (let i = 0; i < OPTION_PATTERNS.length; i++) {
      const m = OPTION_PATTERNS[i].exec(line);
      if (m) return { letter: m[1].toUpperCase(), rest: line.slice(m[0].length) };
    }
    return null;
  }

  function optionLetters(text) {
    const set = new Set();
    let m;
    OPTION_SCAN_RE.lastIndex = 0;
    while ((m = OPTION_SCAN_RE.exec(text)) !== null) {
      set.add(m[1].toUpperCase());
      if (set.size >= 8) break;
    }
    return set;
  }

  function classHint(el) {
    let cls = '';
    try {
      cls = typeof el.className === 'string' ? el.className : (el.getAttribute && el.getAttribute('class')) || '';
    } catch (e) { cls = ''; }
    let id = '';
    try { id = el.id || ''; } catch (e) { id = ''; }
    let dt = '';
    try { dt = (el.getAttribute && el.getAttribute('data-type')) || ''; } catch (e) { dt = ''; }
    return (cls + ' ' + id + ' ' + dt).toLowerCase();
  }

  function rectOf(el, win) {
    try {
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.left + (win.scrollX || 0)),
        y: Math.round(r.top + (win.scrollY || 0)),
        vx: Math.round(r.left),
        vy: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height)
      };
    } catch (e) {
      return null;
    }
  }

  function visibilityScore(rect, win) {
    const vw = win.innerWidth || 1280;
    const vh = win.innerHeight || 800;
    const w = Math.min(rect.right !== undefined ? rect.right : rect.x + rect.width, vw) - Math.max(rect.x, 0);
    const h = Math.min(rect.top !== undefined ? rect.bottom : rect.y + rect.height, vh) - Math.max(rect.y, 0);
    const vis = Math.max(0, w) * Math.max(0, h);
    if (vis <= 0) return 0;
    const total = Math.max(1, (rect.width || 1) * (rect.height || 1));
    return 8 + Math.round(Math.min(1, vis / total) * 10);
  }

  /** 规整文本：统一空白、去掉分隔线、重复行、页面元信息与按钮栏 */
  function normalize(text) {
    let t = String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/\u00a0/g, ' ')
      .replace(/[\u200b-\u200d\ufeff]/g, '')
      .replace(/[ \t\u3000]+/g, ' ');

    const lines = t.split('\n').map(function (s) { return s.trim(); });
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) {
        if (out.length && out[out.length - 1] !== '') out.push('');
        continue;
      }
      if (/^[-_—=*·\s]{3,}$/.test(line)) continue;        // 分隔线
      if (out[out.length - 1] === line) continue;          // 连续重复
      if (isChromeLine(line)) continue;                    // 纯按钮栏
      if (isMetaLine(line)) continue;                      // 题型/题号/来源等信息行
      out.push(line);
    }
    t = out.join('\n').trim().replace(/\n{3,}/g, '\n\n');
    if (t.length > MAX_QUESTION_CHARS) t = t.slice(0, MAX_QUESTION_CHARS) + '\n…（已截断）';
    return t;
  }

  const CHROME_SET = new Set(CHROME_WORDS.concat([
    '收藏', '纠错', '举报', '添加', '分享', '评论', '更多', '确定', '取消', '返回',
    '答题卡', '交卷', '上一页', '下一页', '查看解析', '加入错题本'
  ]));

  /** 「提交 · 上一题 · 下一题」这类整行按钮 */
  function isChromeLine(line) {
    const parts = line.split(/[\s·|｜\/]+/).filter(Boolean);
    if (!parts.length || parts.length > 8) return false;
    return parts.every(function (p) { return CHROME_SET.has(p) || /^\d{1,3}$/.test(p); });
  }

  /** 「单选题 第1题/共20题 来源：模拟卷」这类元信息行 */
  function isMetaLine(line) {
    const t = line;
    if (!t || t.length > 90) return false;
    // 带题干特征的一律当题目保留
    if (/[?？]/.test(t) || STEM_HINT_RE.test(t) || /[（(]\s*[)）]/.test(t) || /_{3,}|＿{3,}/.test(t)) return false;

    let hits = 0;
    if (/第\s*\d+\s*题/.test(t)) hits++;
    if (/共\s*\d+\s*题|总共\s*\d+\s*题/.test(t)) hits++;
    if (/来源\s*[:：]|出题人|试卷名称/.test(t)) hits++;
    if (/分值|难度|用时|答题时间/.test(t)) hits++;
    if (/^(单选|多选|判断|填空|简答|问答|计算)题?$/.test(t)) hits++;
    if (/^题\s*型\s*[:：]/.test(t)) hits++;
    if (hits >= 2) return true;
    if (hits === 1) return t.length <= 40;
    return false;
  }

  /** 这段文字看起来像不像一道题 */
  function looksLikeQuestion(text) {
    if (!text) return false;
    if (/[?？]/.test(text)) return true;
    if (optionLetters(text).size >= 2) return true;
    if (STEM_HINT_RE.test(text)) return true;
    if (/(单选题|多选题|判断题|填空题|简答题|选择题)/.test(text)) return true;
    if (/([（(]\s*[)）]|_{3,}|＿{3,})/.test(text)) return true;
    return false;
  }

  /** 从一行文字里认出题型标签（要求整行像标签，且不含题干措辞） */
  function labelOfLine(line) {
    const t = String(line || '').trim();
    if (!t || t.length > 30) return '';
    if (/^(以下|下列|关于|请|根据)/.test(t)) return '';
    if (/多项选择|多选题|不定项/.test(t)) return '多选题';
    if (/单项选择|单选题/.test(t)) return '单选题';
    if (/判断题/.test(t)) return '判断题';
    if (/填空题/.test(t)) return '填空题';
    if (/简答题|问答题/.test(t)) return '简答题';
    return '';
  }

  /** 从原始文本里找单独成行的题型标签（这些行会在 normalize 时被清掉） */
  function findKindLabelLine(raw) {
    const lines = String(raw || '').split('\n');
    for (let i = 0; i < lines.length && i < 40; i++) {
      const label = labelOfLine(lines[i].replace(/[\s\u3000:：()（）\[\]【】·|]/g, ''));
      if (label) return label;
    }
    return '';
  }

  /** 题型写在小节标题上（如「二、多选题」）：看前面的兄弟元素和上级开头几行 */
  function detectKindFromContext(el) {
    if (!el) return '';
    const doc = el.ownerDocument;
    let node = el;
    for (let depth = 0; depth < 3; depth++) {
      let sib = node.previousElementSibling;
      for (let i = 0; i < 2 && sib; i++) {
        let t = '';
        try { t = (sib.innerText || sib.textContent || '').trim(); } catch (e) { t = ''; }
        if (t && t.indexOf('\n') < 0) {
          const label = labelOfLine(t);
          if (label) return label;
        }
        sib = sib.previousElementSibling;
      }

      const parent = node.parentElement;
      if (!parent || parent === doc.body || parent === doc.documentElement) break;
      let head = '';
      try { head = parent.innerText || ''; } catch (e) { head = ''; }
      const headLines = head.split('\n').slice(0, 3);
      for (let i = 0; i < headLines.length; i++) {
        const label = labelOfLine(headLines[i]);
        if (label) return label;
      }
      node = parent;
    }
    return '';
  }

  /** DOM 线索：复选框=多选，单选框=单选 */
  function detectKindFromDom(el) {
    if (!el) return '';
    const hint = classHint(el) + ' ' + classHint(el.parentElement || el);
    if (/checkbox|check-box|multi-?select|multi-?choice|duoxuan/.test(hint)) return '多选题';
    if (/radio|single-?select|danxuan/.test(hint)) return '单选题';

    let boxes = 0;
    let radios = 0;
    try {
      const inputs = el.querySelectorAll('input[type="checkbox"], input[type="radio"]');
      for (let i = 0; i < inputs.length && i < 40; i++) {
        if (inputs[i].type === 'checkbox') boxes++;
        else radios++;
      }
    } catch (e) { return ''; }

    if (boxes > 0 && radios === 0) return '多选题';
    if (radios > 0 && boxes === 0) return '单选题';
    return '';
  }

  /**
   * 判断题型。
   * text 是清理后的正文，rawText 是清理前的 innerText（下面这些标签行会被清掉，
   * 所以必须单独看一眼原文，否则「多选题」会被误判成单选题）。
   */
  function inferKind(text, el, rawText) {
    const body = String(text || '');
    const raw = String(rawText || body);
    const letters = optionLetters(body);

    // 1) 单独成行的题型标签最可靠
    const label = findKindLabelLine(raw);
    if (label) return label;

    // 2) 原文里明确写了多选 / 不定项
    if (/(多项选择|多选题|不定项|多选)/.test(raw)) return '多选题';
    if (/(判断题|对错题)/.test(raw)) return '判断题';
    // 「判断：……」这种题干，且没有 A/B/C/D 选项时按判断题处理
    if (!letters.size && /判断/.test(raw)) return '判断题';

    // 3) 控件形态
    const dom = detectKindFromDom(el);
    if (dom) return dom;

    // 4) 上下文（小节标题 / 前面板式元素）
    const ctx = detectKindFromContext(el);
    if (ctx) return ctx;

    // 5) 文本形态
    if (SINGLE_LABEL_RE.test(body)) return '单选题';
    if (letters.size >= 2) return '单选题';
    if (/(填空题)/.test(raw)) return '填空题';
    if (/([（(]\s*[)）]|_{3,}|＿{3,})/.test(body)) return '填空题';
    if (/(简答题|问答题|论述题)/.test(raw)) return '简答题';
    if (/(阅读|材料|根据上文)/.test(body)) return '阅读理解';
    return '题目';
  }

  const SINGLE_LABEL_RE = /(单项选择|单选题|单选)/;

  /** 块里带多个选项控件，也算“像题目” */
  function hasChoiceInputs(el) {
    if (!el) return false;
    try {
      return el.querySelectorAll('input[type="checkbox"], input[type="radio"]').length >= 2;
    } catch (e) {
      return false;
    }
  }

  /* ------------------------------ 打分 ------------------------------ */

  function coarseScore(el, text, rect, win) {
    const len = text.length;
    let score = 30;

    if (len < 14) score -= 15;
    if (len > 1200) score -= Math.min(26, (len - 1200) / 130);
    if (len > 5000) score -= 35;
    score -= Math.min(14, len / 170);                 // 轻微偏好紧凑块

    if (/[?？]/.test(text)) score += 8;
    if (STEM_HINT_RE.test(text)) score += 7;
    if (/A\s*[.、．]\s*\S/.test(text) && /B\s*[.、．]/.test(text)) score += 14;
    if (/(单选题|多选题|判断题|单项选择题|多项选择题|选择题|填空题|简答题)/.test(text)) score += 9;
    if (/([（(]\s*[)）]|_{3,}|＿{3,})/.test(text)) score += 5;
    if (/^\s*(\d{1,3}\s*[.、．]|[（(]\s*\d{1,3}\s*[)）]|第\s*\d+\s*题)/.test(text)) score += 6;

    score += visibilityScore(rect, win);

    const hint = classHint(el);
    if (QUESTION_CLASS_RE.test(hint)) score += 12;
    if (NOISE_CLASS_RE.test(hint)) score -= 22;

    return score;
  }

  function detailScore(el, text, rect, win) {
    let score = coarseScore(el, text, rect, win);

    const lines = text.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    const letters = new Set();
    for (let i = 0; i < lines.length; i++) {
      const m = matchOption(lines[i]);
      if (m) letters.add(m.letter);
    }
    // 选项写在同一行（A. 甲 B. 乙 C. 丙）时也认
    optionLetters(text).forEach(function (l) { letters.add(l); });
    score += Math.min(letters.size, 6) * 9;

    // 选项控件是“这是题目”的强信号，顺带帮上多选题
    let choiceInputs = 0;
    try { choiceInputs = el.querySelectorAll('input[type="checkbox"], input[type="radio"]').length; } catch (e) { choiceInputs = 0; }
    score += Math.min(choiceInputs, 6) * 6;

    let noiseHits = 0;
    for (let i = 0; i < CHROME_WORDS.length; i++) {
      if (text.indexOf(CHROME_WORDS[i]) >= 0) noiseHits++;
    }
    score -= Math.min(20, noiseHits * 4);

    let linkLen = 0;
    try {
      const anchors = el.querySelectorAll('a');
      for (let i = 0; i < anchors.length && i < 60; i++) {
        linkLen += (anchors[i].innerText || anchors[i].textContent || '').length;
      }
    } catch (e) { /* ignore */ }
    if (text.length > 40 && linkLen / text.length > 0.45) score -= 22;

    let controls = 0;
    try { controls = el.querySelectorAll('input, textarea, select').length; } catch (e) { controls = 0; }
    if (controls > 8) score -= 10;

    return score;
  }

  /* ------------------------------ 块收缩 / 扩张 ------------------------------ */

  function visibleChildren(el) {
    const out = [];
    const kids = el.children || [];
    for (let i = 0; i < kids.length && i < 40; i++) {
      const k = kids[i];
      if (SKIP_TAGS.has(k.tagName)) continue;
      try {
        const r = k.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
      } catch (e) { continue; }
      out.push(k);
    }
    return out;
  }

  function shrink(el, text) {
    let cur = el;
    let curText = text;
    for (let i = 0; i < 4; i++) {
      const kids = visibleChildren(cur);
      if (kids.length !== 1) break;
      let kt = '';
      try { kt = normalize(kids[0].innerText || kids[0].textContent || ''); } catch (e) { break; }
      if (!kt || kt.length < curText.length * 0.62) break;
      cur = kids[0];
      curText = kt;
    }
    return { el: cur, text: curText };
  }

  /** 题目文本里没有选项时，尝试向上找到包含选项的那一层 */
  function grow(el, text) {
    if (optionLetters(text).size >= 2) return { el: el, text: text };
    let cur = el;
    let curText = text;
    const doc = el.ownerDocument;
    for (let i = 0; i < 2; i++) {
      const p = cur.parentElement;
      if (!p || p === doc.body || p === doc.documentElement) break;
      let pt = '';
      try { pt = normalize(p.innerText || p.textContent || ''); } catch (e) { break; }
      if (!pt) break;
      if (pt.length > Math.max(80, curText.length * 2.2)) break;
      cur = p;
      curText = pt;
    }
    return { el: cur, text: curText };
  }

  /* ------------------------------ 主流程 ------------------------------ */

  function fallbackExtract(doc) {
    let el = null;
    try { el = doc.querySelector('main, article, [role="main"], #content, .content'); } catch (e) { el = null; }
    if (!el || !el.innerText) el = doc.body;
    let text = '';
    try { text = normalize(el.innerText || el.textContent || ''); } catch (e) { text = ''; }
    if (text.length < 20) {
      return { ok: false, text: '', score: -999, kind: '题目', tag: '', title: doc.title || '', rect: null };
    }
    if (text.length > 3000) text = text.slice(0, 3000) + '\n…（已截断）';
    return { ok: true, text: text, score: 0, kind: inferKind(text), tag: el.tagName || '', title: doc.title || '', rect: rectOf(el, doc.defaultView) };
  }

  function createExtractor(win) {
    const doc = win.document;

    function snapshot() {
      if (!doc || !doc.body) {
        return { ok: false, text: '', score: -999, kind: '题目', tag: '', title: '', rect: null };
      }

      let nodes;
      try { nodes = doc.body.getElementsByTagName('*'); } catch (e) { nodes = []; }

      const items = [];
      const limit = Math.min(nodes.length, MAX_SCAN_NODES);

      for (let i = 0; i < limit; i++) {
        const el = nodes[i];
        const tag = el.tagName;
        if (!tag) continue;
        if (SKIP_TAGS.has(tag)) continue;
        if (!CANDIDATE_TAGS.has(tag) && tag.indexOf('-') < 0) continue;

        let tc;
        try { tc = el.textContent || ''; } catch (e) { continue; }
        const len = tc.trim().length;
        if (len < 10 || len > MAX_QUESTION_CHARS * 2) continue;

        let rect;
        try { rect = el.getBoundingClientRect(); } catch (e) { continue; }
        if (!rect || rect.width < 4 || rect.height < 4) continue;

        items.push({ el: el, rect: rect, len: len, score: coarseScore(el, tc, rect, win) });
      }

      if (!items.length) return fallbackExtract(doc);

      items.sort(function (a, b) { return b.score - a.score; });
      const top = items.slice(0, MAX_DETAIL_CANDIDATES);

      let best = null;
      for (let i = 0; i < top.length; i++) {
        const it = top[i];
        let text;
        try { text = it.el.innerText || it.el.textContent || ''; } catch (e) { text = it.el.textContent || ''; }
        text = normalize(text);
        if (!text || text.length < 10) continue;
        const score = detailScore(it.el, text, it.rect, win);
        if (!best || score > best.score) best = { el: it.el, text: text, score: score };
      }

      if (!best) return fallbackExtract(doc);

      let cur = best.el;
      let curText = best.text;
      const s = shrink(cur, curText); cur = s.el; curText = s.text;
      const g = grow(cur, curText); cur = g.el; curText = g.text;

      let rawInner = '';
      try { rawInner = cur.innerText || curText; } catch (e) { rawInner = curText; }

      let finalText = curText;
      try { finalText = normalize(rawInner); } catch (e) { /* keep */ }
      if (!finalText) finalText = curText;

      // 不像题目（例如文章页），退回正文块，避免只抓到零散一段
      if (!looksLikeQuestion(finalText) && !hasChoiceInputs(cur)) {
        const fb = fallbackExtract(doc);
        if (fb && fb.ok && fb.text.length > finalText.length * 1.5) return fb;
      }

      return {
        ok: true,
        text: finalText,
        score: best.score,
        kind: inferKind(finalText, cur, rawInner),
        tag: cur.tagName || '',
        title: doc.title || '',
        rect: rectOf(cur, win),
        url: (win.location && win.location.href) || ''
      };
    }

    /** 用户手动点选元素后使用：包含选项兄弟节点 */
    function extractElement(el) {
      if (!el) return { ok: false, text: '' };
      let cur = el;
      let text = normalize(cur.innerText || cur.textContent || '');
      for (let i = 0; i < 3 && cur.parentElement && cur.parentElement !== doc.body; i++) {
        if (optionLetters(text).size >= 2 || text.length > 120) break;
        const p = cur.parentElement;
        let pt = '';
        try { pt = normalize(p.innerText || p.textContent || ''); } catch (e) { break; }
        if (!pt || pt.length > Math.max(120, text.length * 2.6)) break;
        cur = p;
        text = pt;
      }
      let rawFinal = '';
      try { rawFinal = cur.innerText || cur.textContent || ''; } catch (e) { rawFinal = text; }
      return {
        ok: !!text,
        text: text,
        score: 999,
        kind: inferKind(text, cur, rawFinal),
        tag: cur.tagName || '',
        title: doc.title || '',
        rect: rectOf(cur, win),
        url: (win.location && win.location.href) || ''
      };
    }

    return { version: VERSION, snapshot: snapshot, extractElement: extractElement, normalize: normalize, inferKind: inferKind };
  }

  const api = createExtractor(root);
  api.createExtractor = createExtractor;

  try { root.AIQAExtract = api; } catch (e) { /* ignore */ }
})(typeof window !== 'undefined' ? window : globalThis);