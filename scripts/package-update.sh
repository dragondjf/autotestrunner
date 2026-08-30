#!/usr/bin/env bash
# ============================================================
# 增量更新绿色包（基于已有产物 dist/autotest-runner）
# 仅更新：应用源码（packages/* 排除 node_modules）、根配置、
#         application.json 与启动脚本模板
# 不重复：node 二进制 / node_modules 依赖 / playwright 浏览器 / data
# 用法: make update   （或 bash scripts/package-update.sh）
# ============================================================
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/autotest-runner"

if [ ! -d "$OUT/app" ]; then
  echo "!! 未找到已有绿色包 $OUT —— 请先执行 make package（全量构建）"
  exit 1
fi

echo "==> 增量更新 -> $OUT"

# ---------- 1. 应用源码（排除各包 node_modules，保留包内已重建的依赖链接） ----------
echo "==> 1/4 更新应用源码（跳过 node_modules）"
( cd "$ROOT" && tar cf - \
    --exclude='*/node_modules' \
    --exclude='*/dist' \
    package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json packages ) \
  | ( cd "$OUT/app" && tar xf - )

# 依赖清单变化时提示（需全量重建）
if [ -f "$OUT/app/package.json" ] && [ -f "$ROOT/package.json" ]; then
  if ! diff -q "$ROOT/package.json" "$OUT/app/package.json" >/dev/null 2>&1; then
    echo "    ! 注意: package.json 有变化，若新增了依赖请执行 make package 全量重建"
  fi
fi

# ---------- 2. 应用入口与前端静态资源 ----------
echo "==> 2/4 更新前端静态资源（frontend/assets）"
( cd "$ROOT" && tar cf - --exclude='*/node_modules' packages/web-ui/frontend ) \
  | ( cd "$OUT/app" && tar xf - )

# ---------- 3. 配置与启动脚本（模板可能随版本更新） ----------
echo "==> 3/4 更新 application.json 与启动脚本"
source "$(dirname "$0")/package-tpl.sh"
gen_config
gen_scripts

# ---------- 4. 包内新源码需要重跑依赖链接（仅当 relink 蓝图变化时影响极小，幂等） ----------
echo "==> 4/4 校验依赖链接（幂等）"
node "$ROOT/scripts/relink.mjs" "$ROOT" "$OUT/app" >/dev/null

echo ""
echo "==> 增量更新完成: $OUT"
echo "    如需重新打包 zip: make zip-only"
