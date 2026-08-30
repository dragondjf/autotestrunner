/**
 * 浏览器录制代理路由（/api/record/sessions）。
 * 设计依据：docs/需求设计/数据库与API设计.md §2.4（REC-B01）。
 * Backend 先落库建会话 → 调 Runner /record/start（注入心跳/结果回调 URL 与 X-Internal-Token）
 * → Runner 心跳/结果回调（internal.routes）刷新会话。to-project 把动作流转标准步骤流项目。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { Router } from "express";
import { readJsonBody, wrap } from "../http-error.js";
import { BIZ_CODES, BizError, bizErrors, created, ok } from "../api/respond.js";
import { createProject, getProjectByName } from "../db/dao/projects.js";
import { listRecordSessions, updateRecordSession } from "../db/dao/configs.js";
import { getDb } from "../db/connection.js";
import { registerRecordSession } from "./internal.routes.js";
import { backendPublicUrl, runnerUrl } from "../services/runner-client.js";
import { generatePlaywrightJs, type RecordedStep } from "../services/script-generator.js";
import { recordScriptRun } from "../services/script-run-recorder.js";
import { RECORD_SESSIONS_DIR } from "../paths.js";
import { ensureMigrated } from "../db/ensure.js";
import { getProject, updateProject } from "../db/dao/projects.js";

export const recordRouter: Router = Router();

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY ?? "brickcore-internal-2026";

/** Runner 录制代理转发（Runner 不可达 → 50002，E3） */
async function runnerPost(p: string, body: unknown): Promise<Record<string, unknown>> {
  try {
    const resp = await fetch(`${runnerUrl()}${p}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    return (await resp.json()) as Record<string, unknown>;
  } catch (e) {
    throw new BizError(503, BIZ_CODES.RUNNER_UNREACHABLE, `Runner 不可达（${runnerUrl()}）: ${(e as Error).message}`);
  }
}

// POST /api/record/sessions —— 启动录制（代理 Runner /record/start）
recordRouter.post(
  "/api/record/sessions",
  wrap(async (req, res) => {
    ensureMigrated();
    const body = await readJsonBody(req);
    const url = String(body["url"] ?? "").trim();
    if (!url || !/^https?:\/\//i.test(url)) throw bizErrors.paramInvalid("url 必填且为合法 URL");

    const recordSessionId = registerRecordSession({
      projectId: body["projectId"] ? String(body["projectId"]) : null,
      url,
    });
    const result = await runnerPost("/record/start", {
      record_session_id: recordSessionId,
      url,
      description: String(body["description"] ?? ""),
      max_record_time: Number(body["maxRecordTime"] ?? 600),
      hover_delay_ms: Number(body["hoverDelayMs"] ?? 1000),
      recording_locator_strategy: String(body["locatorStrategy"] ?? "default"),
      callback: {
        callback_url: `${backendPublicUrl()}/internal/record/${recordSessionId}/result`,
        heartbeat_url: `${backendPublicUrl()}/internal/record/${recordSessionId}/heartbeat`,
        api_key: INTERNAL_API_KEY,
      },
    });
    if (result["ok"] !== true) {
      updateRecordSession(recordSessionId, { status: "failed", error: String(result["reason"] ?? "启动失败") });
      throw bizErrors.paramInvalid(`录制启动失败: ${String(result["reason"] ?? "未知原因")}`);
    }
    updateRecordSession(recordSessionId, { status: "recording", startedAt: new Date().toISOString() });
    created(res, {
      recordSessionId,
      status: "recording",
      startedAt: new Date().toISOString(),
    });
  }),
);

// POST /api/record/sessions/:id/control —— 暂停/恢复/清空（AC-B01-3）
recordRouter.post(
  "/api/record/sessions/:id/control",
  wrap(async (req, res) => {
    ensureMigrated();
    const id = Number.parseInt(req.params.id!, 10);
    const body = await readJsonBody(req);
    const action = String(body["action"] ?? "");
    if (!["pause", "resume", "clear"].includes(action)) {
      throw bizErrors.paramInvalid("action 必须为 pause/resume/clear");
    }
    const command = action === "pause" ? "pause" : action === "resume" ? "resume" : "clear";
    const result = await runnerPost(`/record/${id}/control`, { command });
    if (action === "clear") {
      // 重置动作计数并截断 actions.jsonl（由前端二次确认后触发）
      updateRecordSession(id, { actionsCount: 0 });
      try {
        getDb().prepare("UPDATE record_sessions SET actions_count = 0 WHERE id = ?").run(id);
      } catch {
        /* pass */
      }
    } else {
      updateRecordSession(id, { status: action === "pause" ? "paused" : "recording" });
    }
    ok(res, { recordSessionId: id, action, runnerResult: result });
  }),
);

// POST /api/record/sessions/:id/stop —— 停止（幂等，AC-B01-5）
recordRouter.post(
  "/api/record/sessions/:id/stop",
  wrap(async (req, res) => {
    ensureMigrated();
    const id = Number.parseInt(req.params.id!, 10);
    const row = getDb().prepare("SELECT status FROM record_sessions WHERE id = ?").get(id) as
      | { status: string }
      | undefined;
    if (!row) throw bizErrors.notFound("录制会话不存在");
    // 幂等：已终态直接返回
    if (["completed", "failed", "stopped", "lost"].includes(row.status)) {
      ok(res, { recordSessionId: id, status: row.status, alreadyStopped: true });
      return;
    }
    await runnerPost(`/record/${id}/stop`, {});
    // 终态由 Runner 结果回调写入；此处先置 stopped（回调兜底覆盖）
    updateRecordSession(id, { status: "stopped", endedAt: new Date().toISOString() });
    ok(res, { recordSessionId: id, status: "stopped" });
  }),
);

// GET /api/record/sessions —— 会话历史
recordRouter.get(
  "/api/record/sessions",
  wrap((_req, res) => {
    ensureMigrated();
    const sessions = listRecordSessions(50);
    ok(res, {
      list: sessions.map((s) => ({
        id: s.id,
        projectId: s.projectId,
        url: s.url,
        status: s.status,
        actionsCount: s.actionsCount,
        error: s.error,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        createdAt: s.createdAt,
      })),
    });
  }),
);

// GET /api/record/sessions/:id/actions —— 动作流（REC-B05）
recordRouter.get(
  "/api/record/sessions/:id/actions",
  wrap((req, res) => {
    ensureMigrated();
    const id = Number.parseInt(req.params.id!, 10);
    const row = getDb().prepare("SELECT * FROM record_sessions WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw bizErrors.notFound("录制会话不存在");
    let actions: unknown[] = [];
    const actionsPath = row["actions_path"] ? path.join(RECORD_SESSIONS_DIR, String(id), "actions.jsonl") : null;
    if (actionsPath) {
      try {
        actions = readFileSync(actionsPath, "utf-8")
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));
      } catch {
        actions = [];
      }
    }
    ok(res, { recordSessionId: id, status: row["status"], actionsCount: actions.length, actions });
  }),
);

// POST /api/record/sessions/:id/to-project —— 动作流 → 项目（REC-A08 同构）
recordRouter.post(
  "/api/record/sessions/:id/to-project",
  wrap(async (req, res) => {
    ensureMigrated();
    const id = Number.parseInt(req.params.id!, 10);
    const body = await readJsonBody(req);
    const name = String(body["name"] ?? "").trim();
    if (!name) throw bizErrors.paramInvalid("项目名称不能为空");
    if (getProjectByName(name)) throw bizErrors.alreadyExists(`项目名称已存在: ${name}`);

    const row = getDb().prepare("SELECT * FROM record_sessions WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw bizErrors.notFound("录制会话不存在");

    // 读动作流
    let actions: Array<Record<string, unknown>> = [];
    try {
      actions = readFileSync(path.join(RECORD_SESSIONS_DIR, String(id), "actions.jsonl"), "utf-8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch {
      throw bizErrors.paramInvalid("该会话无动作数据（未录制或已清空）");
    }
    if (!actions.length) throw bizErrors.paramInvalid("该会话无动作数据（未录制或已清空）");

    // 动作 → 标准步骤流（selector/candidates → locator）
    const steps = actions
      .filter((a) => String(a["action_type"] ?? "") !== "hover" || actions.length <= 50) // hover 噪音过滤（超长录制时）
      .map((a) => ({
        method: String(a["action_type"] ?? "unknown"),
        params: {
          value: a["value"],
          url: a["url"],
        },
        locator: a["selector"] ? { primary: String(a["selector"]) } : undefined,
        candidates: Array.isArray(a["candidates"]) ? a["candidates"] : undefined,
      }));

    // 自动生成可执行 Playwright JS 脚本（scriptLang=js；步骤流保留在 record_config 便于再编辑）
    const jsCode = generatePlaywrightJs(steps as unknown as RecordedStep[]);
    const project = createProject({
      name,
      description: String(body["description"] ?? `浏览器录制会话 #${id} 转换`),
      type: "browser",
      status: "ready",
      startUrl: String(row["url"] ?? ""),
      scriptContent: jsCode,
      scriptLang: "js",
      recordConfig: { steps }, // 原始步骤流留档（编辑/再生成用）
    });
    ok(res, {
      projectId: project.id,
      steps: steps.length,
      scriptLang: "js",
      scriptPreview: jsCode.slice(0, 500),
      warnings:
        steps.length < actions.length
          ? [`${actions.length - steps.length} 条 hover 事件被合并/丢弃`]
          : [],
    });
  }),
);

// POST /api/record/script-run —— 脚本回放录制视频（REC-B06）
recordRouter.post(
  "/api/record/script-run",
  wrap(async (req, res) => {
    ensureMigrated();
    const body = await readJsonBody(req);
    const projectId = String(body["projectId"] ?? "");
    const project = getProject(projectId);
    if (!project) throw bizErrors.notFound("项目不存在");
    const cfg = JSON.parse(project.recordConfig || "{}") as { steps?: RecordedStep[] };
    if (!Array.isArray(cfg.steps) || !cfg.steps.length) {
      throw bizErrors.paramInvalid("该项目无录制步骤流（无法回放录制）");
    }
    try {
      const result = await recordScriptRun(cfg.steps, project.startUrl);
      ok(res, {
        projectId,
        videoUrl: result.videoPath ? `/api/files/${result.videoPath}` : null,
        stepsCompleted: result.stepsCompleted,
        durationMs: result.durationMs,
      });
    } catch (e) {
      throw new BizError(500, BIZ_CODES.REPORT_GEN_FAILED, `视频录制失败: ${(e as Error).message}`);
    }
  }),
);

// POST /api/projects/:id/regenerate-script —— 步骤流重新生成 JS 脚本（编辑后再生成）
recordRouter.post(
  "/api/projects/:id/regenerate-script",
  wrap((req, res) => {
    ensureMigrated();
    const project = getProject(req.params.id!);
    if (!project) throw bizErrors.notFound("项目不存在");
    const cfg = JSON.parse(project.recordConfig || "{}") as { steps?: RecordedStep[] };
    if (!Array.isArray(cfg.steps) || !cfg.steps.length) {
      throw bizErrors.paramInvalid("该项目无录制步骤流（非录制转换项目或未录制）");
    }
    const jsCode = generatePlaywrightJs(cfg.steps);
    updateProject(project.id, { scriptContent: jsCode, scriptLang: "js" });
    ok(res, { projectId: project.id, scriptLang: "js", scriptPreview: jsCode.slice(0, 500) });
  }),
);
