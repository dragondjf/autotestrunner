/**
 * 迁移执行器：schema_migrations 版本表 + 顺序应用（每版本一个事务）。
 * 附带数据搬迁：data/llm_configs.json → llm_configs 表，成功后改名 .migrated。
 * 设计依据：docs/需求设计/数据库与API设计.md §1.4 迁移策略。
 */
import { existsSync, readFileSync, renameSync } from "node:fs";
import { getDb, type SqliteDatabase } from "./connection.js";
import { CONFIG_FILE } from "../paths.js";
import {
  MIGRATION_001_NAME,
  MIGRATION_001_SQL,
  MIGRATION_001_SYSTEM_DEFAULTS,
} from "./migrations/001-init.js";
import { newId } from "./ids.js";
import { logger } from "../logging.js";

interface Migration {
  version: number;
  name: string;
  sql: string;
  /** 迁移后置数据钩子（同事务外执行，失败不回滚 DDL） */
  after?: (db: SqliteDatabase) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: MIGRATION_001_NAME,
    sql: MIGRATION_001_SQL,
    after: (db) => {
      // system_configs 预置键（存在则跳过）
      const insertDefault = db.prepare(
        "INSERT OR IGNORE INTO system_configs (key, value, updated_at) VALUES (?, ?, ?)",
      );
      for (const [key, value] of Object.entries(MIGRATION_001_SYSTEM_DEFAULTS)) {
        insertDefault.run(key, value, new Date().toISOString());
      }
      // llm_configs.json 数据搬迁
      migrateLlmConfigsJson(db);
    },
  },
];

/** 旧 JSON 配置搬迁进 llm_configs 表；成功后将原文件改名 .migrated（幂等） */
function migrateLlmConfigsJson(db: SqliteDatabase): void {
  if (!existsSync(CONFIG_FILE) || existsSync(`${CONFIG_FILE}.migrated`)) return;
  let configs: unknown;
  try {
    configs = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    logger.warning("[migrate] llm_configs.json 解析失败，跳过搬迁");
    return;
  }
  if (!Array.isArray(configs)) return;
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO llm_configs
     (id, name, provider, api_key, base_url, model, thinking, temperature,
      max_tokens, timeout, is_default, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    for (const raw of configs) {
      const c = raw as Record<string, unknown>;
      const name = String(c["name"] ?? "").trim();
      if (!name) continue;
      insert.run(
        String(c["id"] ?? newId("sess")),
        name,
        String(c["provider"] ?? "自定义"),
        String(c["api_key"] ?? ""),
        String(c["base_url"] ?? ""),
        String(c["model"] ?? ""),
        c["thinking"] ? 1 : 0,
        Number(c["temperature"] ?? 0.7),
        Number.parseInt(String(c["max_tokens"] ?? 8192), 10) || 8192,
        Number.parseInt(String(c["timeout"] ?? 60), 10) || 60,
        c["is_default"] ? 1 : 0,
        c["enabled"] === false ? 0 : 1,
        now,
        now,
      );
    }
  });
  try {
    tx();
    renameSync(CONFIG_FILE, `${CONFIG_FILE}.migrated`);
    logger.info("[migrate] llm_configs.json 已搬迁入 SQLite（%d 条）", String(configs.length));
  } catch (e) {
    logger.exception("[migrate] llm_configs.json 搬迁失败: %s", (e as Error).message);
  }
}

/** 应用全部未执行的迁移；返回本次应用的版本列表 */
export function runMigrations(): number[] {
  const db = getDb();
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  const appliedRows = db.prepare("SELECT version FROM schema_migrations").all() as Array<
    { version: number }
  >;
  const applied = new Set(appliedRows.map((r) => r.version));
  const ran: number[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
    })();
    m.after?.(db);
    ran.push(m.version);
    logger.info("[migrate] 已应用迁移 %d (%s)", String(m.version), m.name);
  }
  return ran;
}
