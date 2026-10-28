"""把 options.html / popup.html 复制成可独立渲染的预览页（用桩替换 chrome.* API），
用于无头浏览器截图验证布局与脚本。生成物放在 test/ 下，不影响扩展本体。"""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

OPTIONS_STUB = """
<script>
  const FAKE = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', visionModel: '',
    temperature: 0.2, maxTokens: 1600, hasApiKey: true, apiKeyTail: 'a1b2',
    systemPrompt: '你是一位严谨、高效的解题助手。\\n\\n请按下面步骤处理：……' };
  window.chrome = {
    runtime: {
      sendMessage: (msg, cb) => {
        if (msg.type === 'GET_SETTINGS') return cb({ ok: true, settings: FAKE });
        if (msg.type === 'GET_DEFAULTS') return cb({ ok: true, systemPrompt: FAKE.systemPrompt });
        if (msg.type === 'TEST_CONNECTION') return setTimeout(() => cb({ ok: true, text: '可用' }), 600);
        cb({ ok: false, error: 'stub' });
      },
      openOptionsPage: () => {}
    },
    storage: { local: { get: async () => ({ apiKey: 'sk-preview-a1b2' }), set: async () => {}, remove: async () => {} } }
  };
</script>
"""

POPUP_STUB = """
<script>
  window.chrome = {
    runtime: {
      sendMessage: (msg, cb) => cb({ ok: true, settings: {
        baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', visionModel: '',
        hasApiKey: true, apiKeyTail: 'a1b2'
      } }),
      openOptionsPage: () => {}
    },
    tabs: { query: async () => [{ url: 'https://example.com/quiz/123' }] },
    storage: { local: { get: async () => ({ 'aiqa:paused': false, 'aiqa:disabledSites': [] }) } }
  };
</script>
"""


def build(src_rel, dst_rel, css_map, script_map, stub):
    src = open(os.path.join(ROOT, src_rel), encoding='utf-8').read()
    for old, new in css_map:
        src = src.replace(old, new)
    for old, new in script_map:
        src = src.replace(old, stub + new)
    out = os.path.join(ROOT, dst_rel)
    open(out, 'w', encoding='utf-8').write(src)
    print('wrote', out)


def main():
    build(
        'options/options.html', 'test/options-preview.html',
        [('href="options.css"', 'href="../options/options.css"')],
        [('<script src="options.js"></script>', '<script src="../options/options.js"></script>')],
        OPTIONS_STUB,
    )
    build(
        'popup/popup.html', 'test/popup-preview.html',
        [],
        [('<script src="popup.js"></script>', '<script src="../popup/popup.js"></script>')],
        POPUP_STUB,
    )


if __name__ == '__main__':
    main()