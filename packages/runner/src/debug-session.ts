/**
 * 交互调试会话引擎（HTTP Runner 侧）。
 * 1:1 对照 brick_runner_http/runner/debug_session.py。
 *
 * 与 Backend 的协议（对齐 backend/app/modules/ui/ui_debug_command.py）：
 *   启动:  Backend POST {runner}/debug/session/start  → run()
 *   轮询:  GET  {callback_base}/runner-command       (X-Internal-Token)
 *   回调:  POST {callback_base}/runner-callback      (X-Internal-Token)
 *   停止:  Backend POST {runner}/debug/session/{id}/stop → requestStop()
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { settings, DEBUG_EVENTS } from "@brickcore/shared";
import { StepExecutor } from "./step-executor.js";

const sleep = (s: number): Promise<void> => new Promise((r) => setTimeout(r, s * 1000));

const DEBUG_SCRIPT = String.raw`
window.__UI_DEBUG__ = {
  highlights: [],
  pickMode: false,
  highlight(desc) {
    this.clearHighlights();
    const el = window.__UI_DEBUG__._find(desc);
    if (!el) return {ok: false, reason: 'not_found'};
    const seen = new Set();
    let cur = el;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      cur.style.outline = '2px solid #ff0000';
      cur.style.outlineOffset = '1px';
      cur = cur.parentElement;
    }
    this.highlights.push(el);
    return {ok: true};
  },
  _find(desc) {
    if (!desc) return null;
    if (desc.tag) {
      let cands = document.querySelectorAll(desc.tag);
      if (desc.text) {
        cands = Array.from(cands).filter(n => n.textContent && n.textContent.includes(desc.text));
      }
      return cands[desc.index || 0] || null;
    }
    if (desc.xpath) {
      const r = document.evaluate(desc.xpath, document, null,
        XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return r.singleNodeValue;
    }
    return null;
  },
  clearHighlights() {
    (this.highlights||[]).forEach(el => {
      el.style.outline = '';
      el.style.outlineOffset = '';
    });
    this.highlights = [];
    return {ok: true};
  },
  setPickMode(on) {
    this.pickMode = !!on;
    return {ok: true};
  }
};
`;

/** 单次交互调试会话封装 */
export class DebugSession {
  readonly debugSessionId: number;
  readonly deviceId: string;
  steps: Record<string, any>[];
  readonly callbackBase: string;
  readonly maxIdleSeconds: number;
  readonly autoNavigate: boolean;
  readonly initialUrl: string;
  hotkeys: Record<string, unknown>;
  readonly apiKey: string;

  private _lastCommandId: string | null = null;
  private _pickMode = false;
  private readonly _variables: Record<string, unknown> = {};

  private _stop = false;
  private _closeReason = "";
  private _browser: Browser | null = null;
  private _context: BrowserContext | null = null;
  private _page: Page | null = null;
  private _stopWaiters: Array<() => void> = [];
  private _polling = false;
  private _idleTimer: NodeJS.Timeout | null = null;
  private readonly _executor = new StepExecutor();

  constructor(env: Record<string, any>, debugSession: Record<string, any>) {
    this.debugSessionId = Number(debugSession["debug_session_id"] ?? 0);
    this.deviceId = String(env["device_id"] ?? "");
    this.steps = Array.from((debugSession["steps"] ?? []) as Record<string, any>[]);
    this.callbackBase = String(debugSession["callback_base"] ?? "");
    this.maxIdleSeconds = Number(
      debugSession["max_idle_seconds"] ?? env["debug_idle_timeout_seconds"] ?? 300,
    );
    this.autoNavigate = Boolean(debugSession["auto_navigate"] ?? true);
    this.initialUrl = String(debugSession["initial_url"] ?? "");
    this.hotkeys = { ...((debugSession["hotkeys"] ?? {}) as Record<string, unknown>) };
    this.apiKey = String(env["runner_api_key"] ?? settings.internalApiKey);
  }

  // ---------- 生命周期 ----------
  async run(): Promise<void> {
    try {
      await this._startBrowser();
      if (this.autoNavigate && this.initialUrl) {
        try {
          await this._page!.goto(this.initialUrl, {
            waitUntil: "domcontentloaded",
            timeout: settings.recordPageLoadTimeoutMs,
          });
        } catch (e) {
          console.warn(`初始导航失败 session=${this.debugSessionId}: ${e instanceof Error ? e.message : e}`);
        }
      }

      await this._report(undefined, DEBUG_EVENTS.READY, { headless: false });

      this._polling = true;
      const pollTask = this._pollLoop();
      this._idleTimer = setTimeout(() => {
        if (!this._stop) {
          console.info(`交互调试会话空闲超时，自动关闭 session=${this.debugSessionId}`);
          this._closeReason = "idle_timeout";
          this._setStop();
        }
      }, this.maxIdleSeconds * 1000);
      this._idleTimer.unref();

      await this._waitStop();
      await this._report(undefined, DEBUG_EVENTS.CLOSED, { reason: this._closeReason || "user_close" });
      this._polling = false;
      await pollTask;
    } catch (e) {
      console.error(`交互调试会话异常 session=${this.debugSessionId} err=${e instanceof Error ? e.message : e}`);
      await this._report(undefined, DEBUG_EVENTS.ERROR, { error: String(e instanceof Error ? e.message : e) });
    } finally {
      await this.cleanup();
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
      headless: false,
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
    // 注入交互调试用脚本（高亮/拾取）
    try {
      await this._context.addInitScript(DEBUG_SCRIPT);
    } catch (e) {
      console.warn(`交互调试 add_init_script 失败: ${e instanceof Error ? e.message : e}`);
    }
    this._page = await this._context.newPage();
    console.info(`交互调试会话已就绪: session=${this.debugSessionId} device=${this.deviceId}`);
  }

  async cleanup(): Promise<void> {
    this._polling = false;
    if (this._idleTimer) clearTimeout(this._idleTimer);
    try {
      await this._browser?.close();
    } catch {
      /* pass */
    }
  }

  // ---------- 命令轮询 ----------
  private async _pollLoop(): Promise<void> {
    while (this._polling && !this._stop) {
      try {
        const cmd = await this._fetchCommand();
        if (cmd) await this._dispatchAction(cmd);
      } catch (e) {
        console.warn(`命令轮询/执行异常 session=${this.debugSessionId}: ${e instanceof Error ? e.message : e}`);
      }
      await sleep(settings.debugPollInterval);
    }
  }

  private async _fetchCommand(): Promise<Record<string, any> | null> {
    if (!this.callbackBase) return null;
    const url = `${this.callbackBase}/runner-command`;
    let node: Record<string, any> | null = null;
    try {
      const resp = await fetch(url, {
        headers: { "X-Internal-Token": this.apiKey },
        signal: AbortSignal.timeout(10000),
      });
      if (resp.status !== 200) return null;
      const data = (await resp.json()) as Record<string, any>;
      node = (data["data"] ?? null) as Record<string, any> | null;
      if (!node) return null;
    } catch (e) {
      console.debug(`拉取命令失败 session=${this.debugSessionId}: ${e instanceof Error ? e.message : e}`);
      return null;
    }

    const cmdId = node["command_id"];
    // 去重：重复 command_id 视为已处理
    if (cmdId && cmdId === this._lastCommandId) return null;
    this._lastCommandId = String(cmdId ?? "");
    return node;
  }

  private async _dispatchAction(cmd: Record<string, any>): Promise<void> {
    const cmdId = cmd["command_id"] ? String(cmd["command_id"]) : undefined;
    const action = String(cmd["action"] ?? "");
    // 后端返回的 pending_command 为 {command_id, action, status, **payload}，
    // payload 字段平铺在顶层，此处剔除元信息后即为命令参数。
    const payload: Record<string, any> = {};
    for (const [k, v] of Object.entries(cmd)) {
      if (!["command_id", "action", "status"].includes(k)) payload[k] = v;
    }

    console.info(`调试命令 session=${this.debugSessionId} action=${action}`);

    try {
      if (action === "run") await this._actionRun(cmdId, payload);
      else if (action === "highlight") await this._actionHighlight(cmdId, payload);
      else if (action === "verify_locator") await this._actionVerify(cmdId, payload);
      else if (action === "pick_mode") await this._actionPickMode(cmdId, payload);
      else if (action === "set_hotkeys") void this._actionSetHotkeys(cmdId, payload);
      else if (action === "select_step") await this._actionSelectStep(cmdId, payload);
      else if (action === "sync_steps") await this._actionSyncSteps(cmdId, payload);
      else if (action === "clear_highlight") await this._actionClearHighlight(cmdId);
      else if (action === "close") await this._actionClose(payload);
      else if (action === "save") this._actionSave();
      else await this._report(cmdId, DEBUG_EVENTS.ERROR, { error: `unknown_action:${action}`, action });
    } catch (e) {
      console.error(`执行调试命令失败 session=${this.debugSessionId} action=${action}: ${e instanceof Error ? e.message : e}`);
      await this._report(cmdId, DEBUG_EVENTS.ERROR, {
        error: String(e instanceof Error ? e.message : e),
        action,
      });
    }
  }

  // ---------- 命令执行 ----------
  private async _actionRun(cmdId: string | undefined, payload: Record<string, any>): Promise<void> {
    const fromIndex = Number(payload["from_index"] ?? 0);
    let throughIndex = Number(payload["through_index"] ?? this.steps.length);
    throughIndex = Math.min(throughIndex, this.steps.length);
    for (let idx = fromIndex; idx < throughIndex; idx++) {
      if (this._stop) return;
      const step = this.steps[idx]!;
      try {
        await this._executor.execute(this._page!, step, this._buildRunEnv(), this._variables);
        await this._report(cmdId, DEBUG_EVENTS.STEP_RESULT, {
          step_index: idx,
          status: "success",
          step,
        });
      } catch (e) {
        await this._report(cmdId, DEBUG_EVENTS.STEP_RESULT, {
          step_index: idx,
          status: "error",
          error: String(e instanceof Error ? e.message : e),
          step,
        });
        break;
      }
    }
  }

  /** 构造执行环境（最简化，复用 env 默认项） */
  private _buildRunEnv(): Record<string, any> {
    return {
      env_default_start_url: "",
      project_default_start_url: "",
      target_host: "",
      ui_nav_wait_until: "domcontentloaded",
    };
  }

  private async _actionHighlight(cmdId: string | undefined, payload: Record<string, any>): Promise<void> {
    const stepIndex = Number(payload["step_index"] ?? 0);
    const step = this.steps.length && stepIndex < this.steps.length ? this.steps[stepIndex]! : {};
    const desc = this._stepLocatorDesc(step);
    let result: Record<string, unknown> = { ok: false, reason: "n/a" };
    if (this._page) {
      try {
        const r = (await this._page.evaluate((d: unknown) => {
          const w = window as unknown as {
            __UI_DEBUG__?: { highlight: (d: unknown) => Record<string, unknown> };
          };
          return w.__UI_DEBUG__ && w.__UI_DEBUG__.highlight(d);
        }, desc)) as Record<string, unknown> | null;
        result = r ?? { ok: false, reason: "no_script" };
      } catch (e) {
        result = { ok: false, reason: String(e instanceof Error ? e.message : e) };
      }
    }
    await this._report(cmdId, DEBUG_EVENTS.HIGHLIGHT_RESULT, { step_index: stepIndex, ...result });
  }

  /** 从步骤提取定位描述 */
  private _stepLocatorDesc(step: Record<string, any>): Record<string, unknown> | null {
    if (!step) return null;
    const params = (step["params"] ?? {}) as Record<string, any>;
    const locator = params["locator"] ?? {};
    if (typeof locator === "object" && locator !== null && !Array.isArray(locator)) {
      return locator as Record<string, unknown>;
    }
    if (typeof locator === "string") return { xpath: locator };
    return null;
  }

  private async _actionVerify(cmdId: string | undefined, payload: Record<string, any>): Promise<void> {
    const stepIndex = Number(payload["step_index"] ?? 0);
    const step = this.steps.length && stepIndex < this.steps.length ? this.steps[stepIndex]! : {};
    const desc = this._stepLocatorDesc(step);
    let found = false;
    let reason = "n/a";
    if (this._page && desc) {
      try {
        const r = await this._page.evaluate((d: unknown) => {
          const w = window as unknown as {
            __UI_DEBUG__?: { _find: (d: unknown) => unknown };
          };
          return w.__UI_DEBUG__!._find(d) !== null;
        }, desc);
        found = Boolean(r);
        reason = found ? "found" : "not_found";
      } catch (e) {
        reason = String(e instanceof Error ? e.message : e);
      }
    }
    await this._report(cmdId, DEBUG_EVENTS.VERIFY_RESULT, { step_index: stepIndex, valid: found, reason });
  }

  private async _actionPickMode(cmdId: string | undefined, payload: Record<string, any>): Promise<void> {
    const enabled = Boolean(payload["enabled"] ?? false);
    this._pickMode = enabled;
    if (this._page) {
      try {
        await this._page.evaluate((e: boolean) => {
          const w = window as unknown as {
            __UI_DEBUG__?: { setPickMode: (e: boolean) => void };
          };
          return w.__UI_DEBUG__ && w.__UI_DEBUG__.setPickMode(e);
        }, enabled);
      } catch {
        /* pass */
      }
    }
    await this._report(cmdId, DEBUG_EVENTS.PICK_MODE, { enabled });
  }

  private async _actionSetHotkeys(cmdId: string | undefined, payload: Record<string, any>): Promise<void> {
    this.hotkeys = { ...((payload["hotkeys"] ?? this.hotkeys) as Record<string, unknown>) };
    // 触发一次性事件，true 表示本次是"提交"而非"实时"
    await this._report(cmdId, DEBUG_EVENTS.HOTKEYS_UPDATED, { hotkeys: this.hotkeys, once: true });
  }

  private async _actionSelectStep(cmdId: string | undefined, payload: Record<string, any>): Promise<void> {
    const stepIndex = Number(payload["step_index"] ?? 0);
    await this._report(cmdId, DEBUG_EVENTS.SELECT_STEP, { step_index: stepIndex });
  }

  private async _actionSyncSteps(cmdId: string | undefined, payload: Record<string, any>): Promise<void> {
    const newSteps = (payload["steps"] ?? []) as Record<string, any>[];
    if (newSteps.length) this.steps = [...newSteps];
    await this._report(cmdId, DEBUG_EVENTS.STEPS_SYNCED, { steps: this.steps });
  }

  private async _actionClearHighlight(cmdId: string | undefined): Promise<void> {
    if (this._page) {
      try {
        await this._page.evaluate(() => {
          const w = window as unknown as {
            __UI_DEBUG__?: { clearHighlights: () => void };
          };
          return w.__UI_DEBUG__ && w.__UI_DEBUG__.clearHighlights();
        });
      } catch {
        /* pass */
      }
    }
    await this._report(cmdId, DEBUG_EVENTS.CLEAR_HIGHLIGHT_RESULT, { ok: true, reason: "clear" });
  }

  private async _actionClose(payload: Record<string, any>): Promise<void> {
    this._closeReason = String(payload["reason"] ?? "user_close");
    this._setStop();
  }

  private _actionSave(): void {
    // save 通常不触发后端回调，无法安全拼装 command_id；仅记录
    console.info(`调试命令 save（忽略，等待后端另行收集录制数据）session=${this.debugSessionId}`);
  }

  // ---------- 停止 ----------
  async requestStop(reason = "user_close"): Promise<Record<string, unknown>> {
    this._closeReason = reason;
    this._setStop();
    return { ok: true, debug_session_id: this.debugSessionId };
  }

  // ---------- 回调 ----------
  private async _report(
    commandId: string | undefined,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.callbackBase) return;
    const url = `${this.callbackBase}/runner-callback`;
    const body: Record<string, unknown> = { event, payload };
    if (commandId) body["command_id"] = commandId;
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Token": this.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      console.debug(`调试回调失败 session=${this.debugSessionId} event=${event}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

/** 管理多个并发交互调试会话 */
export class DebugSessionManager {
  private readonly _sessions = new Map<number, DebugSession>();

  async start(payload: Record<string, any>): Promise<Record<string, unknown>> {
    const env = (payload["env"] ?? {}) as Record<string, any>;
    const debugSession = (payload["debug_session"] ?? {}) as Record<string, any>;
    const sid = Number(debugSession["debug_session_id"] ?? 0);
    if (!sid) return { ok: false, reason: "missing_debug_session_id" };
    if (this._sessions.has(sid)) return { ok: false, reason: "already_debugging" };
    const session = new DebugSession(env, debugSession);
    this._sessions.set(sid, session);
    void session.run();
    console.info(`已接受交互调试任务: session=${sid}`);
    return { ok: true, debug_session_id: sid };
  }

  async stop(sid: number): Promise<Record<string, unknown>> {
    const session = this._sessions.get(Number(sid));
    if (!session) return { ok: false, reason: "no_active_debug_session" };
    await session.requestStop("user_close");
    return { ok: true, debug_session_id: Number(sid) };
  }

  async shutdown(): Promise<void> {
    for (const session of Array.from(this._sessions.values())) {
      await session.requestStop("shutdown");
    }
  }
}

export const debugSessionManager = new DebugSessionManager();
