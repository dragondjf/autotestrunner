/**
 * 测试报告 DAO（reports / report_steps / export_jobs）。
 * 设计依据：docs/需求设计/数据库与API设计.md §1.2.8 / §1.2.10（RPT）。
 */
import type { Row } from "./common.js";
import { camelRow, nowIso, parseJsonField } from "./common.js";
import { getDb } from "../connection.js";
import { newId } from "../ids.js";

export type ReportType = "task" | "plan";
export type ReportStatus = "success" | "failed" | "skipped" | "stopped";
export type StepStatus = "passed" | "failed" | "error" | "skipped" | "stopped" | "pending";

export interface ReportRow {
  id: string;
  type: ReportType;
  taskId: string | null;
  runId: string | null;
  executionId: number | null;
  planId: string | null;
  planRunId: string | null;
  name: string;
  status: ReportStatus;
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  skippedSteps: number;
  passRate: number;
  taskResults: string;
  errorMessage: string | null;
  videoPath: string | null;
  htmlPath: string | null;
  pdfPath: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface ReportStepRow {
  id: number;
  reportId: string;
  stepIndex: number;
  method: string;
  description: string;
  status: StepStatus;
  error: string | null;
  screenshotPath: string | null;
  durationMs: number | null;
  detail: string;
  createdAt: string;
}

export interface CreateReportInput {
  type: ReportType;
  taskId?: string | null;
  runId?: string | null;
  executionId?: number | null;
  planId?: string | null;
  planRunId?: string | null;
  name: string;
  status: ReportStatus;
  totalSteps?: number;
  passedSteps?: number;
  failedSteps?: number;
  skippedSteps?: number;
  taskResults?: unknown;
  errorMessage?: string | null;
  videoPath?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  durationMs?: number | null;
}

export function createReport(input: CreateReportInput): ReportRow {
  const id = newId("rpt");
  const total = input.totalSteps ?? 0;
  const passed = input.passedSteps ?? 0;
  const rate = total > 0 ? Math.round((passed / total) * 1000) / 10 : 0;
  getDb()
    .prepare(
      `INSERT INTO reports
       (id, type, task_id, run_id, execution_id, plan_id, plan_run_id, name, status,
        total_steps, passed_steps, failed_steps, skipped_steps, pass_rate, task_results,
        error_message, video_path, started_at, ended_at, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.type,
      input.taskId ?? null,
      input.runId ?? null,
      input.executionId ?? null,
      input.planId ?? null,
      input.planRunId ?? null,
      input.name,
      input.status,
      total,
      passed,
      input.failedSteps ?? 0,
      input.skippedSteps ?? 0,
      rate,
      JSON.stringify(input.taskResults ?? []),
      input.errorMessage ?? null,
      input.videoPath ?? null,
      input.startedAt ?? null,
      input.endedAt ?? null,
      input.durationMs ?? null,
      nowIso(),
    );
  return getReport(id)!;
}

export function getReport(id: string): ReportRow | null {
  const row = getDb().prepare("SELECT * FROM reports WHERE id = ?").get(id) as Row | undefined;
  return row ? camelRow<ReportRow>(row) : null;
}

export function updateReport(id: string, patch: Partial<Pick<ReportRow, "status" | "totalSteps" | "passedSteps" | "failedSteps" | "skippedSteps" | "passRate" | "taskResults" | "errorMessage" | "videoPath" | "htmlPath" | "pdfPath" | "endedAt" | "durationMs">>): void {
  const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  if (!keys.length) return;
  const snake = keys.map((k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
  const setSql = snake.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => (patch as Record<string, unknown>)[k]);
  getDb()
    .prepare(`UPDATE reports SET ${setSql} WHERE id = ?`)
    .run(...values, id);
}

export function deleteReport(id: string): boolean {
  return getDb().prepare("DELETE FROM reports WHERE id = ?").run(id).changes > 0;
}

export interface ListReportsQuery {
  page?: number;
  pageSize?: number;
  taskId?: string;
  planId?: string;
  status?: ReportStatus;
  type?: ReportType;
  startTime?: string;
  endTime?: string;
}

export function listReports(query: ListReportsQuery): {
  list: ReportRow[];
  total: number;
  page: number;
  pageSize: number;
} {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 10));
  const where: string[] = [];
  const args: unknown[] = [];
  if (query.taskId) {
    where.push("task_id = ?");
    args.push(query.taskId);
  }
  if (query.planId) {
    where.push("plan_id = ?");
    args.push(query.planId);
  }
  if (query.status) {
    where.push("status = ?");
    args.push(query.status);
  }
  if (query.type) {
    where.push("type = ?");
    args.push(query.type);
  }
  if (query.startTime) {
    where.push("created_at >= ?");
    args.push(query.startTime);
  }
  if (query.endTime) {
    where.push("created_at <= ?");
    args.push(query.endTime);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const db = getDb();
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM reports ${whereSql}`).get(...args) as { n: number }
  ).n;
  const rows = db
    .prepare(`SELECT * FROM reports ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize) as Row[];
  return { list: rows.map((r) => camelRow<ReportRow>(r)), total, page, pageSize };
}

// ---------------- report_steps ----------------

export interface AddStepInput {
  reportId: string;
  stepIndex: number;
  method?: string;
  description?: string;
  status: StepStatus;
  error?: string | null;
  screenshotPath?: string | null;
  durationMs?: number | null;
  detail?: unknown;
}

export function addReportStep(input: AddStepInput): ReportStepRow {
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO report_steps
       (report_id, step_index, method, description, status, error, screenshot_path,
        duration_ms, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.reportId,
      input.stepIndex,
      input.method ?? "",
      input.description ?? "",
      input.status,
      input.error ?? null,
      input.screenshotPath ?? null,
      input.durationMs ?? null,
      JSON.stringify(input.detail ?? {}),
      nowIso(),
    );
  return getReportStep(Number(info.lastInsertRowid))!;
}

export function getReportStep(id: number): ReportStepRow | null {
  const row = getDb().prepare("SELECT * FROM report_steps WHERE id = ?").get(id) as Row | undefined;
  return row ? camelRow<ReportStepRow>(row) : null;
}

export function listReportSteps(reportId: string, page = 1, pageSize = 100): {
  list: ReportStepRow[];
  total: number;
  page: number;
  pageSize: number;
} {
  const db = getDb();
  const total = (
    db.prepare("SELECT COUNT(*) AS n FROM report_steps WHERE report_id = ?").get(reportId) as {
      n: number;
    }
  ).n;
  const rows = db
    .prepare(
      "SELECT * FROM report_steps WHERE report_id = ? ORDER BY step_index LIMIT ? OFFSET ?",
    )
    .all(reportId, pageSize, (page - 1) * pageSize) as Row[];
  return { list: rows.map((r) => camelRow<ReportStepRow>(r)), total, page, pageSize };
}

/** 报告截图路径列表（report_steps.screenshot_path 非空集合） */
export function listReportScreenshots(reportId: string): string[] {
  const rows = getDb()
    .prepare("SELECT screenshot_path AS p FROM report_steps WHERE report_id = ? AND screenshot_path IS NOT NULL ORDER BY step_index")
    .all(reportId) as Array<{ p: string }>;
  return rows.map((r) => r.p);
}

/** 解析汇总报告的 taskResults */
export function reportTaskResults(report: ReportRow): Array<Record<string, unknown>> {
  return parseJsonField<Array<Record<string, unknown>>>(report.taskResults, []);
}

// ---------------- 趋势聚合 ----------------

export interface TrendBucket {
  bucket: string;
  total: number;
  success: number;
  failed: number;
  passRate: number;
}

/**
 * 按日/周/月分桶统计某任务的报告趋势。
 * SQLite strftime 无 ISO 周，week 用「年内第几天/7 起始周一」近似 ISO 周（W%02d）。
 */
export function reportTrend(taskId: string, granularity: "day" | "week" | "month", limit = 30): TrendBucket[] {
  const fmt =
    granularity === "day"
      ? "%Y-%m-%d"
      : granularity === "month"
        ? "%Y-%m"
        : null;
  const db = getDb();
  let rows: Array<Row>;
  if (fmt) {
    rows = db
      .prepare(
        `SELECT strftime(?, created_at) AS bucket, COUNT(*) AS total,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM reports WHERE task_id = ?
         GROUP BY bucket ORDER BY bucket DESC LIMIT ?`,
      )
      .all(fmt, taskId, limit) as Array<Row>;
  } else {
    // week：按 strftime('%W')（周一为一周起始，00~53）分桶
    rows = db
      .prepare(
        `SELECT strftime('%Y-W', created_at) || printf('%02d', CAST(strftime('%W', created_at) AS INTEGER)) AS bucket,
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM reports WHERE task_id = ?
         GROUP BY bucket ORDER BY bucket DESC LIMIT ?`,
      )
      .all(taskId, limit) as Array<Row>;
  }
  return rows.map((r) => {
    const total = Number(r["total"] ?? 0);
    const success = Number(r["success"] ?? 0);
    return {
      bucket: String(r["bucket"] ?? ""),
      total,
      success,
      failed: Number(r["failed"] ?? 0),
      passRate: total > 0 ? Math.round((success / total) * 1000) / 10 : 0,
    };
  });
}

// ---------------- export_jobs ----------------

export type ExportFormat = "html" | "pdf";
export type ExportStatus = "processing" | "done" | "failed";

export interface ExportJobRow {
  id: string;
  reportId: string;
  format: ExportFormat;
  status: ExportStatus;
  progress: number;
  filePath: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export function createExportJob(reportId: string, format: ExportFormat): ExportJobRow {
  const id = newId("exp");
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO export_jobs (id, report_id, format, status, progress, created_at, updated_at)
       VALUES (?, ?, ?, 'processing', 0, ?, ?)`,
    )
    .run(id, reportId, format, now, now);
  return getExportJob(id)!;
}

export function getExportJob(id: string): ExportJobRow | null {
  const row = getDb().prepare("SELECT * FROM export_jobs WHERE id = ?").get(id) as Row | undefined;
  return row ? camelRow<ExportJobRow>(row) : null;
}

export function updateExportJob(id: string, patch: Partial<Pick<ExportJobRow, "status" | "progress" | "filePath" | "error">>): void {
  const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  if (!keys.length) return;
  const snake = keys.map((k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
  const setSql = snake.map((k) => `${k} = ?`).join(", ") + ", updated_at = ?";
  const values = keys.map((k) => (patch as Record<string, unknown>)[k]);
  getDb()
    .prepare(`UPDATE export_jobs SET ${setSql} WHERE id = ?`)
    .run(...values, nowIso(), id);
}
