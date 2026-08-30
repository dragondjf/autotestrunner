/**
 * 执行引擎：task_run 驱动（迭代循环 / 重试退避 / 双通道执行 / 状态落库）。
 * 设计依据：docs/需求设计/数据库与API设计.md §4.1/§4.2、§5.2/§5.3。
 * 双通道：scriptLang=json → Runner /run（SSE 进度经 /internal 回调）；
 *         scriptLang=js/py → 本地子进程（script-executor）。
 * 不变式：全局串行（一次仅消费一个 run）；每次迭代一份报告；重试 attempt 递增。
 */
import { parseJsonField } from "../db/dao/common.js";
import { getTask } from "../db/dao/tasks.js";
import {
  appendExecutionLog,
  createExecution,
  createTaskRun,
  getExecution,
  getTaskRun,
  updateExecution,
  updateTaskRun,
  type TaskRunRow,
} from "../db/dao/runs.js";
import { updateTaskStatus } from "../db/dao/tasks.js";
import { dispatchRun, buildSuitePayload, stopExecution } from "./runner-client.js";
import { runScript } from "./script-executor.js";
import { finalizeExecutionFromProgress, handleStepProgress } from "./execution-progress.js";
import { logger } from "../logging.js";

/** 停止请求登记：runId -> true（run-engine 每次迭代前检查） */
const STOP_REQUESTS = new Set<string>();

export function requestStopRun(runId: string): void {
  STOP_REQUESTS.add(runId);
}

function isStopRequested(runId: string): boolean {
  return STOP_REQUESTS.has(runId);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 触发执行：创建 run 入队（TSK-06） */
export function enqueueRun(input: {
  taskId: string;
  triggerType?: "manual" | "plan" | "cron";
  planRunId?: string | null;
}): TaskRunRow {
  const task = getTask(input.taskId);
  if (!task) throw new Error("任务不存在");
  const scheduleConfig = parseJsonField<{ iterations?: number; durationMs?: number; intervalMs?: number }>(
    task.scheduleConfig,
    {},
  );
  const planned =
    task.scheduleMode === "count" ? (scheduleConfig.iterations ?? 1) : task.scheduleMode === "manual" ? 1 : null;
  const run = createTaskRun({
    taskId: task.id,
    planRunId: input.planRunId ?? null,
    triggerType: input.triggerType ?? "manual",
    scheduleMode: task.scheduleMode,
    plannedIterations: planned,
    loopDurationMs: task.scheduleMode === "time" ? (scheduleConfig.durationMs ?? null) : null,
    iterationIntervalMs: scheduleConfig.intervalMs ?? 0,
  });
  queueRun(run.id);
  return run;
}

// ---------------- 全局串行队列 ----------------

const QUEUE: string[] = [];
let consuming = false;

/** 队列状态查询（/api/config/queue/status 用） */
export function queueSnapshot(): { isRunning: boolean; currentRunId: string | null; queue: string[] } {
  return {
    isRunning: consuming,
    currentRunId: consuming ? (QUEUE[0] ?? null) : null,
    queue: consuming ? QUEUE.slice(1) : [...QUEUE],
  };
}

/** 队列位置（run 加入后未开始时） */
export function queuePosition(runId: string): number {
  const idx = QUEUE.indexOf(runId);
  return idx >= 0 ? idx + 1 : 0;
}

export function queueRun(runId: string): void {
  QUEUE.push(runId);
  void consumeLoop();
}

async function consumeLoop(): Promise<void> {
  if (consuming) return;
  consuming = true;
  try {
    while (QUEUE.length > 0) {
      const runId = QUEUE[0]!;
      try {
        await driveRun(runId);
      } catch (e) {
        logger.exception("[run-engine] run %s 执行异常: %s", runId, (e as Error).message);
        updateTaskRun(runId, { status: "error", endedAt: new Date().toISOString() });
        const task = getTaskRun(runId);
        if (task) updateTaskStatus(task.taskId, "failed");
      }
      QUEUE.shift();
    }
  } finally {
    consuming = false;
  }
}

// ---------------- run 驱动 ----------------

async function driveRun(runId: string): Promise<void> {
  const run = getTaskRun(runId);
  if (!run) return;
  const task = getTask(run.taskId);
  if (!task) {
    updateTaskRun(runId, { status: "error", endedAt: new Date().toISOString() });
    return;
  }

  const startedAt = new Date().toISOString();
  updateTaskRun(runId, { status: "running", startedAt });
  updateTaskStatus(task.id, "running", startedAt);

  const maxIterations = run.plannedIterations ?? Number.POSITIVE_INFINITY;
  const deadline = run.loopDurationMs ? Date.now() + run.loopDurationMs : Number.POSITIVE_INFINITY;
  let iteration = 0;
  let success = 0;
  let failed = 0;

  while (iteration < maxIterations && Date.now() < deadline) {
    if (isStopRequested(runId)) break;
    iteration++;
    updateTaskRun(runId, { currentIteration: iteration });

    const exec = createExecution({ runId, taskId: task.id, iterationIndex: iteration });
    const result = await runIterationWithRetry(exec.id, task.id, task.maxRetries);

    if (result.status === "success") success++;
    else if (result.status === "stopped") {
      // 停止：当前迭代已终态，跳出循环
      failed += result.countsAsFailure ? 0 : 0;
      break;
    } else failed++;

    updateTaskRun(runId, {
      completedIterations: iteration,
      successCount: success,
      failedCount: failed,
    });

    // 迭代间隔（最后一轮不等待）
    const isLast = iteration >= maxIterations || Date.now() >= deadline;
    if (!isLast && run.iterationIntervalMs > 0) {
      appendExecutionLog({ executionId: exec.id, message: `等待 ${run.iterationIntervalMs}ms 后开始下一迭代` });
      await sleep(run.iterationIntervalMs);
    }
  }

  const stopped = isStopRequested(runId);
  STOP_REQUESTS.delete(runId);
  const endedAt = new Date().toISOString();
  updateTaskRun(runId, {
    status: stopped ? "stopped" : "completed",
    endedAt,
    completedIterations: iteration,
    successCount: success,
    failedCount: failed,
  });
  // 任务终态 = 最后一次迭代结果
  const finalStatus = stopped ? "stopped" : failed > 0 ? "failed" : "success";
  updateTaskStatus(task.id, finalStatus as "success" | "failed" | "stopped", endedAt);
}

interface IterationResult {
  status: "success" | "failed" | "stopped";
  countsAsFailure: boolean;
}

/** 单迭代：失败重试（指数退避 1000*2^n），每次 attempt 更新同一条 execution 行 */
async function runIterationWithRetry(executionId: number, taskId: string, maxRetries: number): Promise<IterationResult> {
  const task = getTask(taskId)!;
  const total = maxRetries + 1;
  let lastError = "";

  for (let attempt = 0; attempt < total; attempt++) {
    const stopRequested = isStopRequested((getExecution(executionId)!.runId));
    if (stopRequested && attempt > 0) break;

    const startedAt = new Date().toISOString();
    updateExecution(executionId, {
      status: "running",
      attempt,
      startedAt,
      endedAt: null,
      durationMs: null,
      error: null,
    });
    appendExecutionLog({
      executionId,
      message: `迭代开始（第 ${attempt + 1}/${total} 次尝试）`,
      event: "status",
    });
    if (attempt > 0) updateTaskStatus(taskId, "retrying");

    const params = parseJsonField<Record<string, unknown>>(task.params, {});
    const outcome =
      task.scriptLang === "json"
        ? await runViaRunner(executionId, task.id, task.name, task.scriptSnapshot, params)
        : await runViaSubprocess(executionId, task.scriptSnapshot, task.scriptLang, params, task.id);

    if (outcome.ok) {
      const endedAt = new Date().toISOString();
      updateExecution(executionId, { status: "success", endedAt, durationMs: Date.now() - Date.parse(startedAt) });
      finalizeExecutionFromProgress(executionId, "success");
      appendExecutionLog({ executionId, level: "ok", message: "迭代成功", event: "status" });
      return { status: "success", countsAsFailure: false };
    }

    lastError = outcome.error ?? "未知错误";
    const stopped = isStopRequested(getExecution(executionId)!.runId);
    if (stopped) {
      const endedAt = new Date().toISOString();
      updateExecution(executionId, { status: "stopped", endedAt, durationMs: Date.now() - Date.parse(startedAt), error: lastError });
      finalizeExecutionFromProgress(executionId, "stopped", lastError);
      appendExecutionLog({ executionId, level: "warn", message: `迭代被停止: ${lastError}`, event: "status" });
      return { status: "stopped", countsAsFailure: false };
    }

    if (attempt < total - 1) {
      const backoff = 1000 * 2 ** attempt;
      updateExecution(executionId, { status: "retrying", error: lastError });
      appendExecutionLog({
        executionId,
        level: "warn",
        message: `尝试 ${attempt + 1}/${total} 失败: ${lastError}；${backoff}ms 后重试`,
        event: "status",
      });
      await sleep(backoff);
    }
  }

  // 重试耗尽 → failed + 失败报告
  const endedAt = new Date().toISOString();
  const exec = getExecution(executionId)!;
  updateExecution(executionId, { status: "failed", endedAt, durationMs: Date.now() - Date.parse(exec.startedAt ?? endedAt), error: lastError });
  finalizeExecutionFromProgress(executionId, "failed", lastError);
  appendExecutionLog({ executionId, level: "error", message: `重试耗尽，迭代失败: ${lastError}`, event: "status" });
  return { status: "failed", countsAsFailure: true };
}

// ---------------- 双通道 ----------------

async function runViaRunner(
  executionId: number,
  taskId: string,
  taskName: string,
  scriptSnapshot: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const steps = parseSteps(scriptSnapshot);
  if (!steps.length) return { ok: false, error: "脚本快照为空或不含步骤" };
  const payload = buildSuitePayload({
    executionId,
    runId: getExecution(executionId)!.runId,
    taskName,
    steps,
    env: params,
  });
  try {
    await dispatchRun(payload);
    // Runner 异步执行；完成信号经 /internal/runner/progress 回调。
    // 等待终态：轮询 execution 行状态（由回调更新）或超时保护。
    return await waitExecutionTerminal(executionId);
  } catch (e) {
    return { ok: false, error: `Runner 派发失败: ${(e as Error).message}` };
  }
}

/** 解析快照为 RunnerStep[]（兼容 {steps:[...]} 与裸数组） */
function parseSteps(snapshot: string): Array<Record<string, unknown>> {
  const parsed = parseJsonField<unknown>(snapshot, null);
  if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { steps?: unknown[] }).steps)) {
    return (parsed as { steps: Array<Record<string, unknown>> }).steps;
  }
  return [];
}

const EXECUTION_TIMEOUT_MS = 30 * 60 * 1000; // 单迭代 30 分钟兜底

async function waitExecutionTerminal(executionId: number): Promise<{ ok: boolean; error?: string }> {
  const start = Date.now();
  while (Date.now() - start < EXECUTION_TIMEOUT_MS) {
    await sleep(500);
    const exec = getExecution(executionId);
    if (!exec) return { ok: false, error: "执行记录丢失" };
    if (exec.status === "success") return { ok: true };
    if (exec.status === "failed") return { ok: false, error: exec.error ?? "执行失败" };
    if (exec.status === "stopped") return { ok: false, error: exec.error ?? "已停止" };
    // running / retrying → 继续等待（终态由 internal 回调写入）
  }
  await stopExecution(executionId);
  return { ok: false, error: "执行超时（30 分钟）" };
}

async function runViaSubprocess(
  executionId: number,
  scriptSnapshot: string,
  lang: "js" | "py",
  params: Record<string, unknown>,
  taskId: string,
): Promise<{ ok: boolean; error?: string }> {
  const result = await runScript(scriptSnapshot, lang, params, {
    onLog: (level, text) => appendExecutionLog({ executionId, level, message: text }),
  });
  // 收集脚本自动截图 → 落盘 artifacts/executions/{id}/screenshots/ → 写日志事件
  try {
    if (result.screenshots?.length) {
      const { mkdirSync, copyFileSync, rmSync } = await import("node:fs");
      const pathMod = await import("node:path");
      const { ARTIFACTS_DIR } = await import("../paths.js");
      const dir = pathMod.join(ARTIFACTS_DIR, "executions", String(executionId), "screenshots");
      mkdirSync(dir, { recursive: true });
      result.screenshots.forEach((src, i) => {
        const name = pathMod.basename(src);
        try {
          copyFileSync(src, pathMod.join(dir, name));
          appendExecutionLog({
            executionId,
            event: "screenshot",
            message: `step_${String(i + 1).padStart(2, "0")}`,
            payload: { screenshotPath: `artifacts/executions/${executionId}/screenshots/${name}` },
          });
        } catch {
          /* 单张失败忽略 */
        }
      });
    }
  } finally {
    // 清理执行器临时目录（截图已复制）
    if (result.tmpDir) {
      try {
        const { rmSync } = await import("node:fs");
        rmSync(result.tmpDir, { recursive: true, force: true });
      } catch {
        /* pass */
      }
    }
  }
  if (result.ok) {
    // 脚本通道无步骤回调：日志即证据，生成无步骤报告
    finalizeExecutionFromProgress(executionId, "success");
    return { ok: true };
  }
  return { ok: false, error: result.error };
}

/** internal 回调联动：case_end/case_status/case_stop 写终态（Runner 通道） */
export function markExecutionTerminalFromCallback(
  executionId: number,
  status: "success" | "failed" | "stopped",
  error?: string,
): void {
  const endedAt = new Date().toISOString();
  const exec = getExecution(executionId);
  if (!exec || ["success", "failed", "stopped"].includes(exec.status)) return; // 幂等
  updateExecution(executionId, { status, endedAt, error: error ?? exec.error });
  appendExecutionLog({ executionId, level: status === "success" ? "ok" : "error", message: `Runner 回调终态: ${status}${error ? ` (${error})` : ""}`, event: "status" });
  if (status !== "success") finalizeExecutionFromProgress(executionId, status, error);
  else finalizeExecutionFromProgress(executionId, "success");
}
