/**
 * 目录与路径常量。
 * 1:1 对照 agent_web_ui/server_pkg/core.py 的 _BASE_DIR / _INDEX_HTML / _ASSETS_DIR /
 * _STATIC_DIR / _CONFIG_FILE / _SESSION_DIR。
 *
 * node-backend 项目完全独立，不再依赖仓库根（node-backend/packages/web-ui → 上 2 级为项目根）：
 *   packages/web-ui/frontend  前端：index.html / inspect.html / code-generator.js / assets
 *   node-backend/data         运行时配置与历史：llm_configs.json / sessions / inspect_data
 *   node-backend/static       smartbrowser 截图目录
 * 可用环境变量 WEB_UI_DIR / STATIC_DIR 覆盖。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url)); // .../web-ui/src 或 .../web-ui/dist
const pkgRoot = path.resolve(here, "..");
const backendRoot = path.resolve(pkgRoot, "..", ".."); // node-backend 项目根

// 前端静态资源（内置于包内，dev=src / prod=dist 两种入口下 pkgRoot 均为 web-ui 包根）
export const FRONTEND_DIR = path.join(pkgRoot, "frontend");
export const INDEX_HTML = path.join(FRONTEND_DIR, "index.html");
export const APP_HTML = path.join(FRONTEND_DIR, "app.html");
export const INSPECT_HTML = path.join(FRONTEND_DIR, "inspect.html");
export const CODE_GENERATOR_JS = path.join(FRONTEND_DIR, "code-generator.js");
export const ASSETS_DIR = path.join(FRONTEND_DIR, "assets");

// 运行时配置与历史目录（项目内 node-backend/data，可用 WEB_UI_DIR 覆盖）
export const BASE_DIR = process.env.WEB_UI_DIR
  ? path.resolve(process.env.WEB_UI_DIR)
  : path.join(backendRoot, "data");

export const STATIC_DIR = process.env.STATIC_DIR
  ? path.resolve(process.env.STATIC_DIR)
  : path.join(backendRoot, "static");

export const CONFIG_FILE = path.join(BASE_DIR, "llm_configs.json");
export const SESSION_DIR = path.join(BASE_DIR, "sessions");
export const INSPECT_DATA_DIR = path.join(BASE_DIR, "inspect_data");

// ---- 数据库与业务数据目录（docs/需求设计/数据库与API设计.md §1.3）----

/** SQLite 主库文件（WAL 模式，同目录生成 -wal/-shm） */
export const DB_FILE = path.join(BASE_DIR, "autotest.db");

export const UPLOADS_TMP_DIR = path.join(BASE_DIR, "uploads", "tmp"); // 向导临时上传（TTL 24h）
export const TASK_FILES_DIR = path.join(BASE_DIR, "task-files"); // {taskId}/script|resources/
export const PROJECT_FILES_DIR = path.join(BASE_DIR, "project-files"); // {projectId}/ 结束保存落盘（脚本/步骤流/截图）
export const ARTIFACTS_DIR = path.join(BASE_DIR, "artifacts"); // executions/{id}/screenshots|video
export const REPORT_EXPORTS_DIR = path.join(BASE_DIR, "reports", "exports"); // 报告导出产物
export const RECORD_SESSIONS_DIR = path.join(BASE_DIR, "record-sessions"); // 浏览器录制动作流
export const RECORDINGS_DIR = path.join(BASE_DIR, "recordings"); // 脚本回放视频录制
export const AGENT_SESSIONS_DIR = path.join(BASE_DIR, "agent-sessions"); // AI 会话事件流

// os.makedirs(exist_ok=True)
for (const dir of [
  SESSION_DIR,
  INSPECT_DATA_DIR,
  UPLOADS_TMP_DIR,
  TASK_FILES_DIR,
  PROJECT_FILES_DIR,
  ARTIFACTS_DIR,
  REPORT_EXPORTS_DIR,
  RECORD_SESSIONS_DIR,
  AGENT_SESSIONS_DIR,
  RECORDINGS_DIR,
]) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* pass */
  }
}
