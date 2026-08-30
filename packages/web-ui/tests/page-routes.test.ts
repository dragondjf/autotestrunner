import { describe, it, expect, beforeEach, afterAll } from "vitest";
import http from "node:http";
import { createApp } from "../src/app.js";
import { saveConfigs } from "../src/config-store.js";

const server = http.createServer(createApp());
let baseUrl = "";

beforeEach(async () => {
  saveConfigs([]);
  if (!server.listening) {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function setConfigs(data: unknown) {
  saveConfigs(Array.isArray(data) ? data : []);
}

describe("页面路由", () => {
  it("GET / 返回 index.html（真实前端页面，zh-CN 文档）", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("zh-CN");
  });

  it("GET /session/{id} 返回 index.html（SPA 深链）", async () => {
    const res = await fetch(`${baseUrl}/session/abc123`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("zh-CN");
  });

  it("GET /code-generator.js 返回该文件", async () => {
    const res = await fetch(`${baseUrl}/code-generator.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("CodeGenerator");
  });

  it("未匹配路由返回 404 {detail: Not Found}（对齐 FastAPI）", async () => {
    const res = await fetch(`${baseUrl}/no-such-path`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: "Not Found" });
  });

  it("/assets/* 响应带 Cache-Control: no-cache", async () => {
    const res = await fetch(`${baseUrl}/assets/js/bootstrap.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });
});

describe("LLM 配置 CRUD（page_routes.py）", () => {
  it("GET /api/llm-configs：空文件返回空数组", async () => {
    setConfigs([]);
    const res = await fetch(`${baseUrl}/api/llm-configs`);
    expect(await res.json()).toEqual([]);
  });

  it("GET /api/llm-configs：返回原始配置（含明文 api_key，1:1 保留差异）", async () => {
    setConfigs([{ id: "cfg_1", name: "A", api_key: "sk-1234567890", enabled: true, is_default: true }]);
    const res = await fetch(`${baseUrl}/api/llm-configs`);
    const data = (await res.json()) as Array<Record<string, unknown>>;
    expect(data[0]!["api_key"]).toBe("sk-1234567890");
  });

  it("GET /api/llm-configs/options 返回供应商列表", async () => {
    const res = await fetch(`${baseUrl}/api/llm-configs/options`);
    expect(await res.json()).toEqual(["通义千问", "DeepSeek", "智谱", "月之暗面", "OpenAI", "自定义"]);
  });

  it("POST 返回 201、id 前缀 cfg_、响应掩码", async () => {
    setConfigs([]);
    const res = await fetch(`${baseUrl}/api/llm-configs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "测试", api_key: "sk-1234567890", is_default: true }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body["id"])).toMatch(/^cfg_[0-9a-f]{8}$/);
    expect(body["api_key"]).toBe("sk-123****7890");
    // 存储中保存明文
    const stored = JSON.parse(await (await fetch(`${baseUrl}/api/llm-configs`)).text());
    expect(stored[0]["api_key"]).toBe("sk-1234567890");
    expect(stored[0]["is_default"]).toBe(true);
  });

  it("POST 名称为空 → 400 {detail: 配置名称不能为空}", async () => {
    const res = await fetch(`${baseUrl}/api/llm-configs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "  " }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: "配置名称不能为空" });
  });

  it("PUT 更新：掩码 api_key 保留原值，响应掩码", async () => {
    setConfigs([{ id: "cfg_1", name: "旧", api_key: "sk-original-1234", enabled: true, is_default: true }]);
    const res = await fetch(`${baseUrl}/api/llm-configs/cfg_1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "新", api_key: "sk-or****1234" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ id: "cfg_1", name: "新" });
    const stored = JSON.parse(await (await fetch(`${baseUrl}/api/llm-configs`)).text());
    expect(stored[0]["api_key"]).toBe("sk-original-1234");
  });

  it("PUT 不存在 → 404 {detail: 配置不存在}", async () => {
    setConfigs([]);
    const res = await fetch(`${baseUrl}/api/llm-configs/nope`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: "配置不存在" });
  });

  it("DELETE 成功 {ok:true}；不存在 → 404", async () => {
    setConfigs([{ id: "cfg_1", name: "A", enabled: true, is_default: true }]);
    const ok = await fetch(`${baseUrl}/api/llm-configs/cfg_1`, { method: "DELETE" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    const missing = await fetch(`${baseUrl}/api/llm-configs/cfg_1`, { method: "DELETE" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ detail: "配置不存在" });
  });

  it("toggle：禁用后让位并重算默认；启用时无默认则自设", async () => {
    setConfigs([
      { id: "a", enabled: true, is_default: true },
      { id: "b", enabled: true, is_default: false },
    ]);
    // 禁用 a（唯一默认）→ b 补位
    const r1 = await fetch(`${baseUrl}/api/llm-configs/a/toggle`, { method: "POST" });
    expect(r1.status).toBe(200);
    const stored1 = JSON.parse(await (await fetch(`${baseUrl}/api/llm-configs`)).text());
    expect(stored1.find((c: any) => c.id === "a")["enabled"]).toBe(false);
    expect(stored1.find((c: any) => c.id === "b")["is_default"]).toBe(true);

    // 再启用 a（此时 b 是默认）→ a 不自设默认
    await fetch(`${baseUrl}/api/llm-configs/a/toggle`, { method: "POST" });
    const stored2 = JSON.parse(await (await fetch(`${baseUrl}/api/llm-configs`)).text());
    expect(stored2.find((c: any) => c.id === "a")["enabled"]).toBe(true);
    expect(stored2.find((c: any) => c.id === "a")["is_default"]).toBe(false);
  });

  it("default：设为默认；禁用项 → 400 请先启用该配置再设为默认", async () => {
    setConfigs([
      { id: "a", enabled: true, is_default: true },
      { id: "b", enabled: true, is_default: false },
    ]);
    const ok = await fetch(`${baseUrl}/api/llm-configs/b/default`, { method: "POST" });
    expect(ok.status).toBe(200);
    const stored = JSON.parse(await (await fetch(`${baseUrl}/api/llm-configs`)).text());
    expect(stored.find((c: any) => c.id === "b")["is_default"]).toBe(true);
    expect(stored.find((c: any) => c.id === "a")["is_default"]).toBe(false);

    setConfigs([{ id: "c", enabled: false }]);
    const bad = await fetch(`${baseUrl}/api/llm-configs/c/default`, { method: "POST" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ detail: "请先启用该配置再设为默认" });
  });

  it("test：连通成功返回 ok/latency_ms/model/sample（HTTP 200）", async () => {
    // 起一个 OpenAI 兼容的假服务
    const fake = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "OK 可以对话" } }], usage: { total_tokens: 5 } }));
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", () => resolve()));
    const port = (fake.address() as { port: number }).port;

    setConfigs([
      { id: "t", name: "T", enabled: true, is_default: true, base_url: `http://127.0.0.1:${port}/v1`, model: "m-1" },
    ]);
    const res = await fetch(`${baseUrl}/api/llm-configs/t/test`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["model"]).toBe("m-1");
    expect(body["sample"]).toBe("OK 可以对话");
    expect(typeof body["latency_ms"]).toBe("number");
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  });

  it("test：失败仍返回 200 且 ok=false + error", async () => {
    const fake = http.createServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "bad key" }));
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", () => resolve()));
    const port = (fake.address() as { port: number }).port;
    setConfigs([
      { id: "t", name: "T", enabled: true, is_default: true, base_url: `http://127.0.0.1:${port}/v1`, model: "m-1" },
    ]);
    const res = await fetch(`${baseUrl}/api/llm-configs/t/test`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["ok"]).toBe(false);
    expect(String(body["error"])).toContain("401");
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  });
});
