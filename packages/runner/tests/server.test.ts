import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRunnerApp, engine } from "../src/server.js";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = createRunnerApp();
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function json(pathname: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const resp = await fetch(`${base}${pathname}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  return { status: resp.status, body: await resp.json() };
}

describe("Runner HTTP 端点（1:1 runner_server.py）", () => {
  it("GET /health → engine.health()", async () => {
    const { status, body } = await json("/health");
    expect(status).toBe(200);
    expect(body.status).toBe("alive");
    expect(body.runner_id).toBeTruthy();
    expect(body.max_concurrent).toBeGreaterThan(0);
  });

  it("POST /run → 立即返回 task_id + accepted", async () => {
    const { status, body } = await json("/run", {
      method: "POST",
      body: JSON.stringify({ env: {}, callback: {} }),
    });
    expect(status).toBe(200);
    expect(body.status).toBe("accepted");
    expect(body.task_id).toBeTruthy();
    // 等待后台任务结束，避免影响后续断言
    const start = Date.now();
    while (engine.runningCount() > 0 && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 20));
    }
  });

  it("POST /stop/:execution_id → stopping", async () => {
    const { status, body } = await json("/stop/123", { method: "POST" });
    expect(status).toBe(200);
    expect(body).toEqual({ status: "stopping" });
  });

  it("POST /stop/all → stopping + stopped 数量", async () => {
    const { status, body } = await json("/stop/all", { method: "POST" });
    expect(status).toBe(200);
    expect(body.status).toBe("stopping");
    expect(body.stopped).toBe(0);
  });

  it("POST /record/start 缺少 record_session_id → missing_record_session_id", async () => {
    const { body } = await json("/record/start", { method: "POST", body: "{}" });
    expect(body).toEqual({ ok: false, reason: "missing_record_session_id" });
  });

  it("POST /record/:id/stop 无会话 → no_active_recorder", async () => {
    const { body } = await json("/record/5/stop", { method: "POST" });
    expect(body).toEqual({ ok: false, reason: "no_active_recorder" });
  });

  it("POST /record/:id/control 无会话 → no_active_recorder + command 回显", async () => {
    const { body } = await json("/record/5/control", {
      method: "POST",
      body: JSON.stringify({ command: "pause", var_name: "v", source: "text" }),
    });
    expect(body).toEqual({ ok: false, reason: "no_active_recorder", command: "pause" });
  });

  it("POST /debug/session/start 缺少 debug_session_id → missing_debug_session_id", async () => {
    const { body } = await json("/debug/session/start", { method: "POST", body: "{}" });
    expect(body).toEqual({ ok: false, reason: "missing_debug_session_id" });
  });

  it("POST /debug/session/:id/stop 无会话 → no_active_debug_session", async () => {
    const { body } = await json("/debug/session/5/stop", { method: "POST" });
    expect(body).toEqual({ ok: false, reason: "no_active_debug_session" });
  });

  it("未知路由 → 404 {detail: Not Found}（对齐 FastAPI）", async () => {
    const { status, body } = await json("/nope");
    expect(status).toBe(404);
    expect(body).toEqual({ detail: "Not Found" });
  });
});
