/**
 * 结束保存 → 生成全部工程文件（syncRecordingToProject）测试。
 * 覆盖：绑定项目的会话生成 scriptContent/recordConfig/空任务快照补齐、
 * 非空快照不覆盖、未绑定项目/无步骤/项目已删不生成。
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import http from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createApp } from "../src/app.js";
import { runMigrations } from "../src/db/migrate.js";
import { getDb, closeDb } from "../src/db/connection.js";
import { createProject } from "../src/db/dao/projects.js";
import { createTask } from "../src/db/dao/tasks.js";
import { INSPECT_LOG, INSPECT_META, inspectPersist, syncRecordingToProject } from "../src/routes/inspect.routes.js";
import { PROJECT_FILES_DIR } from "../src/paths.js";

const server = http.createServer(createApp());
let baseUrl = "";

beforeEach(async () => {
  runMigrations();
  getDb().exec(
    "DELETE FROM task_runs; DELETE FROM executions; DELETE FROM tasks; DELETE FROM recording_projects; DELETE FROM task_files;",
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

const STEPS = [
  { type: "step", step: 1, method: "fill_value", locator: 'get_by_role=textbox, "账号"', value: "admin", url: "http://x/#/login" },
  { type: "step", step: 2, method: "click_ele", locator: 'get_by_role=button, "登 录"', value: "", url: "http://x/#/login" },
];

// 1x1 JPEG（合法 base64，写盘后可经 /api/files 校验 Content-Type）
const TINY_JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD//gA7Q1JFQVRPUg==";

function shotSteps(): Record<string, unknown>[] {
  return STEPS.map((s, i) => ({ ...s, screenshot: i === 0 ? TINY_JPEG : "" }));
}

function seedSession(sid: string, projectId: string | null, steps: unknown[] = STEPS): void {
  INSPECT_META.set(sid, { start_url: "http://x/#/login", created_at: 1, project_id: projectId });
  INSPECT_LOG.set(sid, steps as Record<string, unknown>[]);
  inspectPersist(sid); // syncRecordingToProject 读磁盘时间线
}

describe("syncRecordingToProject（结束保存生成工程文件）", () => {
  it("绑定项目：生成脚本写入 scriptContent + recordConfig，工程文件树齐备", async () => {
    const p = createProject({ name: "login", type: "browser", status: "ready", scriptContent: "", scriptLang: "json" });
    seedSession("sess_gen_1", p.id);

    const sync = syncRecordingToProject("sess_gen_1");
    expect(sync).toMatchObject({ projectId: p.id, projectName: "login", steps: 2, tasksRefreshed: 0 });

    const detail = await (await fetch(`${baseUrl}/api/projects/${p.id}`)).json();
    expect(detail.data.scriptLang).toBe("js");
    expect(detail.data.scriptContent).toContain("getByRole('textbox', { name: '账号' })");
    expect(detail.data.scriptContent).toContain(".fill('admin')");
    expect(detail.data.recordConfig.steps).toHaveLength(2);
  });

  it("空快照任务补齐：先建任务后录制 → 快照由空变可执行脚本", async () => {
    const p = createProject({ name: "empty-snap", type: "browser", status: "ready", scriptContent: "", scriptLang: "json" });
    createTask({ name: "旧任务", scriptSource: "project", scriptSnapshot: "", scriptLang: "json", projectId: p.id, scheduleMode: "manual" });
    seedSession("sess_snap_1", p.id);

    const sync = syncRecordingToProject("sess_snap_1");
    expect(sync).toMatchObject({ tasksRefreshed: 1 });

    const files = await (await fetch(`${baseUrl}/api/debug-workbench/files?projectId=${p.id}`)).json();
    // 生成脚本 + 任务快照均在树中且非空（另有磁盘镜像/步骤流/截图等录制产物节点）
    const kinds = files.data.files.map((f: { kind: string }) => f.kind);
    expect(kinds).toContain("generated");
    expect(kinds).toContain("script");
    const snapshot = files.data.files.find((f: { kind: string; name: string }) => f.kind === "script" && f.name.includes("snapshot"));
    expect(snapshot.size).toBeGreaterThan(0);

    const task = getDb().prepare("SELECT script_snapshot FROM tasks WHERE project_id = ?").get(p.id) as { script_snapshot: string };
    expect(task.script_snapshot).toContain("chromium.launch");
  });

  it("非空快照不覆盖（定点留档语义）", async () => {
    const p = createProject({ name: "keep-snap", type: "browser", status: "ready", scriptContent: "", scriptLang: "json" });
    seedSession("sess_keep_1", p.id);
    syncRecordingToProject("sess_keep_1"); // 生成脚本

    // 脚本就绪后建的任务 → 快照取当时项目脚本
    createTask({ name: "新任务", scriptSource: "project", scriptSnapshot: "// 定点留档", scriptLang: "js", projectId: p.id, scheduleMode: "manual" });
    const again = syncRecordingToProject("sess_keep_1");
    expect(again).toMatchObject({ tasksRefreshed: 0 });

    const snaps = getDb().prepare("SELECT script_snapshot FROM tasks WHERE project_id = ?").all(p.id) as { script_snapshot: string }[];
    expect(snaps.every((s) => s.script_snapshot === "// 定点留档")).toBe(true);
  });

  it("未绑定项目 / 无步骤 / 项目已删 → null，不生成", () => {
    seedSession("sess_nop_1", null);
    expect(syncRecordingToProject("sess_nop_1")).toBeNull();

    const p2 = createProject({ name: "no-steps", type: "browser", status: "ready", scriptContent: "", scriptLang: "json" });
    seedSession("sess_nop_2", p2.id, []);
    expect(syncRecordingToProject("sess_nop_2")).toBeNull();

    seedSession("sess_nop_3", "proj_missing");
    expect(syncRecordingToProject("sess_nop_3")).toBeNull();
  });

  it("项目 startUrl 为空时随会话补记", () => {
    const p = createProject({ name: "no-url", type: "browser", status: "ready", scriptContent: "", scriptLang: "json" });
    seedSession("sess_url_1", p.id);
    syncRecordingToProject("sess_url_1");
    const row = getDb().prepare("SELECT start_url FROM recording_projects WHERE id = ?").get(p.id) as { start_url: string };
    expect(row.start_url).toBe("http://x/#/login");
  });

  it("录制产物落盘：generated.js 镜像 + steps.json（无 base64）+ 每步截图文件", async () => {
    const p = createProject({ name: "disk-files", type: "browser", status: "ready", scriptContent: "", scriptLang: "json" });
    seedSession("sess_disk_1", p.id, shotSteps());
    const sync = syncRecordingToProject("sess_disk_1");
    expect(sync).toMatchObject({ screenshots: 1 });

    const dir = path.join(PROJECT_FILES_DIR, p.id);
    expect(existsSync(path.join(dir, "generated.js"))).toBe(true);
    expect(readFileSync(path.join(dir, "generated.js"), "utf-8")).toContain("chromium.launch");
    // steps.json 步骤流瘦身：不含 base64 截图
    const stepsJson = JSON.parse(readFileSync(path.join(dir, "steps.json"), "utf-8"));
    expect(stepsJson.steps).toHaveLength(2);
    expect(JSON.stringify(stepsJson)).not.toContain("base64");
    // 有截图的步骤生成 jpg（无截图步骤跳过）
    const shots = readdirSync(path.join(dir, "screenshots"));
    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatch(/^step_01_.*\.jpg$/);
    // record_config 同样不含 base64
    const rc = getDb().prepare("SELECT record_config FROM recording_projects WHERE id = ?").get(p.id) as { record_config: string };
    expect(rc.record_config).not.toContain("base64");

    // 工程文件树：脚本镜像 + 步骤流 + 截图节点
    const files = await (await fetch(`${baseUrl}/api/debug-workbench/files?projectId=${p.id}`)).json();
    const kinds = files.data.files.map((f: { kind: string }) => f.kind);
    expect(kinds).toContain("steps");
    expect(kinds).toContain("image");
    // 截图经 /api/files 可访问（白名单 project-files）
    const imgPath = files.data.files.find((f: { kind: string }) => f.kind === "image").path;
    const imgRes = await fetch(`${baseUrl}/api/files/${imgPath}`);
    expect(imgRes.status).toBe(200);
    expect(imgRes.headers.get("content-type")).toBe("image/jpeg");
    // steps.json 文本经 /file 可读
    const stepsRes = await (await fetch(`${baseUrl}/api/debug-workbench/file?path=${encodeURIComponent(`project-files/${p.id}/steps.json`)}`)).json();
    expect(stepsRes.data.lang).toBe("json");
  });
});
