/**
 * 测试报告路由（/api/reports）。
 * 设计依据：docs/需求设计/数据库与API设计.md §2.11（RPT-01/02/05 + 趋势）。
 * 导出（exports）与删除产物属阶段二；趋势按日/周/月分桶。
 */
import { Router } from "express";
import { readJsonBody, wrap } from "../http-error.js";
import { BIZ_CODES, BizError, bizErrors, ok, parsePage } from "../api/respond.js";
import {
  getReport,
  listReportScreenshots,
  listReportSteps,
  listReports,
  reportTaskResults,
  reportTrend,
  deleteReport,
  type ReportStatus,
  type ReportType,
} from "../db/dao/reports.js";
import { getExportStatus, startExport } from "../services/report-builder.js";
import { fetchExecutionLogs, logPayload } from "../db/dao/runs.js";
import { ensureMigrated } from "../db/ensure.js";

export const reportRouter: Router = Router();

const REPORT_STATUS: ReportStatus[] = ["success", "failed", "skipped", "stopped"];
const REPORT_TYPES: ReportType[] = ["task", "plan"];

// GET /api/reports —— 列表（任务/计划/状态/类型/时间范围过滤）
reportRouter.get(
  "/api/reports",
  wrap((req, res) => {
    ensureMigrated();
    const { page, pageSize } = parsePage(req.query as Record<string, unknown>);
    const status = req.query["status"] as ReportStatus | undefined;
    if (status !== undefined && !REPORT_STATUS.includes(status)) {
      throw bizErrors.paramInvalid("status 必须为 success/failed/skipped/stopped");
    }
    const type = req.query["type"] as ReportType | undefined;
    if (type !== undefined && !REPORT_TYPES.includes(type)) {
      throw bizErrors.paramInvalid("type 必须为 task/plan");
    }
    const result = listReports({
      page,
      pageSize,
      taskId: req.query["taskId"] as string | undefined,
      planId: req.query["planId"] as string | undefined,
      status,
      type,
      startTime: req.query["startTime"] as string | undefined,
      endTime: req.query["endTime"] as string | undefined,
    });
    ok(res, {
      list: result.list.map((r) => ({
        id: r.id,
        type: r.type,
        name: r.name,
        taskId: r.taskId,
        runId: r.runId,
        executionId: r.executionId,
        planId: r.planId,
        status: r.status,
        totalSteps: r.totalSteps,
        passedSteps: r.passedSteps,
        failedSteps: r.failedSteps,
        passRate: r.passRate,
        durationMs: r.durationMs,
        startedAt: r.startedAt,
        createdAt: r.createdAt,
      })),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  }),
);

/** 报告详情通用组装（steps 截断 200，更多走 /steps 分页） */
function reportDetail(id: string): Record<string, unknown> {
  const r = getReport(id)!;
  const stepsResult = listReportSteps(r.id, 1, 200);
  return {
    id: r.id,
    type: r.type,
    taskId: r.taskId,
    runId: r.runId,
    executionId: r.executionId,
    planId: r.planId,
    planRunId: r.planRunId,
    name: r.name,
    status: r.status,
    totalSteps: r.totalSteps,
    passedSteps: r.passedSteps,
    failedSteps: r.failedSteps,
    skippedSteps: r.skippedSteps,
    passRate: r.passRate,
    errorMessage: r.errorMessage,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    durationMs: r.durationMs,
    createdAt: r.createdAt,
    steps: stepsResult.list.map((s) => ({
      stepIndex: s.stepIndex,
      method: s.method,
      description: s.description,
      status: s.status,
      error: s.error,
      durationMs: s.durationMs,
      screenshotUrl: s.screenshotPath ? `/api/files/${s.screenshotPath}` : null,
    })),
    stepsTotal: stepsResult.total,
    stepsTruncated: stepsResult.total > 200,
    // 脚本通道报告无步骤：附执行日志预览（真实执行过程，含截图事件 → 前端渲染步骤详情）
    logsPreview:
      stepsResult.total === 0 && r.executionId
        ? fetchExecutionLogs(r.executionId, 0, 100).logs.map((l) => ({
            seq: l.seq,
            ts: l.ts,
            level: l.level,
            event: l.event,
            message: l.message,
            payload: logPayload(l),
          }))
        : [],
    screenshots: listReportScreenshots(r.id).map((p) => `/api/files/${p}`),
    videoUrl: r.videoPath ? `/api/files/${r.videoPath}` : null,
    exports: {
      html: r.htmlPath ? { url: `/api/files/${r.htmlPath}` } : null,
      pdf: r.pdfPath ? { url: `/api/files/${r.pdfPath}` } : null,
    },
    ...(r.type === "plan" ? { taskResults: reportTaskResults(r) } : {}),
  };
}

// GET /api/reports/trend —— 趋势（日/周/月粒度，RPT-02-3）
reportRouter.get(
  "/api/reports/trend",
  wrap((req, res) => {
    ensureMigrated();
    const taskId = String(req.query["taskId"] ?? "");
    if (!taskId) throw bizErrors.paramInvalid("taskId 必填");
    const granularity = (req.query["granularity"] ?? "day") as "day" | "week" | "month";
    if (!["day", "week", "month"].includes(granularity)) {
      throw bizErrors.paramInvalid("granularity 必须为 day/week/month");
    }
    const limit = Math.min(90, Math.max(1, Number(req.query["limit"] ?? 30)));
    ok(res, { granularity, buckets: reportTrend(taskId, granularity, limit) });
  }),
);

// GET /api/reports/:id —— 详情
reportRouter.get(
  "/api/reports/:id",
  wrap((req, res) => {
    ensureMigrated();
    const r = getReport(req.params.id!);
    if (!r) throw bizErrors.notFound("报告不存在");
    ok(res, reportDetail(r.id));
  }),
);

// GET /api/reports/:id/steps —— 步骤分页（大报告）
reportRouter.get(
  "/api/reports/:id/steps",
  wrap((req, res) => {
    ensureMigrated();
    const r = getReport(req.params.id!);
    if (!r) throw bizErrors.notFound("报告不存在");
    const { page, pageSize } = parsePage(req.query as Record<string, unknown>);
    const result = listReportSteps(r.id, page, Math.min(500, pageSize));
    ok(res, {
      list: result.list.map((s) => ({
        stepIndex: s.stepIndex,
        method: s.method,
        description: s.description,
        status: s.status,
        error: s.error,
        durationMs: s.durationMs,
        screenshotUrl: s.screenshotPath ? `/api/files/${s.screenshotPath}` : null,
        detail: JSON.parse(s.detail),
      })),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  }),
);

// POST /api/reports/:id/exports —— 发起导出（RPT-03/04，异步任务 + 进度）
reportRouter.post(
  "/api/reports/:id/exports",
  wrap(async (req, res) => {
    ensureMigrated();
    const report = getReport(req.params.id!);
    if (!report) throw bizErrors.notFound("报告不存在");
    const body = await readJsonBody(req);
    const format = String(body["format"] ?? "");
    if (format !== "html" && format !== "pdf") {
      throw bizErrors.paramInvalid("format 必须为 html 或 pdf");
    }
    try {
      const exportId = startExport(report.id, format);
      const job = getExportStatus(exportId)!;
      ok(res, { exportId: job.id, status: job.status, progress: job.progress });
    } catch (e) {
      throw new BizError(500, BIZ_CODES.REPORT_EXPORT_FAILED, (e as Error).message);
    }
  }),
);

// GET /api/exports/:exportId —— 导出进度/下载地址（AC-RPT-04-1 进度反馈）
reportRouter.get(
  "/api/exports/:exportId",
  wrap((req, res) => {
    ensureMigrated();
    const job = getExportStatus(req.params.exportId!);
    if (!job) throw bizErrors.notFound("导出任务不存在");
    ok(res, {
      exportId: job.id,
      reportId: job.reportId,
      format: job.format,
      status: job.status,
      progress: job.progress,
      error: job.error,
      downloadUrl:
        job.status === "done" && job.filePath ? `/api/files/${job.filePath}` : null,
    });
  }),
);

// DELETE /api/reports/:id —— 删除（RPT-05；不影响任务/计划记录）
reportRouter.delete(
  "/api/reports/:id",
  wrap((req, res) => {
    ensureMigrated();
    const r = getReport(req.params.id!);
    if (!r) throw bizErrors.notFound("报告不存在");
    deleteReport(r.id);
    ok(res, { deleted: true }, "删除成功");
  }),
);
