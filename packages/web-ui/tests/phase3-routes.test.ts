/**
 * 阶段三测试：报告导出（HTML 真实产物/PDF 缓存路径）、保留清理、录制代理（mock Runner）。
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createApp } from "../src/app.js";
import { runMigrations } from "../src/db/migrate.js";
import { getDb, closeDb } from "../src/db/connection.js";
import { createProject } from "../src/db/dao/projects.js";
import { createTask, addUpload } from "../src/db/dao/tasks.js";
import { addReportStep, createReport } from "../src/db/dao/reports.js";
import { createPlan } from "../src/db/dao/plans.js";
import { setSystemConfig } from "../src/db/dao/configs.js";
import { ARTIFACTS_DIR, REPORT_EXPORTS_DIR, UPLOADS_TMP_DIR, RECORD_SESSIONS_DIR } from "../src/paths.js";

const server = http.createServer(createApp());
let baseUrl = "";

beforeEach(async () => {
  runMigrations();
  getDb().exec(
    "DELETE FROM report_steps; DELETE FROM export_jobs; DELETE FROM reports; DELETE FROM plan_tasks; DELETE FROM plan_runs; DELETE FROM test_plans; DELETE FROM execution_logs; DELETE FROM task_runs; DELETE FROM executions; DELETE FROM tasks; DELETE FROM recording_projects; DELETE FROM uploads; DELETE FROM task_files; DELETE FROM record_sessions;",
  );
  // 清理导出产物目录残留
  try {
    for (const f of readdirExports()) rmSync(path.join(REPORT_EXPORTS_DIR, f), { force: true });
  } catch {
    /* pass */
  }
  if (!server.listening) {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

function readdirExports(): string[] {
  try {
    return readdirSync(REPORT_EXPORTS_DIR);
  } catch {
    return [];
  }
}

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});

async function jfetch(p: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${p}`, init);
  return { status: res.status, body: await res.json() };
}
const post = (p: string, data?: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data ?? {}),
});

function seedReport(): string {
  const project = createProject({ name: `EP${Date.now()}${Math.random().toString(36).slice(2, 5)}`, type: "ai", scriptContent: "{}" });
  const task = createTask({ name: "导出任务", projectId: project.id, scriptSource: "project", scriptSnapshot: "s" });
  const report = createReport({
    type: "task", taskId: task.id, name: "导出报告", status: "failed",
    totalSteps: 2, passedSteps: 1, failedSteps: 1, errorMessage: "Timeout",
  });
  addReportStep({ reportId: report.id, stepIndex: 1, method: "navigate", description: "打开页面", status: "passed", durationMs: 100 });
  addReportStep({ reportId: report.id, stepIndex: 2, method: "click", description: "点击登录", status: "failed", error: "Timeout", durationMs: 200 });
  return report.id;
}

async function waitExportDone(exportId: string, timeoutMs = 10000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { body } = await jfetch(`/api/exports/${exportId}`);
    if (body.data.status !== "processing") return body.data;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("导出超时");
}

describe("报告导出（RPT-03/04）", () => {
  it("HTML 导出：任务完成、文件存在、内容自包含且离线可看", async () => {
    const rid = seedReport();
    const start = await jfetch(`/api/reports/${rid}/exports`, post(`/api/reports/${rid}/exports`, { format: "html" }));
    expect(start.status).toBe(200);
    const done = await waitExportDone(start.body.data.exportId);
    expect(done.status).toBe("done");
    expect(done.downloadUrl).toContain("/api/files/reports/exports/");

    // 文件真实存在且内容正确
    const htmlPath = path.join(REPORT_EXPORTS_DIR, `${rid}.html`);
    expect(existsSync(htmlPath)).toBe(true);
    const html = readFileSync(htmlPath, "utf-8");
    expect(html).toContain("导出报告");
    expect(html).toContain("通过率");
    expect(html).toContain("50.0%");
    expect(html).toContain("Timeout");
    // 详情回填 exports.html
    const detail = await jfetch(`/api/reports/${rid}`);
    expect(detail.body.data.exports.html.url).toBeTruthy();

    // 下载可访问
    const dl = await fetch(`${baseUrl}${done.downloadUrl}`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("text/html; charset=utf-8");
  }, 20000);

  it("重复导出直接复用缓存（新任务 done）", async () => {
    const rid = seedReport();
    const first = await jfetch(`/api/reports/${rid}/exports`, post(`/api/reports/${rid}/exports`, { format: "html" }));
    await waitExportDone(first.body.data.exportId);
    const second = await jfetch(`/api/reports/${rid}/exports`, post(`/api/reports/${rid}/exports`, { format: "html" }));
    const secondDone = await jfetch(`/api/exports/${second.body.data.exportId}`);
    expect(secondDone.body.data.status).toBe("done");
    expect(secondDone.body.data.progress).toBe(100);
  }, 20000);

  it("非法 format → 400；不存在的导出任务 → 404", async () => {
    const rid = seedReport();
    const bad = await jfetch(`/api/reports/${rid}/exports`, post(`/api/reports/${rid}/exports`, { format: "xlsx" }));
    expect(bad.status).toBe(400);
    const missing = await jfetch("/api/exports/exp_nope");
    expect(missing.status).toBe(404);
  });

  it("汇总报告（type=plan）导出含任务结果表", async () => {
    const project = createProject({ name: `SP${Date.now()}`, type: "ai", scriptContent: "{}" });
    const task = createTask({ name: "T", projectId: project.id, scriptSource: "project", scriptSnapshot: "s" });
    const plan = createPlan({ name: "汇总计划", taskIds: [task.id] });
    const report = createReport({
      type: "plan", planId: plan.id, name: "汇总报告", status: "failed",
      totalSteps: 2, passedSteps: 1, failedSteps: 1,
      taskResults: [
        { taskId: task.id, name: "任务A", status: "success", runId: "run_a" },
        { taskId: "task_b", name: "任务B", status: "failed", runId: "run_b" },
      ],
    });
    const start = await jfetch(`/api/reports/${report.id}/exports`, post(`/api/reports/${report.id}/exports`, { format: "html" }));
    await waitExportDone(start.body.data.exportId);
    const html = readFileSync(path.join(REPORT_EXPORTS_DIR, `${report.id}.html`), "utf-8");
    expect(html).toContain("任务结果");
    expect(html).toContain("任务A");
    expect(html).toContain("任务B");
  }, 20000);
});

describe("保留清理（RPT-06）", () => {
  it("超量报告删除并级联 executions/logs", async () => {
    // 限额设为 2
    setSystemConfig("report.retention", { maxPerTask: 2, maxAgeDays: 90 });
    const project = createProject({ name: `RC${Date.now()}`, type: "ai", scriptContent: "{}" });
    const task = createTask({ name: "清理任务", projectId: project.id, scriptSource: "project", scriptSnapshot: "s" });

    // 造 4 份报告（各挂一个 execution + 日志）
    const { createTaskRun, createExecution, appendExecutionLog } = await import("../src/db/dao/runs.js");
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const run = createTaskRun({ taskId: task.id, scheduleMode: "manual" });
      const exec = createExecution({ runId: run.id, taskId: task.id, iterationIndex: 1 });
      appendExecutionLog({ executionId: exec.id, message: `log-${i}` });
      const r = createReport({
        type: "task", taskId: task.id, runId: run.id, executionId: exec.id,
        name: `报告${i}`, status: "success",
      });
      ids.push(r.id);
    }

    const { runRetentionCleanup } = await import("../src/services/retention-cleaner.js");
    const stats = runRetentionCleanup();

    // 保留最近 2 份（按 created_at DESC），删除最旧 2 份
    expect(stats.deletedReports).toBe(2);
    expect(stats.deletedExecutions).toBe(2);
    // 剩余报告是最新的两份
    const remaining = getDb().prepare("SELECT id FROM reports ORDER BY created_at DESC").all() as Array<{ id: string }>;
    expect(remaining.length).toBe(2);
    expect(remaining.map((r) => r.id)).toEqual(expect.arrayContaining([ids[3]!, ids[2]!]));
    // executions/logs 级联删除
    const execCount = (getDb().prepare("SELECT COUNT(*) AS n FROM executions").get() as { n: number }).n;
    expect(execCount).toBe(2);
    const logCount = (getDb().prepare("SELECT COUNT(*) AS n FROM execution_logs").get() as { n: number }).n;
    expect(logCount).toBe(2);
  });

  it("过期 uploads 清理（TTL）", async () => {
    // 造一条已过期上传（expires_at 过去时间）
    const dir = UPLOADS_TMP_DIR;
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "upl_expired_x.txt"), "old");
    getDb()
      .prepare("INSERT INTO uploads (id, filename, stored_path, size, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("upl_expired", "x.txt", "upl_expired_x.txt", 3, new Date().toISOString(), "2020-01-01T00:00:00Z");

    const { runRetentionCleanup } = await import("../src/services/retention-cleaner.js");
    const stats = runRetentionCleanup();
    expect(stats.deletedUploads).toBe(1);
    expect(existsSync(path.join(dir, "upl_expired_x.txt"))).toBe(false);
    const row = getDb().prepare("SELECT COUNT(*) AS n FROM uploads WHERE id = ?").get("upl_expired") as { n: number };
    expect(row.n).toBe(0);
  });

  it("心跳超时录制会话 → lost（E5）", async () => {
    const { RECORD_HEARTBEATS } = await import("../src/routes/internal.routes.js");
    getDb()
      .prepare("INSERT INTO record_sessions (id, project_id, url, status, created_at) VALUES (1, NULL, 'http://x', 'recording', ?)")
      .run(new Date().toISOString());
    // 心跳时间戳设为 60s 前（超过 15s 阈值）
    RECORD_HEARTBEATS.set(1, Date.now() - 60_000);

    const { runRetentionCleanup } = await import("../src/services/retention-cleaner.js");
    const stats = runRetentionCleanup();
    expect(stats.lostRecordSessions).toBe(1);
    const row = getDb().prepare("SELECT status FROM record_sessions WHERE id = 1").get() as { status: string };
    expect(row.status).toBe("lost");
  });
});

describe("录制代理（REC-B01）", () => {
  /** mock Runner：记录请求并返回可控响应 */
  let mockRunner: http.Server;
  let runnerCalls: Array<{ path: string; body: any }> = [];
  let runnerMode: "ok" | "down" = "ok";

  beforeAll(async () => {
    mockRunner = http.createServer((req, resp) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        runnerCalls.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : {} });
        const reply =
          runnerMode === "ok"
            ? { ok: true, record_session_id: 1 }
            : { ok: false, reason: "already_recording" };
        resp.setHeader("Content-Type", "application/json");
        resp.end(JSON.stringify(req.url?.includes("/stop") ? { ok: true, record_session_id: 1 } : reply));
      });
    });
    await new Promise<void>((resolve) => mockRunner.listen(0, "127.0.0.1", () => resolve()));
    const addr = mockRunner.address() as { port: number };
    process.env.RUNNER_URL = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mockRunner.close(() => resolve()));
    delete process.env.RUNNER_URL;
  });

  beforeEach(() => {
    runnerCalls = [];
    runnerMode = "ok";
  });

  it("启动录制：建库 → 转发 Runner（注入回调 URL 与令牌）", async () => {
    const r = await jfetch("/api/record/sessions", post("/api/record/sessions", { url: "http://localhost:8000/#/login" }));
    expect(r.status).toBe(201);
    expect(r.body.data.recordSessionId).toBeGreaterThan(0);
    expect(r.body.data.status).toBe("recording");

    // Runner 收到转发请求且 callback 注入正确
    const call = runnerCalls.find((c) => c.path === "/record/start");
    expect(call).toBeTruthy();
    expect(call!.body.url).toBe("http://localhost:8000/#/login");
    expect(call!.body.callback.heartbeat_url).toContain("/internal/record/");
    expect(call!.body.callback.callback_url).toContain("/internal/record/");
    expect(call!.body.callback.api_key).toBeTruthy();
    // DB 状态
    const row = getDb().prepare("SELECT status FROM record_sessions ORDER BY id DESC LIMIT 1").get() as { status: string };
    expect(row.status).toBe("recording");
  });

  it("Runner 拒绝（already_recording）→ 会话 failed + 400", async () => {
    runnerMode = "down";
    const r = await jfetch("/api/record/sessions", post("/api/record/sessions", { url: "http://x" }));
    expect(r.status).toBe(400);
    const row = getDb().prepare("SELECT status FROM record_sessions ORDER BY id DESC LIMIT 1").get() as { status: string };
    expect(row.status).toBe("failed");
  });

  it("非法 URL → 400", async () => {
    const r = await jfetch("/api/record/sessions", post("/api/record/sessions", { url: "not-a-url" }));
    expect(r.status).toBe(400);
  });

  it("停止幂等：已终态会话直接返回", async () => {
    getDb()
      .prepare("INSERT INTO record_sessions (id, project_id, url, status, created_at) VALUES (99, NULL, 'http://x', 'completed', ?)")
      .run(new Date().toISOString());
    const r = await jfetch("/api/record/sessions/99/stop", post("/api/record/sessions/99/stop"));
    expect(r.status).toBe(200);
    expect(r.body.data.alreadyStopped).toBe(true);
  });

  it("to-project：动作流 → 标准步骤流项目（REC-A08）", async () => {
    // 造会话 + 动作文件
    const sid = 42;
    const dir = path.join(RECORD_SESSIONS_DIR, String(sid));
    mkdirSync(dir, { recursive: true });
    const actions = [
      { action_type: "navigate", url: "http://x/login", timestamp: 1 },
      { action_type: "input", selector: "#username", value: "admin", timestamp: 2, candidates: ["#username", "input[name=u]"] },
      { action_type: "click", selector: "#submit", timestamp: 3 },
    ];
    writeFileSync(path.join(dir, "actions.jsonl"), actions.map((a) => JSON.stringify(a)).join("\n") + "\n", "utf-8");
    getDb()
      .prepare("INSERT INTO record_sessions (id, project_id, url, status, actions_count, actions_path, created_at) VALUES (?, NULL, 'http://x', 'completed', 3, ?, ?)")
      .run(sid, `record-sessions/${sid}/actions.jsonl`, new Date().toISOString());

    const r = await jfetch(`/api/record/sessions/${sid}/to-project`, post(`/api/record/sessions/${sid}/to-project`, { name: "录制转项目" }));
    expect(r.status).toBe(200);
    expect(r.body.data.steps).toBe(3);
    expect(r.body.data.projectId).toMatch(/^proj_/);
    expect(r.body.data.scriptLang).toBe("js");

    // 项目内容校验：scriptContent 为可执行 Playwright JS（自动生成）
    const detail = await jfetch(`/api/projects/${r.body.data.projectId}`);
    expect(detail.body.data.type).toBe("browser");
    expect(detail.body.data.scriptLang).toBe("js");
    const script = detail.body.data.scriptContent as string;
    expect(script).toContain("autoShot");
    expect(script).toContain("playwright");
    expect(script).toContain("page.fill('#username', 'admin')");
    expect(script).toContain("page.click('#submit')");
    // 原始步骤流留档于 recordConfig（详情返回已解析对象，供编辑/再生成）
    const cfg = detail.body.data.recordConfig;
    expect(cfg.steps[1].method).toBe("input");
    expect(cfg.steps[1].locator.primary).toBe("#username");
  });

  it("regenerate-script：步骤流再生成 JS 脚本", async () => {
    // 自建项目（recordConfig 存步骤流），验证再生成
    const created = await jfetch("/api/projects", post("/api/projects", {
      name: "再生项目", type: "browser", status: "ready",
      scriptContent: "// old", scriptLang: "js",
      recordConfig: { steps: [
        { method: "open_url", params: { value: "http://x" }, locator: { primary: "" }, desc: "打开" },
        { method: "fill_value", params: { value: "u" }, locator: { primary: "#u" }, desc: "输入" },
      ] },
    }));
    const pid = created.body.data.id;
    const regen = await jfetch(`/api/projects/${pid}/regenerate-script`, post(`/api/projects/${pid}/regenerate-script`));
    expect(regen.status).toBe(200);
    expect(regen.body.data.scriptLang).toBe("js");
    expect(regen.body.data.scriptPreview).toContain("autoShot");
    expect(regen.body.data.scriptPreview).toContain("require('path')");
    // 无步骤流项目 → 400
    const empty = await jfetch("/api/projects", post("/api/projects", { name: "空项目", type: "ai", scriptContent: "" }));
    const bad = await jfetch(`/api/projects/${empty.body.data.id}/regenerate-script`, post(`/api/projects/${empty.body.data.id}/regenerate-script`));
    expect(bad.status).toBe(400);
  });

  it("空动作流会话 → 400", async () => {
    const sid = 43;
    const dir = path.join(RECORD_SESSIONS_DIR, String(sid));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "actions.jsonl"), "", "utf-8");
    getDb()
      .prepare("INSERT INTO record_sessions (id, project_id, url, status, created_at) VALUES (?, NULL, 'http://x', 'completed', ?)")
      .run(sid, new Date().toISOString());
    const r = await jfetch(`/api/record/sessions/${sid}/to-project`, post(`/api/record/sessions/${sid}/to-project`, { name: "空" }));
    expect(r.status).toBe(400);
  });
});
