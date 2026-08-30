/**
 * SQLite 连接管理（better-sqlite3，WAL 模式）。
 * 设计依据：docs/需求设计/数据库与API设计.md §1（连接初始化 PRAGMA）。
 * 同步 API + 预编译语句，与项目现有 readFileSync 同步风格一致；
 * 单文件惰性单例，测试通过 WEB_UI_DIR 重定向 DB_FILE 实现隔离。
 */
import Database from "better-sqlite3";
import { DB_FILE } from "../paths.js";

export type SqliteDatabase = Database.Database;

/** 已打开连接缓存：db 文件绝对路径 -> 实例（测试切换 WEB_UI_DIR 后可重开新库） */
const openDbs = new Map<string, SqliteDatabase>();

/** 打开（或复用）指定路径的数据库连接，统一应用 PRAGMA */
export function openDb(dbPath: string = DB_FILE): SqliteDatabase {
  const cached = openDbs.get(dbPath);
  if (cached && cached.open) return cached;
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  openDbs.set(dbPath, db);
  return db;
}

/** 惰性获取当前 DB_FILE 对应连接 */
export function getDb(): SqliteDatabase {
  return openDb();
}

/** 关闭指定（缺省全部）连接；供测试与进程关闭钩子调用 */
export function closeDb(dbPath?: string): void {
  if (dbPath) {
    const db = openDbs.get(dbPath);
    if (db) {
      try {
        db.close();
      } catch {
        /* pass */
      }
      openDbs.delete(dbPath);
    }
    return;
  }
  for (const db of openDbs.values()) {
    try {
      db.close();
    } catch {
      /* pass */
    }
  }
  openDbs.clear();
}
