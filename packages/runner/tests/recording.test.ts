import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// 先于 import 设置：心跳间隔缩短以加速测试
const h = vi.hoisted(() => {
  process.env.RECORD_HEARTBEAT_INTERVAL = "0.05";
  return {
    url: "http://a/",
    heartbeatActions: [] as Array<Record<string, unknown>>,
    saveVarInfo: null as Record<string, unknown> | null,
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

import { RecordingSession, RecordingManager } from "../src/recording.js";

// ── 假 page：按脚本内容分发 evaluate 结果 ──
function makePage() {
  const frame = {
    url: () => h.url,
    name: () => "",
    evaluate: async (script: unknown) => {
      const s = String(script);
      if (s.includes("__REC_INIT__")) return true; // 注入探测：已监听
      return undefined;
    },
  };
  return {
    url: () => h.url,
    goto: async () => undefined,
    evaluate: async (script: unknown) => {
      const s = String(script);
      if (s.includes("__RECORDED__")) return h.heartbeatActions.splice(0);
      if (s.includes("__REC_PAUSED__")) return undefined;
      if (s.includes("__LAST_TARGET__")) return h.saveVarInfo;
      if (s.includes("__REC_INIT__")) return true;
      return undefined;
    },
    frames: () => [frame],
    on: () => undefined,
  } as unknown as import("playwright").Page;
}

// ── fetch mock ──
const posts: Array<{ url: string; body: any }> = [];

beforeAll(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    let body: any = null;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = init.body;
      }
    }
    posts.push({ url, body });
    return new Response("{}", { status: 200 });
  }));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function basePayload(over: Record<string, unknown> = {}): Record<string, any> {
  return {
    record_session_id: 1,
    device_id: "dev-1",
    url: "http://a/",
    description: "",
    max_record_time: 0.2,
    recording_locator_strategy: "default",
    callback: {
      callback_url: "http://cb/finish",
      heartbeat_url: "http://cb/heartbeat",
      api_key: "k",
    },
    ...over,
  };
}

describe("RecordingSession", () => {
  it("max_record_time 到期自动结束并回调结果", async () => {
    posts.length = 0;
    h.heartbeatActions = [{ action_type: "click", selector: "#btn" }];
    const session = new RecordingSession(basePayload({ record_session_id: 11 }));
    await session.run();

    const finish = posts.find((p) => p.url === "http://cb/finish")!;
    expect(finish.body.record_session_id).toBe(11);
    expect(finish.body.success).toBe(true);
    expect(finish.body.actions).toEqual([{ action_type: "click", selector: "#btn" }]);
    expect(finish.body.duration_ms).toBeGreaterThanOrEqual(0);

    // 心跳至少上报一次
    const beats = posts.filter((p) => p.url === "http://cb/heartbeat");
    expect(beats.length).toBeGreaterThanOrEqual(1);
    expect(beats[0]!.body.actions_count).toBeGreaterThanOrEqual(0);
    expect(beats[0]!.body.frames.total).toBe(1);
    expect(beats[0]!.body.frames.listening).toBe(1);
  }, 10000);

  it("页面导航变化产生 navigate 动作", async () => {
    posts.length = 0;
    h.heartbeatActions = [];
    h.url = "http://a/";
    const session = new RecordingSession(basePayload({ record_session_id: 12 }));
    setTimeout(() => {
      h.url = "http://b/";
    }, 100);
    await session.run();
    h.url = "http://a/";

    const finish = posts.find((p) => p.url === "http://cb/finish")!;
    const types = (finish.body.actions as Array<Record<string, unknown>>).map((a) => a.action_type);
    expect(types).toContain("navigate");
    const nav = (finish.body.actions as Array<Record<string, unknown>>).find((a) => a.action_type === "navigate")!;
    expect(nav.url).toBe("http://b/");
  }, 10000);

  it("控制指令：pause/resume/save_variable/retry_inject/未知指令", async () => {
    posts.length = 0;
    h.heartbeatActions = [];
    h.saveVarInfo = {
      found: true,
      selector: "#user",
      candidates: ["#user", "css=[name='u']"],
      meta: { id: "user", tag: "input", role: "textbox" },
      text: "张三",
      value: "张三",
    };
    const session = new RecordingSession(
      basePayload({ record_session_id: 13, max_record_time: 30 }),
    );
    const runPromise = session.run();
    await new Promise((r) => setTimeout(r, 150)); // 等待就绪

    const paused = await session.applyControl("pause");
    expect(paused).toEqual({ ok: true, command: "pause" });
    expect(session.paused).toBe(true);

    const resumed = await session.applyControl("resume");
    expect(resumed).toEqual({ ok: true, command: "resume" });
    expect(session.paused).toBe(false);

    const sv = await session.applyControl("save_variable", { var_name: "v1", source: "text" });
    expect(sv.ok).toBe(true);
    expect(sv.var_name).toBe("v1");
    expect(sv.value).toBe("张三");
    expect(sv.selector).toBe("#user");
    const action = session.actions.find((a) => (a as Record<string, unknown>).action_type === "save_variable") as Record<string, any>;
    expect(action.value).toBe("v1");
    expect(action.meta.source).toBe("text");
    expect(action.meta.locatorRankedByRunner).toBe(true);
    expect(action.candidates).toEqual(["#user", "css=[name='u']"]);

    const ri = await session.applyControl("retry_inject", { frame_url: "http://a/" });
    expect(ri.ok).toBe(true);
    expect((ri.frames as Record<string, unknown>).total).toBe(1);

    const bad = await session.applyControl("bogus");
    expect(bad).toEqual({ ok: false, command: "bogus", reason: "unsupported_command" });

    await session.requestStop("manual");
    await runPromise;
    const finish = posts.find((p) => p.url === "http://cb/finish")!;
    expect(finish.body.success).toBe(true);
  }, 10000);

  it("save_variable 无悬停元素时返回失败原因", async () => {
    h.heartbeatActions = [];
    h.saveVarInfo = { found: false, reason: "no_hover_target" };
    const session = new RecordingSession(basePayload({ record_session_id: 14, max_record_time: 30 }));
    const runPromise = session.run();
    await new Promise((r) => setTimeout(r, 100));

    const sv = await session.applyControl("save_variable", { var_name: "v", source: "text" });
    expect(sv).toEqual({ ok: false, command: "save_variable", reason: "no_hover_target" });

    await session.requestStop();
    await runPromise;
  }, 10000);
});

describe("RecordingManager", () => {
  it("缺少 record_session_id 拒绝", async () => {
    const mgr = new RecordingManager();
    expect(await mgr.start({})).toEqual({ ok: false, reason: "missing_record_session_id" });
  });

  it("重复启动拒绝 already_recording；未知会话 stop/control 返回 no_active_recorder", async () => {
    h.heartbeatActions = [];
    const mgr = new RecordingManager();
    const r1 = await mgr.start(basePayload({ record_session_id: 21, max_record_time: 0.15 }));
    expect(r1).toEqual({ ok: true, record_session_id: 21 });

    const r2 = await mgr.start(basePayload({ record_session_id: 21 }));
    expect(r2).toEqual({ ok: false, reason: "already_recording" });

    expect(await mgr.stop(999)).toEqual({ ok: false, reason: "no_active_recorder" });
    expect(await mgr.control(999, "pause")).toEqual({ ok: false, reason: "no_active_recorder", command: "pause" });

    // 等待会话自然结束（manager 不移除会话，与 Python 一致）
    await new Promise((r) => setTimeout(r, 400));
  }, 10000);
});
