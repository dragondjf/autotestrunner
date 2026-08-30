/**
 * 录制项目 DAO（recording_projects）。
 * 设计依据：docs/需求设计/数据库与API设计.md §1.2.1（REC-P）。
 */
import type { Row } from "./common.js";
import { camelRow, nowIso, parseJsonField } from "./common.js";
import { getDb } from "../connection.js";
import { newId } from "../ids.js";

export type ProjectType = "ai" | "browser";
export type ProjectStatus = "draft" | "ready" | "archived";
export type ScriptLang = "json" | "js" | "py";

export interface ProjectRow {
  id: string;
  name: string;
  description: string;
  type: ProjectType;
  status: ProjectStatus;
  startUrl: string;
  scriptContent: string;
  scriptLang: ScriptLang;
  paramsSchema: string;
  recordConfig: string;
  lastRunStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  type: ProjectType;
  status?: ProjectStatus;
  startUrl?: string;
  scriptContent?: string;
  scriptLang?: ScriptLang;
  paramsSchema?: unknown;
  recordConfig?: unknown;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  type?: ProjectType;
  status?: ProjectStatus;
  startUrl?: string;
  scriptContent?: string;
  scriptLang?: ScriptLang;
  paramsSchema?: unknown;
  recordConfig?: unknown;
}

export interface ListProjectsQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  type?: ProjectType;
  status?: ProjectStatus;
}

function toProject(row: Row): ProjectRow {
  return camelRow<ProjectRow>(row);
}

export function createProject(input: CreateProjectInput): ProjectRow {
  const now = nowIso();
  const id = newId("proj");
  getDb()
    .prepare(
      `INSERT INTO recording_projects
       (id, name, description, type, status, start_url, script_content, script_lang,
        params_schema, record_config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.name,
      input.description ?? "",
      input.type,
      input.status ?? "draft",
      input.startUrl ?? "",
      input.scriptContent ?? "",
      input.scriptLang ?? "json",
      JSON.stringify(input.paramsSchema ?? {}),
      JSON.stringify(input.recordConfig ?? {}),
      now,
      now,
    );
  return getProject(id)!;
}

export function getProject(id: string): ProjectRow | null {
  const row = getDb().prepare("SELECT * FROM recording_projects WHERE id = ?").get(id) as
    | Row
    | undefined;
  return row ? toProject(row) : null;
}

export function getProjectByName(name: string): ProjectRow | null {
  const row = getDb().prepare("SELECT * FROM recording_projects WHERE name = ?").get(name) as
    | Row
    | undefined;
  return row ? toProject(row) : null;
}

export function updateProject(id: string, input: UpdateProjectInput): ProjectRow | null {
  const existing = getProject(id);
  if (!existing) return null;
  const next = {
    ...existing,
    ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
  } as ProjectRow;
  getDb()
    .prepare(
      `UPDATE recording_projects
       SET name = ?, description = ?, type = ?, status = ?, start_url = ?, script_content = ?,
           script_lang = ?, params_schema = ?, record_config = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      next.name,
      next.description,
      next.type,
      next.status,
      next.startUrl,
      next.scriptContent,
      next.scriptLang,
      "paramsSchema" in input && input.paramsSchema !== undefined
        ? JSON.stringify(input.paramsSchema)
        : (existing.paramsSchema ?? "{}"),
      "recordConfig" in input && input.recordConfig !== undefined
        ? JSON.stringify(input.recordConfig)
        : (existing.recordConfig ?? "{}"),
      nowIso(),
      id,
    );
  return getProject(id);
}

export function deleteProject(id: string): boolean {
  return getDb().prepare("DELETE FROM recording_projects WHERE id = ?").run(id).changes > 0;
}

export function countProjectTasks(id: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?")
    .get(id) as { n: number };
  return row.n;
}

export function listProjects(query: ListProjectsQuery): {
  list: ProjectRow[];
  total: number;
  page: number;
  pageSize: number;
} {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 10));
  const where: string[] = [];
  const args: unknown[] = [];
  if (query.keyword) {
    where.push("name LIKE ?");
    args.push(`%${query.keyword}%`);
  }
  if (query.type) {
    where.push("type = ?");
    args.push(query.type);
  }
  if (query.status) {
    where.push("status = ?");
    args.push(query.status);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const db = getDb();
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM recording_projects ${whereSql}`).get(...args) as {
      n: number;
    }
  ).n;
  const rows = db
    .prepare(
      `SELECT * FROM recording_projects ${whereSql}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, pageSize, (page - 1) * pageSize) as Row[];
  return { list: rows.map(toProject), total, page, pageSize };
}

/** 解析项目 paramsSchema（JSON 字符串 → 对象） */
export function projectParamsSchema(p: ProjectRow): Record<string, unknown> {
  return parseJsonField<Record<string, unknown>>(p.paramsSchema, {});
}
