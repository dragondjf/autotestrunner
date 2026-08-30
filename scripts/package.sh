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

# ---------- 5. 启动/停止脚本与说明 ----------
echo "==> 5/5 生成启动脚本"
cat > "$OUT/start.bat" <<'BATEOF'
@echo off
chcp 65001 >nul
cd /d %~dp0
if exist data\runner.pid (
  set /p OLD=<data\runner.pid
  tasklist /FI "PID eq %OLD%" 2>nul | find "%OLD%" >nul && (echo AutoTest Runner 已在运行 (PID %OLD^) & exit /b 0)
  del /q data\runner.pid >nul 2>&1
)
set "NODE_DIR=%~dp0node"
set "PATH=%NODE_DIR%;%PATH%"
set "PLAYWRIGHT_BROWSERS_PATH=%~dp0browsers"
set "WEB_UI_DIR=%~dp0data"
cd /d %~dp0app
echo 正在启动 AutoTest Runner ...
powershell -NoProfile -Command "$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','node_modules\.bin\tsx.cmd packages\web-ui\src\server.ts > ..\data\server.log 2>&1' -WorkingDirectory (Get-Location).Path -WindowStyle Hidden -PassThru; $p.Id" > ..\data\runner.pid
cd /d %~dp0
set /p PID=<data\runner.pid
echo.
echo  已启动 (PID %PID%)
echo  管理台:  http://localhost:8080/app
echo  日志:     data\server.log
echo  停止:     stop.bat
BATEOF

cat > "$OUT/stop.bat" <<'BATEOF'
@echo off
chcp 65001 >nul
cd /d %~dp0
if not exist data\runner.pid ( echo AutoTest Runner 未在运行 & exit /b 0 )
set /p PID=<data\runner.pid
taskkill /F /T /PID %PID% >nul 2>&1
del /q data\runner.pid >nul 2>&1
echo 已停止 AutoTest Runner (PID %PID%)
BATEOF

cat > "$OUT/start.sh" <<'SHEOF'
#!/usr/bin/env bash
cd "$(dirname "$0")"
if [ -f data/runner.pid ] && kill -0 "$(cat data/runner.pid)" 2>/dev/null; then
  echo "AutoTest Runner 已在运行 (PID $(cat data/runner.pid))"
  exit 0
fi
export PATH="$PWD/node:$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/browsers"
export WEB_UI_DIR="$PWD/data"
cd app
nohup node_modules/.bin/tsx packages/web-ui/src/server.ts > ../data/server.log 2>&1 &
echo $! > ../data/runner.pid
cd ..
echo "已启动 (PID $(cat data/runner.pid))"
echo "管理台:  http://localhost:8080/app"
echo "日志:     data/server.log"
echo "停止:     stop.sh"
SHEOF

cat > "$OUT/stop.sh" <<'SHEOF'
#!/usr/bin/env bash
cd "$(dirname "$0")"
if [ ! -f data/runner.pid ]; then
  echo "AutoTest Runner 未在运行"
  exit 0
fi
PID=$(cat data/runner.pid)
kill "$PID" 2>/dev/null && echo "已停止 AutoTest Runner (PID $PID)"
rm -f data/runner.pid
SHEOF

cat > "$OUT/README.txt" <<'TXT'
AutoTest Runner 绿色包
======================
包含：Node 二进制、全部依赖、Playwright 及 Chromium 浏览器、应用与前端。

启动：Windows 双击 start.bat；Linux/macOS 执行 ./start.sh
停止：stop.bat / stop.sh
管理台：http://localhost:8080/app

目录说明：
  node/       Node 运行时（已加入 PATH）
  app/        应用源码 + 依赖（node_modules）
  browsers/   Playwright 浏览器（Chromium/headless-shell/ffmpeg）
  data/       运行时数据：数据库 autotest.db、截图、视频、报告导出、录制协议
  data/server.log  服务日志

说明：
  1. 服务默认端口 8080（被占用时日志会提示）。
  2. 任务执行的 JS/PY 脚本通道在包内可用；Runner 通道（录制/步骤协议执行）
     需另行启动 runner 服务（:8900）与本包配合。
  3. 若本机 ms-playwright 缓存缺少浏览器（构建时已警告），可执行：
     app 目录下 `npx playwright install chromium` 后重启。
TXT

chmod +x "$OUT/start.sh" "$OUT/stop.sh"
# Windows 批处理必须 CRLF 换行（LF-only 会导致 cmd 解析错乱）
sed -i 's/\r$//; s/$/\r/' "$OUT/start.bat" "$OUT/stop.bat"

echo ""
echo "==> 完成: $OUT"
du -sh "$OUT" 2>/dev/null | awk '{print "    总大小:", $1}'
