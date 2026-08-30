/**
 * 录制项目路由（/api/projects）。
 * 设计依据：docs/需求设计/数据库与API设计.md §2.3（REC-P01~P06）。
 */
import { Router } from "express";
import { readJsonBody, wrap } from "../http-error.js";
import { BizError, bizErrors, created, ok, parsePage } from "../api/respond.js";
import {
  createProject,
  deleteProject,
  getProject,
  getProjectByName,
  listProjects,
  projectParamsSchema,
  updateProject,
  countProjectTasks,
  type ProjectStatus,
  type ProjectType,
  type ScriptLang,
} from "../db/dao/projects.js";
import { listTasks, taskHasActiveRun } from "../db/dao/tasks.js";
import { parseJsonField } from "../db/dao/common.js";
import { INSPECT_DATA_DIR, SESSION_DIR } from "../paths.js";
import { ensureMigrated } from "../db/ensure.js";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const projectRouter: Router = Router();

const PROJECT_TYPES: ProjectType[] = ["ai", "browser"];
const PROJECT_STATUS: ProjectStatus[] = ["draft", "ready", "archived"];
const SCRIPT_LANGS: ScriptLang[] = ["json", "js", "py"];

/** scriptContent 为标准步骤流（json）时的结构校验；返回错误消息或 null */
function validateStepsJson(scriptContent: string): string | null {
  const trimmed = scriptContent.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return `scriptContent 不是合法 JSON: ${(e as Error).message}`;
  }
  // 兼容两种形态：{steps: [...]} 或直接 [...]
  const steps = Array.isArray(parsed)
    ? parsed
    : (parsed as { steps?: unknown })?.steps;
  if (!Array.isArray(steps)) return "scriptContent 须为步骤数组或 {steps: [...]}";
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] as Record<string, unknown>;
    if (typeof s !== "object" || s === null || typeof s["method"] !== "string" || !s["method"]) {
      return `第 ${i + 1} 个步骤缺少 method 字段`;
    }
  }
  return null;
}

/** 校验公共字段；抛 BizError */
function assertCreatePayload(body: Record<string, unknown>): void {
  const name = String(body["name"] ?? "").trim();
  if (!name) throw bizErrors.paramInvalid("项目名称不能为空");
  if (getProjectByName(name)) throw bizErrors.alreadyExists(`项目名称已存在: ${name}`);
  const type = body["type"] as ProjectType;
  if (!PROJECT_TYPES.includes(type)) throw bizErrors.paramInvalid("type 必须为 ai 或 browser");
  const status = body["status"] as ProjectStatus | undefined;
  if (status !== undefined && !PROJECT_STATUS.includes(status)) {
    throw bizErrors.paramInvalid("status 必须为 draft/ready/archived");
  }
  const scriptLang = (body["scriptLang"] ?? "json") as ScriptLang;
  if (!SCRIPT_LANGS.includes(scriptLang)) throw bizErrors.paramInvalid("scriptLang 必须为 json/js/py");
  const startUrl = String(body["startUrl"] ?? "").trim();
  if (startUrl && !/^https?:\/\//i.test(startUrl)) {
    throw bizErrors.paramInvalid("startUrl 必须为合法 URL（http/https）");
  }
  const scriptContent = String(body["scriptContent"] ?? "");
  if (scriptLang === "json") {
    const err = validateStepsJson(scriptContent);
    if (err) throw bizErrors.paramInvalid(err);
  }
  if (body["paramsSchema"] !== undefined && typeof body["paramsSchema"] !== "object") {
    throw bizErrors.paramInvalid("paramsSchema 必须为对象");
  }
}

function toDetail(p: ReturnType<typeof getProject> & object): Record<string, unknown> {
  return {
    ...p,
    paramsSchema: projectParamsSchema(p),
    recordConfig: parseJsonField<Record<string, unknown>>(p.recordConfig, {}),
    stepsCount: countSteps(p.scriptContent, p.scriptLang),
  };
}

function countSteps(scriptContent: string, lang: ScriptLang): number {
  if (lang !== "json" || !scriptContent.trim()) return 0;
  const parsed = parseJsonField<{ steps?: unknown[] } | unknown[]>(scriptContent, {});
  if (Array.isArray(parsed)) return parsed.length;
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { steps?: unknown[] }).steps)) {
    return (parsed as { steps: unknown[] }).steps.length;
  }
  return 0;
}

// GET /api/projects —— 列表（分页/搜索/类型/状态筛选）
projectRouter.get(
  "/api/projects",
  wrap((req, res) => {
    ensureMigrated();
    const { page, pageSize } = parsePage(req.query as Record<string, unknown>);
    const type = req.query["type"] as ProjectType | undefined;
    const status = req.query["status"] as ProjectStatus | undefined;
    if (type !== undefined && !PROJECT_TYPES.includes(type)) {
      throw bizErrors.paramInvalid("type 必须为 ai 或 browser");
    }
    if (status !== undefined && !PROJECT_STATUS.includes(status)) {
      throw bizErrors.paramInvalid("status 必须为 draft/ready/archived");
    }
    const result = listProjects({
      page,
      pageSize,
      keyword: req.query["keyword"] as string | undefined,
      type,
      status,
    });
    // 关联录制会话数：磁盘会话历史按 URL 前缀匹配（browser → inspect_data，ai → sessions）
    const countSessions = (p: (typeof result.list)[number]): number => {
      try {
        const prefix = (p.startUrl || "").replace(/\/$/, "");
        if (!prefix) return 0;
        const dir = p.type === "browser" ? INSPECT_DATA_DIR : SESSION_DIR;
        let n = 0;
        for (const name of readdirSync(dir)) {
          if (!name.endsWith(".json")) continue;
          try {
            const data = JSON.parse(readFileSync(path.join(dir, name), "utf-8")) as {
              start_url?: string;
            };
            if (String(data.start_url ?? "").replace(/\/$/, "").startsWith(prefix)) n++;
          } catch {
            /* 坏文件跳过 */
          }
        }
        return n;
      } catch {
        return 0;
      }
    };
    ok(res, {
      list: result.list.map((p) => ({
        ...p,
        paramsSchema: undefined,
        recordConfig: undefined,
        stepsCount: countSteps(p.scriptContent, p.scriptLang),
        paramsCount: Object.keys(projectParamsSchema(p)).length,
        sessionCount: countSessions(p),
      })),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  }),
);

// POST /api/projects —— 创建
projectRouter.post(
  "/api/projects",
  wrap(async (req, res) => {
    ensureMigrated();
    const body = await readJsonBody(req);
    assertCreatePayload(body);
    const project = createProject({
      name: String(body["name"]).trim(),
      description: String(body["description"] ?? ""),
      type: body["type"] as ProjectType,
      status: body["status"] as ProjectStatus | undefined,
      startUrl: String(body["startUrl"] ?? ""),
      scriptContent: String(body["scriptContent"] ?? ""),
      scriptLang: (body["scriptLang"] ?? "json") as ScriptLang,
      paramsSchema: body["paramsSchema"],
      recordConfig: body["recordConfig"],
    });
    created(res, toDetail(project));
  }),
);

// GET /api/projects/:id —— 详情（含关联任务摘要）
projectRouter.get(
  "/api/projects/:id",
  wrap((req, res) => {
    ensureMigrated();
    const p = getProject(req.params.id!);
    if (!p) throw bizErrors.notFound("项目不存在");
    const tasks = listTasks({ projectId: p.id, page: 1, pageSize: 5 });
    ok(res, {
      ...toDetail(p),
      tasks: tasks.list.map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status,
        lastRunAt: t.lastRunAt,
      })),
      createTaskDisabled: p.status === "archived",
      createTaskDisabledReason: p.status === "archived" ? "已归档项目不可创建任务" : null,
    });
  }),
);

// PUT /api/projects/:id —— 编辑
projectRouter.put(
  "/api/projects/:id",
  wrap(async (req, res) => {
    ensureMigrated();
    const id = req.params.id!;
    const existing = getProject(id);
    if (!existing) throw bizErrors.notFound("项目不存在");
    const body = await readJsonBody(req);

    const name = body["name"] !== undefined ? String(body["name"]).trim() : existing.name;
    if (!name) throw bizErrors.paramInvalid("项目名称不能为空");
    const conflict = getProjectByName(name);
    if (conflict && conflict.id !== id) throw bizErrors.alreadyExists(`项目名称已存在: ${name}`);
    const type = (body["type"] ?? existing.type) as ProjectType;
    if (!PROJECT_TYPES.includes(type)) throw bizErrors.paramInvalid("type 必须为 ai 或 browser");
    const status = (body["status"] ?? existing.status) as ProjectStatus;
    if (!PROJECT_STATUS.includes(status)) throw bizErrors.paramInvalid("status 必须为 draft/ready/archived");
    const scriptLang = (body["scriptLang"] ?? existing.scriptLang) as ScriptLang;
    if (!SCRIPT_LANGS.includes(scriptLang)) throw bizErrors.paramInvalid("scriptLang 必须为 json/js/py");
    const startUrl = body["startUrl"] !== undefined ? String(body["startUrl"]).trim() : existing.startUrl;
    if (startUrl && !/^https?:\/\//i.test(startUrl)) {
      throw bizErrors.paramInvalid("startUrl 必须为合法 URL（http/https）");
    }
    const scriptContent =
      body["scriptContent"] !== undefined ? String(body["scriptContent"]) : existing.scriptContent;
    if (scriptLang === "json" && body["scriptContent"] !== undefined) {
      const err = validateStepsJson(scriptContent);
      if (err) throw bizErrors.paramInvalid(err);
    }

    const updated = updateProject(id, {
      name,
      description: body["description"] !== undefined ? String(body["description"]) : undefined,
      type,
      status,
      startUrl,
      scriptContent: body["scriptContent"] !== undefined ? scriptContent : undefined,
      scriptLang,
      paramsSchema: body["paramsSchema"],
      recordConfig: body["recordConfig"],
    })!;

    // 修改脚本且已存在关联任务 → 附带警告（AC-P03-2 / REC-P03 边界）
    const warnings: string[] = [];
    if (body["scriptContent"] !== undefined && body["scriptContent"] !== existing.scriptContent) {
      const n = countProjectTasks(id);
      if (n > 0) warnings.push(`已存在 ${n} 个关联任务，本次修改仅影响后续新任务`);
    }
    ok(res, { ...toDetail(updated), warnings });
  }),
);

// DELETE /api/projects/:id —— 删除（级联任务；运行中拦截）
projectRouter.delete(
  "/api/projects/:id",
  wrap((req, res) => {
    ensureMigrated();
    const id = req.params.id!;
    const p = getProject(id);
    if (!p) throw bizErrors.notFound("项目不存在");
    const tasks = listTasks({ projectId: id, page: 1, pageSize: 100 });
    for (const t of tasks.list) {
      if (taskHasActiveRun(t.id)) {
        throw bizErrors.taskBusy(`任务「${t.name}」执行中，无法删除项目`);
      }
    }
    const deletedTasks = tasks.total;
    deleteProject(id);
    ok(res, { deletedTasks }, "删除成功");
  }),
);
