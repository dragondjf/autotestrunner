/**
 * 内部回调路由（/internal/*，Runner → Backend）。
 * 设计依据：docs/需求设计/数据库与API设计.md §2.14（已按 Runner 真实契约修正）。
 * 双鉴权：执行进度 X-API-Key（env API_KEY）；录制/调试 X-Internal-Token（env INTERNAL_API_KEY）。
 * Runner 回调无重试 → 端点幂等且快速返回。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Router } from "express";
import type { Request } from "express";
import { readJsonBody, wrap } from "../http-error.js";
import { handleStepProgress, getProgress } from "../services/execution-progress.js";
import { markExecutionTerminalFromCallback } from "../services/run-engine.js";
import { appendExecutionLog, updateExecution } from "../db/dao/runs.js";
import { insertRecordSession, updateRecordSession } from "../db/dao/configs.js";
import { RECORD_SESSIONS_DIR } from "../paths.js";
import { logger } from "../logging.js";

export const internalRouter: Router = Router();

const RUNNER_API_KEY = process.env.API_KEY ?? "brickcore-runner-secret";
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY ?? "brickcore-internal-2026";

/** 鉴权中间件：按前缀校验不同 Header，失败 401（AC-B04-2） */
function requireToken(expected: string): (req: Request) => boolean {
  return (req: Request) => req.headers[expected === RUNNER_API_KEY ? "x-api-key" : "x-internal-token"] === expected;
}

const isRunner = requireToken(RUNNER_API_KEY);
const isInternal = requireToken(INTERNAL_API_KEY);

// POST /internal/runner/progress —— 执行进度（X-API-Key；report_url 与 progress_url 同 URL）
internalRouter.post(
  "/internal/runner/progress",
  wrap(async (req, res) => {
    if (!isRunner(req)) {
      res.status(401).json({ detail: "Unauthorized" });
      return;
    }
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const type = String(body["type"] ?? "");
    const executionId = Number(body["execution_id"] ?? 0);

    switch (type) {
      case "step_progress": {
        const stepResult = body["step_result"] as Record<string, unknown>;
        if (executionId && stepResult) handleStepProgress(executionId, stepResult as never);
        break;
      }
      case "case_start": {
        if (executionId) {
          updateExecution(executionId, { status: "running", startedAt: new Date().toISOString() });
          appendExecutionLog({ executionId, message: "Runner 开始执行", event: "status" });
        }
        break;
      }
      case "case_end": {
        if (executionId) {
          // 终态由 step 聚合判定：有 failed 步骤则 failed，否则 success
          const progress = getProgress(executionId);
          const status = progress && progress.failed > 0 ? "failed" : "success";
          markExecutionTerminalFromCallback(executionId, status, progress?.error ?? undefined);
        }
        break;
      }
      case "case_status": {
        if (executionId) {
          const status = String(body["status"] ?? "");
          if (["success", "failed", "stopped", "retrying"].includes(status)) {
            if (status === "retrying") updateExecution(executionId, { status: "retrying", error: body["error"] ? String(body["error"]) : undefined });
            else markExecutionTerminalFromCallback(executionId, status as "success" | "failed" | "stopped", body["error"] ? String(body["error"]) : undefined);
          }
        }
        break;
      }
      case "case_stop": {
        if (executionId) {
          markExecutionTerminalFromCallback(executionId, "stopped", String(body["reason"] ?? "runner stopped"));
        }
        break;
      }
      case "case_skip": {
        if (executionId) {
          markExecutionTerminalFromCallback(executionId, "stopped", "skipped");
        }
        break;
      }
      case "suite_start":
      case "suite_end":
      case "suite_error": {
        const suiteId = Number(body["suite_execution_id"] ?? 0);
        if (suiteId) {
          appendExecutionLog({
            executionId: suiteId,
            level: type === "suite_error" ? "error" : "info",
            message: type === "suite_error" ? `套件错误: ${String(body["error"] ?? "")}` : `套件事件: ${type}`,
            event: "status",
          });
          if (type === "suite_error") {
            markExecutionTerminalFromCallback(suiteId, "failed", String(body["error"] ?? "suite error"));
          }
        }
        break;
      }
      default:
        break;
    }
    // 快速 2xx 应答（Runner 5~10s 超时，无重试）
    res.json({ ok: true });
  }),
);

// POST /internal/record/:id/heartbeat —— 录制心跳（X-Internal-Token，每 1s）
internalRouter.post(
  "/internal/record/:id/heartbeat",
  wrap(async (req, res) => {
    if (!isInternal(req)) {
      res.status(401).json({ detail: "Unauthorized" });
      return;
    }
    const id = Number.parseInt(req.params.id!, 10);
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const actionsCount = Number(body["actions_count"] ?? 0);
    const paused = Boolean(body["paused"]);
    const frames = body["frames"] as { total?: number; listening?: number } | undefined;

    updateRecordSession(id, {
      status: paused ? "paused" : "recording",
      actionsCount,
    });
    // 录制进行中实时落盘动作流（raw_actions 全量覆盖），供前端时间线实时查询
    const rawActions = Array.isArray(body["raw_actions"]) ? (body["raw_actions"] as unknown[]) : [];
    if (rawActions.length && !paused) {
      try {
        const dir = path.join(RECORD_SESSIONS_DIR, String(id));
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          path.join(dir, "actions.jsonl"),
          rawActions.map((a) => JSON.stringify(a)).join("\n") + "\n",
          "utf-8",
        );
        updateRecordSession(id, { actionsPath: `record-sessions/${id}/actions.jsonl` });
      } catch {
        /* 落盘失败不影响心跳 */
      }
    }
    // 心跳超时判定数据：内存记录最后心跳时间（失联扫描由 GC 周期任务执行）
    RECORD_HEARTBEATS.set(id, Date.now());

    // 未监听 iframe 警告（AC-B01 边界）
    const warnings: string[] = [];
    if (frames && Number(frames.total ?? 0) > Number(frames.listening ?? 0)) {
      warnings.push(`有 ${Number(frames.total) - Number(frames.listening ?? 0)} 个 iframe 未监听，可能漏录`);
    }
    res.json({ ok: true, warnings });
  }),
);

export const RECORD_HEARTBEATS = new Map<number, number>();

// POST /internal/record/:id/result —— 录制结果（X-Internal-Token，一次性）
internalRouter.post(
  "/internal/record/:id/result",
  wrap(async (req, res) => {
    if (!isInternal(req)) {
      res.status(401).json({ detail: "Unauthorized" });
      return;
    }
    const id = Number.parseInt(req.params.id!, 10);
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const success = Boolean(body["success"]);
    const actions = Array.isArray(body["actions"]) ? body["actions"] : [];
    const error = body["error"] !== undefined ? String(body["error"]) : undefined;

    // 动作流落盘（全量覆盖：心跳已实时写入，此处以最终动作为准）
    const dir = path.join(RECORD_SESSIONS_DIR, String(id));
    mkdirSync(dir, { recursive: true });
    const actionsPath = `${dir}/actions.jsonl`;
    writeFileSync(
      actionsPath,
      actions.map((a) => JSON.stringify(a)).join("\n") + "\n",
      "utf-8",
    );

    updateRecordSession(id, {
      status: success ? "completed" : "failed",
      error: error ?? null,
      actionsCount: actions.length,
      actionsPath: `record-sessions/${id}/actions.jsonl`,
      endedAt: new Date().toISOString(),
    });
    RECORD_HEARTBEATS.delete(id);
    res.json({ ok: true });
  }),
);

// GET /internal/debug/command —— 调试命令轮询（X-Internal-Token，Runner 每 0.5s 拉取）
internalRouter.get(
  "/internal/debug/command",
  wrap((req, res) => {
    if (!isInternal(req)) {
      res.status(401).json({ detail: "Unauthorized" });
      return;
    }
    const debugSessionId = Number(req.query["debug_session_id"] ?? 0);
    const queue = DEBUG_COMMANDS.get(debugSessionId);
    const command = queue && queue.length > 0 ? queue.shift()! : null;
    res.json({ data: command });
  }),
);

// POST /internal/debug/callback —— 调试事件回报（X-Internal-Token）
internalRouter.post(
  "/internal/debug/callback",
  wrap(async (req, res) => {
    if (!isInternal(req)) {
      res.status(401).json({ detail: "Unauthorized" });
      return;
    }
    const body = (await readJsonBody(req)) as { event?: string; payload?: unknown; command_id?: string };
    // 事件透传：阶段三接 inspect WebSocket；此处记录日志即可
    logger.info("[debug] 事件 %s (command=%s)", String(body.event ?? ""), String(body.command_id ?? ""));
    res.json({ ok: true });
  }),
);

/** 调试命令队列（debug_session_id -> 待执行命令；由调试 API 写入） */
export const DEBUG_COMMANDS = new Map<number, Array<Record<string, unknown>>>();

/** 推入调试命令（供后续调试路由使用） */
export function pushDebugCommand(debugSessionId: number, command: Record<string, unknown>): void {
  let queue = DEBUG_COMMANDS.get(debugSessionId);
  if (!queue) {
    queue = [];
    DEBUG_COMMANDS.set(debugSessionId, queue);
  }
  queue.push(command);
}

/** 启动新录制会话登记（供录制代理路由使用） */
export function registerRecordSession(input: { projectId?: string | null; url?: string }): number {
  const row = insertRecordSession(input);
  RECORD_HEARTBEATS.set(row.id, Date.now());
  return row.id;
}
