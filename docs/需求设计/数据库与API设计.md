# Web-UI 自动化测试平台 数据库与 API 设计

> 版本：v1.1
> 日期：2026-08-29
> 状态：设计定稿（原开放问题已按推荐方案确定，见 §7 决策记录）
> 依据文档：《需求文档》v2.1、《AutoTest_UX交互原型_三主题.html》、原《Web-UI自动化工具需求讨论》API 章节
> 技术栈：Node.js + TypeScript + Express + SQLite（better-sqlite3）+ Playwright
> 配套架构：web-ui Backend（:3000）/ runner（:9377）/ smartbrowser / shared 四包结构

---

## 0. 设计总览

### 0.1 现状与边界

| 模块 | 现状 | 本设计动作 |
|------|------|-----------|
| AI 录制（`/api/agent/*`）、浏览器录制（`/api/inspect/*`）、LLM 配置（`/api/llm-configs`） | 已实现，**内存态 + JSON 文件存储** | 接口保持兼容；存储迁移至 SQLite；会话元数据落库 |
| Runner 契约（`/run`、`/record/*`、`/debug/*`） | 已实现（shared/types.ts） | 不改动；Backend 增加代理与回调承接层 |
| 录制项目 / 测试任务 / 测试计划 / 测试报告 | **未实现** | 全新设计（本 文档主体） |
| 看板统计 / 系统配置 / 任务队列 | 未实现 | 全新设计 |

### 0.2 核心设计决策

| 决策点 | 结论 | 理由 |
|--------|------|------|
| 数据库 | SQLite 单文件（`data/autotest.db`），better-sqlite3 驱动，WAL 模式 | 单机单用户；同步 API 与预编译语句足够；零运维 |
| ID 策略 | 业务实体用前缀短 ID（`proj_`/`task_`/`plan_`/`run_`/`rpt_` + 12 位 nanoid）；Runner 契约实体（executions / record_sessions / debug_sessions）用 **INTEGER 自增** | 前缀 ID 对人友好、可从 URL 识别类型；Runner 侧 `execution_id: number` 契约已固化（shared/types.ts） |
| 执行模型 | **两级**：`task_runs`（一次触发，含循环调度）→ `executions`（一次迭代，含重试计数） | 对应 TSK-08 循环调度（迭代 x/N）与 TSK-10 每次迭代独立历史 |
| 重试模型 | 重试在 iteration 内部进行（`attempt` 递增），一次迭代只产出**一份**报告 | AC-TSK-07-3「耗尽后判定 failed 并生成失败报告」；AC-TSK-10-1 每迭代一条记录 |
| 任务脚本 | 创建时快照（`script_snapshot`），支持「项目步骤流 JSON」或「上传 JS/PY」两种来源，**创建后不可变** | 需求业务规则 1（任务快照）；TSK-04-2 |
| 计划任务关系 | `plan_tasks` 关联表（含 sort_order），非 JSON 数组 | 支持外键级联（删任务自动移出计划）与拖拽排序 |
| 日志与产物 | 结构化日志入 `execution_logs` 表（支持增量轮询 seq）；截图/视频存文件系统，DB 存相对路径 | 监控页 2s 轮询增量拉取；大二进制不入库 |
| 时间格式 | 统一 ISO 8601 UTC 字符串（如 `2026-08-29T14:30:00.000Z`） | 与需求文档 API 示例一致 |
| 队列 | 进程内全局串行队列（持有 task_run），状态持久化到 `task_runs.status` | 单机串行（非功能需求）；重启恢复策略见 §5.4 |

---

## 1. 数据库设计

### 1.1 ER 总览

```
recording_projects 1 ──── n tasks 1 ──── n task_runs 1 ──── n executions 1 ──── 1 reports
        │                    │  │                              │                    │
        │                    │  └── task_files (script/res)     │                    └── report_steps
        │                    │                                  │
        └── record_sessions  │                            execution_logs
            agent_sessions   │
            debug_sessions   │
                             │
                       plan_tasks n ──── n test_plans 1 ──── n plan_runs ──── summary report
                                                        │
                                                        └── task_runs.plan_run_id

独立配置域：llm_configs / browsers / system_configs / uploads / export_jobs / schema_migrations
```

要点：
- **任务 → 报告**：每次迭代（execution）最终产出一份报告；计划跑完产出一份**汇总报告**（type=`plan`）。
- **删除语义**：物理删除 + 级联（删项目连带任务；删任务连带文件/执行历史/报告；删计划连带编排与汇总报告）。
- **plan_tasks** 使「任务被删」自动从计划中移除，避免悬挂 ID。

### 1.2 DDL

连接初始化（每次启动执行）：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

#### 1.2.1 recording_projects — 录制项目（REC-P）

```sql
CREATE TABLE recording_projects (
  id               TEXT PRIMARY KEY,              -- proj_xxxxxxxxxxxx
  name             TEXT NOT NULL,                 -- 唯一（AC-P02-1 重名校验）
  description      TEXT NOT NULL DEFAULT '',
  type             TEXT NOT NULL CHECK (type IN ('ai','browser')),
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','ready','archived')),
  start_url        TEXT NOT NULL DEFAULT '',      -- 录制起始地址（创建表单公共字段）
  script_content   TEXT NOT NULL DEFAULT '',      -- 标准步骤流 JSON（steps[{method,params,locator}]）或脚本文本
  script_lang      TEXT NOT NULL DEFAULT 'json'
                   CHECK (script_lang IN ('json','js','py')),
  params_schema    TEXT NOT NULL DEFAULT '{}',    -- JSON Schema（REC-C02 参数化）
  record_config    TEXT NOT NULL DEFAULT '{}',    -- 浏览器录制配置：{locatorStrategy,maxRecordTime,hoverDelayMs}
  last_run_status  TEXT,                          -- 冗余：最近一次执行结果（列表列，避免联表）
                   -- 取值 success|failed|stopped|running|retrying|null(从未执行)
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX uk_projects_name ON recording_projects(name);
CREATE INDEX idx_projects_type_status ON recording_projects(type, status);
```

#### 1.2.2 tasks — 测试任务（TSK）

```sql
CREATE TABLE tasks (
  id               TEXT PRIMARY KEY,              -- task_xxxxxxxxxxxx
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  project_id       TEXT REFERENCES recording_projects(id) ON DELETE SET NULL,
                   -- script_source='upload' 时可为 NULL（独立脚本任务）
  script_source    TEXT NOT NULL DEFAULT 'project'
                   CHECK (script_source IN ('project','upload')),
  script_snapshot  TEXT NOT NULL,                 -- 创建时复制，之后不可变（业务规则1）
  script_lang      TEXT NOT NULL DEFAULT 'json'
                   CHECK (script_lang IN ('json','js','py')),
  browser_type     TEXT NOT NULL DEFAULT 'chromium'
                   CHECK (browser_type IN ('chromium','firefox','webkit')),
  browser_path     TEXT NOT NULL DEFAULT '',      -- 空 = 使用 Playwright 默认安装
  params           TEXT NOT NULL DEFAULT '{}',    -- 执行参数 JSON（按 params_schema 校验）
  max_retries      INTEGER NOT NULL DEFAULT 3 CHECK (max_retries >= 0),
  schedule_mode    TEXT NOT NULL DEFAULT 'manual'
                   CHECK (schedule_mode IN ('manual','time','count')),
  schedule_config  TEXT NOT NULL DEFAULT '{}',
                   -- manual: {}
                   -- time:   {"durationMs": 3600000}                 按时间循环（天/时/分/秒换算）
                   -- count:  {"iterations": 10, "intervalMs": 0}     按次数循环
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','running','retrying','success','failed','stopped')),
  last_run_at      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_browser ON tasks(browser_type);
```

#### 1.2.3 task_files / uploads — 文件存储（TSK-03）

```sql
CREATE TABLE task_files (
  id           TEXT PRIMARY KEY,                  -- file_xxxxxxxxxxxx
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('script','resource')),
  filename     TEXT NOT NULL,                     -- 原始文件名（脚本运行时按此路径引用）
  stored_path  TEXT NOT NULL,                     -- data/task-files/{taskId}/{kind}/{filename}
  size         INTEGER NOT NULL,
  mime_type    TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_task_files_task ON task_files(task_id, kind);

CREATE TABLE uploads (                            -- 创建向导第2步的临时上传（引用后转正）
  id           TEXT PRIMARY KEY,                  -- upl_xxxxxxxxxxxx
  filename     TEXT NOT NULL,
  stored_path  TEXT NOT NULL,                     -- data/uploads/tmp/{uploadId}_{filename}
  size         INTEGER NOT NULL,
  mime_type    TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL                      -- TTL 24h，定时清理（RPT-06 同一清理器）
);
CREATE INDEX idx_uploads_expires ON uploads(expires_at);
```

#### 1.2.4 task_runs — 执行触发（一次 run，含循环）（TSK-08/09）

```sql
CREATE TABLE task_runs (
  id                    TEXT PRIMARY KEY,         -- run_xxxxxxxxxxxx
  task_id               TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  plan_run_id           TEXT REFERENCES plan_runs(id) ON DELETE SET NULL,
  trigger_type          TEXT NOT NULL DEFAULT 'manual'
                        CHECK (trigger_type IN ('manual','plan','cron')),
  schedule_mode         TEXT NOT NULL DEFAULT 'manual'
                        CHECK (schedule_mode IN ('manual','time','count')),
  planned_iterations    INTEGER,                  -- manual=1；count=N；time=NULL（按时长终止）
  loop_duration_ms      INTEGER,                  -- time 模式时长
  iteration_interval_ms INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','running','completed','stopped','error')),
                        -- completed=正常跑完（含迭代失败，容错不中断）；error=引擎级错误终止
  current_iteration     INTEGER NOT NULL DEFAULT 0,
  completed_iterations  INTEGER NOT NULL DEFAULT 0,
  success_count         INTEGER NOT NULL DEFAULT 0,
  failed_count          INTEGER NOT NULL DEFAULT 0,
  started_at            TEXT,
  ended_at              TEXT,
  created_at            TEXT NOT NULL
);
CREATE INDEX idx_task_runs_task ON task_runs(task_id, created_at DESC);
CREATE INDEX idx_task_runs_status ON task_runs(status);
CREATE INDEX idx_task_runs_plan ON task_runs(plan_run_id);
```

#### 1.2.5 executions — 迭代执行记录（TSK-07/10）

```sql
CREATE TABLE executions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,  -- 契约：传给 Runner 作 execution_id
  run_id           TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  iteration_index  INTEGER NOT NULL DEFAULT 1,     -- 1 起
  attempt          INTEGER NOT NULL DEFAULT 0,     -- 重试序号：0=首次，最大 = task.max_retries
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','running','retrying','success','failed','stopped','error')),
  error            TEXT,                           -- 最终失败原因（报告同步展示）
  started_at       TEXT,
  ended_at         TEXT,
  duration_ms      INTEGER,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_executions_run ON executions(run_id, iteration_index);
CREATE INDEX idx_executions_task ON executions(task_id, created_at DESC);
```

#### 1.2.6 execution_logs — 执行日志流（TSK-09/10）

```sql
CREATE TABLE execution_logs (
  execution_id INTEGER NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,                  -- 单次执行内递增，轮询游标
  ts           TEXT NOT NULL,
  level        TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info','ok','warn','error')),
  event        TEXT NOT NULL DEFAULT 'log' CHECK (event IN ('log','screenshot','step','status')),
               -- screenshot: payload.screenshotPath；step: 步骤起止；status: 状态变更
  message      TEXT NOT NULL DEFAULT '',
  payload      TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (execution_id, seq)
);
```

#### 1.2.7 test_plans / plan_tasks / plan_runs — 测试计划（PLN）

```sql
CREATE TABLE test_plans (
  id           TEXT PRIMARY KEY,                  -- plan_xxxxxxxxxxxx
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  cron_expr    TEXT,                              -- 可选；空=仅手动（PLN-06）
  status       TEXT NOT NULL DEFAULT 'idle'
               CHECK (status IN ('idle','running','paused','completed','failed','stopped')),
  last_run_at  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_plans_status ON test_plans(status);

CREATE TABLE plan_tasks (
  plan_id    TEXT NOT NULL REFERENCES test_plans(id) ON DELETE CASCADE,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,          -- 串行执行顺序（拖拽排序）
  PRIMARY KEY (plan_id, task_id)
);
CREATE INDEX idx_plan_tasks_task ON plan_tasks(task_id);

CREATE TABLE plan_runs (
  id                 TEXT PRIMARY KEY,            -- prun_xxxxxxxxxxxx
  plan_id            TEXT NOT NULL REFERENCES test_plans(id) ON DELETE CASCADE,
  trigger_type       TEXT NOT NULL DEFAULT 'manual'
                     CHECK (trigger_type IN ('manual','cron')),
  status             TEXT NOT NULL DEFAULT 'running'
                     CHECK (status IN ('running','paused','completed','failed','stopped')),
                     -- 任一任务失败 → 计划级 failed（PLN-05-3），但执行不中断
  started_at         TEXT,
  ended_at           TEXT,
  summary_report_id  TEXT,                        -- 汇总报告 reports.id（完成后回填）
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_plan_runs_plan ON plan_runs(plan_id, created_at DESC);
```

#### 1.2.8 reports / report_steps — 测试报告（RPT）

```sql
CREATE TABLE reports (
  id              TEXT PRIMARY KEY,               -- rpt_xxxxxxxxxxxx
  type            TEXT NOT NULL CHECK (type IN ('task','plan')),
  task_id         TEXT REFERENCES tasks(id) ON DELETE CASCADE,        -- type=plan 时为 NULL
  run_id          TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  execution_id    INTEGER REFERENCES executions(id) ON DELETE SET NULL, -- type=task 必填
  plan_id         TEXT REFERENCES test_plans(id) ON DELETE CASCADE,   -- 计划触发的任务报告也回填
  plan_run_id     TEXT REFERENCES plan_runs(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,                  -- 冗余：任务名 / 计划名（删除后可追溯）
  status          TEXT NOT NULL
                  CHECK (status IN ('success','failed','skipped','stopped')),
  total_steps     INTEGER NOT NULL DEFAULT 0,
  passed_steps    INTEGER NOT NULL DEFAULT 0,
  failed_steps    INTEGER NOT NULL DEFAULT 0,
  skipped_steps   INTEGER NOT NULL DEFAULT 0,
  pass_rate       REAL NOT NULL DEFAULT 0,        -- 0~100，保留 1 位
  task_results    TEXT NOT NULL DEFAULT '[]',     -- type=plan 汇总用：[{taskId,name,status,reportId,durationMs}]
  error_message   TEXT,                           -- 失败主因（AC-RPT-02-4）
  video_path      TEXT,                           -- 相对路径 data/artifacts/...；缺视频为 NULL
  html_path       TEXT,                           -- 导出缓存（首次导出后回填，避免重复生成）
  pdf_path        TEXT,
  started_at      TEXT,
  ended_at        TEXT,
  duration_ms     INTEGER,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_reports_task ON reports(task_id, created_at DESC);
CREATE INDEX idx_reports_plan ON reports(plan_id, created_at DESC);
CREATE INDEX idx_reports_status ON reports(status);
CREATE INDEX idx_reports_created ON reports(created_at DESC);   -- 趋势图/时间范围过滤

CREATE TABLE report_steps (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id       TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  step_index      INTEGER NOT NULL,
  method          TEXT NOT NULL DEFAULT '',       -- click / input / navigate / assert / ...
  description     TEXT NOT NULL DEFAULT '',       -- 步骤描述（时间线文案）
  status          TEXT NOT NULL
                  CHECK (status IN ('passed','failed','error','skipped','stopped','pending')),
  error           TEXT,
  screenshot_path TEXT,                           -- 相对路径；失败步骤必填（AC-RPT-02-4）
  duration_ms     INTEGER,
  detail          TEXT NOT NULL DEFAULT '{}',     -- {params, locator, 返回值, 命令原文}
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_report_steps_report ON report_steps(report_id, step_index);
```

> 说明：`status` 在需求枚举（success|failed|skipped）基础上扩展 `stopped`，承接「手动停止后的迭代报告」（TSK-09-3 已产生历史保留）。汇总报告（type=plan）不产 steps，`report_steps` 仅任务报告使用，各任务结果聚合在 `task_results` 字段（JSON 数组）。

#### 1.2.9 会话表 — record_sessions / agent_sessions / debug_sessions

```sql
CREATE TABLE record_sessions (                    -- 浏览器录制会话（REC-B01，契约：INTEGER id）
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     TEXT REFERENCES recording_projects(id) ON DELETE SET NULL,
  url            TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','recording','paused','completed','failed','stopped','lost')),
                 -- lost = 心跳连续超时的失联态（E5）
  actions_count  INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  actions_path   TEXT,                            -- data/record-sessions/{id}/actions.jsonl
  started_at     TEXT,
  ended_at       TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_record_sessions_status ON record_sessions(status, created_at DESC);

CREATE TABLE agent_sessions (                     -- AI 录制会话（REC-A10 会话观测）
  sid             TEXT PRIMARY KEY,
  title           TEXT NOT NULL DEFAULT '',
  start_url       TEXT NOT NULL DEFAULT '',
  last_url        TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'running'
                  CHECK (status IN ('pending','running','completed','failed','stopped','expired')),
  mode            TEXT NOT NULL DEFAULT 'task' CHECK (mode IN ('task','qa')),
  steps_completed INTEGER NOT NULL DEFAULT 0,
  steps_failed    INTEGER NOT NULL DEFAULT 0,
  llm_config_id   TEXT,
  events_path     TEXT,                           -- data/agent-sessions/{sid}/events.jsonl
  created_at      TEXT NOT NULL,
  last_active_at  TEXT NOT NULL,
  closed_at       TEXT
);
CREATE INDEX idx_agent_sessions_status ON agent_sessions(status, last_active_at DESC);

CREATE TABLE debug_sessions (                     -- 交互调试会话（REC-B07）
  id            INTEGER PRIMARY KEY AUTOINCREMENT, -- 契约：debug_session_id
  project_id    TEXT REFERENCES recording_projects(id) ON DELETE SET NULL,
  execution_id  INTEGER REFERENCES executions(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','closed','failed')),
  created_at    TEXT NOT NULL,
  closed_at     TEXT
);
```

#### 1.2.10 配置域 — llm_configs / browsers / system_configs / export_jobs

```sql
CREATE TABLE llm_configs (                        -- 迁移自 data/llm_configs.json（REC-A09）
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  provider    TEXT NOT NULL DEFAULT '自定义',
  api_key     TEXT NOT NULL,                      -- 仅服务端存储，API 输出掩码（AC-A09-3）
  base_url    TEXT NOT NULL,
  model       TEXT NOT NULL,
  thinking    INTEGER NOT NULL DEFAULT 0,
  temperature REAL NOT NULL DEFAULT 0.7,
  max_tokens  INTEGER NOT NULL DEFAULT 8192,
  timeout     INTEGER NOT NULL DEFAULT 60,
  is_default  INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE browsers (                           -- 取代 config/browsers.json
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL CHECK (name IN ('chromium','firefox','webkit')),
  version    TEXT NOT NULL DEFAULT '',
  path       TEXT NOT NULL,                       -- 可执行文件路径
  is_default INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE system_configs (                     -- KV 配置（RPT-06 清理策略等）
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '{}',          -- JSON
  updated_at TEXT NOT NULL
);
-- 预置键：
--   report.retention      {"maxPerTask":100,"maxAgeDays":90}
--   report.cleanupCron    "0 2 * * *"
--   upload.limits         {"maxFileBytes":52428800,"maxFilesPerTask":100}
--   queue.pollIntervalMs  2000

CREATE TABLE export_jobs (                        -- 报告导出异步任务（AC-RPT-04-1 进度反馈）
  id         TEXT PRIMARY KEY,                    -- exp_xxxxxxxxxxxx
  report_id  TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  format     TEXT NOT NULL CHECK (format IN ('html','pdf')),
  status     TEXT NOT NULL DEFAULT 'processing'
             CHECK (status IN ('processing','done','failed')),
  progress   INTEGER NOT NULL DEFAULT 0,          -- 0~100
  file_path  TEXT,
  error      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
```

### 1.3 文件存储布局

```
data/
├── autotest.db                                # SQLite（WAL：autotest.db-wal / -shm）
├── llm_configs.json                           # 旧存储，迁移完成后归档为 .migrated
├── uploads/tmp/{uploadId}_{filename}          # 向导临时上传（TTL 24h）
├── task-files/{taskId}/
│   ├── script/{filename}                      # .js / .py
│   └── resources/{filename}                   # 任意类型，批量
├── artifacts/executions/{executionId}/
│   ├── screenshots/step_{n}.png
│   └── video.mp4                              # Playwright webm → ffmpeg 转码；转码失败降级保留 video.webm（决策记录 #4）
├── reports/exports/{reportId}.html / .pdf
├── record-sessions/{id}/actions.jsonl         # 浏览器录制动作流
└── agent-sessions/{sid}/events.jsonl          # AI 会话事件流（环形缓冲镜像）
```

规则：
- DB 内 `*_path` 一律存**相对 data/ 的路径**（如 `artifacts/executions/12/screenshots/step_1.png`），API 输出时拼接为可访问 URL（`/api/files/...`）。
- 删除任务/报告/会话时，同一事务内登记待清理目录，异步物理删除（失败仅告警不回滚）。

### 1.4 迁移策略

1. `schema_migrations` 版本表 + 顺序 SQL 脚本（`src/db/migrations/001_init.sql`…），启动时自动应用。
2. 首次迁移附带数据搬迁：`data/llm_configs.json` → `llm_configs` 表（成功后重命名 `.migrated`）。
3. 内存态的 AI/inspect 会话不搬迁（会话本来就是易失的），仅新会话开始落库。

---

## 2. API 设计

### 2.1 通用规范

| 项目 | 值 |
|------|-----|
| Base URL | `/api`（Backend :3000） |
| 数据格式 | JSON（UTF-8）；文件上传 `multipart/form-data`；导出为文件流 |
| 鉴权 | 前端 API 本期免鉴权（单机单用户）；**内部回调通道必须携带 `X-Internal-Token`**（env `INTERNAL_API_KEY`） |

统一响应包络（沿用既有约定）：

```typescript
// 成功
{ "code": 0, "message": "success", "data": T }
// 失败
{ "code": number, "message": string, "errors"?: unknown }
```

分页响应统一形态：`data = { list: T[], total, page, pageSize }`；请求参数 `page`（默认 1）、`pageSize`（默认 10，上限 100）。

HTTP 状态码：200 成功 / 201 创建 / 400 参数错误 / 401 内部令牌缺失 / 404 资源不存在 / 409 业务冲突 / 500 内部错误。**业务错误以 body.code 为准**，HTTP 层 409 表示「状态冲突类」错误（运行中禁止删除等）。

#### 错误码（在原 10001~50001 基础上扩展）

| 错误码 | 含义 | 对应需求 |
|--------|------|---------|
| 10001 | 参数验证失败（含表单校验） | 各 AC |
| 10002 | 资源不存在 | —— |
| 10003 | 资源已存在（项目重名） | AC-P02-1 |
| 10004 | 文件校验失败（类型/大小/数量超限，errors 定位到文件） | AC-TSK-03-3 |
| 20001 | 任务执行失败 | E6 |
| 20002 | 任务已在队列中 | TSK-06 |
| 20003 | 任务执行中，禁止重复触发 | AC-TSK-06-3 |
| 20004 | 任务执行中，禁止编辑/删除 | AC-TSK-01 边界 |
| 20005 | 调度配置非法（时长/次数 ≤ 0 等） | AC-TSK-08 |
| 20006 | 引用的上传文件不存在或已过期 | TSK-02 第 2 步 |
| 30001 | 计划执行失败 | E7 |
| 30002 | 计划执行中，禁止编辑/删除/重复触发 | E8 / PLN-03 边界 |
| 30003 | 计划至少包含 1 个任务 | AC-PLN-02-1 边界 |
| 40001 | 报告生成失败 | —— |
| 40002 | 报告导出失败 | AC-RPT-03 边界 |
| 50001 | 系统内部错误 | —— |
| 50002 | Runner 不可达（检查 :9377） | E3 |
| 50003 | LLM 未配置 | E2 / AC-A01-2 |

### 2.2 API 总览（按模块）

标注：**[新增]** 本设计新增｜**[已有]** 已实现、契约保持｜**[代理]** Backend 转发 Runner｜**[内部]** Runner → Backend 回调。

| 模块 | 方法与路径 | 说明 | 状态 | 需求 |
|------|-----------|------|------|------|
| 录制项目 | GET /api/projects | 列表（分页/搜索/类型/状态筛选） | 新增 | REC-P01 |
| | POST /api/projects | 创建（AI/浏览器录制保存入口） | 新增 | REC-P02、REC-A08 |
| | GET /api/projects/:id | 详情（含关联任务） | 新增 | REC-P05 |
| | PUT /api/projects/:id | 编辑 | 新增 | REC-P03 |
| | DELETE /api/projects/:id | 删除（级联任务） | 新增 | REC-P04 |
| 浏览器录制 | POST /api/record/sessions | 启动录制（代理 Runner /record/start） | 代理 | REC-B01 |
| | POST /api/record/sessions/:id/stop | 停止并保存 | 代理 | REC-B01 |
| | POST /api/record/sessions/:id/control | 暂停/恢复/清空 | 代理 | REC-B01 |
| | GET /api/record/sessions | 会话历史列表 | 新增 | REC-A10 同构 |
| | GET /api/record/sessions/:id/actions | 动作流（分页） | 新增 | REC-B05 |
| | POST /api/record/sessions/:id/to-project | 动作流 → 项目脚本 | 新增 | REC-A08 同构 |
| AI 录制 | POST /api/agent/run | 发起任务（SSE 11 类事件） | 已有 | REC-A01~A06 |
| | GET /api/agent/sessions | 会话列表 | 已有（改读库） | REC-A10 |
| | GET /api/agent/sessions/:sid/events | 事件回放（环形缓冲） | 已有 | REC-A03 |
| | POST /api/agent/sessions/:sid/to-project | 轨迹 → 项目脚本（预览+保存） | 新增 | REC-A08 |
| | GET/POST/PUT/DELETE /api/llm-configs… | LLM 配置管理 | 已有（迁库） | REC-A09 |
| 交互调试 | POST /api/debug/sessions | 启动调试会话（代理） | 代理 | REC-B07 |
| | POST /api/debug/sessions/:id/commands | 单步命令（highlight/pick/step_*） | 代理 | REC-B07 |
| | POST /api/debug/sessions/:id/stop | 结束 | 代理 | REC-B07 |
| 文件上传 | POST /api/uploads | 临时上传（脚本+资源，multipart） | 新增 | TSK-03 |
| 测试任务 | GET /api/tasks | 列表（项目/状态/浏览器筛选） | 新增 | TSK-01 |
| | POST /api/tasks | 创建（4 步向导聚合提交） | 新增 | TSK-02 |
| | GET /api/tasks/:id | 详情（含调度与最近 run） | 新增 | TSK-01 |
| | PUT /api/tasks/:id | 编辑（快照不可变） | 新增 | TSK-04 |
| | DELETE /api/tasks/:id | 删除（级联） | 新增 | TSK-05 |
| | POST /api/tasks/:id/run | 触发执行（入队） | 新增 | TSK-06 |
| | GET /api/tasks/:id/executions | 迭代历史列表 | 新增 | TSK-10 |
| 执行监控 | GET /api/task-runs/:runId | run 状态/进度/迭代 x/N | 新增 | TSK-09 |
| | GET /api/task-runs/:runId/logs | 增量日志（?afterSeq=&executionId=） | 新增 | TSK-09 |
| | POST /api/task-runs/:runId/stop | 停止执行（幂等） | 新增 | TSK-09 |
| | GET /api/task-runs/:runId/events | SSE 实时流（可选增强） | 新增 | TSK-09 |
| 回放 | GET /api/executions/:id | 迭代详情（日志+步骤+截图） | 新增 | TSK-10 |
| | GET /api/executions/:id/logs | 增量日志（复用日志契约） | 新增 | TSK-10 |
| 测试计划 | GET /api/plans | 列表 | 新增 | PLN-01 |
| | POST /api/plans | 创建（任务多选+排序） | 新增 | PLN-02 |
| | GET /api/plans/:id | 详情（含当前 run） | 新增 | PLN-01 |
| | PUT /api/plans/:id | 编辑 | 新增 | PLN-03 |
| | DELETE /api/plans/:id | 删除 | 新增 | PLN-04 |
| | POST /api/plans/:id/run | 执行计划 | 新增 | PLN-05 |
| | POST /api/plans/:id/pause | 暂停（编排冻结） | 新增 | PLN-05b |
| | POST /api/plans/:id/resume | 恢复 | 新增 | PLN-05b |
| 测试报告 | GET /api/reports | 列表（任务/计划/状态/时间） | 新增 | RPT-01 |
| | GET /api/reports/:id | 详情（含步骤） | 新增 | RPT-02 |
| | GET /api/reports/:id/steps | 步骤分页（大报告） | 新增 | RPT-02 |
| | POST /api/reports/:id/exports | 发起导出（html/pdf） | 新增 | RPT-03/04 |
| | GET /api/exports/:exportId | 导出进度/下载地址 | 新增 | RPT-04 |
| | GET /api/reports/trend | 趋势（日/周/月粒度） | 新增 | RPT-02 |
| | DELETE /api/reports/:id | 删除 | 新增 | RPT-05 |
| 看板 | GET /api/dashboard/stats | 统计卡数据 | 新增 | 原型 dashboard |
| | GET /api/dashboard/trend | 近 N 天执行趋势 | 新增 | 原型 dashboard |
| | GET /api/dashboard/recent-runs | 最近执行列表 | 新增 | 原型 dashboard |
| 系统配置 | GET /api/config/browsers | 浏览器列表 | 新增（读库） | —— |
| | POST/PUT/DELETE /api/config/browsers… | 浏览器管理 | 新增 | —— |
| | GET /api/config/queue/status | 队列状态 | 新增 | TSK-06 |
| | GET/PUT /api/config/system | 系统配置（保留策略等） | 新增 | RPT-06 |
| 文件访问 | GET /api/files/* | 静态产物访问（截图/视频/导出，仅限 data/ 白名单目录） | 新增 | —— |
| 内部回调 | POST /internal/runner/progress | 执行进度（X-API-Key，report_url 与 progress_url 同 URL） | 内部 | Runner 契约 |
| | POST /internal/record/:id/heartbeat | 录制心跳（X-Internal-Token） | 内部 | REC-B04 |
| | POST /internal/record/:id/result | 录制结果（X-Internal-Token，success 布尔形态） | 内部 | REC-B01 |
| | GET /internal/debug/command | 调试命令轮询（Runner 0.5s 拉取，X-Internal-Token） | 内部 | REC-B07 |
| | POST /internal/debug/callback | 调试事件回报（X-Internal-Token） | 内部 | REC-B07 |

### 2.3 录制项目 API

#### GET /api/projects

Query：`page`、`pageSize`、`keyword`（名称模糊）、`type`（ai/browser）、`status`（draft/ready/archived）。

```json
{ "code": 0, "message": "success", "data": {
  "list": [{
    "id": "proj_a1b2c3d4e5f6",
    "name": "登录流程-AI录制",
    "description": "登录冒烟",
    "type": "ai",
    "status": "ready",
    "startUrl": "http://localhost:8000/#/login",
    "scriptLang": "json",
    "stepsCount": 12,                       // script_content 中步骤数（列表卡片展示）
    "paramsCount": 2,                       // params_schema properties 数量
    "lastRunStatus": "success",
    "createdAt": "2026-08-29T14:30:00.000Z",
    "updatedAt": "2026-08-29T15:00:00.000Z"
  }],
  "total": 1, "page": 1, "pageSize": 10
}}
```

#### POST /api/projects

来源三选一：手动新建 / AI 会话保存 / 浏览器录制保存（三者落同一契约）。

```typescript
{
  name: string;                        // 必填，唯一
  type: 'ai' | 'browser';              // 必填
  description?: string;
  startUrl?: string;                   // 必须是合法 URL（AC-P02-1 边界）
  scriptContent?: string;              // 标准步骤流 JSON 字符串或脚本文本
  scriptLang?: 'json' | 'js' | 'py';
  paramsSchema?: object;
  recordConfig?: {                     // type=browser 时生效（AC-P02-4）
    locatorStrategy?: 'default' | 'tolerant' | 'robust' | 'semantic_first' | 'semantic';
    maxRecordTime?: number;            // 默认 600s
    hoverDelayMs?: number;             // 默认 1000
  };
  status?: 'draft' | 'ready' | 'archived';
  source?: {                           // 产物来源（追溯，不影响存储）
    kind: 'manual' | 'agent_session' | 'record_session';
    refId?: string;                    // sid 或 record_session_id
  };
}
```

规则：`scriptContent` 为标准步骤流时做**结构校验**（steps[] 每项含 method；locator/candidates 结构合法），失败返回 10001 并带步骤序号；重名返回 10003。响应 `201` + 完整对象（同列表项 + `scriptContent`/`paramsSchema`/`recordConfig` 原文）。

#### PUT /api/projects/:id

所有字段可选（部分更新）。存在关联任务且修改 `scriptContent` 时，响应附警告字段：

```json
{ "code": 0, "message": "success", "data": { ...project,
  "warnings": ["已存在 N 个关联任务，本次修改仅影响后续新任务"] } }
```

#### DELETE /api/projects/:id

级联：任务（及任务文件/执行历史/报告）。存在**运行中任务**时返回 `409 {code:20004}`。响应 `data: { deletedTasks: N }`。

#### GET /api/projects/:id

详情 + 关联任务摘要（`tasks: [{id,name,status,lastRunAt}]`，最近 5 条）+ 快捷入口可用性（archived 时 createTask 置灰原因）。

### 2.4 浏览器录制 API（Backend 代理层）

#### POST /api/record/sessions

```typescript
// 请求（透传 Runner 契约，Backend 补充回调地址与令牌）
{ "projectId": "proj_xxx" | null,         // 保存回填用
  "url": "http://localhost:8000/#/login",
  "maxRecordTime": 600,
  "hoverDelayMs": 1000,
  "locatorStrategy": "default" }
// 响应
{ "code": 0, "data": {
  "recordSessionId": 3,                   // INTEGER（Runner 契约）
  "status": "recording",
  "startedAt": "..." } }
```

Backend 行为：先建 `record_sessions` 行（status=pending）→ 调 Runner `/record/start`（注入 `callback.heartbeat_url/result_url` 与 `X-Internal-Token`）→ 更新为 recording。Runner 不可达返回 50002（E3）。

#### POST /api/record/sessions/:id/control

Body `{ "action": "pause" | "resume" | "clear" }`。`clear` 需前端二次确认（AC-B01-3），Backend 重置 actions_count 并标记 actions.jsonl 截断。

#### POST /api/record/sessions/:id/stop

幂等（AC-B01-5）：已结束会话重复调用返回当前终态，不报错。停止后返回动作数与「保存为项目」建议。

#### POST /api/record/sessions/:id/to-project

将动作流转换为标准步骤流（REC-B05 → 项目模型）：

```typescript
// 请求
{ "name": "登录流程-浏览器录制", "projectId"?: string /*已存在则覆盖更新脚本*/ }
// 响应：预览 + 保存一步完成（前端在第4步已提供预览）
{ "code": 0, "data": { "projectId": "proj_xxx", "steps": 12, "warnings": ["2 条 hover 事件被合并/丢弃"] } }
```

### 2.5 AI 录制 API（已有，列差异）

`POST /api/agent/run`（SSE）、`GET /api/agent/sessions`、`GET /api/agent/sessions/:sid/events`、LLM 配置族——契约不变。本设计的改动点：

1. 会话元数据**双写**：内存 Map（实时）+ `agent_sessions` 表（观测历史），`/api/agent/sessions` 改读库（运行中的从内存刷新）。
2. 新增 `POST /api/agent/sessions/:sid/to-project`：轨迹 → 标准步骤流 → `POST /api/projects`（REC-A08，含预览参数 `?dryRun=true` 仅返回转换结果不落库）。

### 2.6 文件上传 API

#### POST /api/uploads（multipart/form-data）

字段：`file`（单个，前端批量时多次调用或 `files[]`）、`kind`（`script` | `resource`）。

校验（AC-TSK-03-3，限额读 `upload.limits`）：
- `kind=script`：扩展名 `.js`/`.py`；上传即做**语法校验**（node `--check` / `python -m py_compile`），失败返回 10004 + 错误行号。
- `kind=resource`：任意类型。
- 单文件 ≤ 50MB、每任务 ≤ 100 个。

```json
{ "code": 0, "data": {
  "uploadId": "upl_xxx", "filename": "login.spec.js", "size": 2048,
  "syntaxCheck": { "ok": true, "error": null } } }
```

### 2.7 测试任务 API

#### POST /api/tasks（4 步向导聚合提交）

```typescript
{
  // Step 1 基本信息
  name: string;                                  // 必填
  description?: string;
  // Step 2 脚本与资源（二选一）
  scriptSource: 'project' | 'upload';
  projectId?: string;                            // source=project 必填（须 ready 状态）
  scriptUploadId?: string;                       // source=upload 必填（.js/.py）
  resourceUploadIds?: string[];                  // 批量资源
  // Step 3 执行调度
  browserType?: 'chromium' | 'firefox' | 'webkit';   // 默认 chromium
  browserPath?: string;                          // 空=默认；POST /api/config/browsers 提供候选
  params?: object;                               // 按 paramsSchema 校验（缺失必填 → 10001）
  maxRetries?: number;                           // 默认 3
  schedule: {
    mode: 'manual' | 'time' | 'count';
    durationMs?: number;                         // mode=time 必填 > 0（天/时/分/秒由前端换算）
    iterations?: number;                         // mode=count 必填 1~10000
    intervalMs?: number;                         // 迭代间隔，默认 0
  };
  // Step 4 确认（前端已预览；后端再校验一遍）
  executeNow?: boolean;                          // 「保存并立即执行」
}
```

后端行为：
1. 校验（含调度合法性 20005、上传引用有效性 20006、params 对 paramsSchema 校验）。
2. `script_snapshot` 复制：project 来源 → 项目 `script_content`；upload 来源 → 上传文件内容（`script_lang` 取扩展名）。
3. 上传文件转正：`uploads` 行删除，文件移动至 `task-files/{taskId}/`，写 `task_files`。
4. `executeNow=true` 时直接创建 run 入队，响应附带 `runId` 与 `queuePosition`。

```json
{ "code": 0, "data": {
  "id": "task_xxx", "status": "pending", "scriptLang": "js",
  "snapshotBytes": 4096, "resourceCount": 3,
  "run": { "runId": "run_xxx", "queuePosition": 1 } } }     // executeNow 时才有 run
```

#### GET /api/tasks

Query：`projectId`、`status`、`browserType`、`keyword`、`page`、`pageSize`。列表项含：`id/name/projectId/projectName/description/browserType/scheduleMode/status/lastRunAt/lastRunStatus(冗余)/createdAt`。

#### PUT /api/tasks/:id

可改：`name/description/browserType/browserPath/params/maxRetries/schedule`。**不可改**：`script_snapshot`、`script_source`、`project_id`（改动请求返回 10001）。运行中（running/retrying 或存在 queued/running 的 run）返回 409/20004。

#### POST /api/tasks/:id/run

```json
{ "code": 0, "message": "任务已加入执行队列", "data": {
  "runId": "run_xxx", "queuePosition": 2,       // 1=立即执行
  "plannedIterations": 10, "scheduleMode": "count" } }
```

规则：任务存在未终态 run → 409/20003；`project` 已删且快照仍在 → 仍可执行（快照自包含）。

#### GET /api/tasks/:id/executions（迭代历史，TSK-10）

```json
{ "code": 0, "data": { "list": [{
  "id": 42,                                    // execution_id
  "runId": "run_xxx", "iterationIndex": 3, "attempt": 1,
  "status": "failed", "error": "TimeoutError: locator('#submit') ...",
  "startedAt": "...", "endedAt": "...", "durationMs": 12500,
  "reportId": "rpt_xxx", "reportStatus": "failed",
  "triggerType": "manual", "scheduleMode": "count"
}], "total": 3, "page": 1, "pageSize": 10 } }
```

#### DELETE /api/tasks/:id

级联：task_files / task_runs / executions / execution_logs / 关联任务报告；plan_tasks 自动移除（FK 级联）；物理清理文件目录。运行中 → 409/20004。

### 2.8 执行监控 API（TSK-09）

#### GET /api/task-runs/:runId

```json
{ "code": 0, "data": {
  "runId": "run_xxx", "taskId": "task_xxx", "taskName": "登录回归",
  "status": "running",
  "scheduleMode": "count",
  "currentIteration": 3, "plannedIterations": 10,     // time 模式 plannedIterations=null，改给剩余时间
  "remainingMs": null,                                  // time 模式专用
  "completedIterations": 2, "successCount": 2, "failedCount": 0,
  "queuePosition": 0,
  "currentExecutionId": 42,                             // 当前迭代的日志/截图查询锚点
  "retry": { "attempt": 1, "maxRetries": 3 },           // 当前迭代重试信息（null=非重试中）
  "startedAt": "...", "elapsedMs": 38200,
  "iterations": [                                       // 摘要条（最近迭代在前，最多 20 条）
    { "executionId": 42, "iterationIndex": 3, "status": "retrying", "startedAt": "..." },
    { "executionId": 41, "iterationIndex": 2, "status": "success", "durationMs": 11000, "reportId": "rpt_x1" }
  ] } }
```

#### GET /api/task-runs/:runId/logs

Query：`executionId`（缺省=当前迭代）、`afterSeq`（增量游标，缺省 0）、`limit`（默认 200）。

```json
{ "code": 0, "data": {
  "executionId": 42, "nextSeq": 158, "hasMore": false,
  "logs": [
    { "seq": 150, "ts": "...", "level": "info", "event": "log", "message": "🚀 迭代 3/10 开始（第 2 次尝试）" },
    { "seq": 155, "ts": "...", "level": "info", "event": "screenshot", "message": "step_3",
      "payload": { "screenshotPath": "artifacts/executions/42/screenshots/step_3.png" } }
  ] } }
```

前端轮询节奏 `queue.pollIntervalMs`（默认 2000ms）。

#### POST /api/task-runs/:runId/stop

幂等。语义：**停止整个 run**——当前迭代向 Runner 发 `/stop/:execution_id`，剩余迭代不再启动；已完成的迭代历史与报告保留（AC-TSK-09-3）。当前迭代产出 `status=stopped` 的报告。响应 `{ "stopped": true, "completedIterations": 5 }`。

#### GET /api/task-runs/:runId/events（SSE，可选增强）

事件：`status`（run/迭代状态变更）、`log`（日志透传）、`iteration_start`、`iteration_end`、`run_end`。断线重连以 `Last-Event-ID`（seq）续传。**定为 P2 增强（决策记录 #1）**：本期仅实现 2s 轮询（满足 AC-TSK-09），SSE 契约保留，大日志量场景出现延迟感时升级。

### 2.9 迭代回放 API（TSK-10）

#### GET /api/executions/:id

回放视图 = 监控页只读版，一次返回全量：

```json
{ "code": 0, "data": {
  "id": 42, "runId": "run_xxx", "taskId": "task_xxx", "taskName": "登录回归",
  "iterationIndex": 3, "attempt": 1, "triggerType": "plan", "planRunId": "prun_xxx",
  "status": "failed", "error": "TimeoutError ...",
  "startedAt": "...", "endedAt": "...", "durationMs": 12500,
  "reportId": "rpt_xxx",
  "steps": [                                    // 结构化步骤（report_steps）
    { "stepIndex": 1, "method": "navigate", "description": "打开登录页",
      "status": "passed", "durationMs": 1200, "screenshotUrl": "/api/files/artifacts/..." }
  ],
  "logCount": 158, "logNextSeq": 158,           // 日志仍走增量接口
  "videoUrl": "/api/files/artifacts/executions/42/video.mp4"   // 无视频为 null
} }
```

#### GET /api/executions/:id/logs

契约同 §2.8 日志接口（复用实现）。

### 2.10 测试计划 API

#### POST /api/plans

```typescript
{
  name: string;                          // 必填
  description?: string;
  taskIds: string[];                     // 必填非空（30003），顺序即执行顺序
  cronExpr?: string;                     // 可选，格式校验（cron-parser）
}
```

`taskIds` 写入 `plan_tasks`（sort_order=数组下标）。任务 ID 不存在 → 10002 并列出无效 ID。

#### GET /api/plans/:id

详情含：`tasks: [{id,name,status,sortOrder,lastRunStatus}]`（按 sort_order）、`activeRun`（运行中/暂停的 plan_run 摘要，供详情抽屉展示）。

#### POST /api/plans/:id/run

```json
{ "code": 0, "message": "计划已开始执行", "data": { "planRunId": "prun_xxx" } }
```

规则：计划执行中重复触发 → 409/30002（E8）；Cron 到点触发同规则。执行流程见 §5.3。

#### POST /api/plans/:id/pause ／ POST /api/plans/:id/resume

```
暂停：plan.status: running → paused；当前任务迭代跑完后不再启动下一任务（编排冻结，不打断当前迭代——决策记录 #2）。
恢复：paused → running，从断点任务继续入队。
已完结/闲置状态调用 → 400 {code:10001, message:"仅运行中的计划可暂停"}（AC-PLN-05b 边界）。
```

#### PUT/DELETE /api/plans/:id

编辑含 `taskIds` 重排（整体替换 sort_order）；执行中 → 409/30002。删除级联 plan_tasks / plan_runs / 汇总报告。

### 2.11 测试报告 API

#### GET /api/reports

Query：`taskId`、`planId`、`status`、`type`（task/plan）、`startTime`/`endTime`（ISO）、`page`、`pageSize`。列表项：`id/type/name(任务或计划名)/taskId/planId/status/totalSteps/passedSteps/failedSteps/passRate/durationMs/startedAt/createdAt`。

#### GET /api/reports/:id

```json
{ "code": 0, "data": {
  "id": "rpt_xxx", "type": "task",
  "taskId": "task_xxx", "taskName": "登录回归", "runId": "run_xxx",
  "executionId": 42, "iterationIndex": 3,
  "planId": "plan_xxx", "planRunId": "prun_xxx",       // 计划触发的任务报告回填；手动执行为 null
  "status": "failed",
  "totalSteps": 8, "passedSteps": 7, "failedSteps": 1, "skippedSteps": 0, "passRate": 87.5,
  "errorMessage": "TimeoutError: locator('#submit') timeout 30000ms",
  "startedAt": "...", "endedAt": "...", "durationMs": 12000,
  "steps": [ /* report_steps，最多返回前 200 条，更多走 /steps 分页 */ ],
  "screenshots": ["/api/files/artifacts/executions/42/screenshots/step_1.png"],
  "videoUrl": "/api/files/artifacts/executions/42/video.mp4",   // 缺视频 null，前端占位提示（AC-RPT-02 边界）
  "exports": { "html": { "url": "/api/files/reports/exports/rpt_xxx.html", "generatedAt": "..." },
               "pdf":  null },
  "createdAt": "..." } }
```

`type=plan` 汇总报告：`steps` 为空，改附 `taskResults`（各任务执行结果数组，映射自 `reports.task_results`）。

#### GET /api/reports/:id/steps

分页步骤（`page`/`pageSize`），契约同 `steps[]` 元素——大报告（>200 步）详情页懒加载。

#### POST /api/reports/:id/exports（异步导出，AC-RPT-04-1 进度）

```typescript
// 请求 { "format": "html" | "pdf" }
// 响应
{ "code": 0, "data": { "exportId": "exp_xxx", "status": "processing", "progress": 0 } }
```

已有缓存（html_path/pdf_path 非空）直接返回 done + 下载 URL，不重复生成。

#### GET /api/exports/:exportId

```json
{ "code": 0, "data": { "exportId": "exp_xxx", "status": "done", "progress": 100,
  "downloadUrl": "/api/files/reports/exports/rpt_xxx.pdf" } }
```

失败时 `status=failed, error`（40002 语义）。导出产物写 `reports/exports/`，成功后回填 reports 表缓存字段。HTML 导出为服务端模板渲染（自包含内联样式，AC-RPT-03-1）；PDF 由无头 Chromium（Playwright `page.pdf()`）打印 HTML 报告生成（决策记录 #3，零新增依赖）。

#### GET /api/reports/trend

Query：`taskId`（必填）、`granularity`（`day`|`week`|`month`，默认 day）、`limit`（桶数，默认 30）。

```json
{ "code": 0, "data": { "granularity": "week", "buckets": [
  { "bucket": "2026-W35", "total": 12, "success": 10, "failed": 2, "passRate": 83.3 },
  { "bucket": "2026-W34", "total": 8,  "success": 8,  "failed": 0, "passRate": 100 } ] } }
```

实现：`reports` 按 `strftime` 分桶聚合（week=ISO 周，month=自然月）。

#### DELETE /api/reports/:id

二次确认由前端负责；删除报告行 + report_steps + 导出文件（不影响任务/计划记录，AC-RPT-05 边界）。

### 2.12 看板 API

```
GET /api/dashboard/stats
→ { projects: {total, ai, browser, ready},
    tasks:     {total, byStatus: {pending, running, retrying, success, failed, stopped}},
    plans:     {total, running},
    reports24h:{total, passRate},
    queue:     {running: true, currentTaskName, queueLength} }

GET /api/dashboard/trend?days=7
→ { buckets: [{date:"2026-08-29", total, success, failed, passRate}] }

GET /api/dashboard/recent-runs?limit=10
→ { list: [{runId, taskName, status, scheduleMode, currentIteration, plannedIterations,
            successCount, failedCount, startedAt, endedAt}] }
```

### 2.13 系统配置 API

```
GET    /api/config/browsers            → { list: [{id,name,version,path,isDefault,enabled}], default: {...} }
POST   /api/config/browsers            新增（name/version/path）
PUT    /api/config/browsers/:id        修改/设默认
DELETE /api/config/browsers/:id        删除（默认项删除后自动指认首个启用项）

GET    /api/config/queue/status        → { isRunning, currentRunId, currentTaskId, currentTaskName,
                                           queueLength, queue: [{runId, taskId, taskName, position}] }

GET    /api/config/system              → { reportRetention, reportCleanupCron, uploadLimits, queuePollIntervalMs }
PUT    /api/config/system              部分更新（值校验失败 10001）
```

### 2.14 内部回调 API（Runner → Backend）

> 承接 Runner 现有实现的真实契约（progress-reporter.ts / recording.ts / debug-session.ts）。回调 URL **全部由 Backend 派发任务时注入 payload**（`/run` 的 `callback`、`/record/start` 的 `callback`、`/debug/session/start` 的 `callback_base`），Runner 侧零改动。**两套鉴权头并存**：执行进度类用 `X-API-Key`（env `API_KEY`），录制/调试类用 `X-Internal-Token`（env `INTERNAL_API_KEY`）；缺失/不匹配 → **401**（AC-B04-2）。Runner 侧所有回调**无重试**（失败静默吞掉、超时 5~10s），故 Backend 端点必须**幂等且快速返回**。

#### POST /internal/runner/progress（执行进度，X-API-Key）

同一 URL 同时作为 `callback.report_url` 与 `callback.progress_url` 下发，按消息 `type` 区分（对齐 Runner `ProgressMessage` 契约）：

```typescript
// suite 级（report_url）
{ type: "suite_start";  suite_execution_id: number }
{ type: "suite_end";    suite_execution_id: number }
{ type: "suite_error";  suite_execution_id: number; error: string }
// 用例/步骤级（progress_url）
{ type: "case_start";   execution_id: number }
{ type: "case_end";     execution_id: number }
{ type: "case_skip";    execution_id: number }
{ type: "case_status";  execution_id: number; status: string; error?: string }
{ type: "case_stop";    execution_id: number; reason: string }
{ type: "step_progress"; execution_id: number; step_result: StepResult }
```

Backend 行为（execution_id → executions 行）：
- `step_progress` → 写 `execution_logs`（event=step）；`step_result.screenshot` 为 **base64 PNG**，解码落盘 `artifacts/executions/{id}/screenshots/step_{n}.png`；更新内存进度缓存（供监控轮询）。
- `case_end` → 聚合 `report_steps`、统计 pass_rate、生成/更新 reports 行。
- `case_status` → 联动 executions.status（含 retrying）。
- `case_stop` → executions.status=stopped，run 层判断是否继续下一迭代。
- 注：Runner「单用例模式」（无 suite_execution_id 的单 case）不发 suite_start/suite_end，Backend 不得依赖 suite 事件做状态推进。

#### POST /internal/record/:id/heartbeat（录制心跳，X-Internal-Token）

Body = `RecordHeartbeatBody`（`actions_count/raw_actions/paused/last_control_result/frames`），每 1s 一次。行为：刷新 `record_sessions.actions_count`、追加 actions.jsonl、上报「未监听 iframe」警告透传前端；Backend 侧失联判定（连续 N 个心跳周期无消息 → status=lost，E5）。

#### POST /internal/record/:id/result（录制结果，X-Internal-Token）

Runner 终态回调（对齐 recording.ts 真实 body）：

```typescript
{ record_session_id: number; device_id?: string;
  success: boolean;                       // true→completed，false→failed
  actions: RecordedAction[];
  duration_ms: number;
  error?: string }                        // 仅失败时携带
```

落库 + 状态流转（success 映射 completed / stopped 由 stop 场景另行判定）。

#### 调试会话双路由（X-Internal-Token，callback_base 下发）

Runner 为**轮询拉取**模式（非推送）：

```
GET  {callback_base}/runner-command   → { data: {command_id, action, status, ...payload} | null }
    Runner 每 0.5s（DEBUG_POLL_INTERVAL）轮询一次；无命令 data=null；按 command_id 去重。
POST {callback_base}/runner-callback  → { event: DebugEventName, payload: Record<string,unknown>, command_id? }
    event ∈ DEBUG_EVENTS（ready/step_result/highlight_result/verify_result/pick_result/
    pick_mode/hotkeys_updated/select_step/steps_synced/clear_highlight_result/closed/error）
```

Backend 实现：GET 命令队列（监控/调试页写入）、POST 事件透传给 inspect 前端（复用现有 inspect-ws 通道）。

#### （可选）Runner 注册与存活心跳（X-API-Key）

Runner 启动主动注册、每 10s 心跳（BACKEND_URL 拼接）：

```
POST /runner/http/register   {runner_id, host, port, version, max_concurrent}
POST /runner/http/heartbeat  {runner_id, running_tasks, status:"online", host, port, version, max_concurrent}
```

本轮可先落 `/internal/runner-status` 内存态承接（供 `/api/config/queue/status` 的 runner 健康展示），持久化后续再议。

#### 任务执行适配（双通道，阶段二实现）

- `scriptLang=json`（标准步骤流）→ Runner `POST /run`（SuitePayload：execution_id + steps + callback 注入）。
- `scriptLang=js/py`（上传脚本）→ Backend 本地子进程执行（复用 exec.routes.ts 的 node/python 子进程模式），进度直接写库不走 Runner。

### 2.15 文件访问 API

```
GET /api/files/{relativePath}
```

- 白名单目录：`artifacts/`、`reports/exports/`、`task-files/`（资源下载）、`record-sessions/`。
- `..` 路径穿越防护；`Content-Type` 按扩展名；视频支持 Range（HTML5 播放器拖动）。
- 截图 URL（`/api/files/...`）在所有报告/日志响应中已拼接完成，前端直接使用。

---

## 3. 状态机（与 API 联动）

```
任务 tasks.status：
  pending ── run 启动 ──> running ── 失败且 attempt<max ──> retrying ──(退避后)──> running
     │                      ││                                           │
     │                      │└─ 成功 ──> success                          └─ 耗尽 ──> failed
     │                      └── stop ──> stopped
  （status = 该任务最近一次 execution 的终态；无执行历史时为 pending）

执行触发 task_runs.status：
  queued → running → completed（正常跑完，含迭代失败——容错不中断）
                  → stopped（手动停止）
                  → error（引擎级故障，如 Runner 不可达）

迭代 executions.status：
  pending → running → success | failed | stopped
              │ ↑___________│
              └→ retrying（attempt+1，指数退避 1000*2^n ms）

计划 test_plans.status：
  idle → running → completed | failed（任一任务失败）
          │  ↑
          └→ paused（编排冻结，当前迭代跑完停）→ running（恢复）

录制会话 record_sessions.status：
  pending → recording ⇄ paused → completed | failed | stopped | lost

AI 会话 agent_sessions.status：
  pending → running → completed | failed | stopped | expired（GC 30min）
```

**不变式**（服务层保证，写库前校验）：
1. 同一任务同时最多一个非终态 run（20003）。
2. 同一计划同时最多一个非终态 plan_run（30002）。
3. `executions.attempt ≤ tasks.max_retries`；每次重试清理上次临时产物（AC-TSK-07-1）。
4. 队列同一时刻仅消费一个 run（全局串行）。
5. run/status 变更与 executions 变更同事务提交，监控接口读到的组合状态必然一致。

---

## 4. 关键时序

### 4.1 任务执行（手动单次）

```
前端                Backend                     Runner(:9377)
 │ POST /tasks/:id/run │                             │
 │──────────────────>│ 建 task_run(queued) + execution(pending)
 │                   │ 入队（串行队列）
 │<── runId,pos ─────│
 │                   │ [队列轮到] run→running        │
 │                   │ POST /run (SuitePayload:     │
 │                   │  execution_id, steps=快照,   │
 │                   │  callback=progress_url) ───>│ 启动 Playwright
 │ GET task-runs/:id │<── step_progress ────────────│ 逐步执行
 │   /logs (2s轮询)  │  写 logs/steps/截图           │
 │<── 状态+日志 ─────│<── case_end ─────────────────│
 │                   │ 聚合报告(reports/report_steps)
 │                   │ run→completed, task→success  │
 │ GET reports/:id   │                             │
 │<── 报告详情 ───────│                             │
```

### 4.2 循环调度（count 模式，N=10）

```
run(running) ── iteration 1..N：
   for i in 1..N:
     create execution(i, attempt=0)
     失败 → attempt++ (≤maxRetries, 指数退避) → 重新执行（同 execution 行）
     迭代终态 → 写报告；失败不中断（AC-TSK-08-4）
     intervalMs 等待 → 下一迭代
   N 次完成 / durationMs 到期 / 手动 stop → run 终态
```

### 4.3 计划执行（含暂停恢复）

```
POST /plans/:id/run → plan_run(running)
  按 plan_tasks.sort_order：
    当前任务 → 建 task_run(plan_run_id=prun, trigger=plan) → 入全局队列 → 等待终态
    [paused?] → 挂起调度，等 resume 后继续下一任务
    [失败]    → 记录，继续下一任务（PLN-05-2）
  全部结束 → 生成 type=plan 汇总报告（含 taskResults）→ plan_run/completed|failed
```

---

## 5. 服务端组件设计

### 5.1 新增目录结构（packages/web-ui/src）

```
src/
├── db/
│   ├── connection.ts          # better-sqlite3 单例 + PRAGMA
│   ├── migrations/            # 001_init.sql, 002_xxx.sql...
│   └── dao/                   # projects/tasks/runs/executions/plans/reports/...
├── services/
│   ├── task-queue.ts          # 全局串行队列（run 级）
│   ├── run-engine.ts          # run/迭代/重试状态机（§3 §4）
│   ├── schedule-runner.ts     # time/count 循环推进
│   ├── cron-scheduler.ts      # cron-parser + 1min tick（PLN-06）
│   ├── plan-executor.ts       # 计划编排（含 pause/resume）
│   ├── report-builder.ts      # 报告聚合 + HTML 模板导出 + PDF（Chromium page.pdf）+ 导出任务
│   ├── media-processor.ts     # 视频异步转码 webm→MP4（ffmpeg；失败降级保留 webm）
│   ├── retention-cleaner.ts   # 报告保留（联动 executions/logs）+ 上传 TTL 清理（RPT-06）
│   └── runner-client.ts       # Runner HTTP 客户端（/run /record /debug + 令牌）
└── routes/
    ├── project.routes.ts      ├── report.routes.ts
    ├── task.routes.ts         ├── dashboard.routes.ts
    ├── run.routes.ts          ├── config.routes.ts
    ├── plan.routes.ts         ├── upload.routes.ts
    └── internal.routes.ts     # /internal/* 回调
```

### 5.2 任务队列（task-queue.ts）

- 进程内单例：`Array<{runId}>` + `isRunning`；`add(runId)` 尾插，空闲即消费。
- 消费循环：取队首 run → `run-engine` 驱动迭代（循环/重试）→ 终态后取下一个。
- 队列状态查询直接遍历内存数组（`/api/config/queue/status`），run 持久状态以 DB 为准。
- 同一 run 内的迭代天然串行；计划触发的 run 与手动 run 同一队列（满足全局串行）。

### 5.3 重试与退避

```typescript
async function runIteration(execution) {
  for (let attempt = 0; attempt <= task.maxRetries; attempt++) {
    execution.attempt = attempt;
    await cleanupTempArtifacts(execution);          // AC-TSK-07-1
    const result = await runnerClient.run(payload); // 失败抛出
    if (result.ok) return markSuccess(execution);
    if (attempt === task.maxRetries) return markFailed(execution, result.error);
    execution.status = 'retrying';
    await sleep(1000 * 2 ** (attempt + 1));         // 1000*2^n 指数退避
  }
}
```

### 5.4 重启恢复

启动时（migrations 之后）：
- `task_runs` 中 `queued/running` → `stopped`，error=「服务重启中断」；对应 `executions` 同步 `stopped`。
- `test_plans` 中 `running/paused` → `stopped`（提示用户重新触发；不做自动续跑，避免重启风暴）。
- `export_jobs` 中 `processing` → `failed`（error=「服务重启中断」）。
- 通知 Runner `/stop/all` 清理可能残留的浏览器进程。

### 5.5 定时任务

| 任务 | 触发 | 职责 |
|------|------|------|
| cron-scheduler | 每 1min | 解析各 plan.cron_expr，到点触发 `/plans/:id/run`（执行中拦截 E8） |
| retention-cleaner | `report.cleanupCron`（默认每日 02:00） | 按 `maxPerTask/maxAgeDays` 删报告+导出文件；同一事务级联删除关联 `executions`/`execution_logs` 及产物目录（决策记录 #5）；清过期 uploads |
| agent-session GC | 每 5min | 空闲 30min 会话 → expired，释放浏览器（REC-A04-3） |

---

## 6. 需求追溯矩阵（API ↔ 需求编号）

| 需求 | 承接 API / 表 |
|------|--------------|
| REC-P01~P06 | /api/projects 全族；recording_projects |
| REC-B01~B05 | /api/record/* + /internal/record/*；record_sessions |
| REC-B06 | Runner recordVideo → artifacts；reports.video_path（AC-B06-2 报告播放） |
| REC-B07 | /api/debug/* + /internal/debug/events；debug_sessions |
| REC-A01~A07 | /api/agent/run（已有，SSE 契约不变） |
| REC-A08 | POST /api/agent/sessions/:sid/to-project、/api/record/sessions/:id/to-project |
| REC-A09 | /api/llm-configs*（已有，存储迁 llm_configs 表） |
| REC-A10 | GET /api/agent/sessions（改读库）；agent_sessions |
| REC-C01/C02 | PUT /api/projects/:id（步骤流编辑=scriptContent 更新）+ paramsSchema；POST /api/tasks params 校验 |
| TSK-01~05 | /api/tasks 全族；tasks/task_files/uploads |
| TSK-06 | POST /tasks/:id/run + GET /config/queue/status；task-queue |
| TSK-07 | run-engine 重试循环；executions.attempt |
| TSK-08 | tasks.schedule_mode/config；schedule-runner |
| TSK-09 | GET /task-runs/:runId + /logs + /stop；execution_logs |
| TSK-10 | GET /tasks/:id/executions + /executions/:id；executions |
| PLN-01~06 | /api/plans 全族；test_plans/plan_tasks/plan_runs/cron-scheduler |
| PLN-05b | POST /plans/:id/pause、/resume；plan-executor |
| RPT-01~05 | /api/reports 全族 + /exports；reports/report_steps/export_jobs |
| RPT-06 | retention-cleaner + /api/config/system |
| 看板页 | /api/dashboard/*（原型 page-dashboard） |
| E1~E8 | 错误码 50002/50003/20001/30001/30002 + lost 状态 + stop 幂等 |

---

## 7. 设计决策记录（已确认）

原评审阶段的 5 个开放问题，按推荐方案确定如下，正文相关章节已同步：

| # | 议题 | 决策 | 说明 |
|---|------|------|------|
| 1 | SSE 监控通道（§2.8 events） | **轮询为 P0 基线，SSE 定为 P2 增强** | AC-TSK-09 边界本身约定「监控页轮询（约 2s）」，轮询已满足验收标准；SSE 事件契约保留在设计中（`Last-Event-ID` 续传语义已定义），大日志量场景出现体验问题时可无缝升级，前端无需改数据结构 |
| 2 | 计划暂停粒度（§2.10） | **优雅冻结：当前迭代跑完后再冻结编排** | 与交互原型「暂停计划/恢复计划」的反馈文案一致；不打断在途迭代，已产生的迭代历史完整。需要立即中断的场景由「停止执行」承接（两条路径语义清晰：暂停=可恢复的冻结，停止=终态） |
| 3 | PDF 导出引擎（§2.11） | **Playwright 内置 Chromium `page.pdf()`** | 复用系统已装的 Playwright 浏览器，零新增依赖；在 report-builder 内以无头 Chromium 渲染 HTML 报告并打印，不引入 puppeteer |
| 4 | 视频转码（§1.3） | **ffmpeg 转码 MP4；转码失败降级保留 webm** | Runner 产物为 webm，执行结束后由 Backend 异步转码 MP4；ffmpeg 缺失/转码失败时 `reports.video_path` 指向原 webm，报告页按扩展名渲染播放并附「未转码 MP4」提示，不阻塞报告链路（与 REC-B06 边界「录屏失败不影响动作数据」同思路） |
| 5 | 执行日志保留（§5.5） | **execution_logs 跟随报告保留策略联动清理** | retention-cleaner 清理过期报告时，同一事务内级联删除对应 `executions` + `execution_logs`（报告保留策略即迭代数据保留策略，DB 不会无限增长）；任务删除仍全量级联，不受此影响 |
