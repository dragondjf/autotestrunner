#!/usr/bin/env bash
# 绿色包配置与启动脚本模板生成（全量/增量构建共用）。
# 使用前需设置 OUT（绿色包目录）；本文件被 package.sh / package-update.sh source。

gen_config() {
  cat > "$OUT/application.json" <<'JSONEOF'
{
  "appName": "AutoTest Runner",
  "appTitle": "AutoTest Runner · Web-UI 自动化测试平台",
  "logo": "data/logo.png",
  "host": "0.0.0.0",
  "port": 25000,
  "autoOpenBrowser": true,
  "openPath": "/app"
}
JSONEOF
}

gen_scripts() {
  cat > "$OUT/start.bat" <<'BATEOF'
@echo off
chcp 65001 >nul
cd /d %~dp0

set "NODE_DIR=%~dp0node"
set "PATH=%NODE_DIR%;%PATH%"

rem ===== 读取 application.json 配置（端口/名称/自动开浏览器） =====
set "PORT=25000"
set "APP_NAME=AutoTest Runner"
set "AUTO_OPEN=1"
if exist application.json (
  for /f "delims=" %%a in ('node -e "const c=require('./application.json');process.stdout.write(String(c.port||25000))"') do set "PORT=%%a"
  for /f "delims=" %%a in ('node -e "const c=require('./application.json');process.stdout.write(String(c.appName||'AutoTest Runner'))"') do set "APP_NAME=%%a"
  for /f "delims=" %%a in ('node -e "const c=require('./application.json');process.stdout.write(c.autoOpenBrowser===false?'0':'1')"') do set "AUTO_OPEN=%%a"
)

rem ===== 品牌横幅 =====
echo.
echo   %APP_NAME%  ·  Web-UI 自动化测试平台
echo.
echo   +----------------------------------------------+
echo   ^|  管理台   http://127.0.0.1:%PORT%/app
echo   ^|  日志     data\server.log
echo   ^|  停止     stop.bat
echo   +----------------------------------------------+
echo.

rem ===== 已在运行检查 =====
if exist data\runner.pid (
  set /p OLD=<data\runner.pid
  tasklist /FI "PID eq %OLD%" 2>nul | find "%OLD%" >nul && (echo %APP_NAME% 已在运行 (PID %OLD^) & exit /b 0)
  del /q data\runner.pid >nul 2>&1
)

set "PLAYWRIGHT_BROWSERS_PATH=%~dp0browsers"
set "WEB_UI_DIR=%~dp0data"
cd /d %~dp0app
echo 正在启动 ...
powershell -NoProfile -Command "$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','set PORT=%PORT%&& node_modules\.bin\tsx.cmd packages\web-ui\src\server.ts > ..\data\server.log 2>&1' -WorkingDirectory (Get-Location).Path -WindowStyle Hidden -PassThru; $p.Id" > ..\data\runner.pid
cd /d %~dp0
set /p PID=<data\runner.pid
echo  已启动 (PID %PID%) · 端口 %PORT%

rem ===== 自动打开浏览器 =====
if "%AUTO_OPEN%"=="1" (
  echo  正在打开浏览器 ...
  timeout /t 3 /nobreak >nul
  start "" "http://127.0.0.1:%PORT%/app"
)
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
export PATH="$PWD/node:$PATH"

# ===== 读取 application.json 配置（端口/名称/自动开浏览器） =====
PORT=25000
APP_NAME="AutoTest Runner"
AUTO_OPEN=1
if [ -f application.json ]; then
  PORT="$(node -e "const c=require('./application.json');process.stdout.write(String(c.port||25000))")"
  APP_NAME="$(node -e "const c=require('./application.json');process.stdout.write(String(c.appName||'AutoTest Runner'))")"
  AUTO_OPEN="$(node -e "const c=require('./application.json');process.stdout.write(c.autoOpenBrowser===false?'0':'1')")"
fi

echo ""
echo "  $APP_NAME  ·  Web-UI 自动化测试平台"
echo ""
echo "  +----------------------------------------------+"
echo "  |  管理台   http://127.0.0.1:$PORT/app"
echo "  |  日志     data/server.log"
echo "  |  停止     stop.sh"
echo "  +----------------------------------------------+"
echo ""

if [ -f data/runner.pid ] && kill -0 "$(cat data/runner.pid)" 2>/dev/null; then
  echo "$APP_NAME 已在运行 (PID $(cat data/runner.pid))"
  exit 0
fi
export PLAYWRIGHT_BROWSERS_PATH="$PWD/browsers"
export WEB_UI_DIR="$PWD/data"
export PORT
cd app
nohup node_modules/.bin/tsx packages/web-ui/src/server.ts > ../data/server.log 2>&1 &
echo $! > ../data/runner.pid
cd ..
echo "已启动 (PID $(cat data/runner.pid)) · 端口 $PORT"

if [ "$AUTO_OPEN" = "1" ]; then
  echo "正在打开浏览器 ..."
  sleep 3
  (command -v xdg-open >/dev/null && xdg-open "http://127.0.0.1:$PORT/app") \
    || (command -v open >/dev/null && open "http://127.0.0.1:$PORT/app") || true
fi
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
管理台：http://127.0.0.1:25000/app （启动后自动打开浏览器）

配置：编辑 application.json 可修改：
  port            服务端口（默认 25000）
  appName / appTitle  产品名称
  logo            产品 logo 路径（相对本目录）
  host            监听地址（默认 0.0.0.0）
  autoOpenBrowser 启动后是否自动打开浏览器（true/false）
  openPath        打开的管理台路径（默认 /app）

目录说明：
  node/       Node 运行时（已加入 PATH）
  app/        应用源码 + 依赖（node_modules）
  browsers/   Playwright 浏览器（Chromium/headless-shell/ffmpeg）
  data/       运行时数据：数据库 autotest.db、截图、视频、报告导出、录制协议
  data/server.log  服务日志

说明：
  1. 端口被占用时日志会提示（PORT 已生效于 application.json）。
  2. 任务执行的 JS/PY 脚本通道在包内可用；Runner 通道（录制/步骤协议执行）
     需另行启动 runner 服务（:8900）与本包配合。
  3. 若本机 ms-playwright 缓存缺少浏览器（构建时已警告），可执行：
     app 目录下 `npx playwright install chromium` 后重启。
TXT

  chmod +x "$OUT/start.sh" "$OUT/stop.sh"
  # Windows 批处理必须 CRLF 换行（LF-only 会导致 cmd 解析错乱）
  sed -i 's/\r$//; s/$/\r/' "$OUT/start.bat" "$OUT/stop.bat"
}
