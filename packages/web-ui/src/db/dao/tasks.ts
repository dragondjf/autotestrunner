/**
 * 测试任务 DAO（tasks / task_files / uploads）。
 * 设计依据：docs/需求设计/数据库与API设计.md §1.2.2 / §1.2.3（TSK）。
 */
import type { Row } from "./common.js";
import { camelRow, nowIso } from "./common.js";
import { getDb } from "../connection.js";
import { newId } from "../ids.js";
import type { ScriptLang } from "./projects.js";

export type TaskStatus =
  | "pending"
  | "running"
  | "retrying"
  | "success"
  | "failed"
  | "stopped";
export type BrowserType = "chromium" | "firefox" | "webkit";
export type ScheduleMode = "manual" | "time" | "count";
export type ScriptSource = "project" | "upload";

export interface TaskRow {
  id: string;
  name: string;
  description: string;
  projectId: string | null;
  scriptSource: ScriptSource;
  scriptSnapshot: string;
  scriptLang: ScriptLang;
  browserType: BrowserType;
  browserPath: string;
  params: string;
  maxRetries: number;
  scheduleMode: ScheduleMode;
  scheduleConfig: string;
  status: TaskStatus;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  name: string;
  description?: string;
  projectId?: string | null;
  scriptSource: ScriptSource;
  scriptSnapshot: string;
  scriptLang?: ScriptLang;
  browserType?: BrowserType;
  browserPath?: string;
  params?: unknown;
  maxRetries?: number;
  scheduleMode?: ScheduleMode;
  scheduleConfig?: unknown;
}

export interface UpdateTaskInput {
  name?: string;
  description?: string;
  browserType?: BrowserType;
  browserPath?: string;
  params?: unknown;
  maxRetries?: number;
  scheduleMode?: ScheduleMode;
  scheduleConfig?: unknown;
}

export interface ListTasksQuery {
  page?: number;
  pageSize?: number;
  projectId?: string;
  status?: TaskStatus;
  browserType?: BrowserType;
  keyword?: string;
}

function toTask(row: Row): TaskRow {
  return camelRow<TaskRow>(row);
}

export function createTask(input: CreateTaskInput): TaskRow {
  const now = nowIso();
  const id = newId("task");
  getDb()
    .prepare(
      `INSERT INTO tasks
       (id, name, description, project_id, script_source, script_snapshot, script_lang,
        browser_type, browser_path, params, max_retries, schedule_mode, schedule_config,
        status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      id,
      input.name,
      input.description ?? "",
      input.projectId ?? null,
      input.scriptSource,
      input.scriptSnapshot,
      input.scriptLang ?? "json",
      input.browserType ?? "chromium",
      input.browserPath ?? "",
      JSON.stringify(input.params ?? {}),
      input.maxRetries ?? 3,
      input.scheduleMode ?? "manual",
      JSON.stringify(input.scheduleConfig ?? {}),
      now,
      now,
    );
  return getTask(id)!;
}

export function getTask(id: string): TaskRow | null {
  const row = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
  return row ? toTask(row) : null;
}

export function updateTask(id: string, input: UpdateTaskInput): TaskRow | null {
  const existing = getTask(id);
  if (!existing) return null;
  const next: TaskRow = {
    ...existing,
    ...(Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as object),
  } as TaskRow;
  getDb()
    .prepare(
      `UPDATE tasks
       SET name = ?, description = ?, browser_type = ?, browser_path = ?, params = ?,
           max_retries = ?, schedule_mode = ?, schedule_config = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      next.name,
      next.description,
      next.browserType,
      next.browserPath,
      "params" in input && input.params !== undefined
        ? JSON.stringify(input.params)
        : existing.params,
      next.maxRetries,
      next.scheduleMode,
      "scheduleConfig" in input && input.scheduleConfig !== undefined
        ? JSON.stringify(input.scheduleConfig)
        : existing.scheduleConfig,
      nowIso(),
      id,
    );
  return getTask(id);
}

export function deleteTask(id: string): boolean {
  return getDb().prepare("DELETE FROM tasks WHERE id = ?").run(id).changes > 0;
}

export function updateTaskStatus(id: string, status: TaskStatus, lastRunAt?: string): void {
  getDb()
    .prepare("UPDATE tasks SET status = ?, last_run_at = COALESCE(?, last_run_at), updated_at = ? WHERE id = ?")
    .run(status, lastRunAt ?? null, nowIso(), id);
}

export function listTasks(query: ListTasksQuery): {
  list: TaskRow[];
  total: number;
  page: number;
  pageSize: number;
} {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 10));
  const where: string[] = [];
  const args: unknown[] = [];
  if (query.projectId) {
    where.push("project_id = ?");
    args.push(query.projectId);
  }
  if (query.status) {
    where.push("status = ?");
    args.push(query.status);
  }
  if (query.browserType) {
    where.push("browser_type = ?");
    args.push(query.browserType);
  }
  if (query.keyword) {
    where.push("name LIKE ?");
    args.push(`%${query.keyword}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const db = getDb();
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM tasks ${whereSql}`).get(...args) as { n: number }
  ).n;
  const rows = db
    .prepare(`SELECT * FROM tasks ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize) as Row[];
  return { list: rows.map(toTask), total, page, pageSize };
}

/** 任务是否存在运行中/排队中执行（编辑/删除拦截，错误码 20004） */
export function taskHasActiveRun(taskId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM task_runs
       WHERE task_id = ? AND status IN ('queued','running')`,
    )
    .get(taskId) as { n: number };
  return row.n > 0;
}

// ---------------- task_files ----------------

export type TaskFileKind = "script" | "resource";

export interface TaskFileRow {
  id: string;
  taskId: string;
  kind: TaskFileKind;
  filename: string;
  storedPath: string;
  size: number;
  mimeType: string;
  createdAt: string;
}

export function addTaskFile(input: {
  taskId: string;
  kind: TaskFileKind;
  filename: string;
  storedPath: string;
  size: number;
  mimeType?: string;
}): TaskFileRow {
  const id = newId("file");
  getDb()
    .prepare(
      `INSERT INTO task_files (id, task_id, kind, filename, stored_path, size, mime_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.taskId, input.kind, input.filename, input.storedPath, input.size, input.mimeType ?? "", nowIso());
  return getTaskFile(id)!;
}

export function getTaskFile(id: string): TaskFileRow | null {
  const row = getDb().prepare("SELECT * FROM task_files WHERE id = ?").get(id) as Row | undefined;
  return row ? camelRow<TaskFileRow>(row) : null;
}

export function listTaskFiles(taskId: string, kind?: TaskFileKind): TaskFileRow[] {
  const sql = kind
    ? "SELECT * FROM task_files WHERE task_id = ? AND kind = ? ORDER BY created_at"
    : "SELECT * FROM task_files WHERE task_id = ? ORDER BY created_at";
  const rows = (kind
    ? getDb().prepare(sql).all(taskId, kind)
    : getDb().prepare(sql).all(taskId)) as Row[];
  return rows.map((r) => camelRow<TaskFileRow>(r));
}

// ---------------- uploads（临时上传） ----------------

export interface UploadRow {
  id: string;
  filename: string;
  storedPath: string;
  size: number;
  mimeType: string;
  createdAt: string;
  expiresAt: string;
}

export function addUpload(input: {
  filename: string;
  storedPath: string;
  size: number;
  mimeType?: string;
  ttlHours?: number;
}): UploadRow {
  const id = newId("upl");
  const now = nowIso();
  const ttlMs = (input.ttlHours ?? 24) * 3600 * 1000;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  getDb()
    .prepare(
      `INSERT INTO uploads (id, filename, stored_path, size, mime_type, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.filename, input.storedPath, input.size, input.mimeType ?? "", now, expiresAt);
  return getUpload(id)!;
}

export function getUpload(id: string): UploadRow | null {
  const row = getDb().prepare("SELECT * FROM uploads WHERE id = ?").get(id) as Row | undefined;
  return row ? camelRow<UploadRow>(row) : null;
}

export function deleteUpload(id: string): boolean {
  return getDb().prepare("DELETE FROM uploads WHERE id = ?").run(id).changes > 0;
}
