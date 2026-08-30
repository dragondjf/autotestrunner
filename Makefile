# ============================================================
# AutoTest Runner 绿色包构建
#   make package  → 构建 dist/autotest-runner/（node + 依赖 + playwright/chromium + 启动脚本）
#   make clean    → 清理 dist/
# 依赖：bash、node、git-bash（Windows）/ make + bash（Linux）
# ============================================================
PACKAGE := dist/autotest-runner

.PHONY: package clean

package:
	@bash scripts/package.sh

clean:
	rm -rf dist

# 展示包内容
info:
	@ls -la $(PACKAGE) 2>/dev/null || echo "尚未构建，先执行 make package"
