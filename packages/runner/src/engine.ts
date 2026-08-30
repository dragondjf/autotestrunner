/**
 * 执行引擎：管理浏览器生命周期 + 任务调度。
 * 1:1 对照 brick_runner_http/runner/engine.py。
 */
import net from "node:net";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { StopSignal, settings } from "@brickcore/shared";
import type { SmartStepResult, StepResult, SuitePayload } from "@brickcore/shared";
import { StepExecutor } from "./step-executor.js";
import { ProgressReporter } from "./progress-reporter.js";
import { resolve as resolveVariables } from "./variable-resolver.js";
import { capture as captureScreenshot } from "./screenshot-manager.js";
import { ExecutionRecorder } from "./execution-recorder.js";

const sleep = (s: number): Promise<void> => new Promise((r) => setTimeout(r, s * 1000));

/** asyncio.Semaphore 等价（Node 侧轻量实现） */
class Semaphore {
  private _count: number;
  private readonly _waiters: Array<() => void> = [];

  constructor(count: number) {
    this._count = count;
  }

  async acquire(): Promise<void> {
    if (this._count > 0) {
      this._count -= 1;
      return;
    }
    return new Promise<void>((resolve) => this._waiters.push(resolve));
  }

  release(): void {
    const next = this._waiters.shift();
    if (next) next();
    else this._count += 1;
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export class ExecutionEngine {
  private _browser: Browser | null = null;
  private _cdpUrl: string | null = null;
  private readonly _semaphore = new Semaphore(settings.maxConcurrent);
  private readonly _runningTasks = new Set<string>();
  private readonly _stopEvents = new Map<number, StopSignal>();
  private readonly _stepExecutor = new StepExecutor();
  private _shuttingDown = false;

  // ── 生命周期 ──

  async start(): Promise<void> {
    await this._launchBrowser();
  }

  async shutdown(): Promise<void> {
    this._shuttingDown = true;
    this._runningTasks.clear();
    await this._closeBrowser();
    console.info("Runner 已关闭");
  }

  /** 查找一个随机的可用 TCP 端口 */
  static findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.on("error", reject);
      srv.listen(0, () => {
        const addr = srv.address() as { port: number } | null;
        const port = addr ? addr.port : 0;
        srv.close(() => resolve(port));
      });
    });
  }

  /** 启动浏览器实例（可被重复调用，用于断连后重连） */
  private async _launchBrowser(): Promise<void> {
    const cdpPort = await ExecutionEngine.findFreePort();
    this._cdpUrl = null; // 重置

    this._browser = await chromium.launch({
      headless: settings.headless,
      args: ["--no-sandbox", "--disable-setuid-sandbox", `--remote-debugging-port=${cdpPort}`],
    });

    // 等待浏览器 CDP 服务器就绪，获取 WebSocket 地址
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3000);
        const resp = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: ctrl.signal });
        clearTimeout(timer);
        const data = (await resp.json()) as { webSocketDebuggerUrl?: string };
        this._cdpUrl = data.webSocketDebuggerUrl ?? null;
        if (this._cdpUrl) console.info(`CDP 端点已就绪: ${this._cdpUrl}`);
        break;
      } catch (e) {
        console.debug(`等待 CDP 端点就绪 (${attempt + 1}/10): ${e instanceof Error ? e.message : e}`);
        await sleep(1);
      }
    }
    if (!this._cdpUrl) {
      console.warn("无法获取 CDP 端点 URL，smart_step 将使用独立浏览器");
    }

    console.info(
      `Runner 就绪 — ID=${settings.runnerId} 浏览器=${settings.browserType} headless=${settings.headless} cdp=${Boolean(this._cdpUrl)}`,
    );
  }

  /** 关闭浏览器，释放资源（幂等） */
  private async _closeBrowser(): Promise<void> {
    if (this._browser) {
      try {
        await this._browser.close();
      } catch {
        /* pass */
      }
      this._browser = null;
    }
  }

  /** 创建隔离的浏览器上下文；若浏览器连接已断开则自动重启浏览器后重试一次 */
  private async _createContext(): Promise<BrowserContext> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this._browser === null) await this._launchBrowser();
      try {
        return await this._browser!.newContext({
          viewport: { width: 1920, height: 1080 },
          ignoreHTTPSErrors: true,
        });
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        if (err.includes("Connection closed") || err.includes("Target closed") || attempt === 1) {
          console.warn(`浏览器连接异常，重启浏览器后重试: ${err}`);
          await this._closeBrowser();
          await this._launchBrowser();
          continue;
        }
        throw e;
      }
    }
    throw new Error("无法创建浏览器上下文");
  }

  // ── 状态查询 ──

  runningCount(): number {
    return this._runningTasks.size;
  }

  health(): Record<string, unknown> {
    return {
      runner_id: settings.runnerId,
      status: "alive",
      running_tasks: this.runningCount(),
      max_concurrent: settings.maxConcurrent,
      browser_ready: this._browser !== null,
    };
  }

  // ── 任务执行 ──

  /** 接收任务，立即返回 task_id，后台异步执行 */
  async execute(payload: SuitePayload): Promise<string> {
    const taskId = randomUUID();
    this._runningTasks.add(taskId);
    void this._semaphore
      .runExclusive(() => this._doExecute(payload))
      .catch((e) => console.error(`任务执行异常 task=${taskId}: ${e instanceof Error ? e.message : e}`))
      .finally(() => this._runningTasks.delete(taskId));
    return taskId;
  }

  private async _doExecute(payload: SuitePayload): Promise<void> {
    const env = (payload.env ?? {}) as Record<string, any>;
    // 注入 CDP URL（用于 smart_step 重用当前浏览器）
    if (this._cdpUrl) env["_cdp_url"] = this._cdpUrl;
    const suite = (payload.suite ?? {}) as Record<string, any>;
    const callback = payload.callback ?? {};
    let suiteExecutionId = suite["suite_execution_id"] as number | undefined;
    const cases = (suite["cases"] ?? []) as Record<string, any>[];

    // 单用例执行模式（无 UiSuiteExecution 记录）：使用第一个 case 的 execution_id 作为 stop 键
    const isSingleCase = !suiteExecutionId && cases.length === 1;
    if (isSingleCase) {
      suiteExecutionId = Number(cases[0]!["execution_id"]);
      console.info(`单用例执行模式: case_execution_id=${suiteExecutionId}`);
    } else if (!suiteExecutionId) {
      console.error("缺少 suite_execution_id");
      return;
    }

    const reporter = new ProgressReporter(callback);
    const stopEvent = new StopSignal();
    this._stopEvents.set(suiteExecutionId, stopEvent);

    const context = await this._createContext();
    const variables: Record<string, unknown> = { ...((env["variables"] ?? {}) as Record<string, unknown>) };
    const recorder = new ExecutionRecorder(suiteExecutionId, suite, env, settings.runnerId);

    try {
      if (!isSingleCase) {
        await reporter.reportSuiteStart(suiteExecutionId);
        console.info(`套件开始执行: suite_execution_id=${suiteExecutionId}`);
      }

      // 执行前置步骤 (pre_actions)
      const preActions = (suite["pre_actions"] ?? []) as Record<string, any>[];
      for (let preIndex = 0; preIndex < preActions.length; preIndex++) {
        const step = preActions[preIndex]!;
        const page = await context.newPage();
        try {
          const resolvedStep = resolveVariables(step, variables);
          const preStart = performance.now();
          let preStatus = "passed";
          let preError: string | null = null;
          try {
            await this._stepExecutor.execute(page, resolvedStep, env, variables);
          } catch (e) {
            // 断言失败 → failed；其余 → error（Python 用 AssertionError 区分）
            if (e instanceof Error && e.name === "AssertionError") {
              preStatus = "failed";
              preError = e.message;
            } else {
              preStatus = "error";
              preError = `${(e as Error)?.name ?? "Error"}: ${(e as Error)?.message ?? e}`;
            }
          }
          let preShot: string | null = null;
          try {
            preShot = await captureScreenshot(page);
          } catch (e) {
            console.warn(`pre_action 截图失败: ${e instanceof Error ? e.message : e}`);
          }
          recorder.recordPreStep(
            { ...resolvedStep, _step_index: preIndex },
            preStatus,
            preError,
            Math.round(performance.now() - preStart),
            preShot,
          );
        } finally {
          await page.close();
        }
      }

      // 逐用例执行
      for (const caseItem of cases) {
        if (caseItem["skip"]) {
          await reporter.reportCaseSkip(Number(caseItem["execution_id"]));
          continue;
        }
        if (stopEvent.isSet) {
          await reporter.reportCaseStop(Number(caseItem["execution_id"]), "suite_stopped");
          break;
        }
        await this._executeCase(context, caseItem, env, variables, stopEvent, reporter, recorder);
      }

      if (!isSingleCase) {
        await reporter.reportSuiteEnd(suiteExecutionId);
        console.info(`套件执行完成: suite_execution_id=${suiteExecutionId}`);
      }
    } catch (e) {
      console.error(`套件执行异常: ${e instanceof Error ? e.message : e}`);
      if (!isSingleCase) await reporter.reportSuiteError(suiteExecutionId, String(e instanceof Error ? e.message : e));
    } finally {
      await context.close().catch(() => undefined);
      this._stopEvents.delete(suiteExecutionId);
      await reporter.close();
      // 本地落盘：execution.json + index.html + 截图
      await recorder.save();
    }
  }

  private async _executeCase(
    context: BrowserContext,
    caseItem: Record<string, any>,
    env: Record<string, any>,
    variables: Record<string, unknown>,
    stopEvent: StopSignal,
    reporter: ProgressReporter,
    recorder: ExecutionRecorder,
  ): Promise<void> {
    const executionId = Number(caseItem["execution_id"]);
    const caseId = caseItem["case_id"] ?? "";
    const page = await context.newPage();

    recorder.beginCase(executionId, caseId, caseItem["name"] || caseId, page);

    try {
      await reporter.reportCaseStart(executionId);
      console.info(`用例开始执行: execution_id=${executionId} case_id=${caseId}`);

      const steps = (caseItem["steps"] ?? []) as Record<string, any>[];
      for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
        if (stopEvent.isSet) {
          await reporter.reportCaseStatus(executionId, "stopped");
          recorder.endCase(executionId, "stopped");
          return;
        }

        const step = steps[stepIndex]!;
        // 变量替换
        const resolvedStep = resolveVariables(step, variables);
        // 标记当前步骤，用于网络/console 事件归类
        recorder.setStep(executionId, stepIndex);

        const stepStart = performance.now();
        let status: "passed" | "failed" | "error" = "passed";
        let error: string | null = null;

        let execResult: Record<string, unknown> | null = null;
        try {
          execResult = await this._stepExecutor.execute(page, resolvedStep, env, variables);
        } catch (e) {
          if (e instanceof Error && e.name === "AssertionError") {
            status = "failed";
            error = e.message;
          } else {
            status = "error";
            error = `${(e as Error)?.name ?? "Error"}: ${(e as Error)?.message ?? e}`;
          }
        }

        // 截图（1:1：Python 未捕获异常，此处保持一致语义——失败即向外抛）
        const screenshot = await captureScreenshot(page);

        const durationMs = Math.round(performance.now() - stepStart);
        const stepResult: StepResult = {
          step_index: stepIndex,
          method: step["method"],
          keyword: step["keyword"] ?? "",
          status,
          error,
          screenshot,
          duration_ms: durationMs,
        };

        // 融合 smart_step 的 AI 执行摘要
        if (execResult !== null) {
          if (execResult["smart_step"]) {
            stepResult.smart_step = execResult as unknown as SmartStepResult;
            // 若 AI 内部报错但未抛异常，标记为失败并附带摘要中的错误信息
            if (status === "passed" && execResult["has_errors"]) {
              status = "failed";
              const errs = (execResult["errors"] ?? []) as string[];
              error = error || `AI 智能步骤执行内部存在错误: ${errs.length ? errs[0] : "未知错误"}`;
              stepResult.status = status;
              stepResult.error = error;
            }
          } else {
            stepResult.detail = execResult;
          }
        }

        await reporter.reportStep(executionId, stepResult);

        recorder.recordStep(
          executionId,
          { ...resolvedStep, _step_index: stepIndex },
          status,
          error,
          durationMs,
          screenshot,
          (stepResult["smart_step"] as Record<string, unknown> | undefined) ??
            (stepResult["detail"] as Record<string, unknown> | undefined) ??
            null,
        );

        // 失败时：若配置 stop_on_failure 则停止本用例
        if (status !== "passed") {
          if (Boolean(env["stop_on_failure"]) || Boolean(caseItem["stop_on_failure"])) {
            await reporter.reportCaseStatus(executionId, status, error);
            recorder.endCase(executionId, status, error);
            return;
          }
        }
      }

      await reporter.reportCaseEnd(executionId);
      recorder.endCase(executionId, "passed");
      console.info(`用例执行完成: execution_id=${executionId} status=passed`);
    } finally {
      // 若用例被异常中断/未正确结束，补充错误状态
      if (recorder.isCasePending(executionId)) {
        recorder.endCase(executionId, "error", "用例执行异常中断");
      }
      await page.close().catch(() => undefined);
    }
  }

  // ── 停止控制 ──

  /** 触发停止信号 */
  async signalStop(executionId: number): Promise<void> {
    const event = this._stopEvents.get(executionId);
    if (event) {
      event.set();
      console.info(`已发送停止信号 execution_id=${executionId}`);
    }
  }

  /** 触发所有任务的停止信号，返回受影响任务数 */
  signalStopAll(): number {
    let count = 0;
    for (const event of this._stopEvents.values()) {
      event.set();
      count += 1;
    }
    if (count) console.info(`已发送全局停止信号: ${count} 个任务`);
    return count;
  }

  get isShuttingDown(): boolean {
    return this._shuttingDown;
  }
}
