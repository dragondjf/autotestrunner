import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { createApp } from "../src/app.js";
import { SESSIONS, SESSION_LOG, SESSION_META } from "../src/state.js";
import { sessionFile } from "../src/session-store.js";

const server = http.createServer(createApp());
let baseUrl = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  SESSIONS.clear();
  SESSION_LOG.clear();
  SESSION_META.clear();
});

describe("会话状态端点（agent_routes.py:241/256）", () => {
  it("GET /api/agent/session/{sid} 不存在 → 404", async () => {
    const res = await fetch(`${baseUrl}/api/agent/session/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: "会话不存在或已回收" });
  });

  it("GET /api/agent/session/{sid} 存在时返回 url/steps/urls_visited/last_active", async () => {
    const fake = {
      page: { url: () => "http://fake/x", _close: async () => undefined },
      all_steps: [{ method: "click_ele" }],
      urls_visited: ["http://fake/x"],
      _close: async () => undefined,
    };
    SESSIONS.set("s1", fake as never);
    const res = await fetch(`${baseUrl}/api/agent/session/s1`);
    const body = (await res.json()) as Record<string, any>;
    expect(body["session_id"]).toBe("s1");
    expect(body["url"]).toBe("http://fake/x");
    expect(body["steps"]).toHaveLength(1);
    expect(body["urls_visited"]).toEqual(["http://fake/x"]);
    expect(typeof body["last_active"] === "number" || body["last_active"] === null).toBe(true);
  });

  it("DELETE /api/agent/session/{sid}：成功 {ok:true}；不存在 → 404", async () => {
    SESSIONS.set("s2", {
      page: null,
      _close: async () => undefined,
    } as never);
    const ok = await fetch(`${baseUrl}/api/agent/session/s2`, { method: "DELETE" });
    expect(await ok.json()).toEqual({ ok: true, session_id: "s2" });
    expect(SESSIONS.has("s2")).toBe(false);

    const missing = await fetch(`${baseUrl}/api/agent/session/s2`, { method: "DELETE" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ detail: "会话不存在或已回收" });
  });
});

describe("历史会话端点（agent_routes.py:900/925/933）", () => {
  const sid = "hist-sid";

  beforeEach(() => {
    const p = sessionFile(sid);
    if (existsSync(p)) rmSync(p);
  });

  it("GET /api/sessions 列出磁盘历史并按 updated_at 倒序", async () => {
    writeFileSync(
      sessionFile(sid),
      JSON.stringify({
        session_id: sid,
        title: "标题A",
        created_at: 1,
        updated_at: 2,
        start_url: "http://a",
        last_url: "http://a/x",
        events: [{ type: "user" }, { type: "step" }],
        steps: [{ type: "step" }],
      }),
      "utf-8",
    );
    const res = await fetch(`${baseUrl}/api/sessions`);
    const items = (await res.json()) as Array<Record<string, any>>;
    const hit = items.find((i) => i["session_id"] === sid);
    expect(hit).toBeTruthy();
    expect(hit!["title"]).toBe("标题A");
    expect(hit!["msg_count"]).toBe(2);
    expect(hit!["step_count"]).toBe(1);
    // 倒序校验
    const times = items.map((i) => Number(i["updated_at"] ?? 0));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("GET /api/sessions/{sid} 返回完整磁盘 JSON；不存在 → 404", async () => {
    writeFileSync(sessionFile(sid), JSON.stringify({ session_id: sid, title: "T" }), "utf-8");
    const ok = await fetch(`${baseUrl}/api/sessions/${sid}`);
    expect((await ok.json()) as Record<string, any>).toMatchObject({ session_id: sid, title: "T" });

    const missing = await fetch(`${baseUrl}/api/sessions/never`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ detail: "会话历史不存在" });
  });

  it("DELETE /api/sessions/{sid} 删除磁盘并返回 {ok:true, session_id}", async () => {
    writeFileSync(sessionFile(sid), JSON.stringify({ session_id: sid }), "utf-8");
    const res = await fetch(`${baseUrl}/api/sessions/${sid}`, { method: "DELETE" });
    expect(await res.json()).toEqual({ ok: true, session_id: sid });
    expect(existsSync(sessionFile(sid))).toBe(false);
  });
});

describe("inspect 统一端点错误语义（agent_routes.py:820）", () => {
  it("会话不存在 → 404", async () => {
    const res = await fetch(`${baseUrl}/api/agent/session/nope/inspect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "screenshot" }),
    });
    expect(res.status).toBe(404);
  });

  it("缺 action → 400 缺少 action 参数；未知 action → 400 未知的 action: x", async () => {
    // 浏览器实例不可用（page=null）时先命中 409，故此处用带 page 的假实例验证 action 校验顺序
    SESSIONS.set("s3", { page: {}, _close: async () => undefined } as never);
    const noAction = await fetch(`${baseUrl}/api/agent/session/s3/inspect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(noAction.status).toBe(400);
    expect(await noAction.json()).toEqual({ detail: "缺少 action 参数" });

    const bad = await fetch(`${baseUrl}/api/agent/session/s3/inspect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "what" }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ detail: "未知的 action: what" });
  });

  it("浏览器实例不可用 → 409 会话浏览器实例不可用", async () => {
    SESSIONS.set("s4", { page: null, _close: async () => undefined } as never);
    const res = await fetch(`${baseUrl}/api/agent/session/s4/inspect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "screenshot" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ detail: "会话浏览器实例不可用" });
  });
});

describe("live 端点存在性校验", () => {
  it("会话不存在 → 404；实例不可用 → 409", async () => {
    const r1 = await fetch(`${baseUrl}/api/agent/session/nope/live`);
    expect(r1.status).toBe(404);
    SESSIONS.set("s5", { page: null, _close: async () => undefined } as never);
    const r2 = await fetch(`${baseUrl}/api/agent/session/s5/live`);
    expect(r2.status).toBe(409);
  });
});
