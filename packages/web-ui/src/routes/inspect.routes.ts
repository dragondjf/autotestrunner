/**
 * inspect.html 独立调试器（与 index.html 零交集）。
 * 1:1 对照 agent_web_ui/server_pkg/inspect_routes.py。
 *
 * 独立会话池 / 独立持久化(inspect_data/) / 独立端点(/api/inspect/*)。
 * 仅复用纯技术资产: UiMcpAgentExplorer 浏览器底座、_execute_step 兜底、CDP 帧流方案。
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { Router, type Response } from "express";
import { WebSocketServer, WebSocket } from "ws";
import type { CDPSession, Page } from "playwright";
import { Mutex, SSE_HEADERS, buildRecorderScript } from "@brickcore/shared";
import {
  UiMcpAgentExplorer,
  buildCandidatesFromElement,
  normalizeLocator,
  resolveLocatorOnPage,
} from "@brickcore/smartbrowser";
import {
  HIT_JS,
  inspectHighlight,
  inspectPageInfo,
  inspectProbe,
  inspectShotB64,
  inspectStep,
} from "./agent.routes.js";
import { INSPECT_DATA_DIR, INSPECT_HTML } from "../paths.js";
import { logger } from "../logging.js";
import { httpError, readJsonBody, wrap } from "../http-error.js";

export const inspectRouter: Router = Router();

const sleep = (s: number): Promise<void> => new Promise((r) => setTimeout(r, s * 1000));
const now = (): number => Date.now() / 1000;

// ---------------- 独立状态 ----------------
export const INSPECT_SESSIONS = new Map<string, UiMcpAgentExplorer>();
export const INSPECT_LOCKS = new Map<string, Mutex>();
export const INSPECT_LAST_ACTIVE = new Map<string, number>();
export const INSPECT_LIVE_CDP = new Map<string, Record<string, unknown>>(); // sid -> {cdp, queue, page}
export const INSPECT_LOG = new Map<string, Record<string, unknown>[]>(); // sid -> 时间线事件
export const INSPECT_META = new Map<string, Record<string, unknown>>(); // sid -> {start_url, created_at}
export const INSPECT_IDLE_TIMEOUT = 30 * 60; // 空闲 30 分钟自动关浏览器并落盘

function getInspectLock(sid: string): Mutex {
  let lock = INSPECT_LOCKS.get(sid);
  if (!lock) {
    lock = new Mutex();
    INSPECT_LOCKS.set(sid, lock);
  }
  return lock;
}

try {
  mkdirSync(INSPECT_DATA_DIR, { recursive: true });
} catch {
  /* pass */
}

/** 检视面板动作下拉分组（全部走 _execute_step 白名单，继承 6 层点击兜底） */
export const INSPECT_ACTION_GROUPS = [
  {
    group: "元素动作",
    actions: [
      { method: "click_ele", label: "点击", value: null },
      { method: "double_click_ele", label: "双击", value: null },
      { method: "hover", label: "悬停", value: null },
      { method: "clear_value", label: "清空输入", value: null },
    ],
  },
  {
    group: "输入动作",
    actions: [
      { method: "fill_value", label: "填入文本", value: "输入内容" },
      { method: "type_value", label: "逐键输入", value: "输入内容" },
      { method: "press_key", label: "按键", value: "如 Enter / Tab / Control+a" },
      { method: "select_option", label: "下拉选择", value: "option 的 value 或文本" },
      { method: "upload_file", label: "上传文件", value: "本地文件绝对路径, 如 D:\\data\\a.png" },
    ],
  },
  {
    group: "导航/滚动",
    actions: [
      { method: "open_url", label: "打开 URL", value: "http://..." },
      { method: "refresh", label: "刷新页面", value: null },
      { method: "go_back", label: "后退", value: null },
      { method: "scroll_to_element", label: "滚动到元素", value: null },
      { method: "scroll_to_height", label: "滚动到高度", value: "像素值" },
    ],
  },
  {
    group: "进阶",
    actions: [
      { method: "click_by_text", label: "按文本点击", value: "文本" },
      { method: "execute_script", label: "执行 JS", value: "JS 表达式" },
      { method: "wait_for_element", label: "等待元素出现", value: "毫秒(可选)" },
      { method: "wait_for_time", label: "固定等待", value: "毫秒" },
      { method: "wait_for_load", label: "等待加载完成", value: null },
      { method: "wait_for_element_hidden", label: "等待元素隐藏", value: "毫秒(可选)" },
      { method: "wait_for_url_contains", label: "等待 URL 包含", value: "URL 片段" },
    ],
  },
];

// ---------------- 持久化 ----------------
export function inspectFile(sid: string): string {
  return `${INSPECT_DATA_DIR}/${sid}.json`;
}

/** 时间线落盘（仅本页记录，与 index.html 的 sessions/ 完全隔离） */
export function inspectPersist(sid: string): void {
  const meta = INSPECT_META.get(sid) ?? {};
  const data = {
    session_id: sid,
    start_url: meta["start_url"] ?? "",
    created_at: meta["created_at"],
    updated_at: now(),
    steps: INSPECT_LOG.get(sid) ?? [],
  };
  try {
    writeFileSync(inspectFile(sid), JSON.stringify(data, null, 1), "utf-8");
  } catch (exc) {
    logger.warning("[inspect] 落盘失败 %s: %s", sid, exc instanceof Error ? exc.message : exc);
  }
}

export function inspectLoadDisk(sid: string): Record<string, unknown> | null {
  try {
    if (!existsSync(inspectFile(sid))) return null;
    return JSON.parse(readFileSync(inspectFile(sid), "utf-8"));
  } catch {
    return null;
  }
}

export async function inspectStopCdp(sid: string): Promise<void> {
  const st = INSPECT_LIVE_CDP.get(sid);
  INSPECT_LIVE_CDP.delete(sid);
  const cdp = (st ?? {})["cdp"] as CDPSession | undefined;
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

/** 关闭浏览器 + 落盘。触发点: 手动结束 / 30min 空闲 / 新建替换 / 应用退出。 */
export async function inspectClose(sid: string, persist = true): Promise<void> {
  stopInspectUserCapture(sid);
  if (persist) inspectPersist(sid);
  await inspectStopCdp(sid);
  const explorer = INSPECT_SESSIONS.get(sid);
  INSPECT_SESSIONS.delete(sid);
  INSPECT_LOCKS.delete(sid);
  INSPECT_LAST_ACTIVE.delete(sid);
  INSPECT_LOG.delete(sid);
  INSPECT_META.delete(sid);
  if (explorer !== undefined) {
    try {
      await explorer._close();
    } catch {
      /* pass */
    }
  }
}

/** 空闲超时自动回收（时间线已落盘不丢失） */
export async function inspectGcLoop(): Promise<void> {
  const t = now();
  for (const sid of Array.from(INSPECT_SESSIONS.keys())) {
    if (t - (INSPECT_LAST_ACTIVE.get(sid) ?? 0) > INSPECT_IDLE_TIMEOUT) {
      logger.info("[inspect] 会话 %s 空闲超时回收", sid);
      await inspectClose(sid, true);
    }
  }
}

export function startInspectGc(intervalMs = 60000): NodeJS.Timeout {
  const timer = setInterval(() => {
    void inspectGcLoop();
  }, intervalMs);
  timer.unref();
  return timer;
}

/** 步骤描述生成（1:1 _inspect_desc） */
export function inspectDesc(
  method: string,
  locator: unknown,
  value: unknown,
  elText?: string | null,
): string {
  const t =
    (elText ?? "").trim().slice(0, 24) ||
    (locator ? String(locator).split("=").slice(-1)[0]!.trim().slice(0, 20) : "");
  const v = value != null ? String(value).trim() : "";
  if (method === "click_ele" || method === "double_click_ele") {
    return (method === "double_click_ele" ? "双击 " : "点击 ") + (t || "元素");
  }
  if (method === "fill_value" || method === "type_value") {
    return `在 ${t || "输入框"} 输入 "${v.slice(0, 30)}"`;
  }
  if (method === "clear_value") return `清空 ${t || "输入框"}`;
  if (method === "select_option") return `选择 ${t || "下拉项"} = "${v.slice(0, 30)}"`;
  if (method === "press_key") return `按下 ${v}`;
  if (method === "hover") return `悬停 ${t || "元素"}`;
  if (method === "click_by_text") return `点击文本 "${v.slice(0, 30)}"`;
  if (method === "upload_file") return `上传文件 ${v.slice(0, 50)}`;
  if (method === "open_url") return `打开 ${v.slice(0, 60)}`;
  if (method === "refresh") return "刷新页面";
  if (method === "go_back") return "后退";
  if (method === "scroll_to_element") return `滚动到 ${t || "元素"}`;
  if (method === "scroll_to_height") return `滚动到 ${v || 0}px`;
  if (method === "wait_for_time") return `等待 ${v || 1000}ms`;
  if (method === "wait_for_element") return `等待元素出现 ${t}`.trim();
  if (method === "wait_for_element_hidden") return `等待元素隐藏 ${t}`.trim();
  if (method === "wait_for_load") return "等待加载完成";
  if (method === "wait_for_url_contains") return `等待 URL 包含 ${v.slice(0, 40)}`;
  if (method === "execute_script") return "执行 JS 脚本";
  return method;
}

// ---------------- 页面 ----------------
inspectRouter.get(
  "/inspect",
  wrap((_req, res) => {
    /** inspect.html 独立入口（不在 index.html 加任何跳转，保持零交集） */
    res.sendFile(INSPECT_HTML);
  }),
);

inspectRouter.get(
  "/inspect/:session_id",
  wrap((_req, res) => {
    /** inspect SPA 深链：URL 携带历史会话 id（与 index.html /session/{sid} 同机制） */
    res.sendFile(INSPECT_HTML);
  }),
);

inspectRouter.get(
  "/api/inspect/actions",
  wrap((_req, res) => {
    res.json(INSPECT_ACTION_GROUPS);
  }),
);

// ---------------- 会话创建 ----------------
inspectRouter.post(
  "/api/inspect/session",
  wrap(async (req, res) => {
    /** 新建有头浏览会话（单活跃会话，新建=替换旧会话，旧时间线已落盘） */
    const body = await readJsonBody(req);
    let startUrl = String(body["start_url"] ?? "").trim();
    if (!startUrl) throw httpError(422, "start_url 不能为空");
    if (!startUrl.startsWith("http://") && !startUrl.startsWith("https://")) {
      startUrl = "http://" + startUrl; // 自动补协议
    }
    for (const old of Array.from(INSPECT_SESSIONS.keys())) {
      await inspectClose(old, true);
    }
    const sid = randomUUID().replace(/-/g, "");
    const explorer = new UiMcpAgentExplorer(startUrl, "inspect 手动调试", 1, 15);
    (explorer as unknown as { device_scale_factor?: number }).device_scale_factor = 2; // 2x 渲染
    // headless 模式配置：默认无头（服务端稳妥）；false → 弹出真实浏览器窗口（本地演示）
    if (body["headless"] === false) {
      explorer.headless = false;
    }
    try {
      await explorer._initBrowser();
      // 用户手动操作采集：注入记录脚本（必须在首次导航前，后续跳转/新 tab 自动生效）
      try {
        await explorer.context!.addInitScript(buildRecorderScript());
      } catch {
        /* 注入失败不阻塞会话 */
      }
      await explorer.page!.goto(startUrl, {
        waitUntil: "domcontentloaded",
        timeout: explorer.timeout * 1000,
      });
      try {
        await explorer.page!.waitForLoadState("networkidle", { timeout: 5000 });
      } catch {
        /* pass */
      }
    } catch (exc) {
      try {
        await explorer._close();
      } catch {
        /* pass */
      }
      throw httpError(502, `页面打开失败: ${exc instanceof Error ? exc.message : exc}`);
    }
    bindInspectPage(sid, explorer, explorer.page!);
    // 用户手动操作采集：轮询各页动作写时间线（点击/输入/跳转/新 tab）
    startInspectUserCapture(sid, explorer);
    // 弹窗跟随——target=_blank 开新页时自动切换操作目标
    explorer.context!.on("page", (pg: Page) => {
      void adoptInspectPopup(sid, explorer, pg);
    });
    INSPECT_SESSIONS.set(sid, explorer);
    INSPECT_LOCKS.set(sid, new Mutex());
    INSPECT_LAST_ACTIVE.set(sid, now());
    INSPECT_LOG.set(sid, []);
    INSPECT_META.set(sid, { start_url: startUrl, created_at: now() });
    res.json({
      ok: true,
      sid,
      url: explorer.page!.url(),
      title: await explorer.page!.title(),
      viewport: explorer.page!.viewportSize(),
    });
  }),
);

/** 原生对话框自动接受（防 Playwright 卡死），并记入时间线。 */
export function bindInspectPage(sid: string, explorer: UiMcpAgentExplorer, page: Page): void {
  const onDialog = async (dlg: { type: string; message: string; accept: () => Promise<void> }): Promise<void> => {
    try {
      const msg = `弹出原生对话框 ${dlg.type}: ${dlg.message.slice(0, 80)} → 自动接受`;
      await dlg.accept();
      if (!INSPECT_LOG.has(sid)) INSPECT_LOG.set(sid, []);
      const log = INSPECT_LOG.get(sid)!;
      const evt: Record<string, unknown> = {
        type: "step",
        step: log.length + 1,
        method: "dialog",
        desc: msg,
        locator: "",
        value: "",
        url: page.url(),
        screenshot: "",
        success: true,
        warning: "",
        ts: now(),
      };
      log.push(evt);
      inspectPersist(sid);
      // WS 直推（前端即时补录时间线，无需等 act 响应）
      await inspectWsPush(sid, { type: "dialog", event: evt });
    } catch {
      /* pass */
    }
  };
  page.on("dialog", (d) => {
    void onDialog(d as unknown as { type: string; message: string; accept: () => Promise<void> });
  });
}

/** 用户手动操作采集：注入脚本已生效，轮询各页 __RECORDED__ 写时间线（点击/输入/跳转/新 tab） */
export function startInspectUserCapture(sid: string, explorer: UiMcpAgentExplorer): void {
  const lastUrls = new Map<Page, string>();
  let lastPageCount = -1;
  const timer = setInterval(() => {
    const log = INSPECT_LOG.get(sid);
    if (!log) return; // 会话已关闭
    const pages = explorer.context?.pages() ?? [];
    const knownPages = lastPageCount >= 0 && lastPageCount <= pages.length ? pages.slice(0, lastPageCount) : pages;

    // 1) 先读各页动作（异步）；全部完成后才做新页检测，保证 click → new_page 时序
    const tasks: Promise<void>[] = [];
    const newStepIdx: number[] = [];
    for (let ti = 0; ti < knownPages.length; ti++) {
      const pg = knownPages[ti];
      tasks.push(
        pg.evaluate(() => {
          const w = window as unknown as { __RECORDED__?: Record<string, unknown>[] };
          const a = w.__RECORDED__ || [];
          w.__RECORDED__ = [];
          return a;
        }).then((actions) => {
          const l = INSPECT_LOG.get(sid);
          if (!l) return;
          for (const a of actions ?? []) {
            l.push({
              type: "step",
              step: l.length + 1,
              method: String(a["action_type"] ?? "action"),
              desc: String(a["element_text"] ?? a["value"] ?? "").slice(0, 60),
              locator: String(a["selector"] ?? ""),
              tab_index: ti,
              error: null,
              stepType: "user",
            });
            newStepIdx.push(l.length - 1);
          }
          // 导航检测（每页 url 变化，顺序在动作之后）
          const curr = pg.url();
          const prev = lastUrls.get(pg);
          if (prev !== undefined && prev !== curr) {
            l.push({
              type: "step",
              step: l.length + 1,
              method: "navigate",
              desc: curr.slice(0, 80),
              url: curr,
              tab_index: ti,
              error: null,
              stepType: "user",
            });
            newStepIdx.push(l.length - 1);
          }
          lastUrls.set(pg, curr);
        }).catch(() => {
          /* 页面关闭/导航中跳过 */
        }),
      );
    }
    void Promise.all(tasks).then(() => {
      const l = INSPECT_LOG.get(sid);
      if (!l) return;
      const pagesNow = explorer.context?.pages() ?? [];
      // 2) 新标签页检测（动作之后：click → new_page）
      if (lastPageCount >= 0 && pagesNow.length > lastPageCount) {
        for (let ti = lastPageCount; ti < pagesNow.length; ti++) {
          l.push({
            type: "step",
            step: l.length + 1,
            method: "new_page",
            desc: pagesNow[ti]?.url().slice(0, 80) ?? "新标签页",
            url: pagesNow[ti]?.url() ?? "",
            tab_index: ti,
            error: null,
            stepType: "user",
          });
          newStepIdx.push(l.length - 1);
        }
        lastUrls.set(pagesNow[pagesNow.length - 1]!, pagesNow[pagesNow.length - 1]!.url());
      }
      lastPageCount = pagesNow.length;
      // 3) 每个新步骤补截图（异步，最多 2 张/轮防阻塞）
      for (const idx of newStepIdx.slice(0, 2)) {
        const pg = knownPages[Number(l[idx]?.["tab_index"] ?? 0)] ?? pagesNow[0];
        if (!pg) continue;
        void inspectShotB64(pg).then((shot) => {
          const lg = INSPECT_LOG.get(sid);
          const s = lg?.[idx];
          if (s && !s["screenshot"]) s["screenshot"] = shot;
        }).catch(() => {
          /* 截图失败忽略 */
        });
      }
    });
  }, 1000);
  void timer;
  INSPECT_USER_TIMERS.set(sid, timer);
}

export const INSPECT_USER_TIMERS = new Map<string, ReturnType<typeof setInterval>>();

/** 会话关闭时停止采集轮询 */
export function stopInspectUserCapture(sid: string): void {
  const t = INSPECT_USER_TIMERS.get(sid);
  if (t) clearInterval(t);
  INSPECT_USER_TIMERS.delete(sid);
}

/** 新标签页自动跟随——切换 explorer.page 并通知帧流重连。 */
export async function adoptInspectPopup(
  sid: string,
  explorer: UiMcpAgentExplorer,
  popup: Page,
): Promise<void> {
  try {
    try {
      await popup.waitForLoadState("domcontentloaded", { timeout: 10000 });
    } catch {
      /* pass */
    }
    bindInspectPage(sid, explorer, popup);
    INSPECT_LAST_ACTIVE.set(sid, now());
    // 新标签页即用户当前操作目标：无条件切换（live 帧流跟随激活 tab）
    if (explorer.page !== popup) explorer.page = popup;
    const st = INSPECT_LIVE_CDP.get(sid);
    if (st && st["page"] !== popup) {
      st["page"] = popup;
      const q = st["queue"] as unknown[] | undefined;
      if (q !== undefined && q.length < 2) q.push({ __switched: true });
    }
  } catch {
    /* pass */
  }
}

// ---------------- Live 帧流（SSE） ----------------
inspectRouter.get(
  "/api/inspect/session/:sid/live",
  wrap(async (req, res) => {
    const sid = req.params.sid!;
    const explorer = INSPECT_SESSIONS.get(sid);
    if (explorer === undefined) throw httpError(404, "inspect 会话不存在或已关闭");
    const page = (explorer as { page?: Page | null }).page;
    if (!page) throw httpError(409, "浏览器实例不可用");
    await inspectStopCdp(sid);
    const cdp: CDPSession = await explorer.context!.newCDPSession(page);
    const frames: Record<string, unknown>[] = [];
    const onFrame = (params: Record<string, unknown>): void => {
      if (frames.length >= 2) return;
      frames.push(params);
    };
    cdp.on("Page.screencastFrame", onFrame);
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 70,
      maxWidth: 1920,
      maxHeight: 1080,
    });
    INSPECT_LIVE_CDP.set(sid, { cdp, queue: frames, page });

    res.writeHead(200, { ...SSE_HEADERS, "Content-Type": "text/event-stream" });
    res.flushHeaders?.();
    try {
      while (true) {
        let params: Record<string, unknown>;
        try {
          params = await takeFrame(frames, 25000);
        } catch {
          break;
        }
        if (params["__switched"]) {
          // 页面已切换（弹窗跟随），通知前端立即重连到新页面
          res.write("event: pageswitch\ndata: {}\n\n");
          break;
        }
        res.write(
          `event: frame\ndata: ${JSON.stringify({
            img: "data:image/jpeg;base64," + String(params["data"] ?? ""),
            meta: params["metadata"] ?? {},
          })}\n\n`,
        );
        INSPECT_LAST_ACTIVE.set(sid, now());
        await cdp.send("Page.screencastFrameAck", {
          sessionId: params["sessionId"] as number,
        });
      }
    } finally {
      cdp.off("Page.screencastFrame", onFrame);
      await inspectStopCdp(sid);
      res.end();
    }
  }),
);

async function takeFrame(queue: unknown[], timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (queue.length) return queue.shift() as Record<string, unknown>;
    await sleep(0.05);
  }
  throw new Error("frame timeout");
}

// ---------------- 命中 / 选中 ----------------
/** hover 轻量命中：仅元素指纹，不生成候选（150ms 节流由前端保证） */
async function inspectHitLight(
  explorer: UiMcpAgentExplorer,
  x: unknown,
  y: unknown,
): Promise<Record<string, unknown>> {
  const page = explorer.page as Page;
  try {
    const info = await page.evaluate(HIT_JS, [Number(x), Number(y)]);
    return { ok: true, element: info, url: page.url() };
  } catch (exc) {
    return { ok: false, error: exc instanceof Error ? exc.message : String(exc) };
  }
}

const PROBE_ALL_JS_SRC = String.raw`(locs) => {
  const all = Array.from(document.querySelectorAll('*'));
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const tagRole = (el) => {
    const r = (el.getAttribute('role') || '').toLowerCase();
    if (r) return r;
    const t = el.tagName;
    if (t === 'BUTTON') return 'button';
    if (t === 'A') return 'link';
    if (t === 'INPUT') return 'textbox';
    if (t === 'SELECT') return 'combobox';
    if (t === 'TEXTAREA') return 'textbox';
    return '';
  };
  const txt = (el) => (el.innerText || el.value || el.placeholder || '').trim();
  const results = [];
  for (const loc of locs) {
    const s = String(loc);
    let matched = [];
    let m;
    if ((m = s.match(/^css=(.+)$/))) {
      try { matched = Array.from(document.querySelectorAll(m[1])); } catch (e) {}
    } else if (s.startsWith('#')) {
      try { const el = document.querySelector(s); if (el) matched = [el]; } catch (e) {}
    } else if ((m = s.match(/^get_by_role=([^,]+),\s*(.+)$/))) {
      const role = m[1].trim().toLowerCase(), name = m[2].trim();
      for (const el of all) {
        if (tagRole(el) === role && txt(el) === name) matched.push(el);
      }
    } else if ((m = s.match(/^get_by_text=(.+)$/))) {
      const t = m[1].trim();
      for (const el of all) if ((el.innerText || '').trim() === t) matched.push(el);
    } else if ((m = s.match(/^get_by_placeholder=(.+)$/))) {
      for (const el of all) if ((el.getAttribute('placeholder') || '') === m[1]) matched.push(el);
    } else if ((m = s.match(/^get_by_label=(.+)$/))) {
      for (const el of all) if ((el.getAttribute('aria-label') || '') === m[1]) matched.push(el);
    } else if ((m = s.match(/^get_by_title=(.+)$/))) {
      for (const el of all) if ((el.getAttribute('title') || '') === m[1]) matched.push(el);
    } else {
      try { matched = Array.from(document.querySelectorAll(s)); } catch (e) {}
    }
    const vis = matched.filter(isVisible);
    results.push({
      locator: loc,
      count: matched.length,
      visible: vis.length,
      first: matched.length ? txt(matched[0]).slice(0, 200) : ''
    });
  }
  return results;
}`;
// Node playwright 字符串 evaluate 按表达式处理（isFunction=false），函数字符串
// 不会被调用；模块加载时解析为真函数以复现 Python 客户端自动调用行为。
const PROBE_ALL_JS: (locs: string[]) => unknown = new Function(
  `return (${PROBE_ALL_JS_SRC});`,
)();

/** 选中：命中元素 + 候选定位器 + 批量探测（单次 page.evaluate 一次给全） */
async function inspectSelect(
  explorer: UiMcpAgentExplorer,
  x: unknown,
  y: unknown,
): Promise<Record<string, unknown>> {
  const page = explorer.page as Page;
  let info: Record<string, unknown> | null;
  try {
    info = (await page.evaluate(HIT_JS, [Number(x), Number(y)])) as Record<string, unknown> | null;
  } catch (exc) {
    return { ok: false, error: exc instanceof Error ? exc.message : String(exc) };
  }
  if (!info) return { ok: true, element: null, url: page.url() };
  const cands = buildCandidatesFromElement(info, true).slice(0, 5);
  let scored: Array<Record<string, unknown>> = [];
  try {
    scored = (await page.evaluate(PROBE_ALL_JS, cands)) as Array<Record<string, unknown>> ?? [];
  } catch {
    scored = cands.map((c) => ({ locator: c, count: 0, visible: 0 }));
  }
  info["candidates"] = scored;
  const best =
    (scored.find((c) => c["count"] === 1 && c["visible"]) ?? {})["locator"] ??
    (scored.find((c) => Number(c["visible"] ?? 0) > 0) ?? {})["locator"] ??
    (scored.length ? scored[0]!["locator"] : "");
  info["best"] = best;
  return { ok: true, element: info, url: page.url() };
}

/** 执行成功后追加时间线事件并落盘。 */
async function inspectCommit(
  sid: string,
  page: Page,
  method: string,
  desc: string,
  locator: unknown,
  value: unknown,
  warning: unknown = "",
): Promise<Record<string, unknown>> {
  if (!INSPECT_LOG.has(sid)) INSPECT_LOG.set(sid, []);
  const log = INSPECT_LOG.get(sid)!;
  const evt: Record<string, unknown> = {
    type: "step",
    step: log.length + 1,
    method,
    desc,
    locator: locator ?? "",
    value: value ?? "",
    url: page.url(),
    screenshot: await inspectShotB64(page),
    success: true,
    warning: warning ?? "",
    ts: now(),
  };
  log.push(evt);
  inspectPersist(sid);
  return evt;
}

/** 统一动作分发（HTTP 与 WebSocket 共用；锁由调用方持有） */
export async function inspectDispatch(
  sid: string,
  explorer: UiMcpAgentExplorer,
  action: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  INSPECT_LAST_ACTIVE.set(sid, now());
  const page = explorer.page as Page;

  if (action === "hover") {
    return inspectHitLight(explorer, payload["x"], payload["y"]);
  }
  if (action === "select") {
    return inspectSelect(explorer, payload["x"], payload["y"]);
  }
  if (action === "probe") {
    return { ok: true, ...(await inspectProbe(page, String(payload["locator"] ?? ""))) };
  }
  if (action === "highlight") {
    return { ok: true, ...(await inspectHighlight(page, String(payload["locator"] ?? ""))) };
  }
  if (action === "pageinfo") {
    return { ok: true, ...(await inspectPageInfo(page)) };
  }
  if (action === "screenshot") {
    return {
      ok: true,
      screenshot: await inspectShotB64(page, Boolean(payload["full_page"])),
      url: page.url(),
    };
  }
  if (action === "wheel") {
    const dx = Number(payload["dx"] ?? 0);
    const dy = Number(payload["dy"] ?? 0);
    const x = payload["x"];
    const y = payload["y"];
    if (x !== undefined && x !== null && y !== undefined && y !== null) {
      // 滚轮作用于鼠标位置下的元素——不先 move 到预览对应点，mouse 停在 (0,0) 内层滚动容器永远滚不到
      await page.mouse.move(Number(x), Number(y));
    }
    await page.mouse.wheel(dx, dy);
    await sleep(0.15);
    return { ok: true, url: page.url() };
  }
  if (action === "navigate") {
    const to = payload["to"];
    if (to === "back") await page.goBack();
    else if (to === "forward") await page.goForward();
    else if (to === "reload") await page.reload({ waitUntil: "domcontentloaded" });
    else throw new Error(`未知导航: ${String(to)}`); // 协议错误 → HTTP 422 / WS {ok:false}
    await sleep(0.4);
    return { ok: true, url: page.url(), title: await page.title() };
  }
  if (action === "step") {
    const method = String(payload["method"] ?? "");
    const locator = payload["locator"];
    const value = payload["value"];
    const elText = payload["el_text"];
    let warning: unknown = null;
    const preLen = (INSPECT_LOG.get(sid) ?? []).length; // 执行期间可能插入 dialog 等事件
    if (method === "upload_file") {
      // 文件上传（_execute_step 白名单外，直接 set_input_files）
      if (!locator || !value) throw new Error("上传文件需要定位器与本地文件路径"); // 协议错误
      let success = true;
      let error: unknown = null;
      try {
        const locObj = resolveLocatorOnPage(page, normalizeLocator(String(locator)))!;
        await locObj.first().setInputFiles(String(value));
      } catch (exc) {
        success = false;
        error = exc instanceof Error ? exc.message : String(exc);
      }
      if (!success) return { ok: false, error: error ?? "上传失败" };
    } else {
      const result = await inspectStep(explorer, method, locator, value);
      if (!result["ok"]) return { ok: false, error: result["error"] ?? "执行失败" };
      warning = result["warning"];
    }
    // 成功 → 追加时间线事件并落盘（失败仅面板提示，不进时间线）
    const evt = await inspectCommit(
      sid,
      page,
      method,
      inspectDesc(method, locator, value, elText as string | null),
      locator,
      value,
      warning,
    );
    // 把执行期间（如原生 dialog）插入的事件一并带回给前端
    const extra = (INSPECT_LOG.get(sid) ?? []).slice(preLen, -1);
    return { ok: true, event: evt, warning, extra_events: extra };
  }
  if (action === "click_at") {
    // 坐标点击兜底（canvas/无语义元素无候选定位器时）
    const x = Number(payload["x"] ?? 0);
    const y = Number(payload["y"] ?? 0);
    await page.mouse.click(x, y);
    await sleep(0.4);
    const evt = await inspectCommit(
      sid,
      page,
      "click_at",
      `坐标点击 (${Math.trunc(x)},${Math.trunc(y)})`,
      "",
      "",
    );
    evt["sx"] = x;
    evt["sy"] = y; // 供代码生成
    return { ok: true, event: evt };
  }
  if (action === "drag_start") {
    // 拖拽中继：纯坐标鼠标事件，不依赖 elementFromPoint —— iframe 内滑块也可操作
    await page.mouse.move(Number(payload["x"] ?? 0), Number(payload["y"] ?? 0));
    await page.mouse.down();
    return { ok: true };
  }
  if (action === "drag_move") {
    await page.mouse.move(Number(payload["x"] ?? 0), Number(payload["y"] ?? 0), { steps: 1 });
    return { ok: true };
  }
  if (action === "drag_end") {
    const x = Number(payload["x"] ?? 0);
    const y = Number(payload["y"] ?? 0);
    const sx = Number(payload["sx"] ?? 0);
    const sy = Number(payload["sy"] ?? 0);
    await page.mouse.move(x, y, { steps: 1 });
    await page.mouse.up();
    await sleep(0.4);
    const evt = await inspectCommit(
      sid,
      page,
      "drag",
      `拖拽 (${Math.trunc(sx)},${Math.trunc(sy)}) → (${Math.trunc(x)},${Math.trunc(y)})`,
      "",
      "",
    );
    evt["sx"] = sx;
    evt["sy"] = sy;
    evt["ex"] = x;
    evt["ey"] = y; // 供代码生成
    return { ok: true, event: evt };
  }
  if (action === "options") {
    // 枚举 select 的选项（可视化点选）
    try {
      const locObj = resolveLocatorOnPage(
        page,
        normalizeLocator(String(payload["locator"] ?? "")),
      )!;
      const opts = await locObj.first().evaluate(
        (el: HTMLSelectElement) =>
          Array.from(el.options || []).map((o) => ({
            value: o.value,
            text: o.textContent.trim(),
            selected: o.selected,
          })),
      );
      return { ok: true, options: (opts as unknown[]) ?? [] };
    } catch (exc) {
      return { ok: false, error: exc instanceof Error ? exc.message : String(exc) };
    }
  }
  if (action === "close") {
    await inspectClose(sid, true);
    return { ok: true, closed: true };
  }
  throw new Error(`未知动作: ${action}`); // 协议错误 → HTTP 422 / WS {ok:false}
}

// ---------------- 路由 ----------------
inspectRouter.post(
  "/api/inspect/session/:sid/act",
  wrap(async (req, res) => {
    /**
     * HTTP 版统一动作分发（WebSocket 通道的降级路径）。
     * 协议错误（未知动作/未知导航/缺参）→ 422；业务失败（step 执行失败等）→ 200 + {ok:false}。
     */
    const sid = req.params.sid!;
    const explorer = INSPECT_SESSIONS.get(sid);
    if (explorer === undefined) throw httpError(404, "inspect 会话不存在或已关闭");
    const body = await readJsonBody(req);
    const action = String(body["action"] ?? "");
    const lock = getInspectLock(sid);
    await lock.runExclusive(async () => {
      try {
        res.json(await inspectDispatch(sid, explorer, action, body));
      } catch (exc) {
        // Python ValueError → 协议错误 422
        throw httpError(422, exc instanceof Error ? exc.message : String(exc));
      }
    });
  }),
);

inspectRouter.post(
  "/api/inspect/session/:sid/close",
  wrap(async (req, res) => {
    const sid = req.params.sid!;
    if (!INSPECT_SESSIONS.has(sid)) throw httpError(404, "inspect 会话不存在或已关闭");
    await inspectClose(sid, true);
    res.json({ ok: true });
  }),
);

inspectRouter.get(
  "/api/inspect/sessions",
  wrap((_req, res) => {
    /** 历史列表（inspect_data/ 目录）+ 存活标记（回放+存活续操） */
    const items: Record<string, unknown>[] = [];
    let names: string[] = [];
    try {
      names = readdirSync(INSPECT_DATA_DIR);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const sid = name.slice(0, -5);
      const data = inspectLoadDisk(sid);
      if (!data) continue;
      items.push({
        sid,
        start_url: data["start_url"] ?? "",
        created_at: data["created_at"],
        updated_at: data["updated_at"],
        step_count: Array.isArray(data["steps"]) ? data["steps"].length : 0,
        alive: INSPECT_SESSIONS.has(sid),
      });
    }
    items.sort((a, b) => Number(b["updated_at"] ?? 0) - Number(a["updated_at"] ?? 0));
    res.json(items);
  }),
);

inspectRouter.get(
  "/api/inspect/session/:sid/timeline",
  wrap((req, res) => {
    /** 时间线读取：内存优先（存活续操），否则磁盘（只读回放） */
    const sid = req.params.sid!;
    if (INSPECT_LOG.has(sid)) {
      res.json({
        sid,
        alive: INSPECT_SESSIONS.has(sid),
        start_url: (INSPECT_META.get(sid) ?? {})["start_url"] ?? "",
        steps: INSPECT_LOG.get(sid)!,
      });
      return;
    }
    const data = inspectLoadDisk(sid);
    if (!data) throw httpError(404, "inspect 历史不存在");
    res.json({
      sid,
      alive: false,
      start_url: data["start_url"] ?? "",
      steps: data["steps"] ?? [],
    });
  }),
);

inspectRouter.delete(
  "/api/inspect/sessions/:sid",
  wrap(async (req, res) => {
    const sid = req.params.sid!;
    if (INSPECT_SESSIONS.has(sid)) await inspectClose(sid, false);
    const p = inspectFile(sid);
    if (existsSync(p)) {
      try {
        rmSync(p);
      } catch (exc) {
        throw httpError(500, `删除失败: ${exc instanceof Error ? exc.message : String(exc)}`);
      }
    }
    res.json({ ok: true });
  }),
);

// ================= WebSocket 统一通道 =================
// 一条连接承载：act 请求-响应(correlation id) + 帧流 + URL 推送 + dialog 事件。
// 前端 InsWS 封装负责请求路由；连接断开自动清理，HTTP/SSE 保留为降级路径。

export const INSPECT_WS = new Map<string, Record<string, any>>();

/** 向 sid 的 WS 连接推送事件（失败静默，不影响主流程） */
export async function inspectWsPush(sid: string, obj: Record<string, unknown>): Promise<void> {
  const st = INSPECT_WS.get(sid);
  if (!st) return;
  try {
    const ws = st["ws"] as WebSocket;
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch {
    /* pass */
  }
}

/**
 * 挂载 WS 升级处理：/api/inspect/ws/{sid}
 * 统一性能通道：act 请求响应 + CDP 帧流 + url/dialog 事件。
 */
export function attachInspectWebSocket(server: http.Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";
    const m = /^\/api\/inspect\/ws\/([^/?]+)/.exec(url);
    if (!m) return; // 非本路由，交给其它升级处理器
    const sid = decodeURIComponent(m[1]!);
    // 对齐 FastAPI：先 accept 再按会话状态 close(4404)（不在 upgrade 阶段拒绝）
    wss.handleUpgrade(req, socket, head, (ws) => {
      const explorer = INSPECT_SESSIONS.get(sid);
      if (explorer === undefined) {
        ws.close(4404);
        return;
      }
      void handleInspectWs(sid, explorer, ws);
    });
  });
}

async function handleInspectWs(sid: string, explorer: UiMcpAgentExplorer, ws: WebSocket): Promise<void> {
  // 单活跃连接：替换旧连接（页面刷新/重连场景）
  const old = INSPECT_WS.get(sid);
  if (old && old["ws"] !== ws) {
    try {
      (old["ws"] as WebSocket).close();
    } catch {
      /* pass */
    }
  }
  const st: Record<string, any> = { ws, cdp: null, frames: null, bound_page: explorer.page };
  INSPECT_WS.set(sid, st);
  INSPECT_LAST_ACTIVE.set(sid, now());

  let stopped = false;

  /** 帧流：事件驱动 + 队列背压（丢帧不堆积）+ 页面切换自动重 attach */
  const frameLoop = async (): Promise<void> => {
    while (INSPECT_WS.get(sid) === st && !stopped) {
      const page = explorer.page as Page | null;
      if (!page) {
        await sleep(1);
        continue;
      }
      let cdp: CDPSession;
      try {
        cdp = await explorer.context!.newCDPSession(page);
      } catch {
        await sleep(1);
        continue;
      }
      const frames: Record<string, unknown>[] = [];
      const onFrame = (params: Record<string, unknown>): void => {
        if (frames.length >= 2) return;
        frames.push(params);
      };
      cdp.on("Page.screencastFrame", onFrame);
      st["cdp"] = cdp;
      st["frames"] = frames;
      st["bound_page"] = page;
      try {
        // 默认固定 1920x1080 q70：CDP screencast 硬上限，DSF=2 下=3840 物理渲染采样
        await cdp.send("Page.startScreencast", {
          format: "jpeg",
          quality: 70,
          maxWidth: 1920,
          maxHeight: 1080,
        });
        while (!stopped) {
          let params: Record<string, unknown>;
          try {
            params = await takeFrame(frames, 30000);
          } catch {
            continue; // 静止页：WS 长连接不靠超时重连
          }
          if (params["__switched"]) break; // 页面切换 → 外层循环重 attach
          INSPECT_LAST_ACTIVE.set(sid, now());
          ws.send(
            JSON.stringify({
              type: "frame",
              img: "data:image/jpeg;base64," + String(params["data"] ?? ""),
              meta: params["metadata"] ?? {},
              url: page.url(), // URL 栏零轮询跟随
            }),
          );
          await cdp.send("Page.screencastFrameAck", {
            sessionId: params["sessionId"] as number,
          });
        }
      } catch {
        /* pass */
      } finally {
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
        cdp.off("Page.screencastFrame", onFrame);
      }
      if (INSPECT_WS.get(sid) !== st) return;
      if (explorer.page === page) break; // 页面未切换 → 结束
    }
  };

  const frameTask = (async () => {
    try {
      await frameLoop();
    } catch {
      /* pass */
    }
  })();

  const onMessage = async (raw: WebSocket.RawData): Promise<void> => {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg["type"] === "ack") return; // 兼容旧 ack 语义
    const reqId = msg["id"];
    const action = String(msg["action"] ?? "");
    const payload = (msg["payload"] ?? {}) as Record<string, unknown>;
    const lock = getInspectLock(sid);
    await lock.runExclusive(async () => {
      try {
        const result = await inspectDispatch(sid, explorer, action, payload);
        if (reqId !== undefined && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ id: reqId, ok: true, ...result }));
        }
      } catch (exc) {
        if (reqId !== undefined && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              id: reqId,
              ok: false,
              error: String(exc instanceof Error ? exc.message : exc).slice(0, 200),
            }),
          );
        }
      }
    });
  };

  ws.on("message", (raw) => {
    void onMessage(raw);
  });
  ws.on("close", () => {
    stopped = true;
    if (INSPECT_WS.get(sid) === st) INSPECT_WS.delete(sid);
    void inspectStopCdp(sid);
  });
  ws.on("error", () => {
    stopped = true;
  });

  await frameTask;
}

/** 应用关闭时清理所有 inspect 会话（落盘 + 关浏览器） */
export async function closeAllInspectSessions(): Promise<void> {
  for (const sid of Array.from(INSPECT_SESSIONS.keys())) {
    await inspectClose(sid, true);
  }
}
