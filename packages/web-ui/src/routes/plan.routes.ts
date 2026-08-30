/**
 * 测试计划路由（/api/plans）。
 * 设计依据：docs/需求设计/数据库与API设计.md §2.10（PLN-01~04）。
 * run/pause/resume 属阶段二（计划执行器），本轮不挂载。
 */
import { Router } from "express";
import { readJsonBody, wrap } from "../http-error.js";
import { BIZ_CODES, BizError, bizErrors, created, ok, parsePage } from "../api/respond.js";
import {
  createPlan,
  deletePlan,
  getActivePlanRun,
  getPlan,
  listPlanTasks,
  listPlans,
  findMissingTaskIds,
  planHasActiveRun,
  updatePlan,
  type PlanStatus,
} from "../db/dao/plans.js";
import { getTask } from "../db/dao/tasks.js";
import { ensureMigrated } from "../db/ensure.js";
import { pausePlanRun, resumePlanRun, startPlanRun } from "../services/plan-executor.js";

export const planRouter: Router = Router();

const PLAN_STATUS: PlanStatus[] = ["idle", "running", "paused", "completed", "failed", "stopped"];

/** 简单 Cron 预校验：5 段表达式，每段允许 * / - , 数字 */
function assertCron(expr: string): void {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw bizErrors.paramInvalid("cronExpr 必须为 5 段 Cron 表达式（分 时 日 月 周）");
  for (const p of parts) {
    if (!/^\*|\d+(-\d+)?(\/\d+)?(,\d+(-\d+)?(\/\d+)?)*$/.test(p)) {
      throw bizErrors.paramInvalid(`Cron 字段非法: ${p}`);
    }
  }
}

// GET /api/plans —— 列表
planRouter.get(
  "/api/plans",
  wrap((req, res) => {
    ensureMigrated();
    const { page, pageSize } = parsePage(req.query as Record<string, unknown>);
    const status = req.query["status"] as PlanStatus | undefined;
    if (status !== undefined && !PLAN_STATUS.includes(status)) {
      throw bizErrors.paramInvalid("status 必须为 idle/running/paused/completed/failed/stopped");
    }
    const result = listPlans({ page, pageSize, status });
    ok(res, {
      list: result.list.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        cronExpr: p.cronExpr,
        status: p.status,
        taskCount: listPlanTasks(p.id).length,
        lastRunAt: p.lastRunAt,
        createdAt: p.createdAt,
      })),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  }),
);

// POST /api/plans —— 创建
planRouter.post(
  "/api/plans",
  wrap(async (req, res) => {
    ensureMigrated();
    const body = await readJsonBody(req);
    const name = String(body["name"] ?? "").trim();
    if (!name) throw bizErrors.paramInvalid("计划名称不能为空");
    const taskIds = Array.isArray(body["taskIds"]) ? (body["taskIds"] as string[]) : [];
    if (taskIds.length === 0) throw bizErrors.planEmptyTasks();
    const missing = findMissingTaskIds(taskIds);
    if (missing.length > 0) {
      throw bizErrors.notFound(`任务不存在: ${missing.join(", ")}`);
    }
    if (taskIds.length !== new Set(taskIds).size) {
      throw bizErrors.paramInvalid("taskIds 存在重复项");
    }
    const cronExpr = body["cronExpr"] !== undefined && body["cronExpr"] !== null ? String(body["cronExpr"]) : null;
    if (cronExpr) assertCron(cronExpr);

    const plan = createPlan({
      name,
      description: String(body["description"] ?? ""),
      cronExpr,
      taskIds,
    });
    created(res, planDetail(plan.id));
  }),
);

function planDetail(id: string): Record<string, unknown> {
  const plan = getPlan(id)!;
  const refs = listPlanTasks(id);
  const activeRun = getActivePlanRun(id);
  return {
    ...plan,
    tasks: refs.map((r) => {
      const t = getTask(r.taskId);
      return {
        id: r.taskId,
        name: t?.name ?? "(已删除)",
        status: t?.status ?? null,
        sortOrder: r.sortOrder,
        lastRunAt: t?.lastRunAt ?? null,
      };
    }),
    activeRun: activeRun
      ? { id: activeRun.id, status: activeRun.status, startedAt: activeRun.startedAt }
      : null,
  };
}

// GET /api/plans/:id —— 详情
planRouter.get(
  "/api/plans/:id",
  wrap((req, res) => {
    ensureMigrated();
    const plan = getPlan(req.params.id!);
    if (!plan) throw bizErrors.notFound("计划不存在");
    ok(res, planDetail(plan.id));
  }),
);

// PUT /api/plans/:id —— 编辑（含 taskIds 重排；执行中拦截）
planRouter.put(
  "/api/plans/:id",
  wrap(async (req, res) => {
    ensureMigrated();
    const plan = getPlan(req.params.id!);
    if (!plan) throw bizErrors.notFound("计划不存在");
    if (planHasActiveRun(plan.id)) throw bizErrors.planBusy("计划执行中，禁止编辑");
    const body = await readJsonBody(req);

    let taskIds: string[] | undefined;
    if (body["taskIds"] !== undefined) {
      taskIds = Array.isArray(body["taskIds"]) ? (body["taskIds"] as string[]) : [];
      if (taskIds.length === 0) throw bizErrors.planEmptyTasks();
      const missing = findMissingTaskIds(taskIds);
      if (missing.length > 0) throw bizErrors.notFound(`任务不存在: ${missing.join(", ")}`);
      if (taskIds.length !== new Set(taskIds).size) throw bizErrors.paramInvalid("taskIds 存在重复项");
    }
    let cronExpr: string | null | undefined;
    if ("cronExpr" in body) {
      cronExpr = body["cronExpr"] !== undefined && body["cronExpr"] !== null ? String(body["cronExpr"]) : null;
      if (cronExpr) assertCron(cronExpr);
    }
    updatePlan(plan.id, {
      name: body["name"] !== undefined ? String(body["name"]).trim() || plan.name : undefined,
      description: body["description"] !== undefined ? String(body["description"]) : undefined,
      cronExpr,
      taskIds,
    });
    ok(res, planDetail(plan.id));
  }),
);

// DELETE /api/plans/:id —— 删除（级联；执行中拦截）
planRouter.delete(
  "/api/plans/:id",
  wrap((req, res) => {
    ensureMigrated();
    const plan = getPlan(req.params.id!);
    if (!plan) throw bizErrors.notFound("计划不存在");
    if (planHasActiveRun(plan.id)) throw bizErrors.planBusy("计划执行中，禁止删除");
    deletePlan(plan.id);
    ok(res, { deleted: true }, "删除成功");
  }),
);

// POST /api/plans/:id/run —— 执行计划（PLN-05；执行中拦截 E8）
planRouter.post(
  "/api/plans/:id/run",
  wrap((req, res) => {
    ensureMigrated();
    const plan = getPlan(req.params.id!);
    if (!plan) throw bizErrors.notFound("计划不存在");
    if (planHasActiveRun(plan.id)) throw new BizError(409, BIZ_CODES.PLAN_BUSY, "计划执行中，请勿重复触发");
    if (listPlanTasks(plan.id).length === 0) throw bizErrors.planEmptyTasks();
    try {
      const planRunId = startPlanRun(plan.id, "manual");
      ok(res, { planRunId }, "计划已开始执行");
    } catch (e) {
      throw new BizError(500, BIZ_CODES.PLAN_EXEC_FAILED, (e as Error).message);
    }
  }),
);

// POST /api/plans/:id/pause —— 暂停（编排冻结；PLN-05b）
planRouter.post(
  "/api/plans/:id/pause",
  wrap((req, res) => {
    ensureMigrated();
    const plan = getPlan(req.params.id!);
    if (!plan) throw bizErrors.notFound("计划不存在");
    const active = getActivePlanRun(plan.id);
    if (!active || active.status !== "running") {
      throw bizErrors.paramInvalid("仅运行中的计划可暂停");
    }
    const okPause = pausePlanRun(active.id);
    if (!okPause) throw bizErrors.paramInvalid("暂停失败：计划编排已结束");
    ok(res, { planRunId: active.id, status: "paused" }, "计划已暂停，当前任务完成后不再启动下一任务");
  }),
);

// POST /api/plans/:id/resume —— 恢复（PLN-05b）
planRouter.post(
  "/api/plans/:id/resume",
  wrap((req, res) => {
    ensureMigrated();
    const plan = getPlan(req.params.id!);
    if (!plan) throw bizErrors.notFound("计划不存在");
    const active = getActivePlanRun(plan.id);
    if (!active || active.status !== "paused") {
      throw bizErrors.paramInvalid("仅已暂停的计划可恢复");
    }
    const okResume = resumePlanRun(active.id);
    if (!okResume) throw bizErrors.paramInvalid("恢复失败：计划编排已结束");
    ok(res, { planRunId: active.id, status: "running" }, "计划已恢复调度");
  }),
);
