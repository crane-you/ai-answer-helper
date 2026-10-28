#!/usr/bin/env bash
# 生成 1280×800 的商店截图（Edge 商店要求 1280×800 或 640×480）
# 用法：bash tools/make-store-screenshots.sh
set -u
cd "$(dirname "$0")/.." || exit 1

EDGE="${EDGE_PATH:-}"
if [ -z "$EDGE" ]; then
  for p in \
    "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
    "/c/Program Files/Microsoft/Edge/Application/msedge.exe" \
    "/usr/bin/google-chrome"; do
    if [ -x "$p" ]; then EDGE="$p"; break; fi
  done
fi
if [ -z "$EDGE" ]; then
  echo "找不到浏览器，请用 EDGE_PATH 指定" >&2
  exit 1
fi

BASE=$(python3 -c "import pathlib;print(pathlib.Path('.').resolve().as_uri())" 2>/dev/null \
  || python -c "import pathlib;print(pathlib.Path('.').resolve().as_uri())" 2>/dev/null \
  || echo "file://$(pwd)")
PROFILE="$(pwd)/.edge-shot-$$"
mkdir -p store

common=(--headless=new --disable-gpu --no-first-run --no-default-browser-check --hide-scrollbars
        --force-device-scale-factor=1 --window-size=1280,800
        --user-data-dir="$PROFILE" --virtual-time-budget=9000)

echo "=== 1/2 答题面板 ==="
"$EDGE" "${common[@]}" --screenshot="$(pwd)/store/shot-1-panel.png" \
  "$BASE/demo/preview.html?auto=1" 2>/dev/null

echo "=== 2/2 设置页 ==="
python tools/make-page-previews.py >/dev/null 2>&1 || true
"$EDGE" "${common[@]}" --screenshot="$(pwd)/store/shot-2-options.png" \
  "$BASE/test/options-preview.html" 2>/dev/null

rm -rf "$PROFILE" test/options-preview.html test/popup-preview.html

for f in store/shot-1-panel.png store/shot-2-options.png; do
  if [ -f "$f" ]; then
    echo "  $f"
  else
    echo "  !! 缺少 $f"
  fi
done