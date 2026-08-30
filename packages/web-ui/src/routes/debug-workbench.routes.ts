/**
 * 调试工作台 API（/api/debug-workbench）：
 * - GET /files?projectId= 录制工程文件树（生成脚本 + 任务脚本/资源）
 * - GET /file?path= 读白名单内文件内容（相对 data/）
 * 设计依据：交互调试页三栏布局（左目录树/中编辑器日志/右步骤栏）。
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { Router } from "express";
import { wrap } from "../http-error.js";
import { bizErrors, ok } from "../api/respond.js";
import { getProject } from "../db/dao/projects.js";
import { getTask, listTaskFiles } from "../db/dao/tasks.js";
import { getDb } from "../db/connection.js";
import { BASE_DIR, TASK_FILES_DIR } from "../paths.js";
import { ensureMigrated } from "../db/ensure.js";

export const debugWorkbenchRouter: Router = Router();

interface FileNode {
  name: string;
  kind: "script" | "resource" | "generated";
  path: string; // 相对 data/（可经 /api/files 访问）
  size: number;
  lang: string;
}

/** 项目文件树：生成脚本（scriptContent）+ 关联任务上传的脚本与资源文件 */
debugWorkbenchRouter.get(
  "/api/debug-workbench/files",
  wrap((req, res) => {
    ensureMigrated();
    const projectId = String(req.query["projectId"] ?? "");
    if (!projectId) throw bizErrors.paramInvalid("projectId 必填");
    const project = getProject(projectId);
    if (!project) throw bizErrors.notFound("项目不存在");

    const nodes: FileNode[] = [];
    // 1. 项目生成脚本（虚拟文件：内容在 DB）
    if (project.scriptContent && project.scriptContent.trim()) {
      nodes.push({
        name: `generated.${project.scriptLang === "py" ? "py" : project.scriptLang === "js" ? "js" : "json"}`,
        kind: "generated",
        path: `db://projects/${projectId}/scriptContent`,
        size: Buffer.byteLength(project.scriptContent, "utf-8"),
        lang: project.scriptLang,
      });
    }
    // 2. 关联任务的文件（脚本 + 资源）
    const tasks = getDb()
      .prepare("SELECT id, name, script_source, script_lang FROM tasks WHERE project_id = ? ORDER BY created_at")
      .all(projectId) as Array<{ id: string; name: string; script_source: string; script_lang: string }>;
    for (const t of tasks) {
      const task = getTask(t.id);
      if (!task) continue;
      // 任务快照（虚拟文件）
      nodes.push({
        name: `${t.name}-snapshot.${task.scriptLang === "py" ? "py" : task.scriptLang === "js" ? "js" : "json"}`,
        kind: "script",
        path: `db://tasks/${t.id}/scriptSnapshot`,
        size: Buffer.byteLength(task.scriptSnapshot, "utf-8"),
        lang: task.scriptLang,
      });
      // 上传文件（磁盘）
      for (const f of listTaskFiles(t.id)) {
        nodes.push({
          name: f.filename,
          kind: f.kind,
          path: `task-files/${f.storedPath}`,
          size: f.size,
          lang: f.kind === "script" ? (f.filename.endsWith(".py") ? "py" : "js") : "text",
        });
      }
    }
    ok(res, {
      project: { id: project.id, name: project.name, type: project.type, scriptLang: project.scriptLang },
      files: nodes,
    });
  }),
);

/** 读文件内容：db:// 虚拟文件（DB 字段）或磁盘白名单（task-files/） */
debugWorkbenchRouter.get(
  "/api/debug-workbench/file",
  wrap((req, res) => {
    ensureMigrated();
    const p = String(req.query["path"] ?? "");
    if (!p) throw bizErrors.paramInvalid("path 必填");

    // 虚拟文件：db://projects/:id/scriptContent | db://tasks/:id/scriptSnapshot
    if (p.startsWith("db://")) {
      const parts = p.slice(5).split("/");
      const [domain, id, field] = parts;
      if (domain === "projects" && field === "scriptContent") {
        const project = getProject(id!);
        if (!project) throw bizErrors.notFound("项目不存在");
        ok(res, { content: project.scriptContent, lang: project.scriptLang, name: `generated.${project.scriptLang}` });
        return;
      }
      if (domain === "tasks" && field === "scriptSnapshot") {
        const task = getTask(id!);
        if (!task) throw bizErrors.notFound("任务不存在");
        ok(res, { content: task.scriptSnapshot, lang: task.scriptLang, name: `${task.name}-snapshot` });
        return;
      }
      throw bizErrors.paramInvalid("非法虚拟路径");
    }

    // 磁盘文件：仅允许 task-files/ 前缀（防穿越）
    if (!p.startsWith("task-files/")) throw bizErrors.paramInvalid("禁止访问的路径");
    const abs = path.resolve(TASK_FILES_DIR, p.slice("task-files/".length));
    if (!abs.startsWith(path.resolve(TASK_FILES_DIR))) throw bizErrors.paramInvalid("非法路径");
    if (!existsSync(abs)) throw bizErrors.notFound("文件不存在");
    const content = readFileSync(abs, "utf-8");
    const ext = path.extname(abs).toLowerCase();
    ok(res, {
      content,
      lang: ext === ".py" ? "py" : ext === ".js" ? "js" : ext === ".json" ? "json" : "text",
      name: path.basename(abs),
    });
  }),
);

export { BASE_DIR };
