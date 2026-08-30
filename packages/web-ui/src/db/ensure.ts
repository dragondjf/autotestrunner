/**
 * 迁移惰性触发（路由层共享）。
 * 首个业务请求到达时确保 Schema 已应用（幂等）；服务入口 server.ts 亦会显式执行。
 */
import { runMigrations } from "./migrate.js";
import { logger } from "../logging.js";

let migrated = false;

export function ensureMigrated(): void {
  if (migrated) return;
  try {
    runMigrations();
    migrated = true;
  } catch (e) {
    logger.exception("[db] 迁移执行失败: %s", (e as Error).message);
    throw e;
  }
}

/** 测试重置用 */
export function resetEnsureMigrated(): void {
  migrated = false;
}
