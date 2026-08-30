#!/usr/bin/env bash
# AutoTest UX 原型预览启动器（Git Bash）
# 真实界面（AI录制 index.html / 浏览器录制 inspect.html）依赖本地静态服务
ROOT="$(cd "$(dirname "$0")" && pwd)"
FRONT="$ROOT/packages/web-ui/frontend"
PROTO="$ROOT/docs/需求设计/AutoTest_UX交互原型_三主题.html"

echo "============================================================"
echo "  AutoTest UX 原型预览启动器"
echo "  真实界面依赖本地静态服务 http://127.0.0.1:8123"
echo "============================================================"

if netstat -ano | grep -q ":8123 .*LISTENING"; then
  echo "[已检测到服务运行中] http://127.0.0.1:8123"
else
  echo "[启动静态服务] http://127.0.0.1:8123  (服务根 = frontend)"
  (cd "$FRONT" && python -m http.server 8123 --bind 127.0.0.1 > /tmp/autotest_preview.log 2>&1 &
  echo $! > /tmp/autotest_preview.pid)
  sleep 3
fi

echo "[打开三主题原型] $PROTO"
cmd //c start "" "$(cygpath -w "$PROTO")"

echo "完成。在原型中切换至「AI 录制」或「浏览器录制」即可看到真实页面。"
echo "关闭服务：kill \$(cat /tmp/autotest_preview.pid)"
