/**
 * 重启恢复（设计文档 §5.4）：
 * 未终态 task_runs → stopped（error=服务重启中断）；执行中计划 → stopped；
 * processing 导出任务 → failed。通知 Runner /stop/all 清理残留浏览器。
 */
import { getDb } from "../db/connection.js";
import { updateTaskStatus } from "../db/dao/tasks.js";
import { updatePlanStatus } from "../db/dao/plans.js";
import { logger } from "../logging.js";

export function recoverInterruptedRuns(): void {
  const db = getDb();
  const note = "服务重启中断";

  const runs = db
    .prepare("SELECT id, task_id FROM task_runs WHERE status IN ('queued','running')")
    .all() as Array<{ id: string; task_id: string }>;
  for (const run of runs) {
    db.prepare(
      "UPDATE task_runs SET status = 'stopped', ended_at = ?, current_iteration = completed_iterations WHERE id = ?",
    ).run(new Date().toISOString(), run.id);
    db.prepare(
      "UPDATE executions SET status = 'stopped', ended_at = ?, error = ? WHERE run_id = ? AND status IN ('pending','running','retrying')",
    ).run(new Date().toISOString(), note, run.id);
    updateTaskStatus(run.task_id, "stopped");
  }
  if (runs.length) logger.info("[recovery] %d 个未完成 run 标记为 stopped", String(runs.length));

  const plans = db
    .prepare("SELECT id FROM test_plans WHERE status IN ('running','paused')")
    .all() as Array<{ id: string }>;
  for (const plan of plans) {
    updatePlanStatus(plan.id, "stopped");
  }
  if (plans.length) logger.info("[recovery] %d 个未完成计划标记为 stopped", String(plans.length));

  const exports = db
    .prepare("UPDATE export_jobs SET status = 'failed', error = ? WHERE status = 'processing'")
    .run(note);
  if (exports.changes > 0) logger.info("[recovery] %d 个导出任务标记为 failed", String(exports.changes));
}
