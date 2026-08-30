import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { createApp } from "../src/app.js";

const server = http.createServer(createApp());
let baseUrl = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** 读取 SSE 流，解析为事件数组 */
async function readSse(res: Response, timeoutMs = 15000): Promise<Record<string, any>[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Record<string, any>[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);
      const line = chunk.trim();
      if (line.startsWith("data:")) {
        try {
          events.push(JSON.parse(line.slice(5).trim()));
        } catch {
          /* pass */
        }
      }
    }
    if (events.some((e) => e["type"] === "done")) break;
  }
  return events;
}

describe("POST /api/agent/run-script（exec_routes.py:57）", () => {
  it("正常执行：起始日志 → stdout → 完成 → done，且 SSE 头正确", async () => {
    const res = await fetch(`${baseUrl}/api/agent/run-script`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: 'console.log("hello-js");' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    const events = await readSse(res);
    expect(events[0]).toEqual({
      type: "log",
      level: "info",
      text: "🚀 执行 JavaScript 脚本 (node)…",
    });
    expect(events.some((e) => e["type"] === "log" && e["level"] === "info" && e["text"] === "hello-js")).toBe(true);
    expect(events.at(-2)).toEqual({
      type: "log",
      level: "ok",
      text: "✅ JS 脚本执行完成 (exit 0)",
    });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("stderr 输出为 level=error，退出码非 0 时给出异常退出文案", async () => {
    const res = await fetch(`${baseUrl}/api/agent/run-script`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: 'console.error("boom"); process.exit(3);' }),
    });
    const events = await readSse(res);
    expect(events.some((e) => e["level"] === "error" && e["text"] === "boom")).toBe(true);
    expect(events.at(-2)).toEqual({
      type: "log",
      level: "error",
      text: "❌ JS 脚本异常退出 (exit 3)",
    });
  });
});

describe("POST /api/agent/run-python（exec_routes.py:153）", () => {
  it("调用 python 子进程执行并流式回传", async () => {
    const res = await fetch(`${baseUrl}/api/agent/run-python`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: 'print("hello-py")' }),
    });
    expect(res.status).toBe(200);
    const events = await readSse(res as unknown as Response);
    expect(events[0]).toEqual({ type: "log", level: "info", text: "🚀 执行 Python 脚本…" });
    const finished = events.find(
      (e) => typeof e["text"] === "string" && String(e["text"]).startsWith("✅ Python 脚本执行完成"),
    );
    const failed = events.find(
      (e) => typeof e["text"] === "string" && String(e["text"]).startsWith("❌"),
    );
    // 环境无 python 时给出执行异常/未找到文案；有 python 时应输出 hello-py 并成功结束
    if (finished) {
      expect(events.some((e) => e["text"] === "hello-py")).toBe(true);
    } else {
      expect(failed).toBeTruthy();
    }
    expect(events.at(-1)).toEqual({ type: "done" });
  }, 20000);
});
