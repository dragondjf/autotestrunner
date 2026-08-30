/**
 * 测试计划 DAO（test_plans / plan_tasks / plan_runs）。
 * 设计依据：docs/需求设计/数据库与API设计.md §1.2.7（PLN）。
 */
import type { Row } from "./common.js";
import { camelRow, nowIso } from "./common.js";
import { getDb } from "../connection.js";
import { newId } from "../ids.js";

export type PlanStatus = "idle" | "running" | "paused" | "completed" | "failed" | "stopped";
export type PlanRunStatus = "running" | "paused" | "completed" | "failed" | "stopped";

export interface PlanRow {
  id: string;
  name: string;
  description: string;
  cronExpr: string | null;
  status: PlanStatus;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanTaskRef {
  planId: string;
  taskId: string;
  sortOrder: number;
}

export interface PlanRunRow {
  id: string;
  planId: string;
  triggerType: "manual" | "cron";
  status: PlanRunStatus;
  startedAt: string | null;
  endedAt: string | null;
  summaryReportId: string | null;
  createdAt: string;
}

export function createPlan(input: {
  name: string;
  description?: string;
  cronExpr?: string | null;
  taskIds: string[];
}): PlanRow {
  const db = getDb();
  const now = nowIso();
  const id = newId("plan");
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO test_plans (id, name, description, cron_expr, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'idle', ?, ?)`,
    ).run(id, input.name, input.description ?? "", input.cronExpr ?? null, now, now);
    const insertRef = db.prepare(
      "INSERT INTO plan_tasks (plan_id, task_id, sort_order) VALUES (?, ?, ?)",
    );
    input.taskIds.forEach((taskId, idx) => insertRef.run(id, taskId, idx));
  });
  tx();
  return getPlan(id)!;
}

export function getPlan(id: string): PlanRow | null {
  const row = getDb().prepare("SELECT * FROM test_plans WHERE id = ?").get(id) as Row | undefined;
  return row ? camelRow<PlanRow>(row) : null;
}

export function updatePlan(
  id: string,
  input: {
    name?: string;
    description?: string;
    cronExpr?: string | null;
    taskIds?: string[];
  },
): PlanRow | null {
  const existing = getPlan(id);
  if (!existing) return null;
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE test_plans
       SET name = ?, description = ?, cron_expr = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.name ?? existing.name,
      input.description ?? existing.description,
      "cronExpr" in input ? (input.cronExpr ?? null) : existing.cronExpr,
      nowIso(),
      id,
    );
    if (input.taskIds) {
      db.prepare("DELETE FROM plan_tasks WHERE plan_id = ?").run(id);
      const insertRef = db.prepare(
        "INSERT INTO plan_tasks (plan_id, task_id, sort_order) VALUES (?, ?, ?)",
      );
      input.taskIds.forEach((taskId, idx) => insertRef.run(id, taskId, idx));
    }
  });
  tx();
  return getPlan(id);
}

export function deletePlan(id: string): boolean {
  return getDb().prepare("DELETE FROM test_plans WHERE id = ?").run(id).changes > 0;
}

export function updatePlanStatus(id: string, status: PlanStatus, lastRunAt?: string): void {
  getDb()
    .prepare("UPDATE test_plans SET status = ?, last_run_at = COALESCE(?, last_run_at), updated_at = ? WHERE id = ?")
    .run(status, lastRunAt ?? null, nowIso(), id);
}

export function listPlans(query: {
  page?: number;
  pageSize?: number;
  status?: PlanStatus;
}): { list: PlanRow[]; total: number; page: number; pageSize: number } {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 10));
  const where = query.status ? "WHERE status = ?" : "";
  const args = query.status ? [query.status] : [];
  const db = getDb();
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM test_plans ${where}`).get(...args) as { n: number }
  ).n;
  const rows = db
    .prepare(`SELECT * FROM test_plans ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...(args as unknown[]), pageSize, (page - 1) * pageSize) as Row[];
  return { list: rows.map((r) => camelRow<PlanRow>(r)), total, page, pageSize };
}

/** 计划任务清单（按 sort_order） */
export function listPlanTasks(planId: string): PlanTaskRef[] {
  const rows = getDb()
    .prepare("SELECT * FROM plan_tasks WHERE plan_id = ? ORDER BY sort_order")
    .all(planId) as Row[];
  return rows.map((r) => camelRow<PlanTaskRef>(r));
}

export function countPlanTasks(planId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM plan_tasks WHERE plan_id = ?")
    .get(planId) as { n: number };
  return row.n;
}

/** 校验任务 ID 集合在 tasks 表中全部存在；返回缺失的 ID */
export function findMissingTaskIds(taskIds: string[]): string[] {
  if (!taskIds.length) return [];
  const db = getDb();
  const stmt = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id = ?");
  return taskIds.filter((id) => (stmt.get(id) as { n: number }).n === 0);
}

/** 计划是否存在非终态 plan_run（编辑/删除/重复触发拦截，错误码 30002） */
export function planHasActiveRun(planId: string): boolean {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) AS n FROM plan_runs WHERE plan_id = ? AND status IN ('running','paused')",
    )
    .get(planId) as { n: number };
  return row.n > 0;
}

// ---------------- plan_runs ----------------

export function createPlanRun(planId: string, triggerType: "manual" | "cron" = "manual"): PlanRunRow {
  const id = newId("prun");
  getDb()
    .prepare(
      `INSERT INTO plan_runs (id, plan_id, trigger_type, status, started_at, created_at)
       VALUES (?, ?, ?, 'running', ?, ?)`,
    )
    .run(id, planId, triggerType, nowIso(), nowIso());
  return getPlanRun(id)!;
}

export function getPlanRun(id: string): PlanRunRow | null {
  const row = getDb().prepare("SELECT * FROM plan_runs WHERE id = ?").get(id) as Row | undefined;
  return row ? camelRow<PlanRunRow>(row) : null;
}

export function getActivePlanRun(planId: string): PlanRunRow | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM plan_runs WHERE plan_id = ? AND status IN ('running','paused') ORDER BY created_at DESC LIMIT 1",
    )
    .get(planId) as Row | undefined;
  return row ? camelRow<PlanRunRow>(row) : null;
}

export function updatePlanRun(id: string, patch: Partial<Pick<PlanRunRow, "status" | "endedAt" | "summaryReportId">>): void {
  const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  if (!keys.length) return;
  const snake = keys.map((k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
  const setSql = snake.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => (patch as Record<string, unknown>)[k]);
  getDb()
    .prepare(`UPDATE plan_runs SET ${setSql} WHERE id = ?`)
    .run(...values, id);
}

export function listPlanRuns(planId: string, limit = 20): PlanRunRow[] {
  const rows = getDb()
    .prepare("SELECT * FROM plan_runs WHERE plan_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(planId, limit) as Row[];
  return rows.map((r) => camelRow<PlanRunRow>(r));
}
