import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";

// settings 在 import 时读取环境变量 —— 必须先于所有 import 设置
const h = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || process.env.TMP || "/tmp";
  process.env.REPORT_DIR = `${base}/brickcore-engine-test-${process.pid}-${Date.now()}`;
  process.env.RUNNER_ID = "engine-test-runner";
  return {
    gotoDelayMs: 0,
    clickBoom: false, // locator("#boom").click 是否抛错
  };
});

vi.mock("playwright", () => ({
  chromium: {
    launch: async () => ({
      newContext: async () => ({
        newPage: async () => makePage(),
        close: async () => undefined,
      }),
      close: async () => undefined,
    }),
  },
}));

import { settings, type SuitePayload } from "@brickcore/shared";
import { ExecutionEngine } from "../src/engine.js";

// ── 记录型假 page（覆盖 StepExecutor + PageCapture + 截图所需能力）──
function makePage() {
  const handlers: Record<string, Array<(arg: unknown) => void>> = {};
  const mkLoc = (sel: string) => ({
    __sel: sel,
    nth: () => mkLoc(sel),
    click: async () => {
      if (h.clickBoom && sel === "#boom") throw new Error("element detached");
    },
    fill: async () => undefined,
    hover: async () => undefined,
    selectOption: async () => undefined,
    setInputFiles: async () => undefined,
    waitFor: async () => undefined,
    textContent: async () => "actual-text",
    isVisible: async () => true,
    scrollIntoViewIfNeeded: async () => undefined,
    evaluate: async () => undefined,
  });
  return {
    on: (event: string, cb: (arg: unknown) => void) => {
      (handlers[event] ??= []).push(cb);
    },
    emit: (event: string, arg: unknown) => {
      for (const cb of handlers[event] ?? []) void cb(arg);
    },
    url: () => "http://fake/",
    goto: async (url: string) => {
      void url;
      if (h.gotoDelayMs) await new Promise((r) => setTimeout(r, h.gotoDelayMs));
    },
    reload: async () => undefined,
    goBack: async () => undefined,
    close: async () => undefined,
    screenshot: async () => Buffer.from("png"),
    waitForSelector: async () => undefined,
    waitForLoadState: async () => undefined,
    evaluate: async () => undefined,
    keyboard: { press: async () => undefined, type: async () => undefined },
    mouse: { click: async () => undefined },
    locator: (sel: string) => mkLoc(sel),
    getByText: (t: string) => mkLoc(`text=${t}`),
    frame: () => null,
  } as unknown as import("playwright").Page & { emit: (e: string, a: unknown) => void };
}

// ── 全局 fetch mock：记录所有请求，CDP 端点返回 ws 地址 ──
const fetchLog: Array<{ url: string; body: any }> = [];

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
    fetchLog.push({ url, body });
    if (url.includes("/json/version")) {
      return new Response(
        JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/browser/abc" }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 200 });
  }));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function bodies(): any[] {
  return fetchLog.map((f) => f.body).filter((b) => b && b.type);
}

function postedTypes(): string[] {
  return bodies().map((b) => b.type as string);
}

async function waitIdle(eng: ExecutionEngine, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (eng.runningCount() > 0) {
    if (Date.now() - start > timeoutMs) throw new Error("engine 未在超时内空闲");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function makePayload(over: Record<string, unknown> = {}): SuitePayload {
  return {
    suite_execution_id: 77,
    suite: {
      suite_execution_id: 77,
      name: "演示套件",
      pre_actions: [],
      cases: [
        {
          execution_id: 1,
          case_id: "c1",
          name: "登录",
          steps: [{ method: "open_url", params: { url: "http://x" } }],
        },
      ],
    },
    env: {},
    callback: { report_url: "http://cb/report", progress_url: "http://cb/progress", api_key: "k" },
    ...over,
  } as unknown as SuitePayload;
}

describe("ExecutionEngine 基础", () => {
  it("findFreePort 返回可监听端口", async () => {
    const port = await ExecutionEngine.findFreePort();
    expect(port).toBeGreaterThan(0);
    await new Promise<void>((resolve, reject) => {
      const srv = net.createServer();
      srv.once("error", reject);
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve()));
    });
  });

  it("health() 初始状态", () => {
    const eng = new ExecutionEngine();
    const hinfo = eng.health() as Record<string, unknown>;
    expect(hinfo["runner_id"]).toBe("engine-test-runner");
    expect(hinfo["status"]).toBe("alive");
    expect(hinfo["running_tasks"]).toBe(0);
    expect(hinfo["max_concurrent"]).toBe(settings.maxConcurrent);
  });

  it("signalStopAll 无任务时返回 0", () => {
    const eng = new ExecutionEngine();
    expect(eng.signalStopAll()).toBe(0);
  });

  it("signalStop 未知 execution_id 为 no-op", async () => {
    const eng = new ExecutionEngine();
    await expect(eng.signalStop(99999)).resolves.toBeUndefined();
  });
});

describe("ExecutionEngine 套件执行", () => {
  it("完整流程：回调序列 + 本地报告落盘", async () => {
    const eng = new ExecutionEngine();
    fetchLog.length = 0;
    const payload = makePayload({
      suite: {
        suite_execution_id: 77,
        name: "演示套件",
        pre_actions: [{ method: "open_url", params: { url: "http://pre" } }],
        cases: [
          {
            execution_id: 1,
            case_id: "c1",
            name: "登录",
            steps: [{ method: "open_url", params: { url: "http://x" } }],
          },
        ],
      },
    });

    const taskId = await eng.execute(payload);
    expect(taskId).toBeTruthy();
    await waitIdle(eng);

    const types = postedTypes();
    expect(types).toContain("suite_start");
    expect(types).toContain("case_start");
    expect(types).toContain("step_progress");
    expect(types).toContain("case_end");
    expect(types).toContain("suite_end");

    const stepPost = bodies().find((b) => b.type === "step_progress")!;
    expect(stepPost.execution_id).toBe(1);
    expect(stepPost.step_result.method).toBe("open_url");
    expect(stepPost.step_result.status).toBe("passed");
    expect(stepPost.step_result.screenshot).toBeTruthy();

    // 本地报告目录
    const dirs = fs.readdirSync(settings.reportDir).filter((d) => d.endsWith("_77"));
    expect(dirs.length).toBeGreaterThanOrEqual(1);
    const dir = path.join(settings.reportDir, dirs[dirs.length - 1]!);
    expect(fs.existsSync(path.join(dir, "execution.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "index.html"))).toBe(true);
    const json = JSON.parse(fs.readFileSync(path.join(dir, "execution.json"), "utf-8"));
    expect(json.summary.case_total).toBe(1);
    expect(json.summary.case_passed).toBe(1);
    expect(json.cases[0].status).toBe("passed");
    expect(json.pre_actions.length).toBe(1);
    expect(json.pre_actions[0].method).toBe("open_url");
  });

  it("skip 用例发送 case_skip 且不执行", async () => {
    const eng = new ExecutionEngine();
    fetchLog.length = 0;
    await eng.execute(
      makePayload({
        suite: {
          suite_execution_id: 78,
          cases: [
            { execution_id: 1, skip: true, steps: [] },
            { execution_id: 2, case_id: "c2", steps: [{ method: "open_url", params: {} }] },
          ],
        },
      }),
    );
    await waitIdle(eng);

    const types = postedTypes();
    expect(types).toContain("case_skip");
    const skipPost = bodies().find((b) => b.type === "case_skip")!;
    expect(skipPost.execution_id).toBe(1);
    // 仅用例 2 有 case_start
    const caseStarts = bodies().filter((b) => b.type === "case_start").map((b) => b.execution_id);
    expect(caseStarts).toEqual([2]);
  });

  it("断言失败 → failed；stop_on_failure 触发 case_status 且无 case_end", async () => {
    const eng = new ExecutionEngine();
    fetchLog.length = 0;
    await eng.execute(
      makePayload({
        env: { stop_on_failure: true },
        suite: {
          suite_execution_id: 79,
          cases: [
            {
              execution_id: 5,
              steps: [
                { method: "kw_assert_element_text", params: { locator: "#t", text: "nope" } },
                { method: "open_url", params: { url: "http://never" } },
              ],
            },
          ],
        },
      }),
    );
    await waitIdle(eng);

    const statusPost = bodies().find((b) => b.type === "case_status")!;
    expect(statusPost.status).toBe("failed");
    expect(statusPost.error).toContain("文本断言失败");

    const types = postedTypes();
    expect(types).not.toContain("case_end");
    // 第二步未执行
    const stepPosts = bodies().filter((b) => b.type === "step_progress");
    expect(stepPosts).toHaveLength(1);
  });

  it("非断言异常 → error 状态", async () => {
    const eng = new ExecutionEngine();
    fetchLog.length = 0;
    h.clickBoom = true;
    try {
      await eng.execute(
        makePayload({
          suite: {
            suite_execution_id: 80,
            cases: [{ execution_id: 6, steps: [{ method: "click_ele", params: { locator: "#boom" } }] }],
          },
        }),
      );
      await waitIdle(eng);
    } finally {
      h.clickBoom = false;
    }
    const stepPost = bodies().find((b) => b.type === "step_progress")!;
    expect(stepPost.step_result.status).toBe("error");
    expect(stepPost.step_result.error).toContain("element detached");
  });

  it("停止信号：当前用例 stopped、后续用例 case_stop", async () => {
    const eng = new ExecutionEngine();
    fetchLog.length = 0;
    h.gotoDelayMs = 120;
    try {
      await eng.execute(
        makePayload({
          suite: {
            suite_execution_id: 81,
            cases: [
              { execution_id: 7, steps: Array.from({ length: 5 }, () => ({ method: "open_url", params: {} })) },
              { execution_id: 8, steps: [{ method: "open_url", params: {} }] },
            ],
          },
        }),
      );
      await new Promise((r) => setTimeout(r, 260));
      await eng.signalStop(81);
      await waitIdle(eng);
    } finally {
      h.gotoDelayMs = 0;
    }

    const types = postedTypes();
    expect(types).toContain("case_status");
    const stoppedPost = bodies().find((b) => b.type === "case_status")!;
    expect(stoppedPost.status).toBe("stopped");
    expect(stoppedPost.execution_id).toBe(7);

    const stopPost = bodies().find((b) => b.type === "case_stop")!;
    expect(stopPost.execution_id).toBe(8);
    expect(stopPost.reason).toBe("suite_stopped");
    expect(types).toContain("suite_end");
  });

  it("单用例模式：无 suite_start/suite_end，停止键为 case execution_id", async () => {
    const eng = new ExecutionEngine();
    fetchLog.length = 0;
    await eng.execute(
      {
        suite: {
          cases: [{ execution_id: 9, steps: [{ method: "open_url", params: {} }] }],
        },
        env: {},
        callback: { report_url: "http://cb/report", progress_url: "http://cb/progress", api_key: "k" },
      } as unknown as SuitePayload,
    );
    await waitIdle(eng);

    const types = postedTypes();
    expect(types).not.toContain("suite_start");
    expect(types).not.toContain("suite_end");
    expect(types).toContain("case_start");
    expect(types).toContain("case_end");
  });

  it("缺少 suite_execution_id 且非单用例：直接返回不抛错", async () => {
    const eng = new ExecutionEngine();
    fetchLog.length = 0;
    await eng.execute({ env: {}, callback: {} } as unknown as SuitePayload);
    await waitIdle(eng);
    expect(postedTypes()).toEqual([]);
  });
});
