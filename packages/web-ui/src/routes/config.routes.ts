/**
 * 系统配置路由（/api/config）：浏览器管理 / 系统配置 / 队列状态。
 * 设计依据：docs/需求设计/数据库与API设计.md §2.13。
 * 队列执行态属阶段二；当前返回 DB 侧排队/运行统计。
 */
import { Router } from "express";
import { readJsonBody, wrap } from "../http-error.js";
import { bizErrors, created, ok } from "../api/respond.js";
import {
  deleteBrowser,
  getDefaultBrowser,
  getSystemConfig,
  insertBrowser,
  listBrowsers,
  setDefaultBrowser,
  updateBrowser,
} from "../db/dao/configs.js";
import { getDb } from "../db/connection.js";
import { ensureMigrated } from "../db/ensure.js";

export const configRouter: Router = Router();

const BROWSER_NAMES = ["chromium", "firefox", "webkit"] as const;

// GET /api/config/browsers
configRouter.get(
  "/api/config/browsers",
  wrap((_req, res) => {
    ensureMigrated();
    const list = listBrowsers();
    const def = getDefaultBrowser();
    ok(res, {
      list: list.map((b) => ({
        id: b.id,
        name: b.name,
        version: b.version,
        path: b.path,
        isDefault: b.isDefault,
        enabled: b.enabled,
      })),
      default: def ? { id: def.id, name: def.name, version: def.version } : null,
    });
  }),
);

// POST /api/config/browsers
configRouter.post(
  "/api/config/browsers",
  wrap(async (req, res) => {
    ensureMigrated();
    const body = await readJsonBody(req);
    const name = String(body["name"] ?? "");
    if (!BROWSER_NAMES.includes(name as (typeof BROWSER_NAMES)[number])) {
      throw bizErrors.paramInvalid("name 必须为 chromium/firefox/webkit");
    }
    const path = String(body["path"] ?? "").trim();
    if (!path) throw bizErrors.paramInvalid("path 必填（浏览器可执行文件路径）");
    const version = String(body["version"] ?? "");
    if (!/^[\w.\-]{0,32}$/.test(version)) throw bizErrors.paramInvalid("version 格式非法");
    const b = insertBrowser({ name, version, path, isDefault: Boolean(body["isDefault"]) });
    if (b.isDefault) setDefaultBrowser(b.id);
    created(res, b);
  }),
);

// PUT /api/config/browsers/:id
configRouter.put(
  "/api/config/browsers/:id",
  wrap(async (req, res) => {
    ensureMigrated();
    const id = Number.parseInt(req.params.id!, 10);
    const body = await readJsonBody(req);
    let browserName: "chromium" | "firefox" | "webkit" | undefined;
    if (body["name"] !== undefined) {
      if (!BROWSER_NAMES.includes(String(body["name"]) as (typeof BROWSER_NAMES)[number])) {
        throw bizErrors.paramInvalid("name 必须为 chromium/firefox/webkit");
      }
      browserName = String(body["name"]) as "chromium" | "firefox" | "webkit";
    }
    const updated = updateBrowser(id, {
      name: browserName,
      version: body["version"] as string | undefined,
      path: body["path"] as string | undefined,
      enabled: body["enabled"] === undefined ? undefined : Boolean(body["enabled"]),
    });
    if (!updated) throw bizErrors.notFound("浏览器配置不存在");
    if (body["isDefault"] === true) setDefaultBrowser(id);
    ok(res, getDb().prepare("SELECT * FROM browsers WHERE id = ?").get(id));
  }),
);

// DELETE /api/config/browsers/:id
configRouter.delete(
  "/api/config/browsers/:id",
  wrap((req, res) => {
    ensureMigrated();
    const id = Number.parseInt(req.params.id!, 10);
    if (!deleteBrowser(id)) throw bizErrors.notFound("浏览器配置不存在");
    // 默认项被删：自动指认首个启用项
    if (!getDefaultBrowser()) {
      const first = listBrowsers().find((b) => b.enabled);
      if (first) setDefaultBrowser(first.id);
    }
    ok(res, { deleted: true }, "删除成功");
  }),
);

// GET /api/config/system
configRouter.get(
  "/api/config/system",
  wrap((_req, res) => {
    ensureMigrated();
    ok(res, {
      reportRetention: getSystemConfig("report.retention", { maxPerTask: 100, maxAgeDays: 90 }),
      reportCleanupCron: getSystemConfig("report.cleanupCron", "0 2 * * *"),
      uploadLimits: getSystemConfig("upload.limits", { maxFileBytes: 52428800, maxFilesPerTask: 100 }),
      queuePollIntervalMs: getSystemConfig("queue.pollIntervalMs", 2000),
    });
  }),
);

// PUT /api/config/system
configRouter.put(
  "/api/config/system",
  wrap(async (req, res) => {
    ensureMigrated();
    const body = await readJsonBody(req);
    const { setSystemConfig } = await import("../db/dao/configs.js");
    if (body["reportRetention"] !== undefined) {
      const r = body["reportRetention"] as { maxPerTask?: number; maxAgeDays?: number };
      if (Number(r.maxPerTask) < 1 || Number(r.maxAgeDays) < 1) {
        throw bizErrors.paramInvalid("reportRetention 数值必须 ≥ 1");
      }
      setSystemConfig("report.retention", r);
    }
    if (body["reportCleanupCron"] !== undefined) setSystemConfig("report.cleanupCron", String(body["reportCleanupCron"]));
    if (body["uploadLimits"] !== undefined) {
      const u = body["uploadLimits"] as { maxFileBytes?: number; maxFilesPerTask?: number };
      if (Number(u.maxFileBytes) < 1 || Number(u.maxFilesPerTask) < 1) {
        throw bizErrors.paramInvalid("uploadLimits 数值必须 ≥ 1");
      }
      setSystemConfig("upload.limits", u);
    }
    if (body["queuePollIntervalMs"] !== undefined) {
      const v = Number(body["queuePollIntervalMs"]);
      if (!Number.isFinite(v) || v < 500 || v > 60000) {
        throw bizErrors.paramInvalid("queuePollIntervalMs 必须为 500~60000");
      }
      setSystemConfig("queue.pollIntervalMs", v);
    }
    ok(res, {
      reportRetention: getSystemConfig("report.retention", {}),
      reportCleanupCron: getSystemConfig("report.cleanupCron", ""),
      uploadLimits: getSystemConfig("upload.limits", {}),
      queuePollIntervalMs: getSystemConfig("queue.pollIntervalMs", 2000),
    });
  }),
);

// GET /api/config/queue/status —— 队列状态（阶段二接入执行引擎；当前为 DB 统计）
configRouter.get(
  "/api/config/queue/status",
  wrap((_req, res) => {
    ensureMigrated();
    const db = getDb();
    const active = db
      .prepare("SELECT r.id AS runId, r.task_id AS taskId FROM task_runs r WHERE r.status IN ('queued','running') ORDER BY r.created_at")
      .all() as Array<{ runId: string; taskId: string }>;
    ok(res, {
      isRunning: active.some(() => true),
      currentRunId: active[0]?.runId ?? null,
      currentTaskId: active[0]?.taskId ?? null,
      queueLength: Math.max(0, active.length - 1),
      queue: active.slice(1).map((r, i) => ({ runId: r.runId, taskId: r.taskId, position: i + 1 })),
    });
  }),
);
