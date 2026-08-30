/**
 * 计划执行器：按 plan_tasks 顺序串行编排（单任务失败继续 PLN-05-2），
 * 暂停=编排冻结（当前任务跑完不再启动下一个，决策记录 #2），
 * 完成后生成 type=plan 汇总报告。
 * Cron 定时触发：每分钟 tick 解析各计划表达式（PLN-06，E8 拦截叠加）。
 */
import { createPlanRun, getPlan, getPlanRun, listPlanTasks, updatePlanRun, updatePlanStatus } from "../db/dao/plans.js";
import { createReport } from "../db/dao/reports.js";
import { getTaskRun } from "../db/dao/runs.js";
import { getTask } from "../db/dao/tasks.js";
import { enqueueRun } from "./run-engine.js";
import { getDb } from "../db/connection.js";
import { logger } from "../logging.js";

/** plan_run_id -> 编排控制 */
interface PlanControl {
  paused: boolean;
  stopped: boolean;
  nextTaskIndex: number;
  taskIds: string[];
  taskResults: Array<{ taskId: string; name: string; status: string; runId: string; durationMs: number | null }>;
}

const ACTIVE = new Map<string, PlanControl>();

export function getPlanControl(planRunId: string): PlanControl | null {
  return ACTIVE.get(planRunId) ?? null;
}

/** 触发计划执行（PLN-05）；执行中重复触发由路由层拦截（30002） */
export function startPlanRun(planId: string, triggerType: "manual" | "cron" = "manual"): string {
  const plan = getPlan(planId);
  if (!plan) throw new Error("计划不存在");
  const refs = listPlanTasks(planId);
  if (!refs.length) throw new Error("计划无任务");
  const planRun = createPlanRun(planId, triggerType);
  updatePlanStatus(planId, "running", new Date().toISOString());
  ACTIVE.set(planRun.id, {
    paused: false,
    stopped: false,
    nextTaskIndex: 0,
    taskIds: refs.map((r) => r.taskId),
    taskResults: [],
  });
  void drivePlanRun(planRun.id);
  return planRun.id;
}

/** 暂停：当前任务跑完后不再启动下一个（PLN-05b） */
export function pausePlanRun(planRunId: string): boolean {
  const ctrl = ACTIVE.get(planRunId);
  if (!ctrl) return false;
  ctrl.paused = true;
  const row = getPlanRun(planRunId);
  if (row) {
    updatePlanRun(planRunId, { status: "paused" });
    updatePlanStatus(row.planId, "paused");
  }
  return true;
}

/** 恢复：从断点任务继续 */
export function resumePlanRun(planRunId: string): boolean {
  const ctrl = ACTIVE.get(planRunId);
  if (!ctrl || !ctrl.paused) return false;
  ctrl.paused = false;
  const row = getPlanRun(planRunId);
  if (row) {
    updatePlanRun(planRunId, { status: "running" });
    updatePlanStatus(row.planId, "running");
  }
  return true;
}

/** 停止（计划删除前兜底） */
export function stopPlanRun(planRunId: string): void {
  const ctrl = ACTIVE.get(planRunId);
  if (ctrl) ctrl.stopped = true;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function drivePlanRun(planRunId: string): Promise<void> {
  const ctrl = ACTIVE.get(planRunId)!;
  const planRun = getPlanRun(planRunId)!;
  const plan = getPlan(planRun.planId)!;

  while (ctrl.nextTaskIndex < ctrl.taskIds.length) {
    if (ctrl.stopped) break;
    if (ctrl.paused) {
      await sleep(1000);
      continue;
    }
    const taskId = ctrl.taskIds[ctrl.nextTaskIndex]!;
    const taskRun = enqueueRun({ taskId, triggerType: "plan", planRunId });
    // 等待该 run 终态（全局队列串行保证）
    await waitRunTerminal(taskRun.id);

    // 任务成败按迭代结果判定：run.completed 只是"跑完"（容错模式，含失败迭代）
    const finalRun = getTaskRun(taskRun.id);
    const taskOutcome =
      finalRun?.status === "completed"
        ? finalRun.failedCount > 0
          ? "failed"
          : "success"
        : finalRun?.status === "stopped"
          ? "stopped"
          : "error";
    ctrl.taskResults.push({
      taskId,
      name: getTask(taskId)?.name ?? "(已删除)",
      status: taskOutcome,
      runId: taskRun.id,
      durationMs: null,
    });
    ctrl.nextTaskIndex++;
    // 单任务失败继续下一个（PLN-05-2）
  }

  // 汇总报告（taskResults.status 已是 success/failed/stopped/error 语义）
  const allDone = ctrl.nextTaskIndex >= ctrl.taskIds.length;
  const anyFailed = ctrl.taskResults.some((r) => r.status !== "success");
  const finalStatus = ctrl.stopped ? "stopped" : anyFailed ? "failed" : "completed";
  const summary = createReport({
    type: "plan",
    planId: plan.id,
    planRunId,
    name: plan.name,
    status: finalStatus === "completed" ? "success" : finalStatus === "stopped" ? "stopped" : "failed",
    totalSteps: ctrl.taskIds.length,
    passedSteps: ctrl.taskResults.filter((r) => r.status === "success").length,
    failedSteps: ctrl.taskResults.filter((r) => r.status !== "success").length,
    taskResults: ctrl.taskResults,
    startedAt: planRun.startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - Date.parse(planRun.startedAt ?? new Date().toISOString()),
    errorMessage: anyFailed ? `${ctrl.taskResults.filter((r) => r.status !== "success").length} 个任务未成功` : null,
  });
  void allDone;
  updatePlanRun(planRunId, { status: finalStatus, endedAt: new Date().toISOString(), summaryReportId: summary.id });
  updatePlanStatus(plan.id, finalStatus, new Date().toISOString());
  ACTIVE.delete(planRunId);
  logger.info("[plan] 计划 %s 执行完成: %s", plan.id, finalStatus);
}

async function waitRunTerminal(runId: string): Promise<void> {
  for (;;) {
    await sleep(500);
    const run = getTaskRun(runId);
    if (!run || !["queued", "running"].includes(run.status)) return;
  }
}

// ---------------- Cron 调度（PLN-06） ----------------

let cronTimer: NodeJS.Timeout | null = null;
/** 上次触发时间（防同一分钟重复触发） */
const lastFired = new Map<string, number>();

/** 简易 5 段 Cron 匹配：分 时 日 月 周（支持 * / - , 数字） */
export function cronMatches(expr: string, now: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const fields = [now.getMinutes(), now.getHours(), now.getDate(), now.getMonth() + 1, now.getDay()];
  return parts.every((p, i) => matchField(p, fields[i]!));
}

function matchField(field: string, value: number): boolean {
  if (field === "*") return true;
  return field.split(",").some((seg) => {
    const stepMatch = /^(\*|\d+(?:-\d+)?)\/(\d+)$/.exec(seg);
    if (stepMatch) {
      const step = Number(stepMatch[2]);
      const range = stepMatch[1] === "*" ? { from: 0, to: 59 } : parseRange(stepMatch[1]);
      return value >= range.from && value <= range.to && (value - range.from) % step === 0;
    }
    const range = parseRange(seg);
    return value >= range.from && value <= range.to;
  });
}

function parseRange(seg: string): { from: number; to: number } {
  const m = /^(\d+)-(\d+)$/.exec(seg);
  if (m) return { from: Number(m[1]), to: Number(m[2]) };
  const n = Number(seg);
  return { from: n, to: n };
}

/** Cron tick：扫描启用 Cron 的空闲计划，到点触发（执行中拦截 E8） */
export async function cronTick(): Promise<void> {
  const db = getDb();
  const plans = db
    .prepare("SELECT id, cron_expr FROM test_plans WHERE cron_expr IS NOT NULL AND cron_expr != '' AND status = 'idle'")
    .all() as Array<{ id: string; cron_expr: string }>;
  const now = new Date();
  const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
  for (const plan of plans) {
    if (!cronMatches(plan.cron_expr, now)) continue;
    const last = lastFired.get(plan.id);
    if (last && Date.now() - last < 60_000) continue; // 同分钟去重
    lastFired.set(plan.id, Date.now());
    try {
      startPlanRun(plan.id, "cron");
      logger.info("[cron] 计划 %s 定时触发 (%s)", plan.id, minuteKey);
    } catch (e) {
      logger.warning("[cron] 计划 %s 触发失败: %s", plan.id, (e as Error).message);
    }
  }
}

export function startCronScheduler(intervalMs = 60_000): NodeJS.Timeout {
  stopCronScheduler();
  cronTimer = setInterval(() => {
    void cronTick().catch(() => {});
  }, intervalMs);
  return cronTimer;
}

export function stopCronScheduler(): void {
  if (cronTimer) {
    clearInterval(cronTimer);
    cronTimer = null;
  }
}
