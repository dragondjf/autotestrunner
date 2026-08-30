/**
 * 配置域 DAO（llm_configs / browsers / system_configs）+ 会话表 DAO。
 * 设计依据：docs/需求设计/数据库与API设计.md §1.2.9 / §1.2.10。
 */
import type { Row } from "./common.js";
import { camelRow, nowIso, parseJsonField, toBool } from "./common.js";
import { getDb } from "../connection.js";
import { newId } from "../ids.js";

// ---------------- llm_configs（REC-A09） ----------------

export interface LlmConfigDbRow {
  id: string;
  name: string;
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  thinking: boolean;
  temperature: number;
  maxTokens: number;
  timeout: number;
  isDefault: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export function listLlmConfigs(): LlmConfigDbRow[] {
  const rows = getDb().prepare("SELECT * FROM llm_configs ORDER BY created_at").all() as Row[];
  return rows.map(toLlm);
}

function toLlm(row: Row): LlmConfigDbRow {
  const c = camelRow<LlmConfigDbRow & Row>(row);
  return { ...c, thinking: toBool(c.thinking), isDefault: toBool(c.isDefault), enabled: toBool(c.enabled) };
}

export function getLlmConfig(id: string): LlmConfigDbRow | null {
  const row = getDb().prepare("SELECT * FROM llm_configs WHERE id = ?").get(id) as Row | undefined;
  return row ? toLlm(row) : null;
}

/** 以 config-store 的松散记录（Record<string, any>）读写，兼容既有调用方 */
export function insertLlmConfigRecord(rec: Record<string, unknown>): Record<string, unknown> {
  const now = nowIso();
  const id = String(rec["id"] ?? newId("sess"));
  getDb()
    .prepare(
      `INSERT INTO llm_configs
       (id, name, provider, api_key, base_url, model, thinking, temperature, max_tokens,
        timeout, is_default, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      String(rec["name"] ?? ""),
      String(rec["provider"] ?? "自定义"),
      String(rec["api_key"] ?? ""),
      String(rec["base_url"] ?? ""),
      String(rec["model"] ?? ""),
      rec["thinking"] ? 1 : 0,
      Number(rec["temperature"] ?? 0.7),
      Number.parseInt(String(rec["max_tokens"] ?? 8192), 10) || 8192,
      Number.parseInt(String(rec["timeout"] ?? 60), 10) || 60,
      rec["is_default"] ? 1 : 0,
      rec["enabled"] === false ? 0 : 1,
      now,
      now,
    );
  return { ...rec, id };
}

export function replaceLlmConfigs(records: Array<Record<string, unknown>>): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM llm_configs").run();
    for (const rec of records) insertLlmConfigRecord(rec);
  });
  tx();
}

export function deleteLlmConfig(id: string): boolean {
  return getDb().prepare("DELETE FROM llm_configs WHERE id = ?").run(id).changes > 0;
}

/** DB 行 → config-store 松散记录形态（snake_case 键，与旧 JSON 一致；空值键省略以保持旧语义） */
export function llmDbRowToRecord(row: LlmConfigDbRow): Record<string, unknown> {
  const out: Record<string, unknown> = { id: row.id, name: row.name };
  if (row.provider) out["provider"] = row.provider;
  if (row.apiKey) out["api_key"] = row.apiKey;
  if (row.baseUrl) out["base_url"] = row.baseUrl;
  if (row.model) out["model"] = row.model;
  if (row.thinking) out["thinking"] = true;
  out["temperature"] = row.temperature;
  out["max_tokens"] = row.maxTokens;
  out["timeout"] = row.timeout;
  out["is_default"] = row.isDefault;
  out["enabled"] = row.enabled;
  return out;
}

/** config-store 松散记录 → DB 行（保存路径） */
export function llmRecordToDbRow(rec: Record<string, unknown>): LlmConfigDbRow {
  const now = nowIso();
  return {
    id: String(rec["id"] ?? newId("sess")),
    name: String(rec["name"] ?? ""),
    provider: String(rec["provider"] ?? "自定义"),
    apiKey: String(rec["api_key"] ?? ""),
    baseUrl: String(rec["base_url"] ?? ""),
    model: String(rec["model"] ?? ""),
    thinking: Boolean(rec["thinking"] ?? false),
    temperature: Number(rec["temperature"] ?? 0.7),
    maxTokens: Number.parseInt(String(rec["max_tokens"] ?? 8192), 10) || 8192,
    timeout: Number.parseInt(String(rec["timeout"] ?? 60), 10) || 60,
    isDefault: Boolean(rec["is_default"] ?? false),
    enabled: rec["enabled"] === false ? false : true,
    createdAt: String(rec["created_at"] ?? now),
    updatedAt: now,
  };
}

// ---------------- browsers ----------------

export interface BrowserRow {
  id: number;
  name: string;
  version: string;
  path: string;
  isDefault: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export function listBrowsers(): BrowserRow[] {
  const rows = getDb().prepare("SELECT * FROM browsers ORDER BY name, version").all() as Row[];
  return rows.map((r) => {
    const b = camelRow<BrowserRow>(r);
    return { ...b, isDefault: toBool(b.isDefault), enabled: toBool(b.enabled) };
  });
}

export function getBrowser(id: number): BrowserRow | null {
  const row = getDb().prepare("SELECT * FROM browsers WHERE id = ?").get(id) as Row | undefined;
  if (!row) return null;
  const b = camelRow<BrowserRow>(row);
  return { ...b, isDefault: toBool(b.isDefault), enabled: toBool(b.enabled) };
}

export function insertBrowser(input: {
  name: string;
  version?: string;
  path: string;
  isDefault?: boolean;
  enabled?: boolean;
}): BrowserRow {
  const db = getDb();
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO browsers (name, version, path, is_default, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.name, input.version ?? "", input.path, input.isDefault ? 1 : 0, input.enabled === false ? 0 : 1, now, now);
  return getBrowser(Number(info.lastInsertRowid))!;
}

export function updateBrowser(id: number, patch: Partial<Pick<BrowserRow, "name" | "version" | "path" | "isDefault" | "enabled">>): BrowserRow | null {
  const existing = getBrowser(id);
  if (!existing) return null;
  getDb()
    .prepare("UPDATE browsers SET name = ?, version = ?, path = ?, is_default = ?, enabled = ?, updated_at = ? WHERE id = ?")
    .run(
      patch.name ?? existing.name,
      patch.version ?? existing.version,
      patch.path ?? existing.path,
      (patch.isDefault ?? existing.isDefault) ? 1 : 0,
      (patch.enabled ?? existing.enabled) ? 1 : 0,
      nowIso(),
      id,
    );
  return getBrowser(id);
}

export function deleteBrowser(id: number): boolean {
  return getDb().prepare("DELETE FROM browsers WHERE id = ?").run(id).changes > 0;
}

/** 唯一默认规则：指定 id 为默认，其余清除 */
export function setDefaultBrowser(id: number): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("UPDATE browsers SET is_default = 0").run();
    db.prepare("UPDATE browsers SET is_default = 1 WHERE id = ?").run(id);
  });
  tx();
}

export function getDefaultBrowser(): BrowserRow | null {
  const row = getDb().prepare("SELECT * FROM browsers WHERE is_default = 1 LIMIT 1").get() as Row | undefined;
  if (!row) return null;
  const b = camelRow<BrowserRow>(row);
  return { ...b, isDefault: toBool(b.isDefault), enabled: toBool(b.enabled) };
}

// ---------------- system_configs ----------------

export function getSystemConfig<T>(key: string, fallback: T): T {
  const row = getDb().prepare("SELECT value FROM system_configs WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (!row) return fallback;
  return parseJsonField<T>(row.value, fallback);
}

export function setSystemConfig(key: string, value: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO system_configs (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, JSON.stringify(value), nowIso());
}

// ---------------- 会话表（record/agent/debug，阶段一仅建表与基础读写） ----------------

export interface RecordSessionRow {
  id: number;
  projectId: string | null;
  url: string;
  status: string;
  actionsCount: number;
  error: string | null;
  actionsPath: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export function insertRecordSession(input: { projectId?: string | null; url?: string }): RecordSessionRow {
  const info = getDb()
    .prepare(
      `INSERT INTO record_sessions (project_id, url, status, created_at)
       VALUES (?, ?, 'pending', ?)`,
    )
    .run(input.projectId ?? null, input.url ?? "", nowIso());
  const row = getDb().prepare("SELECT * FROM record_sessions WHERE id = ?").get(info.lastInsertRowid) as Row;
  return camelRow<RecordSessionRow>(row);
}

export function updateRecordSession(id: number, patch: Partial<Pick<RecordSessionRow, "status" | "actionsCount" | "error" | "actionsPath" | "startedAt" | "endedAt">>): void {
  const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  if (!keys.length) return;
  const snake = keys.map((k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
  const setSql = snake.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => (patch as Record<string, unknown>)[k]);
  getDb()
    .prepare(`UPDATE record_sessions SET ${setSql} WHERE id = ?`)
    .run(...values, id);
}

export function listRecordSessions(limit = 50): RecordSessionRow[] {
  const rows = getDb()
    .prepare("SELECT * FROM record_sessions ORDER BY created_at DESC LIMIT ?")
    .all(limit) as Row[];
  return rows.map((r) => camelRow<RecordSessionRow>(r));
}

export interface AgentSessionRow {
  sid: string;
  title: string;
  startUrl: string;
  lastUrl: string;
  status: string;
  mode: string;
  stepsCompleted: number;
  stepsFailed: number;
  llmConfigId: string | null;
  eventsPath: string | null;
  createdAt: string;
  lastActiveAt: string;
  closedAt: string | null;
}

export function upsertAgentSession(input: {
  sid: string;
  title?: string;
  startUrl?: string;
  lastUrl?: string;
  status?: string;
  mode?: string;
  stepsCompleted?: number;
  stepsFailed?: number;
}): void {
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO agent_sessions
       (sid, title, start_url, last_url, status, mode, steps_completed, steps_failed,
        created_at, last_active_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET
         title = COALESCE(excluded.title, title),
         last_url = excluded.last_url,
         status = COALESCE(excluded.status, status),
         steps_completed = MAX(steps_completed, excluded.steps_completed),
         steps_failed = MAX(steps_failed, excluded.steps_failed),
         last_active_at = excluded.last_active_at`,
    )
    .run(
      input.sid,
      input.title ?? "",
      input.startUrl ?? "",
      input.lastUrl ?? "",
      input.status ?? "running",
      input.mode ?? "task",
      input.stepsCompleted ?? 0,
      input.stepsFailed ?? 0,
      now,
      now,
    );
}

export function listAgentSessions(limit = 100): AgentSessionRow[] {
  const rows = getDb()
    .prepare("SELECT * FROM agent_sessions ORDER BY last_active_at DESC LIMIT ?")
    .all(limit) as Row[];
  return rows.map((r) => camelRow<AgentSessionRow>(r));
}
