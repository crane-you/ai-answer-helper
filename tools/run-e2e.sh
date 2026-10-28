#!/usr/bin/env bash
# 端到端：起本地静态服务 + 真实加载扩展的 Edge
#   1) 验证内容脚本注入、跨 frame 取题、面板联动（dump 断言）
#   2) 截取 页面内面板 / 设置页 / 工具栏弹窗 三张图
set -u
cd "$(dirname "$0")/.." || exit 1

EXT="$(pwd)"
EDGE="${EDGE_PATH:-}"
if [ -z "$EDGE" ]; then
  for p in \
    "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
    "/c/Program Files/Microsoft/Edge/Application/msedge.exe" \
    "/c/Program Files/Google/Chrome/Application/chrome.exe" \
    "/usr/bin/google-chrome" \
    "/usr/bin/chromium"; do
    if [ -x "$p" ]; then EDGE="$p"; break; fi
  done
fi
if [ -z "$EDGE" ]; then
  echo "找不到 Chrome / Edge，请用 EDGE_PATH 指定路径" >&2
  exit 1
fi
PROFILE="$EXT/.edge-e2e-$$"
PORT=8137

rm -rf "$PROFILE"
python -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SRV=$!
sleep 1.2

common=(--headless=new --disable-gpu --no-first-run --no-default-browser-check
        --user-data-dir="$PROFILE" --load-extension="$EXT" --disable-extensions-except="$EXT")

echo "=== 端到端 dump ==="
"$EDGE" "${common[@]}" --virtual-time-budget=9000 --dump-dom \
  "http://127.0.0.1:$PORT/test/e2e.html?clicktest=1" 2>/dev/null \
  | sed -n '/<pre id="log">/,/<\/pre>/p' | sed -e 's/<[^>]*>//g'

echo
echo "=== 页内面板截图 ==="
"$EDGE" "${common[@]}" --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=1180,760 --virtual-time-budget=9000 \
  --screenshot="$EXT/test/e2e.png" "http://127.0.0.1:$PORT/test/e2e.html" 2>/dev/null
[ -f test/e2e.png ] && ls -l test/e2e.png || echo "!! 面板截图失败"

# 生成设置页 / 弹窗页预览（桩替换 chrome.* API），再截图
python tools/make-page-previews.py

echo "=== 设置页截图 ==="
"$EDGE" "${common[@]}" --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=800,1000 --virtual-time-budget=4000 \
  --screenshot="$EXT/test/options.png" "http://127.0.0.1:$PORT/test/options-preview.html" 2>/dev/null
[ -f test/options.png ] && ls -l test/options.png || echo "!! 设置页截图失败"

echo "=== 工具栏弹窗截图 ==="
"$EDGE" "${common[@]}" --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=330,300 --virtual-time-budget=4000 \
  --screenshot="$EXT/test/popup.png" "http://127.0.0.1:$PORT/test/popup-preview.html" 2>/dev/null
[ -f test/popup.png ] && ls -l test/popup.png || echo "!! 弹窗截图失败"

kill $SRV 2>/dev/null
rm -rf "$PROFILE"