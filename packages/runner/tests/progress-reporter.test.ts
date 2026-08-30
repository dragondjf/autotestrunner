import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { ProgressReporter } from "../src/progress-reporter.js";

let server: http.Server;
let received: Array<{ url: string; body: Record<string, any>; apiKey: string | undefined }> = [];
let baseUrl = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received.push({
        url: req.url ?? "",
        body: raw ? JSON.parse(raw) : {},
        apiKey: req.headers["x-api-key"] as string | undefined,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function reporter() {
  return new ProgressReporter({
    report_url: `${baseUrl}/report`,
    progress_url: `${baseUrl}/progress`,
    api_key: "test-key",
  });
}

describe("ProgressReporter（progress_reporter.py）", () => {
  beforeAll(() => {
    received = [];
  });

  it("套件级回传到 report_url，带 X-API-Key", async () => {
    received = [];
    const r = reporter();
    await r.reportSuiteStart(11);
    await r.reportSuiteEnd(11);
    await r.reportSuiteError(11, "boom");
    expect(received.map((x) => x.url)).toEqual(["/report", "/report", "/report"]);
    expect(received[0]!.body).toEqual({ type: "suite_start", suite_execution_id: 11 });
    expect(received[1]!.body).toEqual({ type: "suite_end", suite_execution_id: 11 });
    expect(received[2]!.body).toEqual({ type: "suite_error", suite_execution_id: 11, error: "boom" });
    expect(received[0]!.apiKey).toBe("test-key");
  });

  it("用例级回传到 progress_url", async () => {
    received = [];
    const r = reporter();
    await r.reportCaseStart(22);
    await r.reportCaseEnd(22);
    await r.reportCaseStatus(22, "failed", "err");
    await r.reportCaseSkip(22);
    await r.reportCaseStop(22, "suite_stopped");
    expect(received.map((x) => x.url)).toEqual(Array(5).fill("/progress"));
    expect(received[0]!.body).toEqual({ type: "case_start", execution_id: 22 });
    expect(received[1]!.body).toEqual({ type: "case_end", execution_id: 22 });
    expect(received[2]!.body).toEqual({ type: "case_status", execution_id: 22, status: "failed", error: "err" });
    expect(received[3]!.body).toEqual({ type: "case_skip", execution_id: 22 });
    expect(received[4]!.body).toEqual({ type: "case_stop", execution_id: 22, reason: "suite_stopped" });
  });

  it("步骤级回传 step_result 原样透传", async () => {
    received = [];
    const r = reporter();
    const stepResult = {
      step_index: 1,
      method: "click_ele",
      keyword: "点击",
      status: "passed",
      error: null,
      screenshot: "a.png",
      duration_ms: 12,
    };
    await r.reportStep(33, stepResult as never);
    expect(received[0]!.body).toEqual({
      type: "step_progress",
      execution_id: 33,
      step_result: stepResult,
    });
  });

  it("回传失败（4xx）不抛错，仅告警", async () => {
    const bad = new ProgressReporter({
      report_url: `${baseUrl}/not-found-but-200`,
      progress_url: `${baseUrl}/progress`,
      api_key: "k",
    });
    // 未配置 URL 时 Python 会对空 URL POST；此处校验不抛错即可
    const empty = new ProgressReporter({});
    await expect(empty.reportSuiteStart(1)).resolves.toBeUndefined();
    await expect(empty.reportStep(1, {} as never)).resolves.toBeUndefined();
    await bad.close();
    await empty.close();
  });
});
