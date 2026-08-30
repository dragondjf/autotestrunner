/**
 * 会话历史持久化辅助。
 * 1:1 对照 agent_web_ui/server_pkg/core.py 的
 * _session_file / _derive_last_url / _persist_session / _load_session_from_disk。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SESSION_DIR } from "./paths.js";
import { SESSIONS, SESSION_LOG, SESSION_META, type SessionEvent } from "./state.js";
import { DEFAULT_START_URL } from "./config-store.js";
import { logger } from "./logging.js";
import { upsertAgentSession } from "./db/dao/configs.js";

export function sessionFile(sid: string): string {
  return path.join(SESSION_DIR, `${sid}.json`);
}

/** 取最后一条 step 事件的 url，否则取浏览器当前 url。 */
export function deriveLastUrl(explorer: unknown, events: SessionEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e["type"] === "step" && e["url"]) return String(e["url"]);
  }
  const page = (explorer as { page?: { url?: () => string } } | undefined)?.page;
  if (page && typeof page.url === "function") {
    try {
      return page.url();
    } catch {
      return "";
    }
  }
  return "";
}

/** 将内存事件流落盘到 sessions/<sid>.json（永久历史，供历史列表/续聊）。 */
export function persistSession(sid: string): void {
  const events = SESSION_LOG.get(sid) ?? [];
  const meta = SESSION_META.get(sid) ?? {};
  if (!events.length) return;
  const explorer = SESSIONS.get(sid);
  const steps = events.filter((e) => e["type"] === "step" || e["type"] === "inspect");
  const data = {
    session_id: sid,
    title: meta["title"] || "未命名会话",
    created_at: meta["created_at"] || Date.now() / 1000,
    updated_at: Date.now() / 1000,
    start_url: meta["start_url"] || DEFAULT_START_URL,
    last_url: explorer ? deriveLastUrl(explorer, events) : (meta["last_url"] ?? ""),
    events,
    steps,
    urls_visited: Array.from(
      (explorer as { urls_visited?: string[] } | undefined)?.urls_visited ?? [],
    ),
  };
  try {
    writeFileSync(sessionFile(sid), JSON.stringify(data, null, 2), "utf-8");
  } catch {
    logger.exception("[session] 持久化失败 %s", sid);
  }
  // SQLite 双写（agent_sessions 表，会话观测；失败不阻塞 JSON 主链路）
  try {
    upsertAgentSession({
      sid,
      title: String(data.title),
      startUrl: String(data.start_url ?? ""),
      lastUrl: String(data.last_url ?? ""),
      stepsCompleted: steps.filter((e) => e["status"] === "success").length,
      stepsFailed: steps.filter((e) => e["status"] && e["status"] !== "success").length,
    });
  } catch {
    /* DB 未迁移/不可用时跳过 */
  }
}

export function loadSessionFromDisk(sid: string): Record<string, unknown> | null {
  const p = sessionFile(sid);
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf-8"));
    return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
