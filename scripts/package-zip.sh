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

# ---------- 压缩 ----------
# 优先 zip；Windows(git-bash) 用系统自带 bsdtar(tar.exe, C:\Windows\System32，
# 按 .zip 扩展名生成 zip，GNU tar 的 -a 不支持 zip 故必须写死绝对路径)；
# 再兜底 powershell Compress-Archive（必须 cygpath 转 Windows 路径 —— MSYS
# 路径内嵌在引号串里不会被自动转换，曾致 "The path 'D:\d\a\...' does not
# exist" 而打包失败）。
# 注意: bsdtar 的 --exclude 是全树路径段匹配，会误伤深层同名目录(如
# node_modules/**/data)，故用 find -prune 生成"仅顶层排除"的文件清单(-T)。
ZIP_NAME="$(basename "$ZIP")"
if command -v zip >/dev/null 2>&1; then
  ( cd "$OUT" && zip -rq "$ZIP" . -x 'data/*' )
elif [ -x /c/Windows/System32/tar.exe ]; then
  ( cd "$OUT" && \
    find . -path ./data -prune -o -type f -print | sed 's|^\./||' > .artr-filelist.txt && \
    /c/Windows/System32/tar.exe -a -cf "../${ZIP_NAME}" -T .artr-filelist.txt && \
    rm -f .artr-filelist.txt )
else
  # git-bash 环境下 PowerShell 不识别 /d/... 风格路径，先转成 Windows 路径
  PS_OUT="$OUT"; PS_ZIP="$ZIP"
  command -v cygpath >/dev/null 2>&1 && { PS_OUT="$(cygpath -w "$OUT")"; PS_ZIP="$(cygpath -w "$ZIP")"; }
  powershell -NoProfile -Command "Compress-Archive -Path '${PS_OUT}\*' -DestinationPath '${PS_ZIP}' -Force"
fi

SIZE="$(du -h "$ZIP" | awk '{print $1}')"
echo "==> 完成: $ZIP ($SIZE)"
