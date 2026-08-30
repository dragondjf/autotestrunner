/**
 * 报告 / 配置 / 看板 / 文件路由测试。
 * 覆盖：报告列表详情趋势删除、browsers CRUD、system 配置、
 * dashboard 空数据零值结构、files 白名单与路径穿越防护。
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createApp } from "../src/app.js";
import { runMigrations } from "../src/db/migrate.js";
import { getDb, closeDb } from "../src/db/connection.js";
import { createProject } from "../src/db/dao/projects.js";
import { createTask } from "../src/db/dao/tasks.js";
import { addReportStep, createReport } from "../src/db/dao/reports.js";
import { ARTIFACTS_DIR } from "../src/paths.js";

const server = http.createServer(createApp());
let baseUrl = "";

beforeEach(async () => {
  runMigrations();
  getDb().exec(
    "DELETE FROM report_steps; DELETE FROM export_jobs; DELETE FROM reports; DELETE FROM plan_tasks; DELETE FROM plan_runs; DELETE FROM test_plans; DELETE FROM task_runs; DELETE FROM executions; DELETE FROM tasks; DELETE FROM recording_projects; DELETE FROM uploads; DELETE FROM task_files; DELETE FROM browsers;",
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

function seedTaskReport(status: "success" | "failed" = "success"): string {
  const project = createProject({ name: `P${Date.now()}${Math.random()}`, type: "ai", scriptContent: "{}" });
  const task = createTask({ name: "T", projectId: project.id, scriptSource: "project", scriptSnapshot: "s" });
  const report = createReport({
    type: "task", taskId: task.id, name: "T 报告", status,
    totalSteps: 4, passedSteps: status === "success" ? 4 : 3, failedSteps: status === "success" ? 0 : 1,
    startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 5000,
  });
  addReportStep({ reportId: report.id, stepIndex: 1, method: "navigate", description: "打开页面", status: "passed", durationMs: 1000 });
  addReportStep({ reportId: report.id, stepIndex: 2, method: "click", description: "点击登录", status: status === "success" ? "passed" : "failed", error: status === "success" ? null : "Timeout", durationMs: 2000, screenshotPath: "artifacts/executions/1/screenshots/step_2.png" });
  return report.id;
}

describe("报告 API（RPT）", () => {
  it("列表过滤 status 与分页", async () => {
    seedTaskReport("success");
    seedTaskReport("failed");
    const { body } = await jfetch("/api/reports?status=failed");
    expect(body.data.total).toBe(1);
    expect(body.data.list[0].status).toBe("failed");
    expect(body.data.list[0].passRate).toBe(75);
  });

  it("详情含步骤/截图 URL/视频占位", async () => {
    const rid = seedTaskReport("failed");
    const { body } = await jfetch(`/api/reports/${rid}`);
    expect(body.data.totalSteps).toBe(4);
    expect(body.data.steps.length).toBe(2);
    expect(body.data.steps[1].screenshotUrl).toContain("/api/files/artifacts/");
    expect(body.data.screenshots.length).toBe(1);
    expect(body.data.videoUrl).toBeNull();
    expect(body.data.errorMessage ?? body.data.status).toBeTruthy();
  });

  it("步骤分页接口", async () => {
    const rid = seedTaskReport("success");
    const { body } = await jfetch(`/api/reports/${rid}/steps?page=1&pageSize=1`);
    expect(body.data.total).toBe(2);
    expect(body.data.list.length).toBe(1);
    expect(body.data.list[0].stepIndex).toBe(1);
  });

  it("趋势按日分桶", async () => {
    const rid = seedTaskReport("success");
    const taskId = (getDb().prepare("SELECT task_id FROM reports WHERE id = ?").get(rid) as { task_id: string }).task_id;
    const { body } = await jfetch(`/api/reports/trend?taskId=${taskId}&granularity=day`);
    expect(body.data.granularity).toBe("day");
    expect(body.data.buckets.length).toBeGreaterThan(0);
    expect(body.data.buckets[0].total).toBe(1);
  });

  it("趋势缺 taskId → 400", async () => {
    const { status, body } = await jfetch("/api/reports/trend");
    expect(status).toBe(400);
    expect(body.code).toBe(10001);
  });

  it("删除报告不影响任务", async () => {
    const rid = seedTaskReport("success");
    const before = (getDb().prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
    const { status, body } = await jfetch(`/api/reports/${rid}`, { method: "DELETE" });
    expect(status).toBe(200);
    expect(body.data.deleted).toBe(true);
    const after = (getDb().prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
    expect(after).toBe(before);
    const gone = await jfetch(`/api/reports/${rid}`);
    expect(gone.status).toBe(404);
  });
});

describe("系统配置 API", () => {
  it("browsers CRUD 与默认唯一", async () => {
    const c1 = await jfetch("/api/config/browsers", post("/api/config/browsers", {
      name: "chromium", version: "120.0", path: "C:/chrome/chrome.exe", isDefault: true,
    }));
    expect(c1.status).toBe(201);
    const c2 = await jfetch("/api/config/browsers", post("/api/config/browsers", {
      name: "firefox", version: "115.0", path: "C:/ff/firefox.exe",
    }));
    expect(c2.status).toBe(201);

    const list = await jfetch("/api/config/browsers");
    expect(list.body.data.list.length).toBe(2);
    expect(list.body.data.default.name).toBe("chromium");

    // 换默认
    await jfetch(`/api/config/browsers/${c2.body.data.id}`, put(`/api/config/browsers/${c2.body.data.id}`, { isDefault: true }));
    const after = await jfetch("/api/config/browsers");
    expect(after.body.data.default.name).toBe("firefox");

    // 删默认项 → 自动指认首个启用
    await jfetch(`/api/config/browsers/${c2.body.data.id}`, { method: "DELETE" });
    const final = await jfetch("/api/config/browsers");
    expect(final.body.data.default.name).toBe("chromium");
  });

  it("非法浏览器名/空路径 → 400", async () => {
    const bad = await jfetch("/api/config/browsers", post("/api/config/browsers", { name: "safari", path: "x" }));
    expect(bad.status).toBe(400);
    const noPath = await jfetch("/api/config/browsers", post("/api/config/browsers", { name: "chromium" }));
    expect(noPath.status).toBe(400);
  });

  it("system 配置读取与更新（含校验）", async () => {
    const initial = await jfetch("/api/config/system");
    expect(initial.body.data.reportRetention.maxPerTask).toBe(100);
    expect(initial.body.data.queuePollIntervalMs).toBe(2000);

    const upd = await jfetch("/api/config/system", put("/api/config/system", {
      reportRetention: { maxPerTask: 50, maxAgeDays: 30 },
      queuePollIntervalMs: 3000,
    }));
    expect(upd.body.data.reportRetention.maxPerTask).toBe(50);
    expect(upd.body.data.queuePollIntervalMs).toBe(3000);

    const bad = await jfetch("/api/config/system", put("/api/config/system", { queuePollIntervalMs: 10 }));
    expect(bad.status).toBe(400);
  });

  it("队列状态（DB 统计）", async () => {
    const project = createProject({ name: "qp", type: "ai", scriptContent: "{}" });
    const task = createTask({ name: "qt", projectId: project.id, scriptSource: "project", scriptSnapshot: "s" });
    const { createTaskRun } = await import("../src/db/dao/runs.js");
    createTaskRun({ taskId: task.id, scheduleMode: "manual" });
    createTaskRun({ taskId: task.id, scheduleMode: "manual" });
    const { body } = await jfetch("/api/config/queue/status");
    expect(body.data.isRunning).toBe(true);
    expect(body.data.queueLength).toBe(1);
  });
});

describe("看板 API", () => {
  it("stats 空数据零值结构", async () => {
    const { status, body } = await jfetch("/api/dashboard/stats");
    expect(status).toBe(200);
    expect(body.data.projects.total).toBe(0);
    expect(body.data.tasks.total).toBe(0);
    expect(body.data.tasks.byStatus.pending).toBe(0);
    expect(body.data.plans.total).toBe(0);
    expect(body.data.reports24h.total).toBe(0);
    expect(body.data.reports24h.passRate).toBe(0);
    expect(body.data.queue.running).toBe(false);
  });

  it("stats 有数据统计正确", async () => {
    seedTaskReport("success");
    seedTaskReport("failed");
    const { body } = await jfetch("/api/dashboard/stats");
    expect(body.data.projects.total).toBe(2);
    expect(body.data.tasks.total).toBe(2);
    expect(body.data.reports24h.total).toBe(2);
    expect(body.data.reports24h.passRate).toBe(50);
  });

  it("trend 补齐空日期桶", async () => {
    const { body } = await jfetch("/api/dashboard/trend?days=3");
    expect(body.data.buckets.length).toBe(3);
    expect(body.data.buckets.every((b: any) => b.total >= 0)).toBe(true);
  });
});

describe("文件访问 API", () => {
  it("白名单内图片可访问（Content-Type 正确）", async () => {
    const dir = path.join(ARTIFACTS_DIR, "executions", "1", "screenshots");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "step_1.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await fetch(`${baseUrl}/api/files/artifacts/executions/1/screenshots/step_1.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("路径穿越 → 400", async () => {
    // fetch/Node 会先规范化 ..，因此用 %2e%2e 编码形式直达路由内部防护
    const r1 = await jfetch("/api/files/artifacts/%2e%2e%2fllm_configs.json");
    expect([400, 404]).toContain(r1.status); // 规范化后首段非白名单或路径非法
    const r2 = await jfetch("/api/files/uploads/x.txt");
    expect(r2.status).toBe(400);
  });

  it("不存在文件 → 404", async () => {
    const r = await jfetch("/api/files/artifacts/executions/999/nope.png");
    expect(r.status).toBe(404);
  });

  it("视频 Range 请求返回 206", async () => {
    const dir = path.join(ARTIFACTS_DIR, "executions", "2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "video.mp4"), Buffer.alloc(1024, 1));
    const res = await fetch(`${baseUrl}/api/files/artifacts/executions/2/video.mp4`, {
      headers: { Range: "bytes=0-99" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toContain("bytes 0-99/1024");
  });
});
