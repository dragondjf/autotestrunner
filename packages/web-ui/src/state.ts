/**
 * 全局状态（多轮会话存储 / 会话历史 / live 共享状态）。
 * 1:1 对照 agent_web_ui/server_pkg/core.py 的 SESSIONS / SESSION_LOCKS /
 * SESSION_LAST_ACTIVE / SESSIONS_LOCK / SESSION_TTL / SESSION_GC_ELIGIBLE /
 * SESSION_LOG / SESSION_META / _INSPECT_LIVE_STATE。
 */
import { Mutex } from "@brickcore/shared";
import type { UiMcpAgentExplorer } from "@brickcore/smartbrowser";

export type SessionEvent = Record<string, any>;

/** sid -> Playwright 实例（复用登录态与步骤历史） */
export const SESSIONS = new Map<string, UiMcpAgentExplorer>();
/** sid -> 互斥锁（同一会话串行执行） */
export const SESSION_LOCKS = new Map<string, Mutex>();
/** sid -> 最后活跃时间戳（秒） */
export const SESSION_LAST_ACTIVE = new Map<string, number>();
/** SESSIONS 结构自身的锁（对齐 asyncio.Lock） */
export const SESSIONS_LOCK = new Mutex();
/** 5 分钟无请求自动回收 */
export const SESSION_TTL = 300;
/** 仅"新开"会话可被 GC 回收，resume 会话不受 GC 影响 */
export const SESSION_GC_ELIGIBLE = new Set<string>();

/** sid -> 每轮完整事件流（含 user 消息） */
export const SESSION_LOG = new Map<string, SessionEvent[]>();
/** sid -> {title, created_at, start_url, last_url} */
export const SESSION_META = new Map<string, Record<string, unknown>>();

export function getSessionLock(sid: string): Mutex {
  let lock = SESSION_LOCKS.get(sid);
  if (!lock) {
    lock = new Mutex();
    SESSION_LOCKS.set(sid, lock);
  }
  return lock;
}

// ---- live 流式共用状态（被 agent 与 inspect 的 live 端点依赖，置于 core 共享） ----
export interface LiveState {
  cdp?: unknown;
  queue?: unknown[];
  [key: string]: unknown;
}
/** sid -> live 状态 */
export const INSPECT_LIVE_STATE = new Map<string, LiveState>();

/** 关闭并清理 live 的 CDP 会话（1:1 _live_stop_cdp） */
export async function liveStopCdp(sid: string): Promise<void> {
  const st = INSPECT_LIVE_STATE.get(sid);
  INSPECT_LIVE_STATE.delete(sid);
  const cdp = st?.cdp as
    | { send: (m: string) => Promise<unknown>; detach: () => Promise<unknown> }
    | undefined;
  if (cdp === undefined || cdp === null) return;
  try {
    await cdp.send("Page.stopScreencast");
  } catch {
    /* pass */
  }
  try {
    await cdp.detach();
  } catch {
    /* pass */
  }
}
