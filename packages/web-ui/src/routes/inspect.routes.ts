/**
 * inspect.html 独立调试器（与 index.html 零交集）。
 * 1:1 对照 agent_web_ui/server_pkg/inspect_routes.py。
 *
 * 独立会话池 / 独立持久化(inspect_data/) / 独立端点(/api/inspect/*)。
 * 仅复用纯技术资产: UiMcpAgentExplorer 浏览器底座、_execute_step 兜底、CDP 帧流方案。
 */
import http from "node:http";
import net from "node:net";
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
import { INSPECT_DATA_DIR, INSPECT_HTML, PROJECT_FILES_DIR } from "../paths.js";
import { logger } from "../logging.js";
import { httpError, readJsonBody, wrap } from "../http-error.js";
import { getProject, updateProject } from "../db/dao/projects.js";
import { getDb } from "../db/connection.js";
import { ensureMigrated } from "../db/ensure.js";
import { generatePlaywrightJs, type RecordedStep } from "../services/script-generator.js";

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

/** 会话 meta 索引（轻字段，历史列表/会话计数用；steps 内含 base64 截图，全量读取是 MB 级） */
function inspectMetaFile(sid: string): string {
  return `${INSPECT_DATA_DIR}/${sid}.meta.json`;
}

/** 时间线落盘（仅本页记录，与 index.html 的 sessions/ 完全隔离） */
export function inspectPersist(sid: string): void {
  const meta = INSPECT_META.get(sid) ?? {};
  const log = INSPECT_LOG.get(sid) ?? [];
  const data = {
    session_id: sid,
    start_url: meta["start_url"] ?? "",
    project_id: meta["project_id"] ?? null,
    created_at: meta["created_at"],
    updated_at: now(),
    step_count: log.length,
    steps: log,
  };
  try {
    writeFileSync(inspectFile(sid), JSON.stringify(data, null, 1), "utf-8");
  } catch (exc) {
    logger.warning("[inspect] 落盘失败 %s: %s", sid, exc instanceof Error ? exc.message : exc);
  }
  // 同步写 meta 索引：列表接口零全量读取
  try {
    writeFileSync(
      inspectMetaFile(sid),
      JSON.stringify({
        sid,
        start_url: data.start_url,
        project_id: data.project_id,
        created_at: data.created_at,
        updated_at: data.updated_at,
        step_count: data.step_count,
      }),
      "utf-8",
    );
  } catch {
    /* meta 写失败不影响主数据 */
  }
}

/** 读会话 meta：优先索引；旧数据无索引 → 全量读一次并补建索引 */
export function inspectReadMeta(sid: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(inspectMetaFile(sid), "utf-8")) as Record<string, unknown>;
  } catch {
    /* 无索引走全量补建 */
  }
  try {
    const full = JSON.parse(readFileSync(inspectFile(sid), "utf-8")) as Record<string, unknown>;
    const meta = {
      sid,
      start_url: full["start_url"] ?? "",
      project_id: full["project_id"] ?? null,
      created_at: full["created_at"],
      updated_at: full["updated_at"],
      step_count: Array.isArray(full["steps"]) ? full["steps"].length : 0,
    };
    try {
      writeFileSync(inspectMetaFile(sid), JSON.stringify(meta), "utf-8");
    } catch {
      /* pass */
    }
    return meta;
  } catch {
    return null;
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

/** 步骤流瘦身：剔除 base64 截图等大字段（落库/步骤 JSON 用；截图单独存文件） */
function slimSteps(steps: RecordedStep[]): RecordedStep[] {
  return steps.map((s) => {
    const { screenshot: _shot, ...rest } = s as RecordedStep & { screenshot?: string };
    return rest;
  });
}

/** 截图文件名安全化：去 Windows 非法字符，截 40 字符 */
function shotName(idx: number, s: RecordedStep): string {
  const safe = String(s.desc || s.method || "step")
    .replace(/[\\/:*?"<>|\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40)
    .replace(/[. ]+$/, "");
  return `step_${String(idx + 1).padStart(2, "0")}${safe ? "_" + safe : ""}.jpg`;
}

/** 录制产物落盘：project-files/{projectId}/ 下生成脚本镜像 / 步骤流 / 每步截图 */
function writeProjectFiles(projectId: string, sid: string, steps: RecordedStep[], jsCode: string): string[] {
  const dir = `${PROJECT_FILES_DIR}/${projectId}`;
  mkdirSync(dir, { recursive: true });
  const shotDir = `${dir}/screenshots`;
  rmSync(shotDir, { recursive: true, force: true }); // 旧录制截图清空（树与磁盘一致）
  mkdirSync(shotDir, { recursive: true });

  writeFileSync(`${dir}/generated.js`, jsCode, "utf-8");
  writeFileSync(
    `${dir}/steps.json`,
    JSON.stringify({ sessionId: sid, generatedAt: new Date().toISOString(), steps: slimSteps(steps) }, null, 1),
    "utf-8",
  );
  const written: string[] = [];
  steps.forEach((s, i) => {
    const m = /^data:image\/(png|jpeg|jpg);base64,(.+)$/.exec(String(s.screenshot ?? ""));
    if (!m) return; // 无截图的步骤（导航/对话框等）不生成文件
    try {
      const rel = `screenshots/${shotName(i, s)}`;
      writeFileSync(`${dir}/${rel}`, Buffer.from(m[2]!, "base64"));
      written.push(rel);
    } catch {
      /* 单张失败不阻塞 */
    }
  });
  return written;
}

/**
 * 结束保存 → 生成全部工程文件：录制时间线 → 项目脚本 + 磁盘产物。
 * 1) 生成 Playwright JS 写入所属项目（scriptContent + recordConfig 步骤流）；
 * 2) 落盘 project-files/{projectId}/：generated.js（脚本镜像）/ steps.json（步骤流）/ screenshots/（每步截图）；
 * 3) 补齐该项目脚本为空的旧任务快照（任务先于脚本创建 → 空快照执行必败）；
 *    非空快照是任务创建时的定点留档，不覆盖。
 * 无绑定项目 / 无步骤 / 项目已删 → null（保持"仅时间线落盘"行为）。
 */
export function syncRecordingToProject(sid: string): Record<string, unknown> | null {
  try {
    ensureMigrated();
    const data = inspectLoadDisk(sid);
    if (!data) return null;
    const projectId = String(data["project_id"] ?? "");
    const steps = (Array.isArray(data["steps"]) ? data["steps"] : []) as RecordedStep[];
    if (!projectId || steps.length === 0) return null;
    const project = getProject(projectId);
    if (!project) return null;

    const jsCode = generatePlaywrightJs(steps);
    const startUrl = String(data["start_url"] ?? "");
    updateProject(projectId, {
      scriptContent: jsCode,
      scriptLang: "js",
      recordConfig: { steps: slimSteps(steps) }, // base64 截图不入库（步骤流瘦身）
      ...(startUrl && !project.startUrl ? { startUrl } : {}),
    });
    const tasksRefreshed = getDb()
      .prepare(
        "UPDATE tasks SET script_snapshot = ?, script_lang = 'js'" +
          " WHERE project_id = ? AND (script_snapshot IS NULL OR script_snapshot = '')",
      )
      .run(jsCode, projectId).changes;
    const shots = writeProjectFiles(projectId, sid, steps, jsCode);
    logger.info(
      `[inspect] 会话 ${sid} 已生成项目文件: ${project.name}（${steps.length} 步，${shots.length} 张截图，补齐 ${tasksRefreshed} 个空快照任务）`,
    );
    return { projectId, projectName: project.name, steps: steps.length, tasksRefreshed, screenshots: shots.length };
  } catch (exc) {
    logger.warning("[inspect] 录制同步项目失败 %s: %s", sid, exc instanceof Error ? exc.message : exc);
    return null;
  }
}

/** 关闭浏览器 + 落盘。触发点: 手动结束 / 30min 空闲 / 新建替换 / 应用退出。返回项目同步结果（未同步为 null）。 */
export async function inspectClose(
  sid: string,
  persist = true,
): Promise<Record<string, unknown> | null> {
  stopInspectUserCapture(sid);
  let sync: Record<string, unknown> | null = null;
  if (persist) {
    inspectPersist(sid);
    sync = syncRecordingToProject(sid); // 结束保存 → 脚本/步骤流/空快照一并生成
  }
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
  return sync;
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
    const projectId = String(body["project_id"] ?? "").trim(); // 所属录制项目（录制项目页发起时绑定）
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
    // 激活 tab 检测通道：调试端口 /json/list 首位即「最近激活 tab」（唯一可靠信号，
    // Playwright 启动参数下 DOM/CDP 信号全部失效）；SMARTBROWSER_CDP_PORT 已设则复用
    const debugPort =
      Number(process.env.SMARTBROWSER_CDP_PORT) > 0
        ? Number(process.env.SMARTBROWSER_CDP_PORT)
        : await freeTcpPort();
    (explorer as unknown as { extra_launch_args?: string[] }).extra_launch_args = [
      `--remote-debugging-port=${debugPort}`,
    ];
    (explorer as unknown as { debug_port?: number }).debug_port = debugPort;
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
    INSPECT_META.set(sid, { start_url: startUrl, created_at: now(), project_id: projectId || null });
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
    let actPage: Page | null = null; // 本轮用户操作所在页（真实操作必发生在激活 tab）

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
            actPage = pg; // 用户操作发生处 → 该页为当前激活 tab
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
    void Promise.all(tasks).then(async () => {
      const l = INSPECT_LOG.get(sid);
      if (!l) return;
      const pagesNow = explorer.context?.pages() ?? [];
      // 2) 新标签页检测（动作之后：click → new_page）；跟随交给激活检测/adopt 通道
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
      // 3) 激活 tab 跟随：调试端口 /json/list 首位 = 用户最近激活 tab（唯一可靠信号）。
      //    用户操作所在页优先——真实操作必发生在激活 tab，可即时跟随不等下一轮轮询
      const activePage = await activePageFromDebugPort(explorer, pagesNow);
      const targetPage = actPage ?? activePage;
      if (targetPage && targetPage !== explorer.page) {
        explorer.page = targetPage;
        const stAct = INSPECT_LIVE_CDP.get(sid);
        if (stAct) stAct["page"] = targetPage;
        logSwitch(sid, actPage ? "[操作]" : "[激活]", targetPage.url());
        notifyInspectPageSwitch(sid);
      }
      // 4) 当前监控页被关闭 → 跟随剩余页（兜底）
      if (explorer.page && explorer.page.isClosed()) {
        const last = pagesNow[pagesNow.length - 1];
        if (last) {
          explorer.page = last;
          const stC = INSPECT_LIVE_CDP.get(sid);
          if (stC) stC["page"] = last;
          notifyInspectPageSwitch(sid);
        }
      }
      // 5) 每个新步骤补截图（异步，最多 2 张/轮防阻塞）
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

// ---------------- 激活 tab 检测（调试端口 /json/list） ----------------

/** 临时监听 127.0.0.1:0 取一个空闲端口（失败返回 0，激活检测优雅降级） */
function freeTcpPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", () => resolve(0));
  });
}

const PAGE_TARGET_IDS = new WeakMap<Page, string>();

/** 页面的 CDP targetId（首次经页面级会话查询后缓存；与 /json/list 条目匹配用） */
async function pageTargetId(page: Page): Promise<string | null> {
  const cached = PAGE_TARGET_IDS.get(page);
  if (cached) return cached;
  try {
    const cdp = await page.context().newCDPSession(page);
    const info = (await cdp.send("Target.getTargetInfo")) as {
      targetInfo?: { targetId?: string };
    };
    await cdp.detach().catch(() => undefined);
    const id = info.targetInfo?.targetId ?? null;
    if (id) PAGE_TARGET_IDS.set(page, id);
    return id;
  } catch {
    return null;
  }
}

/**
 * 激活 tab 检测：调试端口 /json/list 的 page 类 target 按「最近激活」排序，
 * 首位即用户当前激活的 tab。实测真实切 tab 不产生任何 DOM/CDP 事件
 * （Playwright 启动参数下 visibilityState/hasFocus 恒为 visible/true），
 * 轮询此接口是唯一可靠信号；端口不可用/超时 → 返回 null 维持当前监控页。
 */
async function activePageFromDebugPort(
  explorer: UiMcpAgentExplorer,
  pages: Page[],
): Promise<Page | null> {
  const port = (explorer as unknown as { debug_port?: number }).debug_port;
  if (!port || pages.length < 2) return null; // 单页无从切换，省一次 HTTP
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(1500),
    });
    const list = (await res.json()) as Array<{ id?: string; type?: string }>;
    const first = list.find((t) => t.type === "page");
    if (!first?.id) return null;
    for (const pg of pages) {
      if ((await pageTargetId(pg)) === first.id) return pg;
    }
    return null;
  } catch {
    return null;
  }
}

/** 页面切换通知：WS 主帧流 + SSE 兜底双通道置位（监控立即重 attach/重连） */
let lastSwitchLog = 0;
function logSwitch(sid: string, reason: string, url: string): void {
  const now = Date.now();
  if (now - lastSwitchLog > 500) {
    console.log("[inspect] 切页 %s %s -> %s", reason, sid.slice(0, 6), url.slice(0, 60));
    lastSwitchLog = now;
  }
}
export function notifyInspectPageSwitch(sid: string): void {
  const stLive = INSPECT_LIVE_CDP.get(sid);
  if (stLive) stLive["switched"] = true;
  const stWs = INSPECT_WS.get(sid);
  if (stWs) stWs["switched"] = true;
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
    // 新标签页即用户当前操作目标：立即切换（不等加载完成，避免超时导致不跟随）
    if (explorer.page !== popup) explorer.page = popup;
    const st = INSPECT_LIVE_CDP.get(sid);
    if (st) st["page"] = popup;
    notifyInspectPageSwitch(sid);
    INSPECT_LAST_ACTIVE.set(sid, now());
    bindInspectPage(sid, explorer, popup);
    try {
      await popup.waitForLoadState("domcontentloaded", { timeout: 5000 });
    } catch {
      /* 加载等待超时不影响跟随 */
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
        // 页面切换标志（轮询兜底/adopt 置位）：立即通知前端重连，不被帧队列延迟
        const stNow = INSPECT_LIVE_CDP.get(sid);
        if (stNow && stNow["switched"]) {
          stNow["switched"] = false;
          res.write("event: pageswitch\ndata: {}\n\n");
          break;
        }
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

// page.evaluate 只转发单个 arg → 多个入参必须打包成一个对象（散参会被静默丢弃，
// 导致 hit/hitBox 恒为空、所有候选 index=-1 被过滤成空列表）
const PROBE_ALL_JS_SRC = String.raw`({ locs, hitSel, hitBox }) => {
  const all = Array.from(document.querySelectorAll('*'));
  let hit = null;
  if (hitSel) { try { hit = document.querySelector(hitSel); } catch (e) {} }
  // cssPath 含非法 CSS 字符时 querySelector 会抛错/找不到 → 用包围盒匹配兜底
  const boxEq = (el, b) => {
    if (!b) return false;
    const r = el.getBoundingClientRect();
    return Math.abs(r.x - b.x) < 1.5 && Math.abs(r.y - b.y) < 1.5 &&
      Math.abs(r.width - (b.w || 0)) < 1.5 && Math.abs(r.height - (b.h || 0)) < 1.5;
  };
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
    } else if ((m = s.match(/^get_by_alt_text=(.+)$/))) {
      for (const el of all) if ((el.getAttribute('alt') || '') === m[1]) matched.push(el);
    } else if ((m = s.match(/^get_by_title=(.+)$/))) {
      for (const el of all) if ((el.getAttribute('title') || '') === m[1]) matched.push(el);
    } else if ((m = s.match(/^get_by_test_id=(.+)$/))) {
      for (const el of all) if ((el.getAttribute('data-testid') || '') === m[1]) matched.push(el);
    } else {
      try { matched = Array.from(document.querySelectorAll(s)); } catch (e) {}
    }
    const vis = matched.filter(isVisible);
    let idx = hit ? matched.indexOf(hit) : -1;
    if (idx < 0) idx = matched.findIndex((el) => boxEq(el, hitBox));
    results.push({
      locator: loc,
      count: matched.length,
      visible: vis.length,
      index: idx,
      first: matched.length ? txt(matched[0]).slice(0, 200) : ''
    });
  }
  return results;
}`;
// Node playwright 字符串 evaluate 按表达式处理（isFunction=false），函数字符串
// 不会被调用；模块加载时解析为真函数以复现 Python 客户端自动调用行为。
const PROBE_ALL_JS: (payload: {
  locs: string[];
  hitSel: string;
  hitBox: unknown;
}) => unknown = new Function(`return (${PROBE_ALL_JS_SRC});`)();

/** 定位规则优先级：getByRole>getByText>getByLabel>getByPlaceholder>getByAltText>getByTitle>getByTestId>CSS>XPath。
 *  链式定位（父 >> 子）按末段定性。同层保持生成顺序（稳定排序）。 */
function locatorTier(loc: string): number {
  const last = (loc.split(" >> ").pop() ?? "").trim();
  const table: Array<[RegExp, number]> = [
    [/^get_by_role=/i, 0],
    [/^get_by_text=/i, 1],
    [/^get_by_label=/i, 2],
    [/^get_by_placeholder=/i, 3],
    [/^get_by_alt_text=/i, 4],
    [/^get_by_title=/i, 5],
    [/^get_by_test_id=/i, 6],
    [/^(xpath=|\/\/|\.\/|\(\/)/i, 8],
  ];
  for (const [re, tier] of table) if (re.test(last)) return tier;
  return 7; // CSS 及其它
}

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
  // 全量候选参与探测（不做预截断），过滤后再截断展示
  const cands = buildCandidatesFromElement(info, true);
  let scored: Array<Record<string, unknown>> = [];
  try {
    // hitSel/hitBox = 命中元素的唯一 cssPath 与包围盒 → 每个候选附带 index（命中元素在其匹配列表中的序号）
    scored =
      ((await page.evaluate(PROBE_ALL_JS, {
        locs: cands,
        hitSel: String(info["selector"] ?? ""),
        hitBox: info["box"] ?? null,
      })) as Array<Record<string, unknown>>) ?? [];
  } catch (exc) {
    logger.warning(
      "[inspect] 候选批量探测失败（候选计数降级为 0）: %s",
      exc instanceof Error ? exc.message : String(exc),
    );
    scored = cands.map((c) => ({ locator: c, count: 0, visible: 0, index: -1 }));
  }
  // 只保留「选中的就是命中元素」的候选（index>=0 = 命中元素在其匹配列表中），
  // 多匹配的候选执行时会附加 nth 序号；再按定位规则优先级排序
  scored = scored
    .filter((c) => Number(c["index"] ?? -1) >= 0)
    .sort((a, b) => locatorTier(String(a["locator"] ?? "")) - locatorTier(String(b["locator"] ?? "")))
    .slice(0, 6);
  info["candidates"] = scored;
  const best = scored[0];
  info["best"] = best ? String(best["locator"] ?? "") : "";
  info["best_index"] = best ? Number(best["index"] ?? -1) : -1;
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

// ---------------- 面板执行回声抑制 ----------------
// 面板程序化执行（step/坐标点击/滚轮/拖拽）会在页面触发真实可信事件，
// 注入录制器会把它当作用户操作再记一遍 → 同一动作在时间线出现两次。
// 执行前设长截止覆盖慢执行；执行后收敛为短尾窗，接住 blur/change/滚动防抖等滞后事件。
async function suppressRawCapture(page: Page, during: () => Promise<void>): Promise<void> {
  const setDeadline = (ms: number): Promise<void> =>
    page
      .evaluate((ttl) => {
        (window as unknown as { __REC_SUPPRESS_UNTIL__?: number }).__REC_SUPPRESS_UNTIL__ =
          Date.now() + ttl;
      }, ms)
      .then(() => undefined)
      .catch(() => undefined);
  await setDeadline(30000);
  try {
    await during();
  } finally {
    await setDeadline(600);
  }
}

/** 面板动作引发的跳转可能被采集循环先落盘（1s 轮询先于 WS 提交返回），
 *  把 [preLen, 提交位) 内的 navigate 移到本步骤之后，保持「点击 → 跳转」因果顺序。 */
function demoteCausedNavigates(sid: string, preLen: number, evt: Record<string, unknown>): void {
  const logArr = INSPECT_LOG.get(sid);
  if (!logArr) return;
  const commitIdx = logArr.indexOf(evt);
  if (commitIdx < 0 || commitIdx <= preLen) return;
  const seg = logArr.slice(preLen, commitIdx);
  const navigates = seg.filter((s) => s["method"] === "navigate");
  if (!navigates.length) return;
  const rest = seg.filter((s) => s["method"] !== "navigate");
  logArr.splice(preLen, seg.length + 1, ...rest, evt, ...navigates);
  inspectPersist(sid);
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
    await suppressRawCapture(page, async () => {
      await page.mouse.wheel(dx, dy);
      await sleep(0.15);
    });
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
    let locator: unknown = payload["locator"];
    const value = payload["value"];
    const elText = payload["el_text"];
    // 多元素命中：为定位器附加 nth 实例索引（运行时 resolver 与脚本生成器都识别 >> nth=N），
    // 保证录制时点到的那个元素在回放/生成脚本中依然命中，而非触发严格模式多元素报错
    const elCount = Number(payload["el_count"] ?? 0);
    const elIndex = Number(payload["el_index"] ?? -1);
    if (locator && elCount > 1 && elIndex >= 0) {
      const norm = normalizeLocator(locator);
      if (!/nth\s*=\s*\d+$/.test(norm)) locator = `${norm} >> nth=${elIndex}`;
    }
    let warning: unknown = null;
    const preLen = (INSPECT_LOG.get(sid) ?? []).length; // 执行期间可能插入 dialog 等事件
    if (method === "upload_file") {
      // 文件上传（_execute_step 白名单外，直接 set_input_files）
      if (!locator || !value) throw new Error("上传文件需要定位器与本地文件路径"); // 协议错误
      let success = true;
      let error: unknown = null;
      try {
        const locObj = resolveLocatorOnPage(page, normalizeLocator(String(locator)))!;
        await suppressRawCapture(page, () => locObj.first().setInputFiles(String(value)));
      } catch (exc) {
        success = false;
        error = exc instanceof Error ? exc.message : String(exc);
      }
      if (!success) return { ok: false, error: error ?? "上传失败" };
    } else {
      let result: Record<string, unknown> = { ok: false, error: "未执行" };
      await suppressRawCapture(page, async () => {
        result = await inspectStep(explorer, method, locator, value);
      });
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
    demoteCausedNavigates(sid, preLen, evt);
    return { ok: true, event: evt, warning, extra_events: extra };
  }
  if (action === "click_at") {
    // 坐标点击兜底（canvas/无语义元素无候选定位器时）
    const x = Number(payload["x"] ?? 0);
    const y = Number(payload["y"] ?? 0);
    const preLen = (INSPECT_LOG.get(sid) ?? []).length;
    await suppressRawCapture(page, async () => {
      await page.mouse.click(x, y);
      await sleep(0.4);
    });
    const evt = await inspectCommit(
      sid,
      page,
      "click_at",
      `坐标点击 (${Math.trunc(x)},${Math.trunc(y)})`,
      "",
      "",
    );
    demoteCausedNavigates(sid, preLen, evt);
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
    await suppressRawCapture(page, async () => {
      await page.mouse.move(x, y, { steps: 1 });
      await page.mouse.up();
      await sleep(0.4);
    });
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
    const sync = await inspectClose(sid, true);
    return { ok: true, closed: true, sync };
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
    const sync = await inspectClose(sid, true);
    res.json({ ok: true, sync });
  }),
);

inspectRouter.get(
  "/api/inspect/sessions",
  wrap((_req, res) => {
    /** 历史列表（inspect_data/ 目录）+ 存活标记（回放+存活续操）。
     *  只读轻量 meta 索引（steps 含 base64 截图，全量解析是 MB 级——历史瓶颈） */
    const items: Record<string, unknown>[] = [];
    let names: string[] = [];
    try {
      names = readdirSync(INSPECT_DATA_DIR);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name.endsWith(".meta.json")) continue;
      const sid = name.slice(0, -5);
      const meta = inspectReadMeta(sid);
      if (!meta) continue;
      items.push({
        sid,
        start_url: meta["start_url"] ?? "",
        project_id: meta["project_id"] ?? null,
        created_at: meta["created_at"],
        updated_at: meta["updated_at"],
        step_count: Number(meta["step_count"] ?? 0),
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
        project_id: (INSPECT_META.get(sid) ?? {})["project_id"] ?? null,
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
      project_id: data["project_id"] ?? null,
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
          // 页面切换标志（轮询兜底/adopt 置位）→ 立即重 attach 到新页
          if (st["switched"]) {
            st["switched"] = false;
            break;
          }
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
