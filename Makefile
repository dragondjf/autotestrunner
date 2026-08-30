# ============================================================
# AutoTest Runner 构建
#   make package     全量构建绿色包 dist/autotest-runner/
#                    （node + 依赖 + playwright/chromium + 启动脚本）
#   make update      增量更新（基于已有产物：仅更新源码与脚本，秒级）
#   make zip-only    打包现有产物为 {appname}_{arch}_{os}_{ts}_{commit}.zip
#   make zip         全量构建 + 打包 zip（等效 package + zip-only）
#   make clean       清理 dist/
# 依赖：bash、node、git-bash（Windows）/ make + bash（Linux）
# ============================================================
PACKAGE := dist/autotest-runner

.PHONY: package update zip zip-only clean info

package:
	@bash scripts/package.sh

update:
	@bash scripts/package-update.sh

zip-only:
	@bash scripts/package-zip.sh

zip: package
	@bash scripts/package-zip.sh

clean:
	rm -rf dist

info:
	@ls -la $(PACKAGE) 2>/dev/null || echo "尚未构建，先执行 make package"
