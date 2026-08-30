/**
 * 阶段二执行引擎测试（全链路）。
 * 覆盖：POST /tasks/:id/run（脚本通道，js 子进程真实执行）、监控详情、
 * 增量日志、停止幂等、重试、重复触发 20003、计划编排（run/pause/resume）、
 * 内部回调鉴权 401 与进度事件处理。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import http from "node:http";
import { createApp } from "../src/app.js";
import { runMigrations } from "../src/db/migrate.js";
import { getDb, closeDb } from "../src/db/connection.js";
import { createProject } from "../src/db/dao/projects.js";
import { createTask, getTask } from "../src/db/dao/tasks.js";
import { fetchExecutionLogs, getTaskRun, updateExecution, createTaskRun, createExecution, getExecution } from "../src/db/dao/runs.js";
import { getReport, listReportSteps } from "../src/db/dao/reports.js";
import { createPlan } from "../src/db/dao/plans.js";
import { pushDebugCommand } from "../src/routes/internal.routes.js";

const server = http.createServer(createApp());
let baseUrl = "";

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  runMigrations();
  getDb().exec(
    "DELETE FROM report_steps; DELETE FROM export_jobs; DELETE FROM reports; DELETE FROM plan_tasks; DELETE FROM plan_runs; DELETE FROM test_plans; DELETE FROM execution_logs; DELETE FROM task_runs; DELETE FROM executions; DELETE FROM tasks; DELETE FROM recording_projects; DELETE FROM uploads; DELETE FROM task_files;",
  );
  if (!server.listening) {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

afterAll(async () => {
  vi.useRealTimers();
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

/** 用 JS 脚本任务走子进程通道（不依赖 Runner 服务） */
function seedJsTask(script: string, maxRetries = 0): string {
  const project = createProject({ name: `P${Date.now()}${Math.random().toString(36).slice(2, 6)}`, type: "ai", scriptContent: "{}" });
  const task = createTask({
    name: "JS任务", projectId: project.id, scriptSource: "upload",
    scriptSnapshot: script, scriptLang: "js", maxRetries,
  });
  return task.id;
}

/** 等待 run 终态（轮询 DB，带超时） */
async function waitRunTerminal(runId: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = getTaskRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`run ${runId} 等待终态超时`);
}

describe("任务执行（脚本通道全链路）", () => {
  it("成功执行：run → execution → 日志 → 报告 → 任务 success", async () => {
    const taskId = seedJsTask("console.log('hello-step'); console.log('done');");
    const { status, body } = await jfetch(`/api/tasks/${taskId}/run`, post(`/api/tasks/${taskId}/run`));
    expect(status).toBe(200);
    expect(body.data.runId).toMatch(/^run_/);
    expect(body.data.queuePosition).toBe(1);

    await waitRunTerminal(body.data.runId);

    // run 终态
    const run = getTaskRun(body.data.runId)!;
    expect(run.status).toBe("completed");
    expect(run.successCount).toBe(1);
    expect(run.completedIterations).toBe(1);
    // 任务状态联动
    expect(getTask(taskId)!.status).toBe("success");
    // 报告生成
    const reportRow = getDb().prepare("SELECT id FROM reports WHERE execution_id IS NOT NULL LIMIT 1").get() as { id: string };
    const report = getReport(reportRow.id)!;
    expect(report.status).toBe("success");
  }, 30000);

  it("失败执行：报告 failed + error 记录", async () => {
    const taskId = seedJsTask("console.error('boom'); process.exit(1);");
    const { body } = await jfetch(`/api/tasks/${taskId}/run`, post(`/api/tasks/${taskId}/run`));
    await waitRunTerminal(body.data.runId);
    expect(getTask(taskId)!.status).toBe("failed");
    const execRow = getDb().prepare("SELECT * FROM executions LIMIT 1").get() as Record<string, unknown>;
    expect(execRow["status"]).toBe("failed");
    expect(String(execRow["error"])).toContain("boom");
    const reportRow = getDb().prepare("SELECT id FROM reports LIMIT 1").get() as { id: string };
    expect(getReport(reportRow.id)!.status).toBe("failed");
  }, 30000);

  it("执行中重复触发 → 20003（长脚本占用队列）", async () => {
    const taskId = seedJsTask("setTimeout(() => {}, 5000); console.log('slow');");
    const first = await jfetch(`/api/tasks/${taskId}/run`, post(`/api/tasks/${taskId}/run`));
    // 立即再次触发（此时 run 仍在执行）
    const dup = await jfetch(`/api/tasks/${taskId}/run`, post(`/api/tasks/${taskId}/run`));
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe(20003);
    // 停止以释放
    await jfetch(`/api/task-runs/${first.body.data.runId}/stop`, post(`/api/task-runs/${first.body.data.runId}/stop`));
    await waitRunTerminal(first.body.data.runId, 10000).catch(() => {});
  }, 30000);

  it("停止：停止请求 → run stopped，历史保留", async () => {
    const taskId = seedJsTask("setTimeout(() => console.log('late'), 8000); console.log('start');");
    const { body } = await jfetch(`/api/tasks/${taskId}/run`, post(`/api/tasks/${taskId}/run`));
    await new Promise((r) => setTimeout(r, 300)); // 等迭代开始
    const stop = await jfetch(`/api/task-runs/${body.data.runId}/stop`, post(`/api/task-runs/${body.data.runId}/stop`));
    expect(stop.status).toBe(200);
    expect(stop.body.data.stopped).toBe(true);
    await waitRunTerminal(body.data.runId, 15000);
    const run = getTaskRun(body.data.runId)!;
    expect(run.status).toBe("stopped");
    // 幂等：再次 stop 已终态 run
    const again = await jfetch(`/api/task-runs/${body.data.runId}/stop`, post(`/api/task-runs/${body.data.runId}/stop`));
    expect(again.status).toBe(200);
    expect(again.body.data.stopped).toBe(false);
  }, 30000);
});

describe("监控 API（TSK-09）", () => {
  it("run 详情含迭代列表与队列位置", async () => {
    const taskId = seedJsTask("console.log('x');");
    const { body } = await jfetch(`/api/tasks/${taskId}/run`, post(`/api/tasks/${taskId}/run`));
    await waitRunTerminal(body.data.runId);
    const detail = await jfetch(`/api/task-runs/${body.data.runId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.taskName).toBe("JS任务");
    expect(detail.body.data.scheduleMode).toBe("manual");
    expect(detail.body.data.plannedIterations).toBe(1);
    expect(detail.body.data.iterations.length).toBe(1);
    expect(detail.body.data.iterations[0].executionId).toBeGreaterThan(0);
  }, 30000);

  it("增量日志（afterSeq 游标）", async () => {
    const taskId = seedJsTask("console.log('line-1'); console.log('line-2');");
    const { body } = await jfetch(`/api/tasks/${taskId}/run`, post(`/api/tasks/${taskId}/run`));
    await waitRunTerminal(body.data.runId);
    const execRow = getDb().prepare("SELECT id FROM executions LIMIT 1").get() as { id: number };
    const all = await jfetch(`/api/task-runs/${body.data.runId}/logs`);
    expect(all.body.data.logs.length).toBeGreaterThan(0);
    const mid = Math.floor(all.body.data.logs.length / 2);
    const after = await jfetch(
      `/api/task-runs/${body.data.runId}/logs?afterSeq=${all.body.data.logs[mid].seq}`,
    );
    expect(after.body.data.logs.every((l: any) => l.seq > all.body.data.logs[mid].seq)).toBe(true);
    void execRow;
  }, 30000);

  it("回放视图（/api/executions/:id）", async () => {
    const taskId = seedJsTask("console.log('replay');");
    const { body } = await jfetch(`/api/tasks/${taskId}/run`, post(`/api/tasks/${taskId}/run`));
    await waitRunTerminal(body.data.runId);
    const execRow = getDb().prepare("SELECT id FROM executions LIMIT 1").get() as { id: number };
    const replay = await jfetch(`/api/executions/${execRow.id}`);
    expect(replay.status).toBe(200);
    expect(replay.body.data.status).toBe("success");
    expect(replay.body.data.logCount).toBeGreaterThan(0);
    expect(replay.body.data.reportId).toMatch(/^rpt_/);
    // 日志接口复用
    const logs = await jfetch(`/api/executions/${execRow.id}/logs?afterSeq=0`);
    expect(logs.body.data.logs.length).toBe(replay.body.data.logCount);
  }, 30000);
});

describe("重试机制（TSK-07）", () => {
  it("失败重试 attempt 递增，耗尽后 failed", async () => {
    const taskId = seedJsTask("process.exit(1);", 1); // maxRetries=1 → 共 2 次
    const { body } = await jfetch(`/api/tasks/${taskId}/run`, post(`/api/tasks/${taskId}/run`));
    await waitRunTerminal(body.data.runId, 20000);
    const execRow = getDb().prepare("SELECT * FROM executions LIMIT 1").get() as Record<string, unknown>;
    expect(execRow["attempt"]).toBe(1); // 最后一次尝试 attempt=1
    expect(execRow["status"]).toBe("failed");
    // 日志含重试记录
    const logs = fetchExecutionLogs(Number(execRow["id"]), 0, 100);
    const messages = logs.logs.map((l) => l.message).join("\n");
    expect(messages).toContain("重试");
  }, 40000);
});

describe("计划执行（PLN-05/05b）", () => {
  it("run：串行执行全部任务，失败继续，生成汇总报告", async () => {
    const okTask = seedJsTask("console.log('ok');");
    const failTask = seedJsTask("process.exit(1);");
    const plan = createPlan({ name: "回归计划", taskIds: [okTask, failTask] });

    const { status, body } = await jfetch(`/api/plans/${plan.id}/run`, post(`/api/plans/${plan.id}/run`));
    expect(status).toBe(200);
    const planRunId = body.data.planRunId;

    // 等计划编排完成（轮询 plan_runs）
    const start = Date.now();
    while (Date.now() - start < 25000) {
      const row = getDb().prepare("SELECT status FROM plan_runs WHERE id = ?").get(planRunId) as { status: string };
      if (!["running", "paused"].includes(row.status)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const finalRow = getDb().prepare("SELECT * FROM plan_runs WHERE id = ?").get(planRunId) as Record<string, unknown>;
    expect(finalRow["status"]).toBe("failed"); // 含失败任务
    expect(finalRow["summary_report_id"]).toBeTruthy();
    const summary = getReport(String(finalRow["summary_report_id"]))!;
    expect(summary.type).toBe("plan");
    // 汇总含两个任务结果（失败继续执行了第二个）
    const results = JSON.parse(summary.taskResults) as Array<{ status: string }>;
    expect(results.length).toBe(2);
  }, 40000);

  it("执行中计划重复触发 → 30002；暂停恢复状态流转", async () => {
    const slowTask = seedJsTask("setTimeout(()=>{}, 6000); console.log('slow');");
    const plan = createPlan({ name: "慢计划", taskIds: [slowTask] });
    const { body } = await jfetch(`/api/plans/${plan.id}/run`, post(`/api/plans/${plan.id}/run`));
    const planRunId = body.data.planRunId;

    // 执行中重复触发 → 30002
    const dup = await jfetch(`/api/plans/${plan.id}/run`, post(`/api/plans/${plan.id}/run`));
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe(30002);

    // 暂停 → 状态 paused
    const pause = await jfetch(`/api/plans/${plan.id}/pause`, post(`/api/plans/${plan.id}/pause`));
    expect(pause.status).toBe(200);
    expect(pause.body.data.status).toBe("paused");

    // 恢复 → 状态 running
    const resume = await jfetch(`/api/plans/${plan.id}/resume`, post(`/api/plans/${plan.id}/resume`));
    expect(resume.status).toBe(200);
    expect(resume.body.data.status).toBe("running");

    // 等待完成
    const start = Date.now();
    while (Date.now() - start < 20000) {
      const row = getDb().prepare("SELECT status FROM plan_runs WHERE id = ?").get(planRunId) as { status: string };
      if (!["running", "paused"].includes(row.status)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 40000);

  it("闲置计划暂停 → 400", async () => {
    const task = seedJsTask("console.log('idle');");
    const plan = createPlan({ name: "闲置", taskIds: [task] });
    const r = await jfetch(`/api/plans/${plan.id}/pause`, post(`/api/plans/${plan.id}/pause`));
    expect(r.status).toBe(400);
  });
});

describe("内部回调鉴权（§2.14）", () => {
  it("进度回调缺 X-API-Key → 401", async () => {
    const r = await jfetch("/internal/runner/progress", post("/internal/runner/progress", { type: "case_start", execution_id: 1 }));
    expect(r.status).toBe(401);
  });

  it("录制心跳缺 X-Internal-Token → 401", async () => {
    const r = await jfetch("/internal/record/1/heartbeat", post("/internal/record/1/heartbeat", {}));
    expect(r.status).toBe(401);
  });

  it("合法令牌进度回调写日志与终态", async () => {
    const project = createProject({ name: `CB${Date.now()}`, type: "ai", scriptContent: "{}" });
    const task = createTask({ name: "回调任务", projectId: project.id, scriptSource: "project", scriptSnapshot: "{}" });
    const run = createTaskRun({ taskId: task.id, scheduleMode: "manual" });
    const exec = createExecution({ runId: run.id, taskId: task.id, iterationIndex: 1 });
    updateExecution(exec.id, { status: "running", startedAt: new Date().toISOString() });
    const apiKey = process.env.API_KEY ?? "brickcore-runner-secret";

    // case_start
    await fetch(`${baseUrl}/internal/runner/progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ type: "case_start", execution_id: exec.id }),
    });
    // step_progress（含 base64 截图）
    const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    await fetch(`${baseUrl}/internal/runner/progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({
        type: "step_progress",
        execution_id: exec.id,
        step_result: { step_index: 1, method: "click", keyword: "", status: "passed", error: null, screenshot: pngBase64, duration_ms: 100 },
      }),
    });
    // case_end → success
    await fetch(`${baseUrl}/internal/runner/progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ type: "case_end", execution_id: exec.id }),
    });

    const final = getExecution(exec.id)!;
    expect(final.status).toBe("success");
    // 日志包含步骤事件
    const logs = fetchExecutionLogs(exec.id, 0, 50);
    expect(logs.logs.some((l) => l.event === "step")).toBe(true);
    // 报告生成且含截图
    const reportRow = getDb().prepare("SELECT id FROM reports WHERE execution_id = ?").get(exec.id) as { id: string };
    const report = getReport(reportRow.id)!;
    expect(report.totalSteps).toBe(1);
    expect(report.passedSteps).toBe(1);
    const steps = listReportSteps(report.id, 1, 10);
    expect(steps.list[0].screenshotPath).toContain("artifacts/");
  });

  it("调试命令轮询与回调（X-Internal-Token）", async () => {
    pushDebugCommand(77, { command_id: "c1", action: "highlight", status: "pending" });
    const cmd = await fetch(`${baseUrl}/internal/debug/command?debug_session_id=77`, {
      headers: { "X-Internal-Token": process.env.INTERNAL_API_KEY ?? "brickcore-internal-2026" },
    });
    const cmdBody = await cmd.json();
    expect(cmd.status).toBe(200);
    expect(cmdBody.data.command_id).toBe("c1");
    // 取走后为 null
    const next = await fetch(`${baseUrl}/internal/debug/command?debug_session_id=77`, {
      headers: { "X-Internal-Token": process.env.INTERNAL_API_KEY ?? "brickcore-internal-2026" },
    });
    expect((await next.json()).data).toBeNull();

    const cb = await fetch(`${baseUrl}/internal/debug/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Token": process.env.INTERNAL_API_KEY ?? "brickcore-internal-2026" },
      body: JSON.stringify({ event: "step_result", payload: { ok: true } }),
    });
    expect(cb.status).toBe(200);
  });
});
