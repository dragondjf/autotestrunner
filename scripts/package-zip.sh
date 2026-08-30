#!/usr/bin/env bash
# ============================================================
# 绿色包 zip 打包
# 产物命名: {appname}_{arch}_{os}_{时间戳YYYYMMDDHHmm}_{commit}.zip
#   例: AutoTestRunner_x64_win32_202608302205_1b8eb74.zip
# 用法: make zip-only   （打包现有 dist/autotest-runner）
# ============================================================
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/autotest-runner"

if [ ! -d "$OUT" ] || [ ! -d "$OUT/app" ]; then
  echo "!! 未找到绿色包 $OUT —— 请先执行 make package 或 make update"
  exit 1
fi

# ---------- 命名要素 ----------
APP_NAME="$(node -e "
  try { const c = require('$OUT/application.json'); process.stdout.write(String(c.appName || 'AutoTestRunner').replace(/\s+/g, '')); }
  catch { process.stdout.write('AutoTestRunner'); }
")"
ARCH="$(node -e 'process.stdout.write(process.arch)')"          # x64 / arm64
OS="$(node -e 'process.stdout.write(process.platform)')"        # win32 / linux / darwin
TS="$(date +%Y%m%d%H%M)"
COMMIT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo "nogit")"

ZIP="$ROOT/dist/${APP_NAME}_${ARCH}_${OS}_${TS}_${COMMIT}.zip"
rm -f "$ZIP"

echo "==> 打包: $ZIP"
echo "    ${APP_NAME} | ${ARCH} | ${OS} | ${TS} | commit ${COMMIT}"

# ---------- 压缩（zip 命令优先，缺省回退 powershell Compress-Archive） ----------
if command -v zip >/dev/null 2>&1; then
  ( cd "$OUT" && zip -rq "$ZIP" . -x 'data/*' )
else
  powershell -NoProfile -Command "Compress-Archive -Path '$OUT/*' -DestinationPath '$ZIP' -Force"
fi

SIZE="$(du -h "$ZIP" | awk '{print $1}')"
echo "==> 完成: $ZIP ($SIZE)"
