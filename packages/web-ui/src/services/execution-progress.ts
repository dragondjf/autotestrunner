/**
 * 执行域服务：截图/视频产物落盘 + 进度回调承接的共享写路径。
 * 设计依据：docs/需求设计/数据库与API设计.md §2.14（step_progress 处理）。
 * StepResult.screenshot 为 base64 PNG，解码落盘 artifacts/executions/{id}/screenshots/。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appendExecutionLog } from "../db/dao/runs.js";
import { addReportStep, createReport } from "../db/dao/reports.js";
import type { StepResult } from "@brickcore/shared";
import { getDb } from "../db/connection.js";
import { ARTIFACTS_DIR } from "../paths.js";

/** execution_id -> 运行中聚合状态（监控轮询缓存，回调快速应答） */
export interface ExecutionProgress {
  executionId: number;
  steps: Array<{
    stepIndex: number;
    method: string;
    description: string;
    status: string;
    error: string | null;
    durationMs: number | null;
    screenshotPath: string | null;
  }>;
  totalSteps: number;
  passed: number;
  failed: number;
  error: string | null;
}

const PROGRESS = new Map<number, ExecutionProgress>();

export function getProgress(executionId: number): ExecutionProgress | null {
  return PROGRESS.get(executionId) ?? null;
}

export function takeProgress(executionId: number): ExecutionProgress | null {
  const p = PROGRESS.get(executionId) ?? null;
  if (p) PROGRESS.delete(executionId);
  return p;
}

/** base64 截图落盘；返回相对 data/ 的路径或 null */
export function saveStepScreenshot(executionId: number, stepIndex: number, base64: string): string | null {
  try {
    const dir = path.join(ARTIFACTS_DIR, "executions", String(executionId), "screenshots");
    mkdirSync(dir, { recursive: true });
    const rel = `artifacts/executions/${executionId}/screenshots/step_${stepIndex}.png`;
    writeFileSync(path.join(ARTIFACTS_DIR, "executions", String(executionId), "screenshots", `step_${stepIndex}.png`), Buffer.from(base64, "base64"));
    return rel;
  } catch {
    return null;
  }
}

/** 处理 step_progress 回调：日志 + 截图 + 聚合缓存（幂等：重复 stepIndex 覆盖） */
export function handleStepProgress(executionId: number, stepResult: StepResult): void {
  const stepIndex = Number(stepResult.step_index ?? 0);
  const method = String(stepResult.method ?? "");
  const status = String(stepResult.status ?? "passed");
  const error = stepResult.error ?? null;
  const durationMs = stepResult.duration_ms ?? null;

  let screenshotPath: string | null = null;
  if (stepResult.screenshot) {
    screenshotPath = saveStepScreenshot(executionId, stepIndex, stepResult.screenshot);
    if (screenshotPath) {
      appendExecutionLog({
        executionId,
        event: "screenshot",
        message: `step_${stepIndex}`,
        payload: { screenshotPath },
      });
    }
  }

  appendExecutionLog({
    executionId,
    event: "step",
    level: status === "passed" ? "ok" : status === "failed" || status === "error" ? "error" : "info",
    message: `步骤 ${stepIndex} [${method}] ${status}${error ? `: ${error}` : ""}`,
    payload: { stepIndex, method, status, error, durationMs },
  });

  let progress = PROGRESS.get(executionId);
  if (!progress) {
    progress = { executionId, steps: [], totalSteps: 0, passed: 0, failed: 0, error: null };
    PROGRESS.set(executionId, progress);
  }
  // 覆盖同 stepIndex（重试/重放幂等）
  progress.steps = progress.steps.filter((s) => s.stepIndex !== stepIndex);
  progress.steps.push({
    stepIndex,
    method,
    description: method,
    status,
    error,
    durationMs,
    screenshotPath,
  });
  progress.steps.sort((a, b) => a.stepIndex - b.stepIndex);
  progress.totalSteps = progress.steps.length;
  progress.passed = progress.steps.filter((s) => s.status === "passed").length;
  progress.failed = progress.steps.filter((s) => s.status === "failed" || s.status === "error").length;
  if (error) progress.error = error;
}

/** case_end：从聚合缓存生成报告与 report_steps；脚本通道由 run-engine 直调 */
export function finalizeExecutionFromProgress(executionId: number, finalStatus: "success" | "failed" | "stopped", errorMessage?: string): string | null {
  const progress = takeProgress(executionId);
  // 已有报告（重复回调幂等）则返回既有
  const row = getDb().prepare("SELECT id FROM reports WHERE execution_id = ? LIMIT 1").get(executionId) as
    | { id: string }
    | undefined;
  if (row) return row.id;

  const exec = getDb().prepare("SELECT * FROM executions WHERE id = ?").get(executionId) as
    | Record<string, unknown>
    | undefined;
  if (!exec) return null;
  const taskRow = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(exec["task_id"]) as Record<string, unknown> | undefined;
  const reportName = String(taskRow?.["name"] ?? `执行 #${executionId}`);
  const total = progress?.totalSteps ?? 0;
  const passed = progress?.passed ?? 0;
  const failed = progress?.failed ?? 0;

  const status = finalStatus === "success" ? "success" : finalStatus === "stopped" ? "stopped" : "failed";
  const report = createReport({
    type: "task",
    taskId: String(exec["task_id"]),
    runId: String(exec["run_id"]),
    executionId,
    name: reportName,
    status,
    totalSteps: total,
    passedSteps: passed,
    failedSteps: failed,
    skippedSteps: 0,
    errorMessage: errorMessage ?? progress?.error ?? null,
    startedAt: (exec["started_at"] as string) ?? null,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - Date.parse(String(exec["started_at"] ?? new Date().toISOString())),
  });
  if (progress) {
    for (const s of progress.steps) {
      addReportStep({
        reportId: report.id,
        stepIndex: s.stepIndex,
        method: s.method,
        description: s.description,
        status: s.status as "passed" | "failed" | "error" | "skipped" | "stopped" | "pending",
        error: s.error,
        screenshotPath: s.screenshotPath,
        durationMs: s.durationMs,
        detail: {},
      });
    }
  }
  return report.id;
}
