import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// settings 在 import 时读取 REPORT_DIR —— 必须先于所有 import 设置
vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || process.env.TMP || "/tmp";
  process.env.REPORT_DIR = `${base}/brickcore-recorder-test-${process.pid}-${Date.now()}`;
});

import { settings } from "@brickcore/shared";
import {
  ExecutionRecorder,
  PageCapture,
  shorten,
  renderHtml,
  MAX_BODY_CHARS,
  MAX_CONSOLE,
} from "../src/execution-recorder.js";

const reportDir = settings.reportDir;

// ── 事件型假 page：收集 on() 注册的回调，可手动 emit ──
function makeEventPage() {
  const handlers: Record<string, Array<(arg: unknown) => void>> = {};
  return {
    on(event: string, cb: (arg: unknown) => void) {
      (handlers[event] ??= []).push(cb);
    },
    emit(event: string, arg: unknown) {
      for (const cb of handlers[event] ?? []) void cb(arg);
    },
  } as unknown as import("playwright").Page & { emit: (e: string, a: unknown) => void };
}

function makeResponse(over: Record<string, unknown> = {}) {
  return {
    url: () => over.url ?? "http://x/api",
    status: () => over.status ?? 200,
    statusText: () => over.statusText ?? "OK",
    headers: () => over.headers ?? { "content-type": "application/json" },
    body: async () => Buffer.from(String(over.body ?? "{}")),
    request: () => ({
      method: () => over.method ?? "GET",
      postData: () => over.postData ?? null,
      resourceType: () => over.resourceType ?? "xhr",
      headers: () => ({ accept: "*/*" }),
    }),
  };
}

describe("shorten", () => {
  it("null/undefined 原样返回 null", () => {
    expect(shorten(null, 10)).toBeNull();
    expect(shorten(undefined, 10)).toBeNull();
  });
  it("未超限原样返回", () => {
    expect(shorten("abc", 10)).toBe("abc");
  });
  it("超限截断并标注总长", () => {
    const out = shorten("x".repeat(5000), MAX_BODY_CHARS)!;
    expect(out.length).toBeLessThan(5000);
    expect(out).toContain(`[截断，共 5000 字符]`);
    expect(out.startsWith("x".repeat(MAX_BODY_CHARS))).toBe(true);
  });
});

describe("PageCapture", () => {
  it("按 step_index 归类网络与 console 事件", async () => {
    const page = makeEventPage();
    const cap = new PageCapture();
    cap.attach(page);

    cap.currentStep = 0;
    page.emit("response", makeResponse({ url: "http://x/a" }));
    page.emit("console", { type: () => "log", text: () => "hello" });

    cap.currentStep = 1;
    page.emit("response", makeResponse({ url: "http://x/b", method: "POST", postData: "q=1" }));
    page.emit("console", { type: () => "error", text: () => "boom" });

    // 等待异步 body 读取完成
    await new Promise((r) => setTimeout(r, 50));

    const s0 = cap.take(0);
    expect(s0.network.map((n) => n.url)).toEqual(["http://x/a"]);
    expect(s0.console.map((c) => c.type)).toEqual(["log"]);

    const s1 = cap.take(1);
    expect(s1.network.map((n) => n.method)).toEqual(["POST"]);
    expect(s1.network[0]!.post_data).toBe("q=1");
    expect(s1.network[0]!.body).toBe("{}");
    expect(s1.console.map((c) => c.type)).toEqual(["error"]);
  });

  it("console 超限裁剪最旧记录", async () => {
    const page = makeEventPage();
    const cap = new PageCapture();
    cap.attach(page);
    for (let i = 0; i < MAX_CONSOLE + 60; i++) {
      page.emit("console", { type: () => "log", text: () => `m${i}` });
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(cap.takeAll().console.length).toBeLessThanOrEqual(MAX_CONSOLE + 10);
  });
});

describe("ExecutionRecorder", () => {
  it("目录命名 <ts>_<suite_execution_id> 且自动创建 screenshots/", () => {
    const rec = new ExecutionRecorder(42, { name: "S" }, {}, "runner-1");
    expect(rec.dir.startsWith(path.normalize(reportDir))).toBe(true);
    expect(path.basename(rec.dir)).toMatch(/^\d{8}_\d{6}_42$/);
    expect(fs.existsSync(rec.shotsDir)).toBe(true);
  });

  it("完整生命周期：beginCase → recordStep → endCase → buildData", async () => {
    const rec = new ExecutionRecorder(100, { name: "套件A" }, { k: "v" }, "runner-1");
    const page = makeEventPage();
    rec.beginCase(7, "case-1", "登录流程", page);

    rec.setStep(7, 0);
    page.emit("response", makeResponse({ url: "http://x/login" }));
    await new Promise((r) => setTimeout(r, 30));

    const png = Buffer.from("fakepng").toString("base64");
    rec.recordStep(
      7,
      { method: "open_url", params: { url: "http://x" }, _step_index: 0 },
      "passed",
      null,
      12,
      png,
    );
    rec.recordStep(
      7,
      { method: "kw_assert_element_text", params: {}, _step_index: 1 },
      "failed",
      "文本断言失败",
      8,
      null,
    );
    rec.endCase(7, "failed", "文本断言失败");

    const data = rec.buildData();
    expect(data["suite_execution_id"]).toBe(100);
    expect(data["suite_name"]).toBe("套件A");
    expect(data["runner_id"]).toBe("runner-1");
    expect(data["env"]).toEqual({ k: "v" });
    expect(data["summary"]).toMatchObject({ case_total: 1, case_failed: 1, step_total: 2 });

    const c = (data["cases"] as Record<string, any>[])[0]!;
    expect(c["execution_id"]).toBe(7);
    expect(c["status"]).toBe("failed");
    expect(c["error"]).toBe("文本断言失败");
    expect(c["duration_ms"]).not.toBeNull();

    const steps = c["steps"] as Record<string, any>[];
    expect(steps[0]!["method"]).toBe("open_url");
    expect(steps[0]!["screenshot"]).toMatch(/^screenshots\/7_s0\.png$/);
    expect(fs.existsSync(path.join(rec.dir, steps[0]!["screenshot"]))).toBe(true);
    expect(steps[0]!["network"][0]!["url"]).toBe("http://x/login");
    expect(steps[1]!["status"]).toBe("failed");
    expect(steps[1]!["screenshot"]).toBeNull();
  });

  it("recordPreStep 记录前置动作", () => {
    const rec = new ExecutionRecorder(101, {}, {}, "r");
    rec.recordPreStep({ method: "open_url", params: {}, _step_index: 0 }, "passed", null, 5, null);
    const data = rec.buildData();
    expect((data["pre_actions"] as unknown[]).length).toBe(1);
  });

  it("save() 落盘 execution.json + index.html", async () => {
    const rec = new ExecutionRecorder(102, { name: "落盘" }, {}, "r");
    const page = makeEventPage();
    rec.beginCase(9, "c", "用例", page);
    rec.recordStep(9, { method: "open_url", params: {}, _step_index: 0 }, "passed", null, 3, null);
    rec.endCase(9, "passed");
    await rec.save();

    const json = JSON.parse(fs.readFileSync(rec.jsonPath, "utf-8"));
    expect(json["cases"][0]["status"]).toBe("passed");
    const html = fs.readFileSync(rec.htmlPath, "utf-8");
    expect(html).toContain("BrickCore 执行报告");
    expect(html).toContain("用例");
  });

  it("isCasePending 判定", () => {
    const rec = new ExecutionRecorder(103, {}, {}, "r");
    const page = makeEventPage();
    rec.beginCase(11, "c", "n", page);
    expect(rec.isCasePending(11)).toBe(true);
    rec.endCase(11, "passed");
    expect(rec.isCasePending(11)).toBe(false);
  });
});

describe("renderHtml", () => {
  it("渲染汇总卡片/用例/步骤/网络/console", () => {
    const html = renderHtml({
      suite_execution_id: 5,
      suite_name: "演示",
      runner_id: "r1",
      started_at: "2026-01-01 00:00:00",
      generated_at: "2026-01-01 00:01:00",
      env: { A: "1" },
      pre_actions: [],
      cases: [
        {
          execution_id: 1,
          case_id: "c1",
          name: "登录",
          status: "failed",
          error: "boom <script>",
          duration_ms: 99,
          steps: [
            {
              step_index: 0,
              method: "open_url",
              keyword: "",
              params: { url: "http://x" },
              status: "passed",
              error: null,
              duration_ms: 10,
              screenshot: null,
              network: [
                {
                  step_index: 0,
                  url: "http://x/api",
                  status: 500,
                  status_text: "ERR",
                  method: "POST",
                  resource_type: "xhr",
                  post_data: null,
                  request_headers: {},
                  response_headers: {},
                  body: null,
                },
              ],
              console: [{ step_index: 0, type: "error", text: "bad" }],
            },
          ],
        },
      ],
      summary: {
        case_total: 1,
        case_passed: 0,
        case_failed: 1,
        case_skipped: 0,
        case_error: 0,
        case_stopped: 0,
        step_total: 1,
        network_total: 1,
        console_total: 1,
      },
    });
    expect(html).toContain("BrickCore 执行报告");
    expect(html).toContain("演示");
    expect(html).toContain("登录");
    expect(html).toContain("http://x/api");
    expect(html).toContain("bad");
    // XSS 转义（模板自身的 <script> 标签除外，用户内容必须被转义）
    expect(html).not.toContain("boom <script>");
    expect(html).toContain("boom &lt;script&gt;");
  });
});
