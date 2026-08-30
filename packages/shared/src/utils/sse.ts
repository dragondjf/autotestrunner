/**
 * SSE 工具。
 *
 * 对照点（agent_web_ui core.py 237-238）：
 * - 帧格式 `data: {json}\n\n`（JSON.stringify 默认不转义非 ASCII，等价 ensure_ascii=False）
 * - 响应头四件套：text/event-stream / no-cache / X-Accel-Buffering: no / keep-alive
 * - 命名事件（live 帧流 `event: frame`、pageswitch）单独支持
 */
import type { ServerResponse } from "node:http";

export const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no",
  Connection: "keep-alive",
};

export function sseFrame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export function sseStart(res: ServerResponse): void {
  res.writeHead(200, SSE_HEADERS);
  res.flushHeaders?.();
}

export function sseWrite(res: ServerResponse, obj: unknown): void {
  res.write(sseFrame(obj));
}

/** 命名事件帧：`event: {name}\ndata: {json}\n\n` */
export function sseNamedWrite(res: ServerResponse, event: string, obj: unknown): void {
  res.write(`event: ${event}\n${sseFrame(obj)}`);
}

export function sseEnd(res: ServerResponse): void {
  res.end();
}
