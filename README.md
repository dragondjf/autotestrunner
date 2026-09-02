# AutoTest Runner

Web UI 自动化测试平台：**录制（浏览器 / AI）→ 脚本生成 → 调试 → 任务执行 → 测试计划 → 测试报告** 全链路。

Node.js/TypeScript 单仓多包（pnpm workspace）。

## 快速开始

```bash
pnpm install                # 安装依赖
pnpm install:playwright     # 下载 chromium（浏览器录制/回放需要）
pnpm dev:web-ui             # 启动主服务 → http://127.0.0.1:25000
```

| 入口 | 地址 | 说明 |
|------|------|------|
| 管理台 | `http://127.0.0.1:25000/app` | 项目 / 任务 / 计划 / 报告 / 调试工作台 |
| 浏览器录制 | `http://127.0.0.1:25000/inspect` | 实时检视 + 操作录制（时间线 / 帧流） |
| AI 录制 | `http://127.0.0.1:25000/` | 自然语言描述任务，AI 自主探索生成脚本 |

## 录制 → 工程文件

从管理台（或 `/inspect` 绑定项目）发起录制，操作完成后点 **「⏹ 结束并保存」**，自动生成：

| 产物 | 位置 | 说明 |
|------|------|------|
| 录制时间线 | `data/inspect_data/{会话id}.json` | 全部步骤（方法/定位器/输入值/URL/截图 base64） |
| 项目生成脚本 | DB `recording_projects.script_content` | 可执行 Playwright JS（调试工作台可编辑回存） |
| 步骤流留档 | DB `recording_projects.record_config` | 供「编辑后再生成」 |
| 任务快照 | DB `tasks.script_snapshot` | 每任务一份定点留档；**空快照自动补齐** |
| 脚本镜像 | `data/project-files/{项目id}/generated.js` | 磁盘副本（外部取用） |
| 步骤流 JSON | `data/project-files/{项目id}/steps.json` | 轻量步骤流（不含截图） |
| 录制截图 | `data/project-files/{项目id}/screenshots/step_NN_*.jpg` | 每步一张 |

以上文件在「调试工作台 → 工程文件」树中全部可见；截图点击放大预览。

> 旧版本结束的会话可用 `npx tsx scripts/backfill-session.ts <会话id>` 补生成（`packages/web-ui` 目录下执行）。

## 目录结构

```
packages/
├── web-ui/        主服务（Express API + 前端 app/inspect/index 三入口 + SQLite）
├── smartbrowser/  浏览器引擎（UiMcpAgentExplorer / 定位器解析与候选生成）
├── shared/        跨包共享（录制注入脚本 / 互斥锁 / SSE 工具）
└── runner/        脚本执行引擎（执行会话 / 调试命令轮询 / 截图管理）
docs/              需求与设计文档（需求设计/ 为最新，评审以此为准）
scripts/           绿色包构建（package / update / zip）
data/              运行时数据（见下）
```

### 运行时数据（`data/`）

`autotest.db`（SQLite，WAL）· `project-files/`（录制产物）· `inspect_data/`（录制时间线）·
`record-sessions/` · `task-files/`（任务上传）· `artifacts/`（执行截图/视频）· `recordings/`（回放视频）· `reports/`

## 常用命令

```bash
pnpm test            # 全部包测试（vitest）
pnpm typecheck       # TS 类型检查
pnpm build           # 全量构建

make package         # 全量构建绿色包 dist/autotest-runner/（含 node + chromium + 启动脚本）
make update          # 增量更新产物（秒级）
make zip             # 构建 + 打包 zip（Release 用）
make clean           # 清理 dist/
```

Windows 下推荐 Git Bash 执行 `make`；开发期改后端代码需重启服务（`tsx` 不带 watch）。
