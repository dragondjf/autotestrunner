/**
 * 保留策略清理器（RPT-06 + 决策记录 #5）。
 * 1. 报告保留：按 maxPerTask/maxAgeDays 删除过期报告，
 *    同事务级联删除关联 executions/execution_logs 与产物目录；
 * 2. 上传 TTL：过期 uploads 行与文件清理；
 * 3. 录制会话失联判定：心跳连续超时 → lost（E5）。
 * Cron 表达式解析复用 plan-executor 的 cronMatches（每日默认 02:00）。
 */
import { rmSync } from "node:fs";
import path from "node:path";
import { getDb } from "../db/connection.js";
import { getSystemConfig, updateRecordSession } from "../db/dao/configs.js";
import { RECORD_HEARTBEATS } from "../routes/internal.routes.js";
import { BASE_DIR, ARTIFACTS_DIR, UPLOADS_TMP_DIR } from "../paths.js";
import { cronMatches } from "./plan-executor.js";
import { logger } from "../logging.js";

export interface RetentionStats {
  deletedReports: number;
  deletedExecutions: number;
  deletedUploads: number;
  lostRecordSessions: number;
}

/** 心跳失联阈值（ms）：超过即判 lost */
const RECORD_LOST_TIMEOUT_MS = 15_000;

/** 执行一次完整清理（手动触发或定时） */
export function runRetentionCleanup(now = new Date()): RetentionStats {
  const db = getDb();
  const stats: RetentionStats = { deletedReports: 0, deletedExecutions: 0, deletedUploads: 0, lostRecordSessions: 0 };

  // ---- 1. 报告保留（级联 executions/logs + 产物） ----
  const retention = getSystemConfig<{ maxPerTask: number; maxAgeDays: number }>("report.retention", {
    maxPerTask: 100,
    maxAgeDays: 90,
  });
  const cutoff = new Date(now.getTime() - retention.maxAgeDays * 24 * 3600 * 1000).toISOString();

  // 1a. 按任务超量：每 task_id 保留最近 maxPerTask 份
  const taskIds = db.prepare("SELECT DISTINCT task_id FROM reports WHERE type = 'task' AND task_id IS NOT NULL").all() as Array<{ task_id: string }>;
  const overIds: string[] = [];
  for (const { task_id } of taskIds) {
    const rows = db
      .prepare("SELECT id FROM reports WHERE task_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?")
      .all(task_id, retention.maxPerTask) as Array<{ id: string }>;
    for (const r of rows) overIds.push(r.id);
  }
  // 1b. 按时间过期（含 plan 汇总报告，按 plan_id 分组同样限量）
  const agedRows = db.prepare("SELECT id FROM reports WHERE created_at < ?").all(cutoff) as Array<{ id: string }>;
  for (const r of agedRows) overIds.push(r.id);

  if (overIds.length) {
    const del = db.transaction(() => {
      let execs = 0;
      for (const id of new Set(overIds)) {
        const report = db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as Record<string, unknown> | undefined;
        if (!report) continue;
        // 级联 executions/logs（决策记录 #5）
        execs += db.prepare("DELETE FROM executions WHERE id = ?").run(Number(report["execution_id"] ?? 0)).changes;
        db.prepare("DELETE FROM reports WHERE id = ?").run(id);
        stats.deletedReports++;
        // 产物清理（导出文件；截图/视频目录随 execution 删除）
        removeArtifacts(report);
      }
      stats.deletedExecutions = execs;
    });
    del();
  }

  // ---- 2. 上传 TTL ----
  const expired = db.prepare("SELECT id, stored_path FROM uploads WHERE expires_at < ?").all(now.toISOString()) as Array<{ id: string; stored_path: string }>;
  for (const up of expired) {
    try {
      rmSync(path.join(UPLOADS_TMP_DIR, up.stored_path), { force: true });
    } catch {
      /* pass */
    }
    db.prepare("DELETE FROM uploads WHERE id = ?").run(up.id);
    stats.deletedUploads++;
  }

  // ---- 3. 录制会话失联判定（E5） ----
  const recording = db
    .prepare("SELECT id FROM record_sessions WHERE status IN ('recording','paused')")
    .all() as Array<{ id: number }>;
  for (const { id } of recording) {
    const last = RECORD_HEARTBEATS.get(id);
    if (last !== undefined && now.getTime() - last > RECORD_LOST_TIMEOUT_MS) {
      updateRecordSession(id, { status: "lost", error: "心跳超时，会话失联" });
      RECORD_HEARTBEATS.delete(id);
      stats.lostRecordSessions++;
    }
  }

  if (stats.deletedReports || stats.deletedUploads || stats.lostRecordSessions) {
    logger.info(
      "[retention] 清理完成：报告 %d / 迭代 %d / 过期上传 %d / 失联录制 %d",
      String(stats.deletedReports), String(stats.deletedExecutions), String(stats.deletedUploads), String(stats.lostRecordSessions),
    );
  }
  return stats;
}

/** 报告产物清理：导出文件 + execution 截图/视频目录 */
function removeArtifacts(report: Record<string, unknown>): void {
  try {
    if (report["html_path"]) rmSync(path.join(BASE_DIR, String(report["html_path"])), { force: true });
    if (report["pdf_path"]) rmSync(path.join(BASE_DIR, String(report["pdf_path"])), { force: true });
    if (report["execution_id"]) {
      rmSync(path.join(ARTIFACTS_DIR, "executions", String(report["execution_id"])), { recursive: true, force: true });
    }
  } catch {
    /* pass */
  }
}

// ---- 定时调度（report.cleanupCron，默认每日 02:00） ----

let timer: NodeJS.Timeout | null = null;
let lastRunDay = "";

/** 每分钟 tick：Cron 到点执行（同一自然日去重） */
export function cleanupTick(now = new Date()): void {
  const cron = getSystemConfig<string>("report.cleanupCron", "0 2 * * *");
  if (!cronMatches(cron, now)) return;
  const dayKey = now.toISOString().slice(0, 10);
  if (lastRunDay === dayKey) return;
  lastRunDay = dayKey;
  try {
    runRetentionCleanup(now);
  } catch (e) {
    logger.exception("[retention] 定时清理失败: %s", (e as Error).message);
  }
}

export function startRetentionScheduler(intervalMs = 60_000): NodeJS.Timeout {
  stopRetentionScheduler();
  timer = setInterval(() => cleanupTick(new Date()), intervalMs);
  return timer;
}

export function stopRetentionScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
