/**
 * HTTP 错误与错误响应中间件。
 * 对齐 FastAPI：HTTPException(status_code, detail) 响应体为 {"detail": "..."}；
 * 未匹配路由返回 404 {"detail": "Not Found"}。
 */
import type { NextFunction, Request, Response } from "express";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(detail);
    this.name = "HttpError";
  }
}

export function httpError(status: number, detail: string): HttpError {
  return new HttpError(status, detail);
}

/** 包装 async 处理器，把抛出转为 next(err) */
export function wrap(
  fn: (req: Request, res: Response) => Promise<void> | void,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch(next);
  };
}

export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) return;
  const status = err instanceof HttpError ? err.status : 500;
  const detail = err instanceof HttpError ? err.detail : err instanceof Error ? err.message : "Internal Server Error";
  res.status(status).json({ detail });
}

export function notFoundMiddleware(_req: Request, res: Response): void {
  res.status(404).json({ detail: "Not Found" });
}

/** 读取 JSON body（FastAPI 语义：非法 JSON 返回 400） */
export async function readJsonBody(req: Request): Promise<Record<string, any>> {
  const body = req.body;
  if (body !== undefined && body !== null && typeof body === "object") {
    return body as Record<string, any>;
  }
  return {};
}
