@echo off
chcp 65001 >nul
echo ============================================================
echo   AutoTest UX 原型预览启动器
echo   真实界面（AI录制 index.html / 浏览器录制 inspect.html）
echo   依赖本地静态服务 http://127.0.0.1:8123
echo ============================================================
echo.

cd /d "%~dp0packages\web-ui\frontend"

:: 检查 8123 端口是否已在监听
netstat -ano | findstr ":8123" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo [已检测到服务运行中] http://127.0.0.1:8123
) else (
  echo [启动静态服务] http://127.0.0.1:8123  ^(服务根 = frontend，/assets 可正确解析^)
  start "AutoTestPreview" cmd /k "cd /d "%~dp0packages\web-ui\frontend" && python -m http.server 8123 --bind 127.0.0.1"
  timeout /t 3 /nobreak >nul
)

echo.
echo [打开三主题原型（AI录制/浏览器录制页为真实界面嵌入）]
start "" "%~dp0docs\需求设计\AutoTest_UX交互原型_三主题.html"

echo.
echo 完成。在原型中切换至「AI 录制」或「浏览器录制」即可看到真实页面。
echo 关闭服务：关掉标题为 AutoTestPreview 的命令窗口即可。
echo.
pause
