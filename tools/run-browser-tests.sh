#!/usr/bin/env bash
# 用本机 Chrome / Edge 的无头模式跑「题目识别自测」并生成界面截图。
# 用法：bash tools/run-browser-tests.sh
#      EDGE_PATH="/path/to/msedge" bash tools/run-browser-tests.sh
set -u
cd "$(dirname "$0")/.." || exit 1

# 浏览器路径：优先 EDGE_PATH，其次常见安装位置
EDGE="${EDGE_PATH:-}"
if [ -z "$EDGE" ]; then
  for p in \
    "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
    "/c/Program Files/Microsoft/Edge/Application/msedge.exe" \
    "/c/Program Files/Google/Chrome/Application/chrome.exe" \
    "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/usr/bin/google-chrome" \
    "/usr/bin/chromium" \
    "/usr/bin/chromium-browser"; do
    if [ -x "$p" ]; then EDGE="$p"; break; fi
  done
fi
if [ -z "$EDGE" ]; then
  echo "找不到 Chrome / Edge，请用 EDGE_PATH 指定路径：" >&2
  echo '  EDGE_PATH="/path/to/msedge" bash tools/run-browser-tests.sh' >&2
  exit 1
fi

# 本目录的 file:// URL（自动处理空格与中文路径）
BASE=$(python3 -c "import pathlib;print(pathlib.Path('.').resolve().as_uri())" 2>/dev/null \
  || python -c "import pathlib;print(pathlib.Path('.').resolve().as_uri())" 2>/dev/null \
  || echo "file://$(pwd)")

PROFILE="$(pwd)/.edge-run-$$"
common=(--headless=new --disable-gpu --no-first-run --no-default-browser-check --disable-extensions)

echo "=== 1/2 题目识别自测 ==="
"$EDGE" "${common[@]}" --user-data-dir="$PROFILE" --virtual-time-budget=6000 \
  --dump-dom "$BASE/test/extract-test.html" 2>/dev/null \
  | sed -n '/<pre id="out">/,/<\/pre>/p' \
  | sed -e 's/<pre id="out">//' -e 's/<\/pre>//' -e 's/<[^>]*>//g'

echo
echo "=== 2/2 界面截图 ==="
"$EDGE" "${common[@]}" --user-data-dir="$PROFILE" --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=1180,800 --virtual-time-budget=8000 \
  --screenshot="$(pwd)/demo/preview.png" "$BASE/demo/preview.html?auto=1" 2>/dev/null

if [ -f demo/preview.png ]; then
  ls -l demo/preview.png
else
  echo "!! 截图失败"
fi

rm -rf "$PROFILE"