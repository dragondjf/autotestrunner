/**
 * 迁移执行器测试：幂等、19 表齐全、llm_configs.json 搬迁。
 */
import { describe, expect, it } from "vitest";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import { getDb, closeDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrate.js";
import { listLlmConfigs } from "../src/db/dao/configs.js";
import { DB_FILE, CONFIG_FILE } from "../src/paths.js";

/** 删除库文件重走全流程（模拟首启） */
function resetDbFiles(): void {
  closeDb();
  for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* pass */
    }
  }
}

describe("runMigrations", () => {
  it("首次应用创建全部 19 张业务表", () => {
    const ran = runMigrations();
    expect(ran).toContain(1);
    const db = getDb();
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    const expected = [
      "recording_projects",
      "tasks",
      "task_files",
      "uploads",
      "task_runs",
      "executions",
      "execution_logs",
      "test_plans",
      "plan_tasks",
      "plan_runs",
      "reports",
      "report_steps",
      "record_sessions",
      "agent_sessions",
      "debug_sessions",
      "llm_configs",
      "browsers",
      "system_configs",
      "export_jobs",
      "schema_migrations",
    ];
    for (const t of expected) expect(tables).toContain(t);
  });

  it("重复执行幂等（不重复应用）", () => {
    const ran = runMigrations();
    expect(ran).toEqual([]);
  });

  it("system_configs 预置键写入", () => {
    const db = getDb();
    const keys = (
      db.prepare("SELECT key FROM system_configs").all() as Array<{ key: string }>
    ).map((r) => r.key);
    expect(keys).toContain("report.retention");
    expect(keys).toContain("upload.limits");
  });

  it("旧 llm_configs.json 搬迁并改名 .migrated", () => {
    resetDbFiles();
    const cfgFile = CONFIG_FILE;
    writeFileSync(
      cfgFile,
      JSON.stringify([
        {
          id: "seed-1",
          name: "默认配置",
          provider: "自定义",
          api_key: "sk-test",
          base_url: "https://api.example.com/v1",
          model: "demo-model",
          temperature: 0.2,
          max_tokens: 4096,
          timeout: 30,
          is_default: true,
          enabled: true,
        },
      ]),
      "utf-8",
    );
    const ran = runMigrations();
    expect(ran).toContain(1);
    const configs = listLlmConfigs();
    expect(configs.length).toBe(1);
    expect(configs[0]!.name).toBe("默认配置");
    expect(configs[0]!.apiKey).toBe("sk-test");
    expect(configs[0]!.isDefault).toBe(true);
    expect(existsSync(cfgFile)).toBe(false);
    expect(existsSync(`${cfgFile}.migrated`)).toBe(true);
  });

  it("llm_configs.json 非数组时不阻塞迁移", () => {
    resetDbFiles();
    writeFileSync(CONFIG_FILE, JSON.stringify({ not: "array" }), "utf-8");
    expect(() => runMigrations()).not.toThrow();
    expect(listLlmConfigs().length).toBe(0);
  });
});
