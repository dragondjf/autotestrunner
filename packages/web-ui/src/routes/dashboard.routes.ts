/**
 * 看板路由（/api/dashboard）：统计卡 / 趋势 / 最近执行。
 * 设计依据：docs/需求设计/数据库与API设计.md §2.12（原型 page-dashboard）。
 */
import { Router } from "express";
import { wrap } from "../http-error.js";
import { ok } from "../api/respond.js";
import { getDb } from "../db/connection.js";
import { listRecentRuns } from "../db/dao/runs.js";
import { getTask } from "../db/dao/tasks.js";
import { ensureMigrated } from "../db/ensure.js";

export const dashboardRouter: Router = Router();

// GET /api/dashboard/stats —— 统计卡
dashboardRouter.get(
  "/api/dashboard/stats",
  wrap((_req, res) => {
    ensureMigrated();
    const db = getDb();
    const count = (sql: string, ...args: unknown[]): number =>
      (db.prepare(sql).get(...args) as { n: number }).n;

    const projects = {
      total: count("SELECT COUNT(*) AS n FROM recording_projects"),
      ai: count("SELECT COUNT(*) AS n FROM recording_projects WHERE type = 'ai'"),
      browser: count("SELECT COUNT(*) AS n FROM recording_projects WHERE type = 'browser'"),
      ready: count("SELECT COUNT(*) AS n FROM recording_projects WHERE status = 'ready'"),
    };
    const byStatus: Record<string, number> = {};
    for (const row of db.prepare("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status").all() as Array<{ status: string; n: number }>) {
      byStatus[row.status] = row.n;
    }
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const reports24hRow = db
      .prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success FROM reports WHERE created_at >= ?")
      .get(dayAgo) as { total: number; success: number | null };
    const activeRuns = db
      .prepare("SELECT r.id, r.task_id FROM task_runs r WHERE r.status IN ('queued','running') ORDER BY r.created_at")
      .all() as Array<{ id: string; task_id: string }>;

    ok(res, {
      projects,
      tasks: {
        total: count("SELECT COUNT(*) AS n FROM tasks"),
        byStatus: {
          pending: byStatus["pending"] ?? 0,
          running: byStatus["running"] ?? 0,
          retrying: byStatus["retrying"] ?? 0,
          success: byStatus["success"] ?? 0,
          failed: byStatus["failed"] ?? 0,
          stopped: byStatus["stopped"] ?? 0,
        },
      },
      plans: {
        total: count("SELECT COUNT(*) AS n FROM test_plans"),
        running: count("SELECT COUNT(*) AS n FROM test_plans WHERE status IN ('running','paused')"),
      },
      reports24h: {
        total: reports24hRow.total,
        passRate:
          reports24hRow.total > 0
            ? Math.round(((reports24hRow.success ?? 0) / reports24hRow.total) * 1000) / 10
            : 0,
      },
      queue: {
        running: activeRuns.length > 0,
        currentTaskName: activeRuns.length ? getTask(activeRuns[0]!.task_id)?.name ?? null : null,
        queueLength: Math.max(0, activeRuns.length - 1),
      },
    });
  }),
);

// GET /api/dashboard/trend?days=7 —— 近 N 天执行趋势
dashboardRouter.get(
  "/api/dashboard/trend",
  wrap((req, res) => {
    ensureMigrated();
    const days = Math.min(90, Math.max(1, Number(req.query["days"] ?? 7)));
    const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT strftime('%Y-%m-%d', created_at) AS date, COUNT(*) AS total,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success
         FROM reports WHERE created_at >= ? || 'T00:00:00Z'
         GROUP BY date ORDER BY date`,
      )
      .all(since) as Array<{ date: string; total: number; success: number | null }>;
    const byDate = new Map(rows.map((r) => [r.date, r]));
    // 补齐空日期桶
    const buckets: Array<{ date: string; total: number; success: number; failed: number; passRate: number }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const r = byDate.get(d);
      const total = r?.total ?? 0;
      const success = r?.success ?? 0;
      buckets.push({
        date: d,
        total,
        success,
        failed: total - success,
        passRate: total > 0 ? Math.round((success / total) * 1000) / 10 : 0,
      });
    }
    ok(res, { days, buckets });
  }),
);

// GET /api/dashboard/recent-runs?limit=10 —— 最近执行
dashboardRouter.get(
  "/api/dashboard/recent-runs",
  wrap((req, res) => {
    ensureMigrated();
    const limit = Math.min(50, Math.max(1, Number(req.query["limit"] ?? 10)));
    const runs = listRecentRuns(limit);
    ok(res, {
      list: runs.map((r) => ({
        runId: r.id,
        taskId: r.taskId,
        taskName: getTask(r.taskId)?.name ?? null,
        status: r.status,
        scheduleMode: r.scheduleMode,
        currentIteration: r.currentIteration,
        plannedIterations: r.plannedIterations,
        successCount: r.successCount,
        failedCount: r.failedCount,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
      })),
    });
  }),
);
