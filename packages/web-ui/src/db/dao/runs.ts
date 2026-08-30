/**
 * 执行域 DAO（task_runs / executions / execution_logs）。
 * 设计依据：docs/需求设计/数据库与API设计.md §1.2.4~§1.2.6（TSK-07~10）。
 */
import type { Row } from "./common.js";
import { camelRow, nowIso, parseJsonField } from "./common.js";
import { getDb } from "../connection.js";
import { newId } from "../ids.js";
import type { ScheduleMode } from "./tasks.js";

export type RunStatus = "queued" | "running" | "completed" | "stopped" | "error";
export type TriggerType = "manual" | "plan" | "cron";
export type ExecutionStatus =
  | "pending"
  | "running"
  | "retrying"
  | "success"
  | "failed"
  | "stopped"
  | "error";

export interface TaskRunRow {
  id: string;
  taskId: string;
  planRunId: string | null;
  triggerType: TriggerType;
  scheduleMode: ScheduleMode;
  plannedIterations: number | null;
  loopDurationMs: number | null;
  iterationIntervalMs: number;
  status: RunStatus;
  currentIteration: number;
  completedIterations: number;
  successCount: number;
  failedCount: number;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export interface ExecutionRow {
  id: number;
  runId: string;
  taskId: string;
  iterationIndex: number;
  attempt: number;
  status: ExecutionStatus;
  error: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface ExecutionLogRow {
  executionId: number;
  seq: number;
  ts: string;
  level: "info" | "ok" | "warn" | "error";
  event: "log" | "screenshot" | "step" | "status";
  message: string;
  payload: string;
}

export interface CreateRunInput {
  taskId: string;
  planRunId?: string | null;
  triggerType?: TriggerType;
  scheduleMode: ScheduleMode;
  plannedIterations?: number | null;
  loopDurationMs?: number | null;
  iterationIntervalMs?: number;
}

export function createTaskRun(input: CreateRunInput): TaskRunRow {
  const id = newId("run");
  getDb()
    .prepare(
      `INSERT INTO task_runs
       (id, task_id, plan_run_id, trigger_type, schedule_mode, planned_iterations,
        loop_duration_ms, iteration_interval_ms, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    )
    .run(
      id,
      input.taskId,
      input.planRunId ?? null,
      input.triggerType ?? "manual",
      input.scheduleMode,
      input.plannedIterations ?? null,
      input.loopDurationMs ?? null,
      input.iterationIntervalMs ?? 0,
      nowIso(),
    );
  return getTaskRun(id)!;
}

export function getTaskRun(id: string): TaskRunRow | null {
  const row = getDb().prepare("SELECT * FROM task_runs WHERE id = ?").get(id) as Row | undefined;
  return row ? camelRow<TaskRunRow>(row) : null;
}

export function updateTaskRun(id: string, patch: Partial<Omit<TaskRunRow, "id" | "taskId" | "createdAt">>): void {
  const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  if (!keys.length) return;
  const snake = keys.map((k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
  const setSql = snake.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => (patch as Record<string, unknown>)[k]);
  getDb()
    .prepare(`UPDATE task_runs SET ${setSql} WHERE id = ?`)
    .run(...values, id);
}

export function listTaskRunsByTask(taskId: string, limit = 20): TaskRunRow[] {
  const rows = getDb()
    .prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(taskId, limit) as Row[];
  return rows.map((r) => camelRow<TaskRunRow>(r));
}

export function listRecentRuns(limit = 10): TaskRunRow[] {
  const rows = getDb()
    .prepare("SELECT * FROM task_runs ORDER BY created_at DESC LIMIT ?")
    .all(limit) as Row[];
  return rows.map((r) => camelRow<TaskRunRow>(r));
}

// ---------------- executions ----------------

export interface CreateExecutionInput {
  runId: string;
  taskId: string;
  iterationIndex: number;
}

export function createExecution(input: CreateExecutionInput): ExecutionRow {
  const info = getDb()
    .prepare(
      `INSERT INTO executions (run_id, task_id, iteration_index, attempt, status, created_at)
       VALUES (?, ?, ?, 0, 'pending', ?)`,
    )
    .run(input.runId, input.taskId, input.iterationIndex, nowIso());
  return getExecution(Number(info.lastInsertRowid))!;
}

export function getExecution(id: number): ExecutionRow | null {
  const row = getDb().prepare("SELECT * FROM executions WHERE id = ?").get(id) as Row | undefined;
  return row ? camelRow<ExecutionRow>(row) : null;
}

export function updateExecution(id: number, patch: Partial<Omit<ExecutionRow, "id" | "runId" | "taskId" | "iterationIndex" | "createdAt">>): void {
  const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  if (!keys.length) return;
  const snake = keys.map((k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
  const setSql = snake.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => (patch as Record<string, unknown>)[k]);
  getDb()
    .prepare(`UPDATE executions SET ${setSql} WHERE id = ?`)
    .run(...values, id);
}

export function listExecutionsByTask(taskId: string, page = 1, pageSize = 10): {
  list: ExecutionRow[];
  total: number;
  page: number;
  pageSize: number;
} {
  const db = getDb();
  const total = (
    db.prepare("SELECT COUNT(*) AS n FROM executions WHERE task_id = ?").get(taskId) as {
      n: number;
    }
  ).n;
  const rows = db
    .prepare(
      "SELECT * FROM executions WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
    )
    .all(taskId, pageSize, (page - 1) * pageSize) as Row[];
  return { list: rows.map((r) => camelRow<ExecutionRow>(r)), total, page, pageSize };
}

export function listExecutionsByRun(runId: string, limit = 20): ExecutionRow[] {
  const rows = getDb()
    .prepare("SELECT * FROM executions WHERE run_id = ? ORDER BY iteration_index DESC LIMIT ?")
    .all(runId, limit) as Row[];
  return rows.map((r) => camelRow<ExecutionRow>(r));
}

// ---------------- execution_logs ----------------

export interface AppendLogInput {
  executionId: number;
  level?: "info" | "ok" | "warn" | "error";
  event?: "log" | "screenshot" | "step" | "status";
  message: string;
  payload?: unknown;
}

export function appendExecutionLog(input: AppendLogInput): ExecutionLogRow {
  const db = getDb();
  const seq =
    (
      db
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM execution_logs WHERE execution_id = ?")
        .get(input.executionId) as { next: number }
    ).next ?? 1;
  const row: ExecutionLogRow = {
    executionId: input.executionId,
    seq,
    ts: nowIso(),
    level: input.level ?? "info",
    event: input.event ?? "log",
    message: input.message,
    payload: JSON.stringify(input.payload ?? {}),
  };
  db.prepare(
    `INSERT INTO execution_logs (execution_id, seq, ts, level, event, message, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.executionId, row.seq, row.ts, row.level, row.event, row.message, row.payload);
  return row;
}

export interface FetchLogsResult {
  logs: ExecutionLogRow[];
  nextSeq: number;
  hasMore: boolean;
}

export function fetchExecutionLogs(
  executionId: number,
  afterSeq = 0,
  limit = 200,
): FetchLogsResult {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM execution_logs WHERE execution_id = ? AND seq > ?
       ORDER BY seq LIMIT ?`,
    )
    .all(executionId, afterSeq, limit) as Row[];
  const logs = rows.map((r) => camelRow<ExecutionLogRow>(r));
  const lastSeq = logs.length ? logs[logs.length - 1]!.seq : afterSeq;
  const hasMore = logs.length === limit;
  return { logs, nextSeq: lastSeq, hasMore };
}

export function countExecutionLogs(executionId: number): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM execution_logs WHERE execution_id = ?")
    .get(executionId) as { n: number };
  return row.n;
}

/** 解析日志 payload 字段 */
export function logPayload(log: ExecutionLogRow): Record<string, unknown> {
  return parseJsonField<Record<string, unknown>>(log.payload, {});
}
