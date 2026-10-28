#!/usr/bin/env bash
# 上架前自检：解压 zip，用真实浏览器加载，确认打包内容完整可用。
# 用法：bash tools/check-package.sh [dist/xxx.zip]
set -u
cd "$(dirname "$0")/.." || exit 1

ZIP="${1:-$(ls -t dist/*.zip 2>/dev/null | head -1)}"
if [ -z "$ZIP" ] || [ ! -f "$ZIP" ]; then
  echo "找不到 zip，请先运行：python tools/build-package.py" >&2
  exit 1
fi

EDGE="${EDGE_PATH:-}"
if [ -z "$EDGE" ]; then
  for p in \
    "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
    "/c/Program Files/Microsoft/Edge/Application/msedge.exe" \
    "/usr/bin/google-chrome" \
    "/usr/bin/chromium"; do
    if [ -x "$p" ]; then EDGE="$p"; break; fi
  done
fi
if [ -z "$EDGE" ]; then
  echo "找不到浏览器，请用 EDGE_PATH 指定" >&2
  exit 1
fi

PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()' 2>/dev/null \
  || python -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')

rm -rf .pkg-check .pkg-profile
mkdir .pkg-check
unzip -q "$ZIP" -d .pkg-check || { echo "解压失败" >&2; exit 1; }

echo "=== 包内容 ==="
(cd .pkg-check && find . -type f | sort | sed 's|^\./|  |')
echo

python -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SRV=$!
sleep 1.2

OUT=$("$EDGE" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --user-data-dir="$(pwd)/.pkg-profile" \
  --load-extension="$(pwd)/.pkg-check" --disable-extensions-except="$(pwd)/.pkg-check" \
  --virtual-time-budget=9000 --dump-dom "http://127.0.0.1:$PORT/test/e2e.html" 2>/dev/null \
  | sed -n '/<pre id="log">/,/<\/pre>/p' | sed -e 's/<[^>]*>//g')

kill $SRV 2>/dev/null
echo "=== 运行结果 ==="
echo "$OUT"

if echo "$OUT" | grep -q "PANEL_OPEN=true" && echo "$OUT" | grep -q "HAS_OPTIONS=true" && echo "$OUT" | grep -q "NO_NOISE=true"; then
  echo
  echo "打包校验通过：zip 可直接安装并正常工作"
  rm -rf .pkg-check .pkg-profile
  exit 0
fi

echo
echo "打包校验失败：检查 dist 是否缺文件（保留 .pkg-check 供排查）"
exit 1