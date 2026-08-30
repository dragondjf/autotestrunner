import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// 先于 import 设置：轮询间隔缩短以加速测试
const h = vi.hoisted(() => {
  process.env.DEBUG_POLL_INTERVAL = "0.02";
  return {
    commandQueue: [] as Array<Record<string, unknown>>,
    gotoUrls: [] as string[],
  };
});

vi.mock("playwright", () => ({
  chromium: {
    launch: async () => ({
      newContext: async () => ({
        addInitScript: async () => undefined,
        newPage: async () => makePage(),
        close: async () => undefined,
      }),
      close: async () => undefined,
    }),
  },
}));

import { DebugSession, DebugSessionManager } from "../src/debug-session.js";

// ── 假 page：按脚本内容分发 evaluate 结果 ──
function makePage() {
  const mkLoc = (sel: string) => ({
    nth: () => mkLoc(sel),
    click: async () => undefined,
    fill: async () => undefined,
    textContent: async () => "t",
    isVisible: async () => true,
    waitFor: async () => undefined,
    scrollIntoViewIfNeeded: async () => undefined,
    selectOption: async () => undefined,
    setInputFiles: async () => undefined,
    hover: async () => undefined,
    evaluate: async () => undefined,
  });
  return {
    url: () => "http://fake/",
    goto: async (url: string) => {
      h.gotoUrls.push(url);
    },
    evaluate: async (script: unknown) => {
      const s = String(script);
      if (s.includes("highlight")) return { ok: true };
      if (s.includes("_find")) return true;
      if (s.includes("setPickMode")) return { ok: true };
      if (s.includes("clearHighlights")) return { ok: true };
      return undefined;
    },
    on: () => undefined,
    close: async () => undefined,
    screenshot: async () => Buffer.from("png"),
    waitForSelector: async () => undefined,
    waitForLoadState: async () => undefined,
    reload: async () => undefined,
    goBack: async () => undefined,
    keyboard: { press: async () => undefined, type: async () => undefined },
    mouse: { click: async () => undefined },
    locator: (sel: string) => mkLoc(sel),
    getByText: (t: string) => mkLoc(`text=${t}`),
    frame: () => null,
  } as unknown as import("playwright").Page;
}

// ── fetch mock：GET /runner-command 出队；POST /runner-callback 记录 ──
const callbacks: Array<Record<string, any>> = [];

beforeAll(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/runner-command")) {
      const cmd = h.commandQueue.shift() ?? null;
      return new Response(JSON.stringify({ data: cmd }), { status: 200 });
    }
    if (url.endsWith("/runner-callback") && init?.body) {
      callbacks.push(JSON.parse(String(init.body)));
    }
    return new Response("{}", { status: 200 });
  }));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function basePayload(over: Record<string, unknown> = {}): Record<string, any> {
  return {
    env: { device_id: "dev-1", runner_api_key: "k" },
    debug_session: {
      debug_session_id: 1,
      steps: [{ method: "open_url", params: { url: "http://x" } }],
      callback_base: "http://cb",
      max_idle_seconds: 60,
      auto_navigate: true,
      initial_url: "http://start/",
      hotkeys: {},
    },
    ...over,
  };
}

function events(): string[] {
  return callbacks.map((c) => c.event);
}

describe("DebugSession", () => {
  it("全命令分发：ready → 各命令结果 → closed", async () => {
    callbacks.length = 0;
    h.gotoUrls.length = 0;
    h.commandQueue = [
      { command_id: "c1", action: "highlight", step_index: 0 },
      { command_id: "c2", action: "verify_locator", step_index: 0 },
      { command_id: "c3", action: "pick_mode", enabled: true },
      { command_id: "c4", action: "sync_steps", steps: [{ method: "open_url", params: { url: "http://y" } }] },
      { command_id: "c5", action: "select_step", step_index: 0 },
      { command_id: "c6", action: "set_hotkeys", hotkeys: { F5: "run" } },
      { command_id: "c7", action: "run", from_index: 0, through_index: 1 },
      { command_id: "c8", action: "clear_highlight" },
      { command_id: "c9", action: "close", reason: "user_close" },
    ];

    const session = new DebugSession(basePayload().env, basePayload().debug_session);
    await session.run();
    // set_hotkeys 的回调为 fire-and-forget，稍等确保落账
    await new Promise((r) => setTimeout(r, 50));

    // 初始导航
    expect(h.gotoUrls[0]).toBe("http://start/");
    // run 命令执行了 sync 后的步骤
    expect(h.gotoUrls).toContain("http://y");

    const ev = events();
    expect(ev).toContain("ready");
    expect(ev).toContain("highlight_result");
    expect(ev).toContain("verify_result");
    expect(ev).toContain("pick_mode");
    expect(ev).toContain("steps_synced");
    expect(ev).toContain("select_step");
    expect(ev).toContain("hotkeys_updated");
    expect(ev).toContain("step_result");
    expect(ev).toContain("clear_highlight_result");
    expect(ev).toContain("closed");

    const hl = callbacks.find((c) => c.event === "highlight_result")!;
    expect(hl.command_id).toBe("c1");
    expect(hl.payload.ok).toBe(true);

    const verify = callbacks.find((c) => c.event === "verify_result")!;
    expect(verify.payload.valid).toBe(true);

    const step = callbacks.find((c) => c.event === "step_result")!;
    expect(step.payload.status).toBe("success");
    expect(step.payload.step.method).toBe("open_url");

    const hk = callbacks.find((c) => c.event === "hotkeys_updated")!;
    expect(hk.payload.hotkeys).toEqual({ F5: "run" });

    const closed = callbacks.find((c) => c.event === "closed")!;
    expect(closed.payload.reason).toBe("user_close");
  }, 15000);

  it("未知 action → error 事件", async () => {
    callbacks.length = 0;
    h.commandQueue = [
      { command_id: "e1", action: "bogus" },
      { command_id: "e2", action: "close", reason: "user_close" },
    ];
    const session = new DebugSession(basePayload().env, {
      ...basePayload().debug_session,
      debug_session_id: 2,
      auto_navigate: false,
    });
    await session.run();

    const err = callbacks.find((c) => c.event === "error")!;
    expect(err.payload.error).toBe("unknown_action:bogus");
    expect(events()).toContain("closed");
  }, 15000);

  it("run 命令步骤失败 → step_result error 并中断", async () => {
    callbacks.length = 0;
    h.commandQueue = [
      { command_id: "r1", action: "run", from_index: 0, through_index: 2 },
      { command_id: "r2", action: "close", reason: "user_close" },
    ];
    const session = new DebugSession(basePayload().env, {
      ...basePayload().debug_session,
      debug_session_id: 3,
      auto_navigate: false,
      steps: [
        { method: "kw_assert_element_text", params: { locator: "#t", text: "nope" } },
        { method: "open_url", params: { url: "http://never" } },
      ],
    });
    await session.run();

    const stepResults = callbacks.filter((c) => c.event === "step_result");
    expect(stepResults).toHaveLength(1);
    expect(stepResults[0]!.payload.status).toBe("error");
    expect(stepResults[0]!.payload.error).toContain("文本断言失败");
  }, 15000);
});

describe("DebugSessionManager", () => {
  it("缺少 debug_session_id 拒绝；未知会话 stop 返回 no_active_debug_session", async () => {
    const mgr = new DebugSessionManager();
    expect(await mgr.start({})).toEqual({ ok: false, reason: "missing_debug_session_id" });
    expect(await mgr.stop(999)).toEqual({ ok: false, reason: "no_active_debug_session" });
  });

  it("重复启动拒绝 already_debugging", async () => {
    h.commandQueue = [];
    const mgr = new DebugSessionManager();
    const p = basePayload();
    (p.debug_session as Record<string, any>).max_idle_seconds = 0.15;
    const r1 = await mgr.start(p);
    expect(r1).toEqual({ ok: true, debug_session_id: 1 });
    const r2 = await mgr.start(p);
    expect(r2).toEqual({ ok: false, reason: "already_debugging" });
    // 等待空闲超时自然结束
    await new Promise((r) => setTimeout(r, 400));
  }, 10000);
});
