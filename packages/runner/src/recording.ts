/**
 * AI 录制引擎（HTTP Runner 侧）。
 * 1:1 对照 brick_runner_http/runner/recording.py。
 *
 * 与 Backend 的协议：
 *   启动:  Backend POST {runner}/record/start   → start()
 *   心跳:  POST {heartbeat_url}  (X-Internal-Token)
 *   结果:  POST {callback_url}   (X-Internal-Token)
 *   控制:  Backend POST {runner}/record/{id}/control|stop → applyControl()/requestStop()
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { settings } from "@brickcore/shared";
import { buildRecorderScript } from "./recorder-script.js";

const sleep = (s: number): Promise<void> => new Promise((r) => setTimeout(r, s * 1000));

// Node playwright 的字符串 evaluate 一律按表达式处理（isFunction=false），函数字符串
// 不会被调用；与 Python 客户端（服务端 eval 后自动调用函数）行为不同。
// 模块加载时把函数源码解析为真函数，保证 evaluate 走 isFunction=true 路径。
const SAVE_VAR_FN: () => Record<string, any> | null = new Function(`return (() => {
    if (!window.__REC__ || !window.__LAST_TARGET__) {
        return {
            found: false,
            reason: window.__REC__
                ? "no_hover_target"
                : "script_not_injected",
            hoverAgeMs: window.__LAST_TARGET__IN_MS__
                ? Date.now() - window.__LAST_TARGET__IN_MS__ : 0,
        };
    }
    const R = window.__REC__;
    const t = window.__LAST_TARGET__;
    const candidates = R.buildCandidates(t);
    const meta = R.buildMeta(t);
    const tag = (t.tagName || "").toUpperCase();
    const raw = (tag === "INPUT" || tag === "TEXTAREA")
        ? String(t.value || "").trim()
        : (t.innerText || t.textContent || "").trim();
    return {
        found: true,
        selector: candidates[0] || meta.cssPath || "",
        candidates: candidates,
        meta: meta,
        text: meta.text || "",
        value: raw,
    };
});`)();

export interface RecordFrames {
  total: number;
  listening: number;
  items: Array<{ url: string; name: string; listening: boolean }>;
}

/** 单次录制会话封装 */
export class RecordingSession {
  readonly recordSessionId: number;
  readonly deviceId: string;
  readonly url: string;
  readonly description: string;
  readonly maxRecordTime: number;
  readonly hoverDelayMs: number;
  readonly locatorStrategy: string;
  readonly callbackUrl: string;
  readonly heartbeatUrl: string;
  readonly apiKey: string;

  readonly startedAt: number = Date.now() / 1000;
  actions: Record<string, unknown>[] = [];
  paused = false;
  lastControlResult: Record<string, unknown> | null = null;
  frames: RecordFrames = { total: 0, listening: 0, items: [] };

  private readonly _script: string;
  private _stop = false;
  private _finishEmitted = false;
  private _browser: Browser | null = null;
  private _context: BrowserContext | null = null;
  private _page: Page | null = null;
  private _lastUrl: string | null = null;
  private _heartbeatTask: Promise<void> | null = null;
  private _timeoutTask: Promise<void> | null = null;
  private _stopWaiters: Array<() => void> = [];

  constructor(payload: Record<string, any>) {
    this.recordSessionId = Number(payload["record_session_id"] ?? 0);
    this.deviceId = String(payload["device_id"] ?? "");
    this.url = String(payload["url"] ?? "");
    this.description = String(payload["description"] ?? "");
    this.maxRecordTime = Number(payload["max_record_time"] ?? 600) || 600;
    this.hoverDelayMs = Number(payload["hover_delay_ms"] ?? 1000) || 1000;
    this.locatorStrategy = String(payload["recording_locator_strategy"] || "default");
    const cb = (payload["callback"] ?? {}) as Record<string, any>;
    this.callbackUrl = String(cb["callback_url"] ?? "");
    this.heartbeatUrl = String(cb["heartbeat_url"] ?? "");
    this.apiKey = String(cb["api_key"] ?? "");
    this._script = buildRecorderScript(this.locatorStrategy);
  }

  // ---------- 生命周期 ----------
  /** 后台任务：开浏览器 → 注入 → 心跳/超时 → 等待结束 → 回调 */
  async run(): Promise<void> {
    try {
      await this._startBrowser();
      await this._waitStop();
      await this._finish(true);
    } catch (e) {
      console.error(`录制会话异常: record_id=${this.recordSessionId} err=${e instanceof Error ? e.message : e}`);
      await this._finish(false, e instanceof Error ? e.message : String(e));
    } finally {
      await this._cleanup();
    }
  }

  private _waitStop(): Promise<void> {
    if (this._stop) return Promise.resolve();
    return new Promise<void>((resolve) => this._stopWaiters.push(resolve));
  }

  private _setStop(): void {
    if (this._stop) return;
    this._stop = true;
    const waiters = this._stopWaiters;
    this._stopWaiters = [];
    for (const w of waiters) w();
  }

  private async _startBrowser(): Promise<void> {
    this._browser = await chromium.launch({
      headless: settings.recordHeadless,
      args: [
        "--start-maximized",
        "--no-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--disable-popup-blocking",
      ],
    });
    const vp = settings.recordViewport;
    this._context = await this._browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      ignoreHTTPSErrors: true,
    });
    // 对所有 frame（含后续导航新建）注入录音脚本
    try {
      await this._context.addInitScript(this._script);
    } catch (e) {
      console.warn(`add_init_script 失败: ${e instanceof Error ? e.message : e}`);
    }

    this._page = await this._context.newPage();
    await this._page.goto(this.url, {
      waitUntil: "domcontentloaded",
      timeout: settings.recordPageLoadTimeoutMs,
    });
    // 对已存在的 iframe 手工再注入一次
    await this._injectExistingFrames();
    this._lastUrl = this._page.url();
    this.frames = await this._computeFrames();

    this._heartbeatTask = this._heartbeatLoop();
    this._timeoutTask = this._autoStop();
    console.info(
      `录制会话已就绪: record_id=${this.recordSessionId} url=${this.url} headless=${String(settings.recordHeadless)}`,
    );
  }

  private async _cleanup(): Promise<void> {
    this._setStop();
    try {
      await this._browser?.close();
    } catch {
      /* pass */
    }
  }

  // ---------- 采集 ----------
  private async _heartbeatLoop(): Promise<void> {
    while (!this._stop) {
      try {
        if (this._page && !this.paused && !this._finishEmitted) {
          const raw = (await this._page.evaluate(() => {
            const w = window as unknown as {
              __RECORDED__?: Record<string, unknown>[];
            };
            const a = w.__RECORDED__ || [];
            w.__RECORDED__ = [];
            return a;
          })) as Record<string, unknown>[] | null;
          for (const it of raw ?? []) this.actions.push(it);
          // 检测用户导航
          const curr = this._page.url();
          if (this._lastUrl !== null && curr !== this._lastUrl) {
            this.actions.push({
              action_type: "navigate",
              timestamp: Math.round(Date.now()),
              url: curr,
              meta: {},
            });
          }
          this._lastUrl = curr;
          this.frames = await this._computeFrames();
        }
        await this._postHeartbeat();
      } catch (e) {
        console.warn(`心跳采集异常: ${e instanceof Error ? e.message : e}`);
      }
      await sleep(settings.recordHeartbeatInterval);
    }
  }

  private async _autoStop(): Promise<void> {
    await sleep(this.maxRecordTime);
    this._setStop();
    console.info(`录制到达最大时长，自动结束: record_id=${this.recordSessionId}`);
  }

  private async _postHeartbeat(): Promise<void> {
    if (!this.heartbeatUrl) return;
    const body = {
      actions_count: this.actions.length,
      raw_actions: this.actions,
      paused: this.paused,
      last_control_result: this.lastControlResult,
      frames: this.frames,
    };
    try {
      await fetch(this.heartbeatUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Token": this.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      console.debug(`心跳上报失败: ${e instanceof Error ? e.message : e}`);
    }
  }

  // ---------- 控制指令 ----------
  async applyControl(command: string, kw: Record<string, any> = {}): Promise<Record<string, unknown>> {
    if (command === "pause") {
      if (this._page) {
        try {
          await this._page.evaluate(() => {
            (window as unknown as Record<string, unknown>).__REC_PAUSED__ = true;
          });
        } catch {
          /* pass */
        }
      }
      this.paused = true;
      return { ok: true, command };
    }

    if (command === "resume") {
      if (this._page) {
        try {
          await this._page.evaluate(() => {
            (window as unknown as Record<string, unknown>).__REC_PAUSED__ = false;
          });
        } catch {
          /* pass */
        }
      }
      this.paused = false;
      return { ok: true, command };
    }

    if (command === "save_variable") {
      return this._saveVariable(String(kw["var_name"] ?? ""), String(kw["source"] ?? "text"));
    }

    if (command === "retry_inject") {
      await this._injectExistingFrames(String(kw["frame_url"] ?? ""), String(kw["frame_name"] ?? ""));
      await this._injectBySlot(String(kw["slot_id"] ?? ""));
      return { ok: true, command, frames: await this._computeFrames() };
    }

    if (command === "stop") {
      this._setStop();
      return { ok: true, command };
    }

    return { ok: false, command, reason: "unsupported_command" };
  }

  async requestStop(reason = "manual"): Promise<void> {
    console.info(`请求结束录制: record_id=${this.recordSessionId} reason=${reason}`);
    this._setStop();
  }

  private async _saveVariable(varName: string, source: string): Promise<Record<string, unknown>> {
    if (!this._page) return { ok: false, command: "save_variable", reason: "page_not_ready" };
    // 复用主注入脚本的 window.__REC__ 工具，保证与 click/fill 事件产出的
    // candidates/meta 完全同构
    let info: Record<string, any> | null = null;
    try {
      info = (await this._page.evaluate(SAVE_VAR_FN)) as Record<string, any> | null;
    } catch (e) {
      console.warn(`读取悬停元素失败: ${e instanceof Error ? e.message : e}`);
      return { ok: false, command: "save_variable", reason: "eval_failed" };
    }

    if (!info || !info["found"]) {
      return {
        ok: false,
        command: "save_variable",
        reason: (info ?? {})["reason"] ?? "no_hover_element",
      };
    }

    const extracted = String(info["value"] ?? info["text"] ?? "").trim();
    const candidates = (info["candidates"] ?? []) as string[];
    const selector = String(info["selector"] ?? (candidates.length ? candidates[0] : ""));
    const meta: Record<string, unknown> = { ...((info["meta"] ?? {}) as Record<string, unknown>) };
    meta["source"] = source;
    meta["locatorRankedByRunner"] = true;
    const action: Record<string, unknown> = {
      action_type: "save_variable",
      timestamp: Math.round(Date.now()),
      selector,
      element_text: info["text"] ?? "",
      value: varName,
      candidates,
      meta,
    };
    this.actions.push(action);
    return {
      ok: true,
      command: "save_variable",
      var_name: varName,
      value: extracted,
      selector,
      source,
    };
  }

  // ---------- frames / 注入 ----------
  private async _injectExistingFrames(frameUrl = "", frameName = ""): Promise<void> {
    if (!this._page) return;
    for (const f of this._page.frames()) {
      const fUrl = f.url() ?? "";
      if (frameUrl && !fUrl.includes(frameUrl)) continue;
      if (frameName && f.name() !== frameName) continue;
      try {
        await f.evaluate(this._script);
      } catch {
        /* pass */
      }
    }
  }

  /** W-33 P2 占位：按槽位重试注入（当前不强依赖槽位，全量重注入即可） */
  private async _injectBySlot(_slotId: string): Promise<void> {
    return;
  }

  private async _computeFrames(): Promise<RecordFrames> {
    if (!this._page) return { total: 0, listening: 0, items: [] };
    const items: Array<{ url: string; name: string; listening: boolean }> = [];
    let total = 0;
    let listening = 0;
    for (const f of this._page.frames()) {
      total += 1;
      let ok = false;
      try {
        ok = Boolean(
          await f.evaluate(() =>
            Boolean((window as unknown as Record<string, unknown>).__REC_INIT__),
          ),
        );
      } catch {
        ok = false;
      }
      if (ok) listening += 1;
      items.push({ url: (f.url() ?? "").slice(0, 120), name: f.name() ?? "", listening: ok });
    }
    return { total, listening, items };
  }

  // ---------- 结果回调 ----------
  private async _finish(success: boolean, error?: string): Promise<void> {
    if (this._finishEmitted) return;
    this._finishEmitted = true;
    this._setStop();
    if (!this.callbackUrl) return;
    const payload: Record<string, unknown> = {
      record_session_id: this.recordSessionId,
      device_id: this.deviceId,
      success,
      actions: this.actions,
      duration_ms: Math.round((Date.now() / 1000 - this.startedAt) * 1000),
    };
    if (error) payload["error"] = error;
    try {
      await fetch(this.callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Token": this.apiKey },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
      console.info(
        `录制结果已回调: record_id=${this.recordSessionId} success=${String(success)} actions=${this.actions.length}`,
      );
    } catch (e) {
      console.error(`录制结果回调失败: ${e instanceof Error ? e.message : e}`);
    }
  }
}

/** 管理多个并发录制会话 */
export class RecordingManager {
  private readonly _sessions = new Map<number, RecordingSession>();

  async start(payload: Record<string, any>): Promise<Record<string, unknown>> {
    const rid = Number(payload["record_session_id"] ?? 0);
    if (!rid) return { ok: false, reason: "missing_record_session_id" };
    if (this._sessions.has(rid)) return { ok: false, reason: "already_recording" };
    const session = new RecordingSession(payload);
    this._sessions.set(rid, session);
    void session.run();
    console.info(`已接受录制任务: record_id=${rid}`);
    return { ok: true, record_session_id: rid };
  }

  async stop(rid: number): Promise<Record<string, unknown>> {
    const session = this._sessions.get(Number(rid));
    if (!session) return { ok: false, reason: "no_active_recorder" };
    await session.requestStop("manual");
    return { ok: true, record_session_id: Number(rid) };
  }

  async control(rid: number, command: string, kw: Record<string, any> = {}): Promise<Record<string, unknown>> {
    const session = this._sessions.get(Number(rid));
    if (!session) return { ok: false, reason: "no_active_recorder", command };
    return session.applyControl(command, kw);
  }

  async shutdown(): Promise<void> {
    for (const session of Array.from(this._sessions.values())) {
      await session.requestStop("shutdown");
    }
  }
}

export const recordingManager = new RecordingManager();
