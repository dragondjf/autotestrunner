/**
 * 迁移 001：初始 Schema（19 张表 + 索引 + system_configs 预置键）。
 * 1:1 对照 docs/需求设计/数据库与API设计.md §1.2 DDL。
 * SQL 以 TS 导出（tsc 构建不拷贝 .sql 资源文件）。
 */

export const MIGRATION_001_NAME = "001_init";

export const MIGRATION_001_SQL = `
-- ============ 录制项目（REC-P） ============
CREATE TABLE IF NOT EXISTS recording_projects (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  type             TEXT NOT NULL CHECK (type IN ('ai','browser')),
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','ready','archived')),
  start_url        TEXT NOT NULL DEFAULT '',
  script_content   TEXT NOT NULL DEFAULT '',
  script_lang      TEXT NOT NULL DEFAULT 'json'
                   CHECK (script_lang IN ('json','js','py')),
  params_schema    TEXT NOT NULL DEFAULT '{}',
  record_config    TEXT NOT NULL DEFAULT '{}',
  last_run_status  TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_projects_name ON recording_projects(name);
CREATE INDEX IF NOT EXISTS idx_projects_type_status ON recording_projects(type, status);

-- ============ 测试任务（TSK） ============
CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  project_id       TEXT REFERENCES recording_projects(id) ON DELETE SET NULL,
  script_source    TEXT NOT NULL DEFAULT 'project'
                   CHECK (script_source IN ('project','upload')),
  script_snapshot  TEXT NOT NULL DEFAULT '',
  script_lang      TEXT NOT NULL DEFAULT 'json'
                   CHECK (script_lang IN ('json','js','py')),
  browser_type     TEXT NOT NULL DEFAULT 'chromium'
                   CHECK (browser_type IN ('chromium','firefox','webkit')),
  browser_path     TEXT NOT NULL DEFAULT '',
  params           TEXT NOT NULL DEFAULT '{}',
  max_retries      INTEGER NOT NULL DEFAULT 3 CHECK (max_retries >= 0),
  schedule_mode    TEXT NOT NULL DEFAULT 'manual'
                   CHECK (schedule_mode IN ('manual','time','count')),
  schedule_config  TEXT NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','running','retrying','success','failed','stopped')),
  last_run_at      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_browser ON tasks(browser_type);

-- ============ 任务文件与临时上传（TSK-03） ============
CREATE TABLE IF NOT EXISTS task_files (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('script','resource')),
  filename     TEXT NOT NULL,
  stored_path  TEXT NOT NULL,
  size         INTEGER NOT NULL,
  mime_type    TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_files_task ON task_files(task_id, kind);

CREATE TABLE IF NOT EXISTS uploads (
  id           TEXT PRIMARY KEY,
  filename     TEXT NOT NULL,
  stored_path  TEXT NOT NULL,
  size         INTEGER NOT NULL,
  mime_type    TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uploads_expires ON uploads(expires_at);

-- ============ 执行触发与迭代（TSK-07/08/09/10） ============
CREATE TABLE IF NOT EXISTS task_runs (
  id                    TEXT PRIMARY KEY,
  task_id               TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  plan_run_id           TEXT,
  trigger_type          TEXT NOT NULL DEFAULT 'manual'
                        CHECK (trigger_type IN ('manual','plan','cron')),
  schedule_mode         TEXT NOT NULL DEFAULT 'manual'
                        CHECK (schedule_mode IN ('manual','time','count')),
  planned_iterations    INTEGER,
  loop_duration_ms      INTEGER,
  iteration_interval_ms INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','running','completed','stopped','error')),
  current_iteration     INTEGER NOT NULL DEFAULT 0,
  completed_iterations  INTEGER NOT NULL DEFAULT 0,
  success_count         INTEGER NOT NULL DEFAULT 0,
  failed_count          INTEGER NOT NULL DEFAULT 0,
  started_at            TEXT,
  ended_at              TEXT,
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);
CREATE INDEX IF NOT EXISTS idx_task_runs_plan ON task_runs(plan_run_id);

CREATE TABLE IF NOT EXISTS executions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id           TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  iteration_index  INTEGER NOT NULL DEFAULT 1,
  attempt          INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','running','retrying','success','failed','stopped','error')),
  error            TEXT,
  started_at       TEXT,
  ended_at         TEXT,
  duration_ms      INTEGER,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_executions_run ON executions(run_id, iteration_index);
CREATE INDEX IF NOT EXISTS idx_executions_task ON executions(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS execution_logs (
  execution_id INTEGER NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  ts           TEXT NOT NULL,
  level        TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info','ok','warn','error')),
  event        TEXT NOT NULL DEFAULT 'log' CHECK (event IN ('log','screenshot','step','status')),
  message      TEXT NOT NULL DEFAULT '',
  payload      TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (execution_id, seq)
);

-- ============ 测试计划（PLN） ============
CREATE TABLE IF NOT EXISTS test_plans (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  cron_expr    TEXT,
  status       TEXT NOT NULL DEFAULT 'idle'
               CHECK (status IN ('idle','running','paused','completed','failed','stopped')),
  last_run_at  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_status ON test_plans(status);

CREATE TABLE IF NOT EXISTS plan_tasks (
  plan_id    TEXT NOT NULL REFERENCES test_plans(id) ON DELETE CASCADE,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (plan_id, task_id)
);
CREATE INDEX IF NOT EXISTS idx_plan_tasks_task ON plan_tasks(task_id);

CREATE TABLE IF NOT EXISTS plan_runs (
  id                 TEXT PRIMARY KEY,
  plan_id            TEXT NOT NULL REFERENCES test_plans(id) ON DELETE CASCADE,
  trigger_type       TEXT NOT NULL DEFAULT 'manual'
                     CHECK (trigger_type IN ('manual','cron')),
  status             TEXT NOT NULL DEFAULT 'running'
                     CHECK (status IN ('running','paused','completed','failed','stopped')),
  started_at         TEXT,
  ended_at           TEXT,
  summary_report_id  TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_runs_plan ON plan_runs(plan_id, created_at DESC);

-- ============ 测试报告（RPT） ============
CREATE TABLE IF NOT EXISTS reports (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL CHECK (type IN ('task','plan')),
  task_id         TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  run_id          TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  execution_id    INTEGER REFERENCES executions(id) ON DELETE SET NULL,
  plan_id         TEXT REFERENCES test_plans(id) ON DELETE CASCADE,
  plan_run_id     TEXT REFERENCES plan_runs(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL
                  CHECK (status IN ('success','failed','skipped','stopped')),
  total_steps     INTEGER NOT NULL DEFAULT 0,
  passed_steps    INTEGER NOT NULL DEFAULT 0,
  failed_steps    INTEGER NOT NULL DEFAULT 0,
  skipped_steps   INTEGER NOT NULL DEFAULT 0,
  pass_rate       REAL NOT NULL DEFAULT 0,
  task_results    TEXT NOT NULL DEFAULT '[]',
  error_message   TEXT,
  video_path      TEXT,
  html_path       TEXT,
  pdf_path        TEXT,
  started_at      TEXT,
  ended_at        TEXT,
  duration_ms     INTEGER,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_task ON reports(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_plan ON reports(plan_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC);

CREATE TABLE IF NOT EXISTS report_steps (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id       TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  step_index      INTEGER NOT NULL,
  method          TEXT NOT NULL DEFAULT '',
  description     TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL
                  CHECK (status IN ('passed','failed','error','skipped','stopped','pending')),
  error           TEXT,
  screenshot_path TEXT,
  duration_ms     INTEGER,
  detail          TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_steps_report ON report_steps(report_id, step_index);

-- ============ 录制/AI/调试会话（REC-B / REC-A10 / REC-B07） ============
CREATE TABLE IF NOT EXISTS record_sessions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     TEXT REFERENCES recording_projects(id) ON DELETE SET NULL,
  url            TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','recording','paused','completed','failed','stopped','lost')),
  actions_count  INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  actions_path   TEXT,
  started_at     TEXT,
  ended_at       TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_record_sessions_status ON record_sessions(status, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_sessions (
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
  events_path     TEXT,
  created_at      TEXT NOT NULL,
  last_active_at  TEXT NOT NULL,
  closed_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_status ON agent_sessions(status, last_active_at DESC);

CREATE TABLE IF NOT EXISTS debug_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT REFERENCES recording_projects(id) ON DELETE SET NULL,
  execution_id  INTEGER REFERENCES executions(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','closed','failed')),
  created_at    TEXT NOT NULL,
  closed_at     TEXT
);

-- ============ 配置域（LLM / 浏览器 / 系统配置 / 导出任务） ============
CREATE TABLE IF NOT EXISTS llm_configs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT '',
  provider    TEXT NOT NULL DEFAULT '自定义',
  api_key     TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS browsers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL CHECK (name IN ('chromium','firefox','webkit')),
  version    TEXT NOT NULL DEFAULT '',
  path       TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_configs (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS export_jobs (
  id         TEXT PRIMARY KEY,
  report_id  TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  format     TEXT NOT NULL CHECK (format IN ('html','pdf')),
  status     TEXT NOT NULL DEFAULT 'processing'
             CHECK (status IN ('processing','done','failed')),
  progress   INTEGER NOT NULL DEFAULT 0,
  file_path  TEXT,
  error      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`;

/** system_configs 预置键（设计文档 §1.2.10） */
export const MIGRATION_001_SYSTEM_DEFAULTS: Record<string, string> = {
  "report.retention": JSON.stringify({ maxPerTask: 100, maxAgeDays: 90 }),
  "report.cleanupCron": JSON.stringify("0 2 * * *"),
  "upload.limits": JSON.stringify({ maxFileBytes: 52428800, maxFilesPerTask: 100 }),
  "queue.pollIntervalMs": JSON.stringify(2000),
};
