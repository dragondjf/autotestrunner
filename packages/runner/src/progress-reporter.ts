/**
 * 进度回传器：通过 HTTP POST 将执行进度 / 结果回传 Backend。
 * 1:1 对照 brick_runner_http/runner/progress_reporter.py。
 */
import type { RunnerCallbackConfig, StepResult } from "@brickcore/shared";

/** 回传失败仅告警，不抛错（对齐 Python） */
async function post(url: string, data: Record<string, unknown>, apiKey: string): Promise<void> {
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(10000),
    });
    if (resp.status >= 400) {
      console.warn(`回传失败 ${url}: ${resp.status}`);
    }
  } catch (e) {
    console.warn(`回传异常 ${url}: ${e instanceof Error ? e.message : e}`);
  }
}

export class ProgressReporter {
  private readonly callback: RunnerCallbackConfig;
  private readonly apiKey: string;

  constructor(callback: RunnerCallbackConfig) {
    this.callback = callback;
    this.apiKey = callback.api_key ?? "";
  }

  private reportUrl(): string {
    // 对齐 Python：callback.get("report_url", "")
    return this.callback.report_url ?? "";
  }

  private progressUrl(): string {
    return this.callback.progress_url ?? "";
  }

  // ── 套件级别 ──
  async reportSuiteStart(suiteExecutionId: number): Promise<void> {
    await post(this.reportUrl(), { type: "suite_start", suite_execution_id: suiteExecutionId }, this.apiKey);
  }

  async reportSuiteEnd(suiteExecutionId: number): Promise<void> {
    await post(this.reportUrl(), { type: "suite_end", suite_execution_id: suiteExecutionId }, this.apiKey);
  }

  async reportSuiteError(suiteExecutionId: number, error: string): Promise<void> {
    await post(
      this.reportUrl(),
      { type: "suite_error", suite_execution_id: suiteExecutionId, error },
      this.apiKey,
    );
  }

  // ── 用例级别 ──
  async reportCaseStart(executionId: number): Promise<void> {
    await post(this.progressUrl(), { type: "case_start", execution_id: executionId }, this.apiKey);
  }

  async reportCaseEnd(executionId: number): Promise<void> {
    await post(this.progressUrl(), { type: "case_end", execution_id: executionId }, this.apiKey);
  }

  async reportCaseStatus(executionId: number, status: string, error?: string | null): Promise<void> {
    await post(
      this.progressUrl(),
      { type: "case_status", execution_id: executionId, status, error },
      this.apiKey,
    );
  }

  async reportCaseSkip(executionId: number): Promise<void> {
    await post(this.progressUrl(), { type: "case_skip", execution_id: executionId }, this.apiKey);
  }

  async reportCaseStop(executionId: number, reason: string): Promise<void> {
    await post(
      this.progressUrl(),
      { type: "case_stop", execution_id: executionId, reason },
      this.apiKey,
    );
  }

  // ── 步骤级别 ──
  async reportStep(executionId: number, stepResult: StepResult): Promise<void> {
    await post(
      this.progressUrl(),
      { type: "step_progress", execution_id: executionId, step_result: stepResult },
      this.apiKey,
    );
  }

  /** Python httpx.AsyncClient.aclose() —— Node fetch 无连接池，此处保持接口一致 */
  async close(): Promise<void> {
    /* no-op */
  }
}
