/**
 * Agent 执行 / 会话管理 / 页面调试器 / 实时画面 路由。
 * 1:1 对照 agent_web_ui/server_pkg/agent_routes.py。
 */
import { randomUUID } from "node:crypto";
import { readdirSync, rmSync, existsSync } from "node:fs";
import { Router, type Response } from "express";
import { chromium, type CDPSession, type Page } from "playwright";
import { AsyncQueue, SSE_HEADERS } from "@brickcore/shared";
import {
  buildCandidatesFromElement,
  captureAccessibilitySnapshot,
  normalizeLocator,
  resolveLocatorOnPage,
} from "@brickcore/smartbrowser";
import type { UiMcpAgentExplorer } from "@brickcore/smartbrowser";
import { runAgent, closeSession } from "../agent-runner.js";
import { normalizeStartUrl } from "../config-store.js";
import {
  INSPECT_LIVE_STATE,
  SESSIONS,
  SESSION_LAST_ACTIVE,
  SESSION_LOG,
  getSessionLock,
  liveStopCdp,
  type SessionEvent,
} from "../state.js";
import { loadSessionFromDisk, sessionFile } from "../session-store.js";
import { SESSION_DIR } from "../paths.js";
import { HttpError, httpError, readJsonBody, wrap } from "../http-error.js";
import { logger } from "../logging.js";

export const agentRouter: Router = Router();

const sleep = (s: number): Promise<void> => new Promise((r) => setTimeout(r, s * 1000));

function sseHeaders(res: Response): void {
  res.writeHead(200, { ...SSE_HEADERS, "Content-Type": "text/event-stream" });
  res.flushHeaders?.();
}

// ---------------- /api/agent/run ----------------
agentRouter.post(
  "/api/agent/run",
  wrap(async (req, res) => {
    const body = await readJsonBody(req);
    const startUrl = normalizeStartUrl(String(body["start_url"] ?? ""));
    const userReq = String(body["user_req"] ?? "").trim();
    const maxSteps = Number.parseInt(String(body["max_steps"] ?? 15), 10) || 15;
    // 首轮即预生成会话 id 并立即回传：让 step/status/qa 等每一步事件都携带 session_id，
    // 前端才能在事件流中途就记住 sessionId，从而复用同一会话（登录/问答、跨轮累积），
    // 避免因中断或未收到 final 导致 sessionId 丢失、被当作新会话而清空时间线。
    const sessionId = String(body["session_id"] ?? "") || randomUUID().replace(/-/g, "");

    const queue = new AsyncQueue<SessionEvent>();
    const task = runAgent(startUrl, userReq, maxSteps, queue, sessionId).catch((e) => {
      logger.exception("[agent/run] %s", e instanceof Error ? e.message : e);
      return sessionId;
    });
    let taskDone = false;
    void task.then(() => {
      taskDone = true;
    });

    sseHeaders(res);
    res.write(`data: ${JSON.stringify({ type: "status", done: false, message: "Agent 启动中…" })}\n\n`);

    while (true) {
      let evt: SessionEvent;
      try {
        // 对齐 asyncio.wait_for(queue.get(), timeout=0.5)：超时查看任务是否结束
        evt = await queue.get(500);
      } catch {
        if (taskDone) break;
        continue;
      }
      // 若事件未带 session_id，回传当前会话 id
      if (evt["session_id"] == null) evt["session_id"] = sessionId;
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
      if (evt["type"] === "final" || evt["type"] === "error") break;
    }
    if (!taskDone) {
      // 客户端断开：任务仍在跑，交由 GC 回收；此处仅结束响应
      logger.info("[agent/run] 客户端断开，保留后台任务（任务仍会写入会话历史）");
    }
    res.end();
  }),
);

// ---------------- /api/agent/run-steps（步骤回放） ----------------
agentRouter.post(
  "/api/agent/run-steps",
  wrap(async (req, res) => {
    const body = await readJsonBody(req);
    const steps = Array.from(body["steps"] ?? []) as Array<Record<string, any>>;
    let startUrl = String(body["current_url"] ?? "");

    const queue = new AsyncQueue<SessionEvent>();

    const execute = async (): Promise<void> => {
      let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
      try {
        browser = await chromium.launch({ headless: false });
        const context = await browser.newContext();
        const page = await context.newPage();

        await queue.put({ type: "log", level: "info", text: "🚀 启动浏览器" });

        if (startUrl) {
          await queue.put({ type: "log", level: "info", text: `📄 导航到 ${startUrl}` });
          await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        }

        for (let i = 0; i < steps.length; i++) {
          const step = steps[i]!;
          const stepUrl = String(step["url"] ?? "");
          if (stepUrl && stepUrl !== startUrl) {
            await queue.put({ type: "log", level: "info", text: `📄 导航到 ${stepUrl}` });
            await page.goto(stepUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
            startUrl = stepUrl;
          }

          const method = String(step["method"] ?? "");
          const locator = String(step["locator"] ?? step["selector"] ?? step["target"] ?? "");
          const value = String(step["value"] ?? step["text"] ?? step["option"] ?? "");
          const desc = String(step["desc"] ?? step["description"] ?? step["action"] ?? "");

          const stepNum = step["step"] ?? i + 1;
          let descText = desc || method;
          if (locator) descText += ` ${locator}`;
          if (value && ["fill", "type", "select", "press"].includes(method)) descText += ` = ${value}`;
          await queue.put({ type: "log", level: "cmd", text: `  Step ${stepNum}: ${descText}` });

          try {
            if (method === "click" && locator) {
              const el = page.locator(locator);
              await el.waitFor({ state: "visible", timeout: 10000 });
              await el.click();
            } else if (method === "fill" && locator) {
              await page.locator(locator).fill(value);
            } else if (method === "type" && locator) {
              await page.locator(locator).fill(value);
            } else if (method === "select" && locator) {
              await page.locator(locator).selectOption(value);
            } else if (method === "navigate" || method === "goto") {
              const url = value || stepUrl;
              await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
            } else if (method === "wait_for_selector" && locator) {
              await page.locator(locator).waitFor({ timeout: 10000 });
            } else if (method === "press" && locator) {
              await page.locator(locator).press(value);
            } else if (method === "hover" && locator) {
              await page.locator(locator).hover();
            } else if (method === "check" && locator) {
              await page.locator(locator).check();
            } else if (method === "uncheck" && locator) {
              await page.locator(locator).uncheck();
            } else if (method === "screenshot") {
              const ss = await page.screenshot({ fullPage: true });
              await queue.put({ type: "screenshot", data: ss.toString("base64") });
            } else if (method === "evaluate" && value) {
              const result = await page.evaluate(value);
              await queue.put({ type: "log", level: "info", text: `  → evaluate: ${String(result)}` });
            } else if (method === "get_text" && locator) {
              const text = await page.locator(locator).textContent();
              await queue.put({ type: "log", level: "info", text: `  → text: ${text}` });
            } else if (locator) {
              // 兜底：有 locator 则 click，有 value 则 fill
              const el = page.locator(locator);
              await el.waitFor({ state: "visible", timeout: 10000 });
              if (value) await el.fill(value);
              else await el.click();
            }

            await queue.put({ type: "log", level: "ok", text: `  ✓ Step ${stepNum} 完成` });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            await queue.put({
              type: "log",
              level: "error",
              text: `  ✗ Step ${stepNum} 失败: ${msg.slice(0, 120)}`,
            });
          }

          await sleep(0.3);
        }

        await queue.put({ type: "log", level: "ok", text: "✅ 所有步骤执行完成" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await queue.put({ type: "log", level: "error", text: `❌ 执行异常: ${msg.slice(0, 200)}` });
      } finally {
        try {
          await browser?.close();
        } catch {
          /* pass */
        }
        await queue.put({ type: "done" });
      }
    };

    void execute();

    sseHeaders(res);
    while (true) {
      let evt: SessionEvent;
      try {
        evt = await queue.get(1000);
      } catch {
        continue;
      }
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
      if (evt["type"] === "done") break;
    }
    res.end();
  }),
);

// ---------------- 会话状态 ----------------
agentRouter.get(
  "/api/agent/session/:session_id",
  wrap((req, res) => {
    const sid = req.params.session_id!;
    const explorer = SESSIONS.get(sid);
    if (explorer === undefined) throw httpError(404, "会话不存在或已回收");
    const page = (explorer as { page?: Page | null }).page;
    res.json({
      session_id: sid,
      url: page ? page.url() : null,
      steps: (explorer as unknown as { all_steps?: unknown[] }).all_steps ?? [],
      urls_visited: (explorer as unknown as { urls_visited?: string[] }).urls_visited ?? [],
      last_active: SESSION_LAST_ACTIVE.get(sid) ?? null,
    });
  }),
);

agentRouter.delete(
  "/api/agent/session/:session_id",
  wrap(async (req, res) => {
    const sid = req.params.session_id!;
    const ok = await closeSession(sid);
    if (!ok) throw httpError(404, "会话不存在或已回收");
    res.json({ ok: true, session_id: sid });
  }),
);

// ---------------- 页面调试器（17 种 action） ----------------
/** 手动单步允许的方法白名单（与 smartbrowser _execute_step 支持集一致） */
export const INSPECT_STEP_METHODS = new Set([
  "click_ele", "double_click_ele", "fill_value", "type_value", "clear_value",
  "hover", "select_option", "press_key", "click_by_text",
  "scroll_to_height", "scroll_to_element",
  "open_url", "refresh", "go_back",
  "wait_for_time", "wait_for_element", "wait_for_load",
  "wait_for_element_hidden", "wait_for_url_contains", "execute_script",
]);

/** 元素点选模式状态: sid -> {queue, active} */
const INSPECT_PICK_STATE = new Map<string, { queue: unknown[]; active: boolean }>();

/** 截图并编码为 data URI（JPEG q=60 全视口）；inspect 模块复用。
 *  不裁剪：与 CDP screencast 帧同为完整视口，尺寸/宽高比一致，
 *  applyShot 替换预览帧时才不会布局跳变（闪烁）；裁剪会切掉视口右侧/底部内容。 */
export async function inspectShotB64(page: Page, fullPage = false): Promise<string> {
  const raw = await page.screenshot({ fullPage, type: "jpeg", quality: 60 });
  return "data:image/jpeg;base64," + raw.toString("base64");
}

/** 提取可交互元素 + 每个元素的最优定位器与候选列表 */
async function inspectClickable(explorer: UiMcpAgentExplorer): Promise<Record<string, unknown>> {
  const elements = (await explorer.extractInteractiveElements()) ?? [];
  const items: Record<string, unknown>[] = [];
  for (const el of elements.slice(0, 400)) {
    let cands: string[] = [];
    try {
      cands = buildCandidatesFromElement(el);
    } catch {
      cands = [];
    }
    const entry: Record<string, unknown> = {};
    for (const k of ["tag", "id", "class", "text", "role", "name", "type", "placeholder", "aria_label", "title", "selector"]) {
      entry[k] = el[k];
    }
    entry["text"] = String(entry["text"] ?? "").slice(0, 100);
    entry["best_locator"] = cands.length ? cands[0]! : String(el["selector"] ?? "");
    entry["candidates"] = cands.slice(0, 5);
    items.push(entry);
  }
  return { count: items.length, elements: items };
}

/** 探测定位器：匹配数 / 可见性 / 首个匹配的标签与文本 / 位置框 */
/** 探测定位器；inspect 模块复用 */
export async function inspectProbe(page: Page, locatorStr: string): Promise<Record<string, unknown>> {
  const locStr = normalizeLocator(locatorStr || "");
  const loc = resolveLocatorOnPage(page, locStr)!;
  const total = await loc.count();
  const result: Record<string, unknown> = { locator: locStr, count: total, visible: 0, first: null };
  if (total === 0) return result;
  const first = loc.first();
  const firstInfo: Record<string, unknown> = {};
  result["first"] = firstInfo;
  try {
    firstInfo["visible"] = undefined; // 占位，下面用 result.visible
    result["visible"] = (await first.isVisible()) ? 1 : 0;
  } catch {
    /* pass */
  }
  try {
    firstInfo["text"] = String((await first.textContent()) ?? "").trim().slice(0, 200);
  } catch {
    /* pass */
  }
  try {
    firstInfo["box"] = await first.boundingBox();
  } catch {
    /* pass */
  }
  try {
    const attrs = await first.evaluate((el: Element) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id,
      cls: String(el.className || "").slice(0, 200),
      name: el.getAttribute("name") || "",
      role: el.getAttribute("role") || "",
    }));
    Object.assign(firstInfo, attrs ?? {});
  } catch {
    /* pass */
  }
  delete firstInfo["visible"];
  return result;
}

const INSPECT_HIGHLIGHT_JS_SRC = String.raw`(el) => {
  el.style.setProperty('outline', '3px solid #ff4d4f', 'important');
  el.style.setProperty('outline-offset', '1px', 'important');
  const r = el.getBoundingClientRect();
  const badge = document.createElement('div');
  badge.setAttribute('data-sb-dbg', '1');
  const cls = (typeof el.className === 'string' ? el.className : '').trim();
  badge.textContent = el.tagName.toLowerCase()
    + (el.id ? '#' + el.id : '')
    + (cls ? '.' + cls.split(/\s+/).slice(0, 3).join('.') : '');
  badge.style.cssText = 'position:fixed;z-index:2147483647;background:#ff4d4f;'
    + 'color:#fff;font:12px/1.4 monospace;padding:2px 6px;border-radius:3px;'
    + 'pointer-events:none;max-width:60vw;overflow:hidden;text-overflow:ellipsis;'
    + 'white-space:nowrap;';
  badge.style.left = Math.max(4, Math.min(window.innerWidth - 220, r.left)) + 'px';
  badge.style.top = Math.max(4, r.top - 22) + 'px';
  document.documentElement.appendChild(badge);
  setTimeout(() => {
    el.style.removeProperty('outline');
    el.style.removeProperty('outline-offset');
    badge.remove();
  }, 8000);
  return true;
}`;
// Node playwright 字符串 evaluate 按表达式处理（isFunction=false），函数字符串
// 不会被调用；模块加载时解析为真函数以复现 Python 客户端自动调用行为。
const INSPECT_HIGHLIGHT_JS: (el: Element) => boolean = new Function(
  `return (${INSPECT_HIGHLIGHT_JS_SRC});`,
)();

/** 页面描边高亮并回传标注截图；inspect 模块复用 */
export async function inspectHighlight(page: Page, locatorStr: string): Promise<Record<string, unknown>> {
  const locStr = normalizeLocator(locatorStr || "");
  const loc = resolveLocatorOnPage(page, locStr)!;
  const total = await loc.count();
  const result: Record<string, unknown> = { locator: locStr, count: total, screenshot: null };
  if (total === 0) return result;
  const handle = await loc.first().elementHandle();
  if (handle === null) return result;
  await page.evaluate(INSPECT_HIGHLIGHT_JS, handle);
  await sleep(0.35);
  result["screenshot"] = await inspectShotB64(page);
  return result;
}

/** 页面信息；inspect 模块复用 */
export async function inspectPageInfo(page: Page): Promise<Record<string, unknown>> {
  let title = "";
  try {
    title = await page.title();
  } catch {
    /* pass */
  }
  let scrollY = 0;
  try {
    scrollY = await page.evaluate(
      () => window.scrollY || document.documentElement.scrollTop || 0,
    ) as number;
  } catch {
    /* pass */
  }
  return { url: page.url(), title, viewport: page.viewportSize(), frames: page.frames().length, scroll_y: scrollY };
}

/** 手动单步执行（复用 smartbrowser _execute_step 全部兜底逻辑）+ 指纹对比 warning */
/** 手动单步执行（复用 smartbrowser _execute_step 兜底）+ 指纹对比 warning；inspect 模块复用 */
export async function inspectStep(
  explorer: UiMcpAgentExplorer,
  method: string,
  locator: unknown,
  value: unknown,
): Promise<Record<string, unknown>> {
  if (!INSPECT_STEP_METHODS.has(method)) {
    return { ok: false, error: `不支持的方法: ${method}` };
  }
  const params: Record<string, unknown> = {};
  if (locator !== null && locator !== undefined && String(locator).trim() !== "") {
    params["locator"] = locator;
  }
  if (value !== null && value !== undefined && String(value).trim() !== "") {
    params["value"] = value;
  }
  const step = { method, params } as Record<string, unknown>;

  const mutating = new Set([
    "click_ele", "double_click_ele", "fill_value", "type_value", "clear_value",
    "select_option", "press_key", "click_by_text", "open_url", "refresh", "go_back",
  ]).has(method);
  const page = explorer.page as Page;

  const fingerprint = async (): Promise<string> => {
    try {
      return (await page.evaluate(
        () =>
          location.href +
          "|" +
          document.body.innerText.length +
          "|" +
          document.querySelectorAll("*").length,
      )) as string;
    } catch {
      return page.url();
    }
  };

  const before = mutating ? await fingerprint() : null;
  const [success, error] = await explorer._executeStep(step as never);
  let after: string | null = null;
  if (mutating && success) {
    await sleep(0.5);
    after = await fingerprint();
  }
  const result: Record<string, unknown> = { ok: Boolean(success), error, step };
  if (success && mutating && before !== null && before === after) {
    result["warning"] =
      "执行完成但页面无变化：可能点中了非目标元素（同名文本/隐藏元素兜底）或该元素无点击响应。" +
      "建议用 Elements/Locator 面板核实目标元素及其定位器。";
  }
  return result;
}

async function inspectEvaluate(page: Page, js: string): Promise<Record<string, unknown>> {
  const result = await page.evaluate(js);
  try {
    JSON.stringify(result);
    return { result };
  } catch {
    return { result: String(result) };
  }
}

const INSPECT_PICK_JS_SRC = String.raw`() => {
  if (window.__sbPickActive) return true;
  const cleanup = () => {
    try {
      document.removeEventListener('mouseover', window.__sbPickOnOver, true);
      document.removeEventListener('click', window.__sbPickOnClick, true);
    } catch (e) {}
    const info = document.getElementById('__sbPickInfo');
    if (info) info.remove();
    const st = document.getElementById('__sbPickStyle');
    if (st) st.remove();
    if (window.__sbPickLastEl && window.__sbPickLastEl.classList) {
      window.__sbPickLastEl.classList.remove('__sbPickHover');
      window.__sbPickLastEl = null;
    }
    window.__sbPickActive = false;
  };
  const css = document.createElement('style');
  css.id = '__sbPickStyle';
  css.textContent = '.__sbPickHover{outline:2px solid #1677ff!important;'
    + 'outline-offset:1px!important;cursor:crosshair!important}';
  document.head.appendChild(css);
  const info = document.createElement('div');
  info.id = '__sbPickInfo';
  info.style.cssText = 'position:fixed;z-index:2147483647;background:#1677ff;'
    + 'color:#fff;font:12px/1.5 monospace;padding:2px 6px;border-radius:3px;'
    + 'pointer-events:none;display:none;max-width:70vw;overflow:hidden;'
    + 'text-overflow:ellipsis;white-space:nowrap;';
  document.body.appendChild(info);
  let lastEl = null;
  window.__sbPickOnOver = (e) => {
    if (lastEl && lastEl.classList) lastEl.classList.remove('__sbPickHover');
    lastEl = e.target;
    window.__sbPickLastEl = lastEl;
    if (!lastEl || !lastEl.classList) return;
    lastEl.classList.add('__sbPickHover');
    const cls = (typeof lastEl.className === 'string' ? lastEl.className : '').trim();
    info.textContent = lastEl.tagName.toLowerCase()
      + (lastEl.id ? '#' + lastEl.id : '')
      + (cls ? '.' + cls.split(/\s+/).slice(0, 3).join('.') : '');
    info.style.display = 'block';
    const r = lastEl.getBoundingClientRect();
    info.style.left = Math.max(4, r.left) + 'px';
    info.style.top = Math.max(4, r.top - 24) + 'px';
  };
  window.__sbPickOnClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    if (!el || !el.tagName) return false;
    let selector = '';
    try {
      if (el.id) {
        selector = '#' + CSS.escape(el.id);
      } else {
        const parts = [];
        let n = el;
        while (n && n !== document.body && parts.length < 6) {
          let p = n.tagName.toLowerCase();
          if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break; }
          if (n.parentElement) {
            const sibs = Array.prototype.filter.call(
              n.parentElement.children, (c) => c.tagName === n.tagName);
            if (sibs.length > 1) p += ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')';
          }
          parts.unshift(p);
          n = n.parentElement;
        }
        selector = parts.join(' > ');
      }
    } catch (err) { selector = ''; }
    const txt = (el.innerText || el.value || el.placeholder
      || el.getAttribute('aria-label') || '').trim();
    const payload = {
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      class: (typeof el.className === 'string' ? el.className : '').slice(0, 200),
      text: txt.slice(0, 120),
      role: el.getAttribute('role') || '',
      name: el.getAttribute('name') || '',
      type: el.getAttribute('type') || '',
      placeholder: el.getAttribute('placeholder') || '',
      aria_label: el.getAttribute('aria-label') || '',
      title: el.getAttribute('title') || '',
      href: (el.getAttribute('href') || '').slice(0, 200),
      selector: selector,
    };
    try {
      el.style.setProperty('outline', '3px solid #ff4d4f', 'important');
      setTimeout(() => { el.style.removeProperty('outline'); }, 3000);
    } catch (err) {}
    if (window.__sbPickElement) {
      try { window.__sbPickElement(payload); } catch (err) {}
    }
    return false;
  };
  window.__sbPickCleanup = cleanup;
  document.addEventListener('mouseover', window.__sbPickOnOver, true);
  document.addEventListener('click', window.__sbPickOnClick, true);
  window.__sbPickActive = true;
  return true;
}`;
// Node playwright 字符串 evaluate 按表达式处理（isFunction=false），函数字符串
// 不会被调用；模块加载时解析为真函数以复现 Python 客户端自动调用行为。
const INSPECT_PICK_JS: () => boolean = new Function(
  `return (${INSPECT_PICK_JS_SRC});`,
)();

async function injectPickJs(page: Page): Promise<boolean> {
  try {
    await page.evaluate(INSPECT_PICK_JS);
    return true;
  } catch {
    return false;
  }
}

async function inspectPickStart(sessionId: string, explorer: UiMcpAgentExplorer): Promise<Record<string, unknown>> {
  const page = explorer.page as Page;
  let state = INSPECT_PICK_STATE.get(sessionId);
  if (!state) {
    state = { queue: [], active: false };
    INSPECT_PICK_STATE.set(sessionId, state);
  }
  const st = state;

  const onPick = (_source: unknown, payload: unknown): void => {
    try {
      st.queue.push(payload ?? {});
    } catch {
      /* pass */
    }
  };

  // expose_binding 重复注册同名会报错，用 page 实例属性做幂等标记
  const anyPage = page as unknown as { _sb_pick_bound?: boolean };
  if (!anyPage._sb_pick_bound) {
    await page.exposeBinding("__sbPickElement", onPick);
    anyPage._sb_pick_bound = true;
  }
  const injected = await injectPickJs(page);
  st.active = true;
  return { active: true, injected };
}

async function inspectPickPoll(sessionId: string, explorer: UiMcpAgentExplorer): Promise<Record<string, unknown>> {
  const state = INSPECT_PICK_STATE.get(sessionId);
  if (!state || !state.active) return { active: false, picked: [] };
  const picked = state.queue;
  state.queue = [];
  try {
    const alive = await (explorer.page as Page).evaluate(() =>
      Boolean((window as unknown as Record<string, unknown>).__sbPickActive),
    );
    if (!alive) await injectPickJs(explorer.page as Page);
  } catch {
    /* pass */
  }
  return { active: true, picked };
}

async function inspectPickStop(sessionId: string, explorer: UiMcpAgentExplorer): Promise<Record<string, unknown>> {
  const state = INSPECT_PICK_STATE.get(sessionId);
  if (state) {
    state.active = false;
    state.queue = [];
  }
  try {
    await (explorer.page as Page).evaluate(() => {
      if ((window as unknown as Record<string, unknown>).__sbPickCleanup) {
        (window as unknown as { __sbPickCleanup: () => void }).__sbPickCleanup();
      }
      return true;
    });
  } catch {
    /* pass */
  }
  return { active: false };
}

/** 轻量命中 JS（元素指纹，不生成候选）；inspect 模块复用 */
const HIT_JS_SRC = String.raw`([x,y])=>{
  let el=document.elementFromPoint(x,y);
  if(!el) return null;
  while(el.parentElement && ['SPAN','B','I','EM','STRONG'].indexOf(el.tagName)>=0 &&
        ['BUTTON','A'].indexOf(el.parentElement.tagName)>=0){
    el = el.parentElement;
  }
  function cssPath(node){
    if(node.id) return '#'+node.id;
    const parts=[];
    let cur=node, depth=0;
    while(cur && cur.nodeType===1 && depth<5){
      let s=cur.tagName.toLowerCase();
      if(cur.id){ parts.unshift('#'+cur.id); break; }
      if(typeof cur.className==='string' && cur.className.trim()){
        const cls=cur.className.trim().split(/\s+/).filter(c=>c && c.indexOf(':')<0).slice(0,2);
        if(cls.length) s+='.'+cls.join('.');
      }
      let sib=cur, n=1;
      while(sib=sib.previousElementSibling){
        if(sib.tagName===cur.tagName) n++;
      }
      s+=':nth-of-type('+n+')';
      parts.unshift(s);
      cur=cur.parentElement; depth++;
    }
    return parts.join('>');
  }
  const r=el.getBoundingClientRect();
  const t=(el.innerText||el.value||el.placeholder||el.getAttribute('aria-label')||'').trim();
  return{
    tag:el.tagName.toLowerCase(),
    id:el.id||'',
    class:(typeof el.className==='string'?el.className:'').slice(0,200),
    text:t.slice(0,120),
    role:el.getAttribute('role')||'',
    name:el.getAttribute('name')||'',
    type:el.getAttribute('type')||'',
    placeholder:el.getAttribute('placeholder')||'',
    title:el.getAttribute('title')||'',
    aria_label:el.getAttribute('aria-label')||'',
    data_testid:el.getAttribute('data-testid')||'',
    selector:cssPath(el),
    checked:(el.type==='checkbox'||el.type==='radio'||el.tagName==='OPTION')?!!el.checked:undefined,
    box:{x:r.x,y:r.y,w:r.width,h:r.height}
  };
}`;
// Node playwright 字符串 evaluate 按表达式处理（isFunction=false），函数字符串
// 不会被调用；模块加载时解析为真函数以复现 Python 客户端自动调用行为。
export const HIT_JS: (args: number[]) => unknown = new Function(
  `return (${HIT_JS_SRC});`,
)();

async function inspectHit(page: Page, x: number, y: number): Promise<Record<string, unknown> | null> {
  let info: Record<string, unknown> | null;
  try {
    info = (await page.evaluate(HIT_JS, [Number(x), Number(y)])) as Record<string, unknown> | null;
  } catch (exc) {
    return { error: exc instanceof Error ? exc.message : String(exc) };
  }
  if (!info) return null;
  const cands: string[] = [];
  if (info["id"]) cands.push("css=#" + String(info["id"]));
  if (info["role"] && info["text"]) {
    cands.push(`get_by_role=${String(info["role"])}, ${String(info["text"])}`);
  }
  if (info["text"]) cands.push("text=" + String(info["text"]));
  info["candidates"] = cands.slice(0, 5);
  info["best_locator"] = cands.length ? cands[0]! : "";
  return info;
}

/** 按 action 分发到对应的确定性操作（零 LLM） */
export async function dispatchInspect(
  action: string,
  payload: Record<string, unknown>,
  sessionId: string,
  explorer: UiMcpAgentExplorer,
  page: Page,
): Promise<Record<string, unknown>> {
  if (action === "screenshot") {
    const fullPage = Boolean(payload["full_page"]);
    return { ok: true, action, screenshot: await inspectShotB64(page, fullPage), url: page.url() };
  }
  if (action === "clickable") {
    return { ok: true, action, ...(await inspectClickable(explorer)), url: page.url() };
  }
  if (action === "probe") {
    return { ok: true, action, ...(await inspectProbe(page, String(payload["locator"] ?? ""))) };
  }
  if (action === "highlight") {
    return { ok: true, action, ...(await inspectHighlight(page, String(payload["locator"] ?? ""))) };
  }
  if (action === "aria") {
    const [text, snapType] = await captureAccessibilitySnapshot(page);
    return { ok: true, action, snapshot: text, snapshot_type: snapType, url: page.url() };
  }
  if (action === "pageinfo") {
    return { ok: true, action, ...(await inspectPageInfo(page)) };
  }
  if (action === "scroll") {
    const direction = String(payload["direction"] ?? "down");
    const jsMap: Record<string, string> = {
      top: "window.scrollTo(0, 0)",
      down: "window.scrollBy(0, window.innerHeight * 0.9)",
      bottom: "window.scrollTo(0, document.body.scrollHeight)",
    };
    const js = jsMap[direction];
    if (js === undefined) {
      return { ok: false, action, error: `不支持的滚动方向: ${direction}` };
    }
    await page.evaluate(js);
    return { ok: true, action, direction };
  }
  if (action === "navigate") {
    const nav = String(payload["nav"] ?? "");
    if (nav === "back") await page.goBack();
    else if (nav === "forward") await page.goForward();
    else if (nav === "reload") await page.reload();
    else return { ok: false, action, error: `不支持的导航: ${nav}` };
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 8000 });
    } catch {
      /* pass */
    }
    return { ok: true, action, url: page.url() };
  }
  if (action === "goto") {
    let url = String(payload["url"] ?? "").trim();
    if (!url) return { ok: false, action, error: "缺少 url" };
    if (!/^https?:\/\//.test(url)) url = "https://" + url;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    return { ok: true, action, url: page.url() };
  }
  if (action === "hit_test") {
    const info = await inspectHit(page, Number(payload["x"] ?? 0), Number(payload["y"] ?? 0));
    return { ok: true, action, element: info };
  }
  if (action === "click_at") {
    const info = await inspectHit(page, Number(payload["x"] ?? 0), Number(payload["y"] ?? 0));
    if (!info) return { ok: false, action, error: "该坐标无元素" };
    const loc = String(info["best_locator"] ?? "");
    const [ok2, err2] = await explorer._executeStep({
      method: "click_ele",
      params: { locator: loc },
    } as never);
    return { ok: Boolean(ok2), action, element: info, error: err2 };
  }
  if (action === "step") {
    return {
      ok: true,
      action,
      ...(await inspectStep(
        explorer,
        String(payload["method"] ?? ""),
        payload["locator"],
        payload["value"],
      )),
    };
  }
  if (action === "evaluate") {
    const js = String(payload["js"] ?? "");
    if (!js.trim()) return { ok: false, action, error: "缺少 js" };
    return { ok: true, action, ...(await inspectEvaluate(page, js)) };
  }
  if (action === "pick_start") {
    return { ok: true, action, ...(await inspectPickStart(sessionId, explorer)) };
  }
  if (action === "pick_poll") {
    return { ok: true, action, ...(await inspectPickPoll(sessionId, explorer)) };
  }
  if (action === "pick_stop") {
    return { ok: true, action, ...(await inspectPickStop(sessionId, explorer)) };
  }
  if (action === "pin") {
    const seq =
      (SESSION_LOG.get(sessionId) ?? []).filter((e) => e["type"] === "step" || e["type"] === "inspect")
        .length + 1;
    const evt: SessionEvent = {
      type: "inspect",
      subtype: String(payload["subtype"] ?? "screenshot"),
      method: "inspect",
      step: seq,
      desc: String(payload["desc"] ?? "手动检视"),
      note: String(payload["note"] ?? ""),
      screenshot: String(payload["screenshot"] ?? ""),
      url: page.url(),
      ts: Date.now() / 1000,
    };
    if (!SESSION_LOG.has(sessionId)) SESSION_LOG.set(sessionId, []);
    SESSION_LOG.get(sessionId)!.push(evt);
    const { persistSession } = await import("../session-store.js");
    persistSession(sessionId);
    return { ok: true, action, event: evt };
  }
  throw new HttpError(400, `未知的 action: ${action}`);
}

agentRouter.post(
  "/api/agent/session/:session_id/inspect",
  wrap(async (req, res) => {
    /** 页面调试器统一端点：直接操作会话的 Playwright 实例，零 LLM 参与。 */
    const sid = req.params.session_id!;
    const payload = await readJsonBody(req);
    const explorer = SESSIONS.get(sid);
    if (explorer === undefined) throw httpError(404, "会话不存在或已回收");
    const page = (explorer as { page?: Page | null }).page;
    if (!page) throw httpError(409, "会话浏览器实例不可用");
    const action = String(payload["action"] ?? "").trim();
    if (!action) throw httpError(400, "缺少 action 参数");

    const sessionLock = getSessionLock(sid);
    if (sessionLock.locked) {
      // 点选轮询是高频操作，会话忙时静默返回不中断轮询
      if (action === "pick_poll") {
        res.json({ ok: true, action, busy: true, active: true, picked: [] });
        return;
      }
      throw httpError(409, "该会话正在执行中,请稍候再试");
    }

    await sessionLock.runExclusive(async () => {
      SESSION_LAST_ACTIVE.set(sid, Date.now() / 1000);
      try {
        res.json(await dispatchInspect(action, payload, sid, explorer, page));
      } catch (exc) {
        if (exc instanceof HttpError) throw exc;
        res.json({
          ok: false,
          action,
          error: exc instanceof Error ? exc.message : String(exc),
        });
      }
    });
  }),
);

// ---------------- Live 实时画面（CDP Screencast） ----------------
agentRouter.get(
  "/api/agent/session/:session_id/live",
  wrap(async (req, res) => {
    const sid = req.params.session_id!;
    const explorer = SESSIONS.get(sid);
    if (explorer === undefined) throw httpError(404, "会话不存在或已回收");
    const page = (explorer as { page?: Page | null }).page;
    if (!page) throw httpError(409, "会话浏览器实例不可用");
    await liveStopCdp(sid); // 幂等清旧流
    const cdp: CDPSession = await explorer.context!.newCDPSession(page);
    // asyncio.Queue(maxsize=2)：帧队列满则丢弃最新帧（背压丢帧，避免积压）
    const frameQueue: Record<string, any>[] = [];
    const FRAME_QUEUE_MAX = 2;
    const onFrame = (params: Record<string, any>): void => {
      if (frameQueue.length >= FRAME_QUEUE_MAX) return;
      frameQueue.push(params);
    };

    cdp.on("Page.screencastFrame", onFrame);
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 70,
      maxWidth: 1280,
      maxHeight: 800,
    });
    INSPECT_LIVE_STATE.set(sid, { cdp, queue: frameQueue });

    sseHeaders(res);
    try {
      while (true) {
        let params: Record<string, any>;
        try {
          params = await takeFrame(frameQueue, 25000);
        } catch {
          break; // 25 秒无帧超时（对齐 wait_for timeout=25.0）
        }
        res.write(
          `event: frame\ndata: ${JSON.stringify({
            img: "data:image/jpeg;base64," + String(params["data"] ?? ""),
            meta: params["metadata"] ?? {},
          })}\n\n`,
        );
        SESSION_LAST_ACTIVE.set(sid, Date.now() / 1000);
        await cdp.send("Page.screencastFrameAck", { sessionId: params["sessionId"] });
      }
    } finally {
      cdp.off("Page.screencastFrame", onFrame);
      await liveStopCdp(sid);
      res.end();
    }
  }),
);

/** 等待队列中出现一帧（超时抛错，对齐 asyncio.wait_for(timeout=25.0)） */
async function takeFrame(queue: unknown[], timeoutMs: number): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (queue.length) return queue.shift() as Record<string, any>;
    await sleep(0.05);
  }
  throw new Error("frame timeout");
}

// ---------------- 历史会话 ----------------
agentRouter.get(
  "/api/sessions",
  wrap((_req, res) => {
    /** 历史会话列表（按 updated_at 倒序），读取磁盘永久历史。 */
    const items: Record<string, unknown>[] = [];
    let names: string[] = [];
    try {
      names = readdirSync(SESSION_DIR);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const sid = name.slice(0, -5);
      const data = loadSessionFromDisk(sid);
      if (!data) continue;
      items.push({
        session_id: sid,
        title: data["title"] ?? "未命名会话",
        created_at: data["created_at"],
        updated_at: data["updated_at"],
        start_url: data["start_url"],
        last_url: data["last_url"],
        msg_count: Array.isArray(data["events"]) ? data["events"].length : 0,
        step_count: Array.isArray(data["steps"]) ? data["steps"].length : 0,
      });
    }
    items.sort((a, b) => Number(b["updated_at"] ?? 0) - Number(a["updated_at"] ?? 0));
    res.json(items);
  }),
);

agentRouter.get(
  "/api/sessions/:session_id",
  wrap((req, res) => {
    const sid = req.params.session_id!;
    const data = loadSessionFromDisk(sid);
    if (!data) throw httpError(404, "会话历史不存在");
    res.json(data);
  }),
);

agentRouter.delete(
  "/api/sessions/:session_id",
  wrap(async (req, res) => {
    /** 删除历史会话（同时释放内存中的浏览器实例） */
    const sid = req.params.session_id!;
    await closeSession(sid);
    const p = sessionFile(sid);
    if (existsSync(p)) {
      try {
        rmSync(p);
      } catch (exc) {
        throw new HttpError(500, `删除失败: ${exc instanceof Error ? exc.message : String(exc)}`);
      }
    }
    res.json({ ok: true, session_id: sid });
  }),
);
