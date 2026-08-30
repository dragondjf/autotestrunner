/**
 * 测试任务 + 测试计划路由测试。
 * 覆盖：向导创建（快照/上传转正/params 校验/调度合法性）、编辑限制、
 * executions 列表、计划排序写入/空任务 30003/无效 ID/Cron 校验/执行中拦截。
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import http from "node:http";
import { createApp } from "../src/app.js";
import { runMigrations } from "../src/db/migrate.js";
import { getDb, closeDb } from "../src/db/connection.js";
import { createProject } from "../src/db/dao/projects.js";
import { createTask } from "../src/db/dao/tasks.js";
import { createPlan, updatePlanStatus } from "../src/db/dao/plans.js";

const server = http.createServer(createApp());
let baseUrl = "";

beforeEach(async () => {
  runMigrations();
  getDb().exec(
    "DELETE FROM plan_tasks; DELETE FROM plan_runs; DELETE FROM test_plans; DELETE FROM task_runs; DELETE FROM executions; DELETE FROM tasks; DELETE FROM recording_projects; DELETE FROM uploads; DELETE FROM task_files;",
  );
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

async function jfetch(p: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${p}`, init);
  return { status: res.status, body: await res.json() };
}
const post = (p: string, data: unknown): RequestInit => ({
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
});
const put = (p: string, data: unknown): RequestInit => ({
  method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
});

const STEPS = JSON.stringify({ steps: [{ method: "navigate", params: { url: "http://x" } }] });

function seedProject(name = "项目", paramsSchema?: unknown): string {
  const p = createProject({
    name, type: "ai", status: "ready", scriptContent: STEPS, paramsSchema,
  });
  return p.id;
}

describe("任务向导创建（TSK-02/03）", () => {
  it("project 来源：快照复制自项目脚本", async () => {
    const pid = seedProject();
    const { status, body } = await jfetch("/api/tasks", post("/api/tasks", {
      name: "登录回归", scriptSource: "project", projectId: pid,
      browserType: "chromium", schedule: { mode: "manual" },
    }));
    expect(status).toBe(201);
    expect(body.data.id).toMatch(/^task_/);
    expect(body.data.scriptLang).toBe("json");
    expect(body.data.snapshotBytes).toBeGreaterThan(0);
  });

  it("upload 来源：脚本上传转正 task-files，快照为文件内容", async () => {
    const fd = new FormData();
    fd.append("kind", "script");
    fd.append("file", new Blob(["async function run(page){ await page.goto('http://x'); }"]), "login.spec.js");
    const up = await fetch(`${baseUrl}/api/uploads`, { method: "POST", body: fd });
    const upBody = await up.json();

    const { status, body } = await jfetch("/api/tasks", post("/api/tasks", {
      name: "上传任务", scriptSource: "upload", scriptUploadId: upBody.data.uploadId,
    }));
    expect(status).toBe(201);
    expect(body.data.scriptLang).toBe("js");

    const detail = await jfetch(`/api/tasks/${body.data.id}`);
    expect(detail.body.data.scriptPreview).toContain("page.goto");
    expect(detail.body.data.files.length).toBe(1);
    expect(detail.body.data.files[0].kind).toBe("script");
  });

  it("资源文件批量转正", async () => {
    const fd1 = new FormData();
    fd1.append("kind", "resource");
    fd1.append("file", new Blob(["a,b\n1,2"]), "users.csv");
    const up1 = await (await fetch(`${baseUrl}/api/uploads`, { method: "POST", body: fd1 })).json();
    const fd2 = new FormData();
    fd2.append("kind", "resource");
    fd2.append("file", new Blob(["name\n张三"]), "names.json");
    const up2 = await (await fetch(`${baseUrl}/api/uploads`, { method: "POST", body: fd2 })).json();

    const { body } = await jfetch("/api/tasks", post("/api/tasks", {
      name: "带资源", scriptSource: "project", projectId: seedProject(),
      resourceUploadIds: [up1.data.uploadId, up2.data.uploadId],
    }));
    expect(body.data.resourceCount).toBe(2);
    const detail = await jfetch(`/api/tasks/${body.data.id}`);
    expect(detail.body.data.files.filter((f: any) => f.kind === "resource").length).toBe(2);
  });

  it("params 必填校验（REC-C02）", async () => {
    const pid = seedProject("参数项目", {
      type: "object",
      properties: { username: { type: "string" }, password: { type: "string" } },
      required: ["username", "password"],
    });
    const { status, body } = await jfetch("/api/tasks", post("/api/tasks", {
      name: "缺参", scriptSource: "project", projectId: pid,
      params: { username: "admin" },
    }));
    expect(status).toBe(400);
    expect(body.message).toContain("password");
  });

  it("调度合法性：time 缺时长 / count 越界 → 20005", async () => {
    const pid = seedProject();
    const t1 = await jfetch("/api/tasks", post("/api/tasks", {
      name: "t", scriptSource: "project", projectId: pid, schedule: { mode: "time" },
    }));
    expect(t1.status).toBe(400);
    expect(t1.body.code).toBe(20005);

    const t2 = await jfetch("/api/tasks", post("/api/tasks", {
      name: "t", scriptSource: "project", projectId: pid,
      schedule: { mode: "count", iterations: 0 },
    }));
    expect(t2.status).toBe(400);
    expect(t2.body.code).toBe(20005);

    const ok1 = await jfetch("/api/tasks", post("/api/tasks", {
      name: "t", scriptSource: "project", projectId: pid,
      schedule: { mode: "count", iterations: 5, intervalMs: 100 },
    }));
    expect(ok1.status).toBe(201);
    expect(ok1.body.data.scheduleMode).toBe("count");
  });

  it("upload 来源但引用无效 → 20006", async () => {
    const { status, body } = await jfetch("/api/tasks", post("/api/tasks", {
      name: "坏引用", scriptSource: "upload", scriptUploadId: "upl_notexist",
    }));
    expect(status).toBe(400);
    expect(body.code).toBe(20006);
  });
});

describe("任务编辑/删除/历史（TSK-04/05/10）", () => {
  it("快照字段不可改 → 10001", async () => {
    const pid = seedProject();
    const { body } = await jfetch("/api/tasks", post("/api/tasks", {
      name: "t", scriptSource: "project", projectId: pid,
    }));
    const r = await jfetch(`/api/tasks/${body.data.id}`, put(`/api/tasks/${body.data.id}`, {
      scriptSnapshot: "changed", name: "新名",
    }));
    expect(r.status).toBe(400);
    expect(r.body.message).toContain("scriptSnapshot");
  });

  it("正常编辑调度与重试次数", async () => {
    const pid = seedProject();
    const { body } = await jfetch("/api/tasks", post("/api/tasks", {
      name: "t", scriptSource: "project", projectId: pid,
    }));
    const r = await jfetch(`/api/tasks/${body.data.id}`, put(`/api/tasks/${body.data.id}`, {
      maxRetries: 5, schedule: { mode: "count", iterations: 3 },
    }));
    expect(r.body.data.maxRetries).toBe(5);
    expect(r.body.data.scheduleMode).toBe("count");
  });

  it("运行中任务禁止编辑/删除 → 20004", async () => {
    const pid = seedProject();
    const { body } = await jfetch("/api/tasks", post("/api/tasks", {
      name: "t", scriptSource: "project", projectId: pid,
    }));
    // 直接造一个 queued run（执行引擎阶段二前的数据准备）
    const { createTaskRun } = await import("../src/db/dao/runs.js");
    createTaskRun({ taskId: body.data.id, scheduleMode: "manual" });
    const edit = await jfetch(`/api/tasks/${body.data.id}`, put(`/api/tasks/${body.data.id}`, { name: "x" }));
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe(20004);
    const del = await jfetch(`/api/tasks/${body.data.id}`, { method: "DELETE" });
    expect(del.status).toBe(409);
  });

  it("executions 历史列表（TSK-10）", async () => {
    const pid = seedProject();
    const { body } = await jfetch("/api/tasks", post("/api/tasks", {
      name: "t", scriptSource: "project", projectId: pid,
    }));
    const { createTaskRun, createExecution } = await import("../src/db/dao/runs.js");
    const run = createTaskRun({ taskId: body.data.id, scheduleMode: "count", plannedIterations: 3 });
    createExecution({ runId: run.id, taskId: body.data.id, iterationIndex: 1 });
    createExecution({ runId: run.id, taskId: body.data.id, iterationIndex: 2 });

    const hist = await jfetch(`/api/tasks/${body.data.id}/executions`);
    expect(hist.body.data.total).toBe(2);
    expect(hist.body.data.list[0].iterationIndex).toBe(2);
  });
});

describe("测试计划（PLN-01~04）", () => {
  function seedTwoTasks(): string[] {
    const pid = seedProject();
    const t1 = createTask({ name: "T1", projectId: pid, scriptSource: "project", scriptSnapshot: "s" });
    const t2 = createTask({ name: "T2", projectId: pid, scriptSource: "project", scriptSnapshot: "s" });
    return [t1.id, t2.id];
  }

  it("创建：taskIds 顺序写入 sort_order", async () => {
    const [a, b] = seedTwoTasks();
    const { status, body } = await jfetch("/api/plans", post("/api/plans", {
      name: "每日回归", taskIds: [a, b], cronExpr: "0 2 * * *",
    }));
    expect(status).toBe(201);
    expect(body.data.id).toMatch(/^plan_/);
    expect(body.data.tasks.map((t: any) => t.id)).toEqual([a, b]);
    expect(body.data.tasks[0].sortOrder).toBe(0);
    expect(body.data.cronExpr).toBe("0 2 * * *");
  });

  it("空任务列表 → 30003；无效任务 ID → 10002", async () => {
    const empty = await jfetch("/api/plans", post("/api/plans", { name: "空", taskIds: [] }));
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe(30003);

    const bad = await jfetch("/api/plans", post("/api/plans", { name: "坏", taskIds: ["task_nope"] }));
    expect(bad.status).toBe(404);
    expect(bad.body.code).toBe(10002);
  });

  it("Cron 格式校验", async () => {
    const [a] = seedTwoTasks();
    const bad = await jfetch("/api/plans", post("/api/plans", { name: "c", taskIds: [a], cronExpr: "bad cron" }));
    expect(bad.status).toBe(400);
  });

  it("编辑重排 taskIds（整体替换 sort_order）", async () => {
    const [a, b] = seedTwoTasks();
    const { body } = await jfetch("/api/plans", post("/api/plans", { name: "p", taskIds: [a, b] }));
    const r = await jfetch(`/api/plans/${body.data.id}`, put(`/api/plans/${body.data.id}`, {
      taskIds: [b, a],
    }));
    expect(r.body.data.tasks.map((t: any) => t.id)).toEqual([b, a]);
  });

  it("执行中计划禁止编辑/删除 → 30002", async () => {
    const [a] = seedTwoTasks();
    const plan = createPlan({ name: "p", taskIds: [a] });
    const { createPlanRun } = await import("../src/db/dao/plans.js");
    createPlanRun(plan.id, "manual");
    const edit = await jfetch(`/api/plans/${plan.id}`, put(`/api/plans/${plan.id}`, { name: "x" }));
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe(30002);
    const del = await jfetch(`/api/plans/${plan.id}`, { method: "DELETE" });
    expect(del.status).toBe(409);
  });

  it("列表含 taskCount 与状态过滤", async () => {
    const [a, b] = seedTwoTasks();
    createPlan({ name: "p1", taskIds: [a, b] });
    createPlan({ name: "p2", taskIds: [a] });
    const { body } = await jfetch("/api/plans");
    expect(body.data.total).toBe(2);
    expect(body.data.list.find((p: any) => p.name === "p1").taskCount).toBe(2);
    updatePlanStatus((await jfetch("/api/plans")).body.data.list[0].id, "running");
    const filtered = await jfetch("/api/plans?status=running");
    expect(filtered.body.data.total).toBe(1);
  });
});
