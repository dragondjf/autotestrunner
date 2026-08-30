/**
 * 业务 API 统一响应包络与错误码。
 * 设计依据：docs/需求设计/数据库与API设计.md §2.1。
 * 新业务路由（/api/projects|tasks|plans|reports|config|dashboard|uploads|files）
 * 统一用 {code, message, data} 包络 + BizError；既有 4 个 router 保持 {detail} 不动。
 */
import type { NextFunction, Request, Response } from "express";

/** 业务错误码（设计文档 §2.1 错误码定义） */
export const BIZ_CODES = {
  PARAM_INVALID: 10001, // 参数验证失败
  NOT_FOUND: 10002, // 资源不存在
  ALREADY_EXISTS: 10003, // 资源已存在（项目重名）
  FILE_INVALID: 10004, // 文件校验失败
  TASK_EXEC_FAILED: 20001, // 任务执行失败
  TASK_ALREADY_QUEUED: 20002, // 任务已在队列中
  TASK_RUNNING: 20003, // 任务执行中，禁止重复触发
  TASK_BUSY: 20004, // 任务执行中，禁止编辑/删除
  SCHEDULE_INVALID: 20005, // 调度配置非法
  UPLOAD_MISSING: 20006, // 引用的上传文件不存在或已过期
  PLAN_EXEC_FAILED: 30001, // 计划执行失败
  PLAN_BUSY: 30002, // 计划执行中，禁止编辑/删除/重复触发
  PLAN_EMPTY_TASKS: 30003, // 计划至少包含 1 个任务
  REPORT_GEN_FAILED: 40001, // 报告生成失败
  REPORT_EXPORT_FAILED: 40002, // 报告导出失败
  INTERNAL: 50001, // 系统内部错误
  RUNNER_UNREACHABLE: 50002, // Runner 不可达
  LLM_NOT_CONFIGURED: 50003, // LLM 未配置
} as const;

/** 业务错误：由路由 catch 后转统一包络（HTTP 状态 + body.code/message） */
export class BizError extends Error {
  readonly status: number;
  readonly code: number;
  readonly errors?: unknown;

  constructor(status: number, code: number, message: string, errors?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.errors = errors;
  }
}

/** 快捷工厂 */
export const bizErrors = {
  paramInvalid: (msg: string, errors?: unknown) =>
    new BizError(400, BIZ_CODES.PARAM_INVALID, msg, errors),
  notFound: (msg: string) => new BizError(404, BIZ_CODES.NOT_FOUND, msg),
  alreadyExists: (msg: string) => new BizError(409, BIZ_CODES.ALREADY_EXISTS, msg),
  fileInvalid: (msg: string, errors?: unknown) =>
    new BizError(400, BIZ_CODES.FILE_INVALID, msg, errors),
  taskBusy: (msg: string) => new BizError(409, BIZ_CODES.TASK_BUSY, msg),
  scheduleInvalid: (msg: string) => new BizError(400, BIZ_CODES.SCHEDULE_INVALID, msg),
  planBusy: (msg: string) => new BizError(409, BIZ_CODES.PLAN_BUSY, msg),
  planEmptyTasks: () => new BizError(400, BIZ_CODES.PLAN_EMPTY_TASKS, "计划至少包含 1 个任务"),
  uploadMissing: (msg: string) => new BizError(400, BIZ_CODES.UPLOAD_MISSING, msg),
};

/** 成功响应 */
export function ok(res: Response, data: unknown, message = "success"): void {
  res.json({ code: 0, message, data });
}

/** 创建成功响应（201） */
export function created(res: Response, data: unknown, message = "success"): void {
  res.status(201).json({ code: 0, message, data });
}

/** BizError → 统一错误包络 */
export function fail(res: Response, err: BizError): void {
  res.status(err.status).json({ code: err.code, message: err.message, errors: err.errors });
}

/** 解析分页参数（page 默认 1，pageSize 默认 10 上限 100） */
export function parsePage(query: Record<string, unknown>): { page: number; pageSize: number } {
  const page = Math.max(1, Number.parseInt(String(query["page"] ?? "1"), 10) || 1);
  const rawSize = Number.parseInt(String(query["pageSize"] ?? "10"), 10) || 10;
  return { page, pageSize: Math.min(100, Math.max(1, rawSize)) };
}

/** BizError 统一转包络（挂在 404 之后、通用 errorMiddleware 之前） */
export function bizErrorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (err instanceof BizError) {
    fail(res, err);
    return;
  }
  next(err);
}
