/**
 * Agent 后台执行 / 会话生命周期 / GC。
 * 1:1 对照 agent_web_ui/server_pkg/core.py 的
 * _run_agent / _close_session / _gc_sessions。
 */
import { randomUUID } from "node:crypto";
import { AsyncQueue } from "@brickcore/shared";
import {
  UiMcpAgentExplorer,
  createAgentPlanFunc,
  createLlmCall,
} from "@brickcore/smartbrowser";
import {
  SESSIONS,
  SESSIONS_LOCK,
  SESSION_GC_ELIGIBLE,
  SESSION_LAST_ACTIVE,
  SESSION_LOCKS,
  SESSION_LOG,
  SESSION_META,
  SESSION_TTL,
  getSessionLock,
  type SessionEvent,
} from "./state.js";
import { runtimeLlmConfig } from "./config-store.js";
import { loadSessionFromDisk, persistSession } from "./session-store.js";
import { logger } from "./logging.js";

const nowSeconds = (): number => Date.now() / 1000;

/**
 * 后台跑 agent，每步通过 queue 发出事件。
 *
 * 支持会话复用：session_id 命中 SESSIONS 时复用已有 Playwright 实例（保留登录态、
 * 累积步骤历史），否则新建实例并在结束后存入 SESSIONS（keep_alive）。
 * 返回 session_id（首轮新建时生成）。
 */
export async function runAgent(
  startUrl: string,
  userReq: string,
  maxSteps: number,
  queue: AsyncQueue<SessionEvent>,
  sessionId?: string | null,
): Promise<string> {
  let explorer: UiMcpAgentExplorer;
  let resume: boolean;

  if (sessionId && SESSIONS.has(sessionId)) {
    explorer = SESSIONS.get(sessionId)!;
    resume = true;
    // 关键：每轮刷新用户目标，否则 LLM 仍按上一轮的 description 规划
    explorer.description = userReq || explorer.description;
    logger.info(
      "[session] 复用会话 %s (已有步骤 %s 条, url=%s), 更新目标=%s",
      sessionId,
      explorer.all_steps?.length ?? 0,
      explorer.page ? safeUrl(explorer) : "?",
      explorer.description,
    );
  } else {
    explorer = new UiMcpAgentExplorer(
      startUrl,
      userReq || "根据用户需求在页面上执行操作",
      1,
      15,
    );
    resume = false;
  }

  const sid = sessionId || randomUUID().replace(/-/g, "");
  // 仅新开（非 resume）会话可被 GC 回收，resume 会话不受 GC 影响
  if (resume) {
    SESSION_GC_ELIGIBLE.delete(sid);
  } else {
    SESSION_GC_ELIGIBLE.add(sid);
  }

  // —— 会话历史：载入已有（续聊）或初始化本轮（新会话）——
  if (!SESSION_LOG.has(sid)) {
    const disk = sessionId ? loadSessionFromDisk(sid) : null;
    if (disk) {
      SESSION_LOG.set(sid, Array.from((disk["events"] as SessionEvent[]) ?? []));
      SESSION_META.set(sid, {
        title: disk["title"] || "未命名会话",
        created_at: disk["created_at"] || nowSeconds(),
        start_url: disk["start_url"] || startUrl,
        last_url: disk["last_url"] || "",
      });
    } else {
      SESSION_LOG.set(sid, []);
      SESSION_META.set(sid, {
        title: userReq.length > 24 ? `${userReq.slice(0, 24)}…` : userReq || "未命名会话",
        created_at: nowSeconds(),
        start_url: startUrl,
        last_url: "",
      });
    }
  }
  // 追加本轮用户消息到事件流
  SESSION_LOG.get(sid)!.push({ type: "user", text: userReq, ts: nowSeconds() });

  logger.info(
    "[session] 本轮 session_id=%s resume=%s SESSIONS 键数=%s, 历史事件=%s",
    sid,
    resume,
    SESSIONS.size,
    SESSION_LOG.get(sid)!.length,
  );

  // 同一会话串行执行，避免并发操作同一 page
  const sessionLock = getSessionLock(sid);
  if (sessionLock.locked) {
    await queue.put({ type: "error", error: "该会话正在执行中，请稍候" });
    return sid;
  }

  try {
    await sessionLock.runExclusive(async () => {
      const onStep = async (evt: SessionEvent): Promise<void> => {
        if (!SESSION_LOG.has(sid)) SESSION_LOG.set(sid, []);
        SESSION_LOG.get(sid)!.push(evt);
        queue.put(evt);
      };

      const cfg = runtimeLlmConfig(); // 从启用的默认配置读取
      const callLlm = createLlmCall(cfg);
      const planFunc = createAgentPlanFunc(callLlm);

      const result = await explorer.agentExplore({
        llm_plan_func: planFunc,
        max_steps: maxSteps,
        on_step: onStep,
        resume,
        keep_alive: true,
      });

      logger.info(
        "[session] 会话 %s 本轮完成: executed=%s, 累计步骤=%s, urls=%s",
        sid,
        result["executed_steps"],
        explorer.all_steps?.length ?? 0,
        explorer.urls_visited ?? [],
      );
      await queue.put({ type: "final", result: result as unknown as SessionEvent, session_id: sid });
      SESSIONS.set(sid, explorer); // 常驻会话，供下轮复用
      persistSession(sid);
    });
  } catch (exc) {
    await queue.put({
      type: "error",
      error: exc instanceof Error ? exc.message : String(exc),
      session_id: sid,
    });
    persistSession(sid);
  } finally {
    SESSION_LAST_ACTIVE.set(sid, nowSeconds());
  }
  return sid;
}

function safeUrl(explorer: UiMcpAgentExplorer): string {
  try {
    return (explorer.page as { url?: () => string } | null)?.url?.() ?? "?";
  } catch {
    return "?";
  }
}

/** 关闭并释放指定会话的 Playwright 实例（1:1 _close_session） */
export async function closeSession(sessionId: string): Promise<boolean> {
  return SESSIONS_LOCK.runExclusive(async () => {
    const explorer = SESSIONS.get(sessionId);
    SESSIONS.delete(sessionId);
    SESSION_LOCKS.delete(sessionId);
    SESSION_LAST_ACTIVE.delete(sessionId);
    SESSION_LOG.delete(sessionId);
    SESSION_META.delete(sessionId);
    SESSION_GC_ELIGIBLE.delete(sessionId);
    if (explorer === undefined) return false;
    try {
      await explorer._close();
    } catch {
      /* pass */
    }
    return true;
  });
}

/** 定期回收空闲会话（仅回收新开且长期空闲的会话）（1:1 _gc_sessions） */
export async function gcSessions(): Promise<void> {
  const now = nowSeconds();
  const stale: string[] = [];
  for (const [sid, ts] of SESSION_LAST_ACTIVE.entries()) {
    if (SESSION_GC_ELIGIBLE.has(sid) && now - ts > SESSION_TTL) stale.push(sid);
  }
  for (const sid of stale) {
    await closeSession(sid);
    logger.info("[session] 空闲回收会话 %s", sid);
  }
}

/** 启动 GC 定时循环（30 秒一次，对齐 asyncio 后台任务） */
export function startSessionGc(intervalMs = 30000): NodeJS.Timeout {
  const timer = setInterval(() => {
    void gcSessions();
  }, intervalMs);
  timer.unref();
  return timer;
}
