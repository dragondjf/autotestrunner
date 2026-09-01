---
name: nodejs-green-packager
description: 为 Node.js 项目生成多平台绿色便携版（Green Software），打包内容含 Node.js 运行时 + node_modules + Playwright 浏览器，输出 zip 压缩包。适用于 GitHub Actions CI/CD 打包发布场景，或用户要求"生成绿色版""免安装包""便携版打包""打包 Playwright 应用""多平台打包 zip"时触发。
---

# Node.js Green Packager

## 概述

为 Node.js 项目生成**绿色便携版（Green Software）**安装包，用户解压即用，无需安装 Node.js 或执行 npm install。本技能提供完整的 GitHub Actions 工作流模板和跨平台启停脚本，一键产出 Windows / Linux x64 / Linux ARM64 三个平台的 zip 包。

## 核心能力

- 打包 Node.js 22 运行时（Windows/Linux x64/ARM64）
- 打包项目依赖（node_modules）
- 打包 Playwright 浏览器（Chromium）
- 生成平台专属启动/停止脚本（含 PID 管理）
- 统一输出 zip 压缩包（所有平台）
- 自动上传 GitHub Artifacts
- 支持 GitHub Release 发布

## 工作流

### 第 1 步：放置工作流文件

将 [templates/workflow.yml](templates/workflow.yml) 复制到项目根目录的 `.github/workflows/package-green.yml`，并按需调整：

- 修改 `package_name` 为你的应用名称（如 `myapp-win-x64`）
- 修改 `NODE_VERSION` 为需要的 Node.js 版本
- 修改启动/停止脚本中的 `PORT` 为你的应用默认端口
- 如需 Firefox/WebKit，在 `Install Playwright browsers` 步骤追加对应 `npx playwright install firefox|webkit`

### 第 2 步：生成启动/停止脚本

工作流内部已内联生成脚本。如需作为独立文件管理，使用 [templates](templates/) 下的模板：

| 平台 | 启动脚本 | 停止脚本 |
|------|---------|---------|
| Linux/macOS | `start.sh.template` | `stop.sh.template` |
| Windows | `start.bat.template` | `stop.bat.template` |

脚本逻辑：
- 通过 PID 文件 + 端口双重查找进程，避免残留
- Linux 用 `kill`，Windows 用 `taskkill`
- 自动设置 `NODE_PATH` 和 `PLAYWRIGHT_BROWSERS_PATH`

### 第 3 步：生成使用说明

使用 [templates/README.txt.template](templates/README.txt.template) 生成 `README.txt`，随包分发，说明目录结构、启停方法与参数传递。

### 第 4 步：配置自定义示例

参考 [examples/custom-config.yml](examples/custom-config.yml) 快速修改应用名、Node.js 版本、默认端口等自定义项。

## 自定义配置

- **应用名称**：替换所有 `package_name` 与脚本中的应用名
- **Node.js 版本**：`NODE_VERSION="22.11.0"`
- **默认端口**：Linux 修改 `PORT="${PORT:-8080}"`；Windows 修改 `set PORT=8080`
- **Playwright 浏览器**：默认只装 Chromium（控制体积），按需追加 firefox/webkit
- **GitHub Release**：在工作流末尾追加 release job（`softprops/action-gh-release`），上传 `artifacts/**/*.zip`

## 注意事项

| 问题 | 解决方案 |
|------|---------|
| 包体积过大 | Playwright 浏览器约 300-500MB，只打包 Chromium |
| Linux 系统依赖 | 预先安装：`sudo apt-get install -y libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 libasound2` |
| ARM64 兼容性 | Playwright 已支持 ARM64，使用 `ubuntu-24.04-arm` 运行器 |
| PID 管理 | Linux 用 `kill`，Windows 用 `taskkill`，脚本已分别实现 |
| 端口冲突 | 停止脚本会通过 PID 文件和端口号双重查找进程 |

## 输出产物

每个 zip 包包含：
- Node.js 22 运行时（node/）
- 项目构建产物（dist/）
- 项目依赖（node_modules/）
- Playwright Chromium 浏览器（.cache/ms-playwright）
- 启动/停止脚本
- 使用说明（README.txt）

## 资源

- `templates/workflow.yml` — 完整 GitHub Actions 工作流（多平台 matrix + 打包 + 上传 artifact）
- `templates/start.sh.template` / `stop.sh.template` — Linux 启停脚本模板
- `templates/start.bat.template` / `stop.bat.template` — Windows 启停脚本模板
- `templates/README.txt.template` — 使用说明模板
- `examples/custom-config.yml` — 自定义配置示例
