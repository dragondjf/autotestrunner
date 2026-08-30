#!/usr/bin/env bash
# ============================================================
# AutoTest Runner 绿色包构建脚本
# 产物: dist/autotest-runner/
#   node/      完整 node 二进制（单文件，随包分发）
#   app/       monorepo 源码 + 完整 node_modules（含 tsx/playwright）
#   browsers/  playwright 浏览器（chromium + headless-shell + ffmpeg）
#   data/      运行时数据目录（WEB_UI_DIR，自动生成 DB/截图/视频）
#   start.bat / stop.bat / start.sh / stop.sh / README.txt
# 用法: make package   （或直接 bash scripts/package.sh）
# ============================================================
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/autotest-runner"

echo "==> 构建 AutoTest Runner 绿色包 -> $OUT"
rm -rf "$OUT"
mkdir -p "$OUT/node" "$OUT/app" "$OUT/browsers" "$OUT/data"

# ---------- 1. node 二进制 ----------
NODE_BIN="$(node -e 'console.log(process.execPath)')"
echo "==> 1/5 拷贝 node 二进制: $NODE_BIN"
cp "$NODE_BIN" "$OUT/node/"
# Windows 分发目录下的辅助可执行（如 corepack/npm）不必须；node.exe 单文件即可运行

# ---------- 2. 应用源码（保持 monorepo 结构，启动用 app/node_modules/.bin/tsx） ----------
echo "==> 2/5 拷贝应用源码"
mkdir -p "$OUT/app"
# tar 管道：正确展开 pnpm 的 junction/symlink（cp -r 会生成空目录）
( cd "$ROOT" && tar cf - package.json pnpm-workspace.yaml tsconfig.base.json packages ) | ( cd "$OUT/app" && tar xf - )
mkdir -p "$OUT/app/static"   # STATIC_DIR 默认 app/static（截图产物）

# ---------- 3. 依赖（整份 node_modules：.pnpm + .bin shims，tsx 为运行必需） ----------
echo "==> 3/5 拷贝 node_modules（较大，请稍候）"
( cd "$ROOT" && tar cf - node_modules ) | ( cd "$OUT/app" && tar xf - )
# pnpm 的包间链接是绝对路径 symlink（指向源仓库）→ 以源为蓝图在包内重建链接
echo "==> 3b/5 重建依赖链接（包内独立）"
node "$ROOT/scripts/relink.mjs" "$ROOT" "$OUT/app"

# ---------- 4. playwright 浏览器（版本与 playwright-core 对齐） ----------
PW_CACHE="$USERPROFILE/AppData/Local/ms-playwright"
[ -d "$PW_CACHE" ] || PW_CACHE="$HOME/.cache/ms-playwright"
REVS="$(node -e "
  const fs = require('fs');
  const p = fs.readdirSync(process.cwd() + '/node_modules/.pnpm').find(x => x.startsWith('playwright-core@'));
  const b = JSON.parse(fs.readFileSync(process.cwd() + '/node_modules/.pnpm/' + p + '/node_modules/playwright-core/browsers.json', 'utf-8'));
  const names = { chromium: 'chromium', 'chromium-headless-shell': 'chromium_headless_shell', ffmpeg: 'ffmpeg' };
  console.log(b.browsers.filter(x => names[x.name]).map(x => names[x.name] + '-' + x.revision).join(' '));
")"
echo "==> 4/5 拷贝 playwright 浏览器: $REVS"
for d in $REVS; do
  if [ -d "$PW_CACHE/$d" ]; then
    cp -r "$PW_CACHE/$d" "$OUT/browsers/"
  else
    echo "    ! 警告: 缓存缺少 $d，将使用本机 playwright 缓存路径启动（见 README）"
  fi
done

# ---------- 5. 配置、启动/停止脚本与说明 ----------
echo "==> 5/5 生成 application.json 与启动脚本"
# shellcheck source=scripts/package-tpl.sh
source "$(dirname "$0")/package-tpl.sh"
gen_config
gen_scripts

echo ""
echo "==> 完成: $OUT"
du -sh "$OUT" 2>/dev/null | awk '{print "    总大小:", $1}'
