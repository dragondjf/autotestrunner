/**
 * 录制项目 + 上传路由测试。
 * 覆盖：CRUD / 重名 10003 / 步骤流校验 / 级联删除 / 运行中拦截 / 上传语法校验。
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import http from "node:http";
import { createApp } from "../src/app.js";
import { runMigrations } from "../src/db/migrate.js";
import { getDb, closeDb } from "../src/db/connection.js";
import { createTask } from "../src/db/dao/tasks.js";
import { createTaskRun } from "../src/db/dao/runs.js";

const server = http.createServer(createApp());
let baseUrl = "";

beforeEach(async () => {
  runMigrations();
  getDb().exec("DELETE FROM task_runs; DELETE FROM executions; DELETE FROM tasks; DELETE FROM recording_projects; DELETE FROM uploads;");
  if (!server.listening) {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});

async function jfetch(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, init);
  return { status: res.status, body: await res.json() };
}

function post(path: string, data: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) };
}

const validSteps = JSON.stringify({ steps: [{ method: "navigate", params: { url: "http://x" } }] });

describe("项目 CRUD（REC-P）", () => {
  it("POST 创建 → 201 前缀 ID + 默认 draft", async () => {
    const { status, body } = await jfetch("/api/projects", post("/api/projects", {
      name: "登录流程", type: "ai", startUrl: "http://localhost:8000/#/login", scriptContent: validSteps,
    }));
    expect(status).toBe(201);
    expect(body.code).toBe(0);
    expect(body.data.id).toMatch(/^proj_/);
    expect(body.data.status).toBe("draft");
    expect(body.data.stepsCount).toBe(1);
  });

  it("POST 重名 → 409 code=10003", async () => {
    await jfetch("/api/projects", post("/api/projects", { name: "重复", type: "ai" }));
    const { status, body } = await jfetch("/api/projects", post("/api/projects", { name: "重复", type: "browser" }));
    expect(status).toBe(409);
    expect(body.code).toBe(10003);
  });

  it("POST 步骤流非法 → 400 指明步骤序号", async () => {
    const bad = JSON.stringify({ steps: [{ params: {} }] });
    const { status, body } = await jfetch("/api/projects", post("/api/projects", {
      name: "非法", type: "ai", scriptContent: bad,
    }));
    expect(status).toBe(400);
    expect(body.message).toContain("第 1 个步骤");
  });

  it("GET 列表支持 keyword/type 过滤与分页", async () => {
    await jfetch("/api/projects", post("/api/projects", { name: "AI一号", type: "ai" }));
    await jfetch("/api/projects", post("/api/projects", { name: "浏览器二号", type: "browser" }));
    const { body } = await jfetch("/api/projects?type=browser&page=1&pageSize=10");
    expect(body.data.total).toBe(1);
    expect(body.data.list[0].name).toBe("浏览器二号");
    const kw = await jfetch("/api/projects?keyword=一号");
    expect(kw.body.data.total).toBe(1);
  });

  it("PUT 编辑脚本且有关联任务 → 附 warnings", async () => {
    const { body: created1 } = await jfetch("/api/projects", post("/api/projects", {
      name: "原始", type: "ai", scriptContent: validSteps, status: "ready",
    }));
    createTask({
      name: "任务", projectId: created1.data.id, scriptSource: "project", scriptSnapshot: validSteps,
    });
    const { body } = await jfetch(`/api/projects/${created1.data.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scriptContent: JSON.stringify({ steps: [{ method: "click", params: {} }] }) }),
    });
    expect(body.data.warnings.length).toBe(1);
    expect(body.data.warnings[0]).toContain("仅影响后续新任务");
  });

  it("DELETE 级联删除任务并返回数量", async () => {
    const { body: created1 } = await jfetch("/api/projects", post("/api/projects", {
      name: "级联", type: "ai", scriptContent: validSteps, status: "ready",
    }));
    createTask({ name: "t1", projectId: created1.data.id, scriptSource: "project", scriptSnapshot: "s" });
    createTask({ name: "t2", projectId: created1.data.id, scriptSource: "project", scriptSnapshot: "s" });
    const { body } = await jfetch(`/api/projects/${created1.data.id}`, { method: "DELETE" });
    expect(body.data.deletedTasks).toBe(2);
    const after = await jfetch(`/api/projects/${created1.data.id}`);
    expect(after.status).toBe(404);
  });

  it("DELETE 存在运行中任务的项�目 → 409 code=20004", async () => {
    const { body: created1 } = await jfetch("/api/projects", post("/api/projects", {
      name: "运行中", type: "ai", scriptContent: validSteps, status: "ready",
    }));
    const task = createTask({ name: "t", projectId: created1.data.id, scriptSource: "project", scriptSnapshot: "s" });
    createTaskRun({ taskId: task.id, scheduleMode: "manual" });
    const { status, body } = await jfetch(`/api/projects/${created1.data.id}`, { method: "DELETE" });
    expect(status).toBe(409);
    expect(body.code).toBe(20004);
  });

  it("详情含任务摘要与 archived 拦截提示", async () => {
    const { body: created1 } = await jfetch("/api/projects", post("/api/projects", {
      name: "归档", type: "ai", scriptContent: validSteps,
    }));
    await jfetch(`/api/projects/${created1.data.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "archived" }),
    });
    const { body } = await jfetch(`/api/projects/${created1.data.id}`);
    expect(body.data.createTaskDisabled).toBe(true);
    expect(body.data.createTaskDisabledReason).toContain("归档");
  });
});

describe("上传（TSK-03）", () => {
  async function upload(name: string, content: string, kind: string): Promise<{ status: number; body: any }> {
    const fd = new FormData();
    fd.append("kind", kind);
    fd.append("file", new Blob([content]), name);
    const res = await fetch(`${baseUrl}/api/uploads`, { method: "POST", body: fd });
    return { status: res.status, body: await res.json() };
  }

  it("合法 JS 脚本上传成功且语法校验通过", async () => {
    const { status, body } = await upload("login.spec.js", "async function run(page, params) { await page.goto(params.url); }", "script");
    expect(status).toBe(201);
    expect(body.data.uploadId).toMatch(/^upl_/);
    expect(body.data.syntaxCheck.ok).toBe(true);
  });

  it("语法错误的 JS 脚本 → 400 code=10004 带错误详情", async () => {
    const { status, body } = await upload("bad.spec.js", "async function run( {", "script");
    expect(status).toBe(400);
    expect(body.code).toBe(10004);
    expect(body.errors.error).toBeTruthy();
  });

  it("非脚本扩展名 → 10004", async () => {
    const { status, body } = await upload("a.exe", "x", "script");
    expect(status).toBe(400);
    expect(body.code).toBe(10004);
  });

  it("资源文件任意类型可上传", async () => {
    const { status, body } = await upload("data.csv", "a,b\n1,2", "resource");
    expect(status).toBe(201);
    expect(body.data.filename).toBe("data.csv");
  });
});
