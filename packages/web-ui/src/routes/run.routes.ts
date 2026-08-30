/**
 * 执行监控 API（/api/task-runs、/api/executions）。
 * 设计依据：docs/需求设计/数据库与API设计.md §2.8/§2.9（TSK-06/09/10）。
 * POST /api/tasks/:id/run 也在此挂载（执行引擎入口）。
 */
import { Router } from "express";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readJsonBody, wrap } from "../http-error.js";
import { BIZ_CODES, BizError, bizErrors, ok, parsePage } from "../api/respond.js";
import { getTask, updateTaskStatus } from "../db/dao/tasks.js";
import {
  countExecutionLogs,
  fetchExecutionLogs,
  getExecution,
  getTaskRun,
  listExecutionsByRun,
  listExecutionsByTask,
} from "../db/dao/runs.js";
import { getReport, listReportSteps } from "../db/dao/reports.js";
import { enqueueRun, requestStopRun, queuePosition, queueSnapshot } from "../services/run-engine.js";
import { stopExecution } from "../services/runner-client.js";
import { parseJsonField } from "../db/dao/common.js";
import { getDb } from "../db/connection.js";
import { ensureMigrated } from "../db/ensure.js";
import { RECORD_SESSIONS_DIR } from "../paths.js";

export const runRouter: Router = Router();

// POST /api/tasks/:id/run —— 触发执行（TSK-06）
runRouter.post(
  "/api/tasks/:id/run",
  wrap(async (req, res) => {
    ensureMigrated();
    const task = getTask(req.params.id!);
    if (!task) throw bizErrors.notFound("任务不存在");
    // 不变式：同一任务最多一个非终态 run（20003）
    const active = getDb()
      .prepare("SELECT id FROM task_runs WHERE task_id = ? AND status IN ('queued','running')")
      .get(task.id) as { id: string } | undefined;
    if (active) throw new BizError(409, BIZ_CODES.TASK_RUNNING, "任务执行中，禁止重复触发");

    const body = await readJsonBody(req).catch(() => ({}) as Record<string, unknown>);
    const run = enqueueRun({
      taskId: task.id,
      triggerType: (body["triggerType"] as "manual" | "plan" | "cron") ?? "manual",
    });
    const position = queuePosition(run.id);
    ok(
      res,
      {
        runId: run.id,
        queuePosition: position,
        scheduleMode: run.scheduleMode,
        plannedIterations: run.plannedIterations,
      },
      position <= 1 ? "任务已开始执行" : "任务已加入执行队列",
    );
  }),
);

// GET /api/task-runs/:runId —— 监控主视图（TSK-09）
runRouter.get(
  "/api/task-runs/:runId",
  wrap((req, res) => {
    ensureMigrated();
    const run = getTaskRun(req.params.runId!);
    if (!run) throw bizErrors.notFound("执行记录不存在");
    const task = getTask(run.taskId);
    const iterations = listExecutionsByRun(run.id, 20);
    const current = iterations.find((e) => !["success", "failed", "stopped"].includes(e.status)) ?? iterations[0] ?? null;
    const remainingMs = run.loopDurationMs && run.startedAt
      ? Math.max(0, Date.parse(run.startedAt) + run.loopDurationMs - Date.now())
      : null;

    ok(res, {
      runId: run.id,
      taskId: run.taskId,
      taskName: task?.name ?? null,
      status: run.status,
      triggerType: run.triggerType,
      planRunId: run.planRunId,
      scheduleMode: run.scheduleMode,
      currentIteration: run.currentIteration,
      plannedIterations: run.plannedIterations,
      remainingMs,
      completedIterations: run.completedIterations,
      successCount: run.successCount,
      failedCount: run.failedCount,
      queuePosition: queueSnapshot().queue.includes(run.id) ? queuePosition(run.id) : 0,
      currentExecutionId: current?.id ?? null,
      retry: current && current.attempt > 0 ? { attempt: current.attempt, maxRetries: task?.maxRetries ?? 0 } : null,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      // 已完成 run 的 elapsed 固定在执行时长（endedAt - startedAt），避免随时间增长
      elapsedMs: run.startedAt
        ? (run.endedAt ? Date.parse(run.endedAt) : Date.now()) - Date.parse(run.startedAt)
        : 0,
      iterations: iterations.map((e) => {
        const reportRow = getDb()
          .prepare("SELECT id FROM reports WHERE execution_id = ? LIMIT 1")
          .get(e.id) as { id: string } | undefined;
        return {
          executionId: e.id,
          iterationIndex: e.iterationIndex,
          attempt: e.attempt,
          status: e.status,
          error: e.error,
          startedAt: e.startedAt,
          endedAt: e.endedAt,
          durationMs: e.durationMs,
          reportId: reportRow?.id ?? null,
        };
      }),
    });
  }),
);

// GET /api/task-runs/:runId/logs —— 增量日志（executionId 缺省=当前迭代）
runRouter.get(
  "/api/task-runs/:runId/logs",
  wrap((req, res) => {
    ensureMigrated();
    const run = getTaskRun(req.params.runId!);
    if (!run) throw bizErrors.notFound("执行记录不存在");
    let executionId = Number(req.query["executionId"] ?? 0);
    if (!executionId) {
      const iterations = listExecutionsByRun(run.id, 1);
      executionId = iterations[0]?.id ?? 0;
    }
    if (!executionId) throw bizErrors.notFound("暂无执行迭代");
    const afterSeq = Number(req.query["afterSeq"] ?? 0) || 0;
    const limit = Math.min(500, Math.max(1, Number(req.query["limit"] ?? 200)));
    const result = fetchExecutionLogs(executionId, afterSeq, limit);
    ok(res, {
      executionId,
      nextSeq: result.nextSeq,
      hasMore: result.hasMore,
      logs: result.logs.map((l) => ({
        seq: l.seq,
        ts: l.ts,
        level: l.level,
        event: l.event,
        message: l.message,
        payload: parseJsonField<Record<string, unknown>>(l.payload, {}),
      })),
    });
  }),
);

// POST /api/task-runs/:runId/stop —— 停止执行（幂等；已产生历史保留）
runRouter.post(
  "/api/task-runs/:runId/stop",
  wrap(async (req, res) => {
    ensureMigrated();
    const run = getTaskRun(req.params.runId!);
    if (!run) throw bizErrors.notFound("执行记录不存在");
    if (["completed", "stopped", "error"].includes(run.status)) {
      // 幂等：已终态直接返回
      ok(res, { stopped: false, completedIterations: run.completedIterations, status: run.status }, "执行已结束");
      return;
    }
    requestStopRun(run.id);
    // 当前迭代若走 Runner 通道，立即通知停止
    const iterations = listExecutionsByRun(run.id, 1);
    if (iterations[0] && iterations[0].status === "running") {
      await stopExecution(iterations[0].id);
    }
    ok(res, { stopped: true, completedIterations: run.completedIterations }, "停止请求已发送");
  }),
);

// GET /api/task-runs/:runId/protocol —— 录制 json 协议步骤
// 来源：1) 任务快照为 json 协议（script_lang=json）直接解析；2) 任务关联项目最近一次录制会话 actions.jsonl
runRouter.get(
  "/api/task-runs/:runId/protocol",
  wrap((req, res) => {
    ensureMigrated();
    const run = getTaskRun(req.params.runId!);
    if (!run) throw bizErrors.notFound("执行记录不存在");
    const task = run.taskId ? getTask(run.taskId) : null;
    const projectId = task?.projectId ?? null;
    let steps: unknown[] = [];
    let sessionId: number | null = null;
    // 1) 任务快照本身为 json 协议
    if (task && task.scriptLang === "json" && task.scriptSnapshot) {
      try {
        const parsed = JSON.parse(task.scriptSnapshot);
        if (Array.isArray(parsed)) steps = parsed;
      } catch {
        /* 非法 json 忽略 */
      }
    }
    // 2) 项目关联的最近一次录制会话动作流
    if (!steps.length && projectId) {
      const row = getDb()
        .prepare(
          `SELECT id, actions_path FROM record_sessions
           WHERE project_id = ? AND status = 'completed'
           ORDER BY ended_at DESC LIMIT 1`,
        )
        .get(projectId) as { id: number; actions_path: string | null } | undefined;
      if (row?.actions_path) {
        try {
          const p = path.join(RECORD_SESSIONS_DIR, String(row.id), "actions.jsonl");
          if (existsSync(p)) {
            steps = readFileSync(p, "utf-8")
              .split(/\r?\n/)
              .filter(Boolean)
              .map((line) => {
                try {
                  return JSON.parse(line);
                } catch {
                  return null;
                }
              })
              .filter((s) => s !== null);
            sessionId = row.id;
          }
        } catch {
          /* 协议缺失忽略 */
        }
      }
    }
    ok(res, { runId: run.id, taskId: run.taskId, projectId, sessionId, steps });
  }),
);

// GET /api/executions/:id —— 迭代回放视图（TSK-10，布局与监控一致）
runRouter.get(
  "/api/executions/:id",
  wrap((req, res) => {
    ensureMigrated();
    const exec = getExecution(Number(req.params.id!));
    if (!exec) throw bizErrors.notFound("执行记录不存在");
    const run = getTaskRun(exec.runId);
    const task = getTask(exec.taskId);
    const report = getDbReport(exec.id);
    const logsCount = countExecutionLogs(exec.id);

    ok(res, {
      id: exec.id,
      runId: exec.runId,
      taskId: exec.taskId,
      taskName: task?.name ?? null,
      iterationIndex: exec.iterationIndex,
      attempt: exec.attempt,
      triggerType: run?.triggerType ?? "manual",
      planRunId: run?.planRunId ?? null,
      status: exec.status,
      error: exec.error,
      startedAt: exec.startedAt,
      endedAt: exec.endedAt,
      durationMs: exec.durationMs,
      reportId: report?.id ?? null,
      reportStatus: report?.status ?? null,
      steps: report ? listSteps(report.id) : [],
      logCount: logsCount,
      logNextSeq: logsCount,
      videoUrl: report?.videoPath ? `/api/files/${report.videoPath}` : null,
    });
  }),
);

// GET /api/executions/:id/logs —— 回放增量日志
runRouter.get(
  "/api/executions/:id/logs",
  wrap((req, res) => {
    ensureMigrated();
    const exec = getExecution(Number(req.params.id!));
    if (!exec) throw bizErrors.notFound("执行记录不存在");
    const afterSeq = Number(req.query["afterSeq"] ?? 0) || 0;
    const limit = Math.min(500, Math.max(1, Number(req.query["limit"] ?? 200)));
    const result = fetchExecutionLogs(exec.id, afterSeq, limit);
    ok(res, {
      executionId: exec.id,
      nextSeq: result.nextSeq,
      hasMore: result.hasMore,
      logs: result.logs.map((l) => ({
        seq: l.seq,
        ts: l.ts,
        level: l.level,
        event: l.event,
        message: l.message,
        payload: parseJsonField<Record<string, unknown>>(l.payload, {}),
      })),
    });
  }),
);

// ---------------- 内部辅助 ----------------

function getDbReport(executionId: number) {
  const row = getDb().prepare("SELECT id FROM reports WHERE execution_id = ? LIMIT 1").get(executionId) as
    | { id: string }
    | undefined;
  return row ? getReport(row.id) : null;
}

function listSteps(reportId: string) {
  const steps = listReportSteps(reportId, 1, 200);
  return steps.list.map((s) => ({
    stepIndex: s.stepIndex,
    method: s.method,
    description: s.description,
    status: s.status,
    durationMs: s.durationMs,
    screenshotUrl: s.screenshotPath ? `/api/files/${s.screenshotPath}` : null,
  }));
}
