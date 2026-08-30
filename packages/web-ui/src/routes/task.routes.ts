/**
 * 测试任务路由（/api/tasks）。
 * 设计依据：docs/需求设计/数据库与API设计.md §2.7（TSK-01~05、10）。
 * 4 步向导聚合提交：快照复制 / 上传转正 / params 校验 / 调度合法性；
 * POST /:id/run 与监控端点属阶段二（执行引擎），本轮不挂载。
 */
import { readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { Router } from "express";
import { readJsonBody, wrap } from "../http-error.js";
import { bizErrors, created, ok, parsePage } from "../api/respond.js";
import {
  addTaskFile,
  createTask,
  deleteTask,
  getTask,
  getUpload,
  deleteUpload,
  listTasks,
  taskHasActiveRun,
  updateTask,
  listTaskFiles,
  type BrowserType,
  type ScheduleMode,
} from "../db/dao/tasks.js";
import { listExecutionsByTask } from "../db/dao/runs.js";
import { getProject, projectParamsSchema } from "../db/dao/projects.js";
import { parseJsonField } from "../db/dao/common.js";
import { getDb } from "../db/connection.js";
import { ensureMigrated } from "../db/ensure.js";
import { TASK_FILES_DIR, UPLOADS_TMP_DIR } from "../paths.js";

export const taskRouter: Router = Router();

const BROWSER_TYPES: BrowserType[] = ["chromium", "firefox", "webkit"];
const SCHEDULE_MODES: ScheduleMode[] = ["manual", "time", "count"];

/** 调度配置校验（AC-TSK-08 / 20005） */
function assertSchedule(schedule: unknown): { mode: ScheduleMode; config: Record<string, unknown> } {
  if (typeof schedule !== "object" || schedule === null) {
    throw bizErrors.scheduleInvalid("schedule 必须为对象");
  }
  const s = schedule as Record<string, unknown>;
  const mode = s["mode"] as ScheduleMode;
  if (!SCHEDULE_MODES.includes(mode)) throw bizErrors.scheduleInvalid("schedule.mode 必须为 manual/time/count");
  if (mode === "time") {
    const durationMs = Number(s["durationMs"] ?? 0);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw bizErrors.scheduleInvalid("按时间循环必须配置 durationMs（毫秒，> 0）");
    }
    return { mode, config: { durationMs } };
  }
  if (mode === "count") {
    const iterations = Number(s["iterations"] ?? 0);
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10000) {
      throw bizErrors.scheduleInvalid("按次数循环必须配置 iterations（1~10000）");
    }
    const intervalMs = Number(s["intervalMs"] ?? 0);
    if (!Number.isFinite(intervalMs) || intervalMs < 0) {
      throw bizErrors.scheduleInvalid("intervalMs 必须为非负数");
    }
    return { mode, config: { iterations, intervalMs } };
  }
  return { mode: "manual", config: {} };
}

/** params 对 paramsSchema 的必填校验（REC-C02 边界） */
function assertParams(params: unknown, schema: Record<string, unknown>): void {
  if (typeof params === "undefined" || params === null) return;
  if (typeof params !== "object" || Array.isArray(params)) {
    throw bizErrors.paramInvalid("params 必须为对象");
  }
  const props = (schema["properties"] ?? {}) as Record<string, { required?: boolean; type?: string }>;
  const required = (schema["required"] ?? []) as string[];
  for (const key of required) {
    const v = (params as Record<string, unknown>)[key];
    if (v === undefined || v === null || v === "") {
      throw bizErrors.paramInvalid(`缺少必填参数: ${key}`);
    }
  }
  for (const key of Object.keys(params as Record<string, unknown>)) {
    if (!(key in props) && Object.keys(props).length > 0) {
      // schema 定义了 properties 时校验未知键（宽松：仅提示性校验，不拦截扩展）
      continue;
    }
  }
}

// GET /api/tasks —— 列表
taskRouter.get(
  "/api/tasks",
  wrap((req, res) => {
    ensureMigrated();
    const { page, pageSize } = parsePage(req.query as Record<string, unknown>);
    const browserType = req.query["browserType"] as BrowserType | undefined;
    if (browserType !== undefined && !BROWSER_TYPES.includes(browserType)) {
      throw bizErrors.paramInvalid("browserType 必须为 chromium/firefox/webkit");
    }
    const result = listTasks({
      page,
      pageSize,
      projectId: req.query["projectId"] as string | undefined,
      status: req.query["status"] as never,
      browserType,
      keyword: req.query["keyword"] as string | undefined,
    });
    ok(res, {
      list: result.list.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        projectId: t.projectId,
        projectName: t.projectId ? getProject(t.projectId)?.name ?? null : null,
        scriptSource: t.scriptSource,
        scriptLang: t.scriptLang,
        browserType: t.browserType,
        scheduleMode: t.scheduleMode,
        status: t.status,
        lastRunAt: t.lastRunAt,
        createdAt: t.createdAt,
      })),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  }),
);

// POST /api/tasks —— 4 步向导聚合提交
taskRouter.post(
  "/api/tasks",
  wrap(async (req, res) => {
    ensureMigrated();
    const body = await readJsonBody(req);

    // Step 1 基本信息
    const name = String(body["name"] ?? "").trim();
    if (!name) throw bizErrors.paramInvalid("任务名称不能为空");

    // Step 2 脚本与资源
    const scriptSource = body["scriptSource"] === "upload" ? "upload" : "project";
    let scriptSnapshot = "";
    let scriptLang = "json" as "json" | "js" | "py";
    let projectId: string | null = null;
    const warnings: string[] = [];

    if (scriptSource === "project") {
      projectId = String(body["projectId"] ?? "");
      if (!projectId) throw bizErrors.paramInvalid("scriptSource=project 时 projectId 必填");
      const project = getProject(projectId);
      if (!project) throw bizErrors.notFound("关联项目不存在");
      if (project.status === "archived") throw bizErrors.paramInvalid("已归档项目不可创建任务");
      scriptSnapshot = project.scriptContent;
      scriptLang = project.scriptLang;
    } else {
      const scriptUploadId = String(body["scriptUploadId"] ?? "");
      if (!scriptUploadId) throw bizErrors.paramInvalid("scriptSource=upload 时 scriptUploadId 必填");
      const upload = getUpload(scriptUploadId);
      if (!upload) throw bizErrors.uploadMissing(`上传文件不存在: ${scriptUploadId}`);
      const ext = path.extname(upload.filename).toLowerCase();
      scriptLang = ext === ".py" ? "py" : "js";
      const filePath = path.join(UPLOADS_TMP_DIR, upload.storedPath);
      if (!existsSync(filePath)) throw bizErrors.uploadMissing(`上传文件已过期: ${upload.filename}`);
      scriptSnapshot = readFileSync(filePath, "utf-8");
    }

    // params 校验（来自项目 paramsSchema）
    const project = projectId ? getProject(projectId) : null;
    if (project) assertParams(body["params"], projectParamsSchema(project));

    // Step 3 调度
    const schedule = assertSchedule(body["schedule"] ?? { mode: "manual" });
    const browserType = (body["browserType"] ?? "chromium") as BrowserType;
    if (!BROWSER_TYPES.includes(browserType)) throw bizErrors.paramInvalid("browserType 必须为 chromium/firefox/webkit");
    const maxRetries = body["maxRetries"] === undefined ? 3 : Number(body["maxRetries"]);
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
      throw bizErrors.paramInvalid("maxRetries 必须为 0~10 的整数");
    }

    const task = createTask({
      name,
      description: String(body["description"] ?? ""),
      projectId,
      scriptSource,
      scriptSnapshot,
      scriptLang,
      browserType,
      browserPath: String(body["browserPath"] ?? ""),
      params: body["params"] ?? {},
      maxRetries,
      scheduleMode: schedule.mode,
      scheduleConfig: schedule.config,
    });

    // 上传转正：脚本 + 资源 移入 task-files/{taskId}/
    const resourceUploadIds = Array.isArray(body["resourceUploadIds"]) ? (body["resourceUploadIds"] as string[]) : [];
    let resourceCount = 0;
    const promoteTx = getDb().transaction(() => {
      if (scriptSource === "upload") {
        const upload = getUpload(String(body["scriptUploadId"]))!;
        promoteUpload(upload.id, task.id, "script");
      }
      for (const uplId of resourceUploadIds) {
        const upload = getUpload(uplId);
        if (!upload) throw bizErrors.uploadMissing(`资源上传不存在: ${uplId}`);
        promoteUpload(upload.id, task.id, "resource");
        resourceCount++;
      }
    });
    promoteTx();

    // Step 4 确认：executeNow 阶段二实现（执行引擎），本轮提示
    if (body["executeNow"] === true) {
      warnings.push("executeNow 将在执行引擎上线后生效（阶段二），当前仅保存任务");
    }

    created(res, {
      id: task.id,
      status: task.status,
      scriptLang: task.scriptLang,
      snapshotBytes: Buffer.byteLength(task.scriptSnapshot, "utf-8"),
      resourceCount,
      scheduleMode: task.scheduleMode,
      warnings,
    });
  }),
);

/** 上传转正：uploads → task-files/{taskId}/{kind}/，写 task_files，删 uploads 行 */
function promoteUpload(uploadId: string, taskId: string, kind: "script" | "resource"): void {
  const upload = getUpload(uploadId);
  if (!upload) throw bizErrors.uploadMissing(`上传文件不存在: ${uploadId}`);
  const src = path.join(UPLOADS_TMP_DIR, upload.storedPath);
  if (!existsSync(src)) throw bizErrors.uploadMissing(`上传文件已过期: ${upload.filename}`);
  const destDir = path.join(TASK_FILES_DIR, taskId, kind);
  mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, upload.filename);
  renameSync(src, dest);
  addTaskFile({
    taskId,
    kind,
    filename: upload.filename,
    storedPath: path.join(taskId, kind, upload.filename).replace(/\\/g, "/"),
    size: upload.size,
    mimeType: upload.mimeType,
  });
  deleteUpload(uploadId);
}

// GET /api/tasks/:id —— 详情
taskRouter.get(
  "/api/tasks/:id",
  wrap((req, res) => {
    ensureMigrated();
    const task = getTask(req.params.id!);
    if (!task) throw bizErrors.notFound("任务不存在");
    const files = listTaskFiles(task.id);
    ok(res, {
      ...task,
      params: parseJsonField<Record<string, unknown>>(task.params, {}),
      scheduleConfig: parseJsonField<Record<string, unknown>>(task.scheduleConfig, {}),
      paramsSchema: task.projectId ? projectParamsSchema(getProject(task.projectId)!) : {},
      scriptPreview: task.scriptSnapshot.slice(0, 2000),
      files: files.map((f) => ({
        id: f.id, kind: f.kind, filename: f.filename, size: f.size,
        url: `/api/files/task-files/${f.storedPath}`,
      })),
    });
  }),
);

// PUT /api/tasks/:id —— 编辑（快照不可变；运行中拦截）
taskRouter.put(
  "/api/tasks/:id",
  wrap(async (req, res) => {
    ensureMigrated();
    const task = getTask(req.params.id!);
    if (!task) throw bizErrors.notFound("任务不存在");
    if (taskHasActiveRun(task.id)) throw bizErrors.taskBusy("任务执行中，禁止编辑");
    const body = await readJsonBody(req);

    for (const forbidden of ["scriptSnapshot", "scriptLang", "scriptSource", "projectId"]) {
      if (forbidden in body) throw bizErrors.paramInvalid(`${forbidden} 不可修改（脚本快照在创建时锁定）`);
    }
    if (body["browserType"] !== undefined && !BROWSER_TYPES.includes(body["browserType"] as BrowserType)) {
      throw bizErrors.paramInvalid("browserType 必须为 chromium/firefox/webkit");
    }
    if (body["maxRetries"] !== undefined) {
      const r = Number(body["maxRetries"]);
      if (!Number.isInteger(r) || r < 0 || r > 10) throw bizErrors.paramInvalid("maxRetries 必须为 0~10 的整数");
    }
    let scheduleMode: ScheduleMode | undefined;
    let scheduleConfig: Record<string, unknown> | undefined;
    if (body["schedule"] !== undefined) {
      const s = assertSchedule(body["schedule"]);
      scheduleMode = s.mode;
      scheduleConfig = s.config;
    }
    if (body["params"] !== undefined && task.projectId) {
      assertParams(body["params"], projectParamsSchema(getProject(task.projectId)!));
    }

    const updated = updateTask(task.id, {
      name: body["name"] !== undefined ? String(body["name"]).trim() || task.name : undefined,
      description: body["description"] !== undefined ? String(body["description"]) : undefined,
      browserType: body["browserType"] as BrowserType | undefined,
      browserPath: body["browserPath"] !== undefined ? String(body["browserPath"]) : undefined,
      params: body["params"],
      maxRetries: body["maxRetries"] !== undefined ? Number(body["maxRetries"]) : undefined,
      scheduleMode,
      scheduleConfig,
    })!;
    ok(res, {
      ...updated,
      params: parseJsonField<Record<string, unknown>>(updated.params, {}),
      scheduleConfig: parseJsonField<Record<string, unknown>>(updated.scheduleConfig, {}),
    });
  }),
);

// DELETE /api/tasks/:id —— 删除（级联；运行中拦截）
taskRouter.delete(
  "/api/tasks/:id",
  wrap((req, res) => {
    ensureMigrated();
    const task = getTask(req.params.id!);
    if (!task) throw bizErrors.notFound("任务不存在");
    if (taskHasActiveRun(task.id)) throw bizErrors.taskBusy("任务执行中，禁止删除");
    deleteTask(task.id);
    ok(res, { deleted: true }, "删除成功");
  }),
);

// GET /api/tasks/:id/executions —— 迭代历史（TSK-10）
taskRouter.get(
  "/api/tasks/:id/executions",
  wrap((req, res) => {
    ensureMigrated();
    const task = getTask(req.params.id!);
    if (!task) throw bizErrors.notFound("任务不存在");
    const { page, pageSize } = parsePage(req.query as Record<string, unknown>);
    const result = listExecutionsByTask(task.id, page, pageSize);
    ok(res, {
      list: result.list.map((e) => ({
        id: e.id,
        runId: e.runId,
        iterationIndex: e.iterationIndex,
        attempt: e.attempt,
        status: e.status,
        error: e.error,
        startedAt: e.startedAt,
        endedAt: e.endedAt,
        durationMs: e.durationMs,
      })),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  }),
);
