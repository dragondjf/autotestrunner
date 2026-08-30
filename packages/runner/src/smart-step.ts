/**
 * smart_step（AI 智能步骤）：复用 smartbrowser 的「快照 → LLM 规划 → 执行」链路，
 * 在当前 page 上按 intent 自主完成操作。
 *
 * 对照 brick_runner_http/runner/step_executor.py 的 smart_step 分支：
 * - Python 侧依赖 browser_use Agent（Node 无等价物），此处以自研轻量 agent 循环替代
 * - **返回结构与 summary 字段与 Python 版 1:1 对齐**（ACCEPTANCE.md 3.4-a）
 * - 复用当前 page（等价且优于 CDP 重连：保留同一上下文与登录态）
 */

import type { Page } from "playwright";
import { captureAccessibilitySnapshot, createAgentPlanFunc, createLlmCall } from "@brickcore/smartbrowser";
import * as variableResolver from "./variable-resolver.js";
import { StepExecutor } from "./step-executor.js";

const DEFAULT_MAX_STEPS = 25;

export interface HistoryEntry {
  model_output: { actions: Array<Record<string, unknown>> } | null;
  error: string | null;
}

/** 对齐 browser_use 的 AgentHistoryList 最小契约（供 summary 生成使用） */
export class AgentHistoryList {
  history: HistoryEntry[] = [];
  usage: { entry_count: number } = { entry_count: 0 };
  private readonly _finalResult: string | null;
  private readonly _isDone: boolean;

  constructor(opts: { finalResult: string | null; isDone: boolean; modelCalls: number }) {
    this._finalResult = opts.finalResult;
    this._isDone = opts.isDone;
    this.usage = { entry_count: opts.modelCalls };
  }

  is_done(): boolean {
    return this._isDone;
  }

  has_errors(): boolean {
    return this.history.some((h) => h.error);
  }

  is_successful(): boolean {
    return this._isDone && !this.has_errors();
  }

  errors(): string[] {
    return this.history.filter((h) => h.error).map((h) => h.error as string);
  }

  final_result(): string | null {
    return this._finalResult;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 执行 smart_step。
 * @returns 缺少 intent 时返回 {smart_step_error: "缺少 intent 参数"}（不抛异常）
 */
export async function runSmartStep(
  page: Page,
  params: Record<string, any>,
  env: Record<string, any>,
  variables: Record<string, any>,
): Promise<Record<string, unknown>> {
  const intent = String(params["intent"] ?? "");
  if (!intent) {
    console.warn("smart_step 缺少 intent 参数，跳过执行");
    return { smart_step_error: "缺少 intent 参数" };
  }

  // 优先使用环境负载中的 LLM 配置（由 backend 平台配置注入）
  const llmApiKey =
    env["llm_api_key"] ||
    env["BROWSER_USE_API_KEY"] ||
    process.env.BROWSER_USE_API_KEY ||
    env["OPENAI_API_KEY"] ||
    process.env.OPENAI_API_KEY;

  if (!llmApiKey) {
    throw new Error(
      "smart_step 需要配置 LLM API Key。请设置以下环境变量之一：\n" +
        "  1) BROWSER_USE_API_KEY — 从 https://cloud.browser-use.com 获取\n" +
        "  2) OPENAI_API_KEY — OpenAI API Key\n" +
        "或在平台配置中设置 LLM 模型并确保已设为默认配置。",
    );
  }

  const cfg = {
    base_url: String(env["llm_api_base"] || "https://api.openai.com/v1"),
    api_key: String(llmApiKey),
    model: String(env["llm_model"] || "gpt-4o"),
    temperature: Number(env["llm_temperature"] ?? 0.0),
    max_tokens: Number.parseInt(String(env["llm_max_tokens"] ?? 4096), 10),
    timeout: Number(env["llm_timeout"] ?? 60),
    extra_headers: {},
  };
  const callLlm = createLlmCall(cfg);
  const planFunc = createAgentPlanFunc(callLlm);

  // 复用当前浏览器（Python 侧经 CDP 重连；Node 侧直接在当前 page 上执行，语义等价）
  if (env["_cdp_url"]) {
    console.info(`smart_step 复用当前浏览器: ${String(env["_cdp_url"])}`);
  } else {
    console.info("smart_step 在当前页面上下文执行（无 CDP URL）");
  }

  const maxSteps = Number(params["max_steps"] ?? env["smart_step_max_steps"] ?? DEFAULT_MAX_STEPS);
  const executor = new StepExecutor();

  const history: HistoryEntry[] = [];
  let modelCalls = 0;
  let finalResult: string | null = null;
  let isDone = false;
  let lastAction: string | null = null;

  for (let i = 1; i <= maxSteps; i++) {
    const [snapshot, snapType] = await captureAccessibilitySnapshot(page);
    const plan = await planFunc({
      accessibility_snapshot: snapshot,
      snapshot_type: snapType,
      description: intent,
      executed_steps: history.map((h) => ({
        method: (h.model_output?.actions?.[0]?.["__name__"] as string) ?? "",
        params: h.model_output?.actions?.[0] ?? {},
      })),
      current_url: page.url(),
      step_index: i,
      stuck_hint: "",
    });
    modelCalls += 1;

    if (plan["type"] === "qa") {
      finalResult = String(plan["answer"] ?? "");
      isDone = true;
      history.push({ model_output: null, error: null });
      break;
    }

    if (plan["done"]) {
      isDone = true;
      finalResult = String(plan["message"] ?? "") || null;
      break;
    }

    const rawStep = plan["step"] as Record<string, any> | undefined;
    if (!rawStep) {
      history.push({ model_output: null, error: `第 ${i} 步 LLM 未返回有效 step` });
      break;
    }

    const method = String(rawStep["method"] ?? "");
    const resolved = variableResolver.resolve(
      { method, params: (rawStep["params"] ?? {}) as Record<string, any>, keyword: String(rawStep["keyword"] ?? "") },
      variables,
    );
    lastAction = method;

    try {
      await executor.execute(page, resolved, env, variables);
      history.push({
        model_output: { actions: [{ __name__: method, ...((rawStep["params"] ?? {}) as Record<string, unknown>) }] },
        error: null,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      history.push({
        model_output: { actions: [{ __name__: method }] },
        error: msg,
      });
      break;
    }

    await sleep(300);
  }

  const hist = new AgentHistoryList({ finalResult, isDone, modelCalls });
  hist.history = history;

  const totalSteps = history.length;
  const errors = hist.errors();

  return {
    smart_step: true,
    total_steps: totalSteps,
    model_calls: modelCalls,
    is_done: hist.is_done(),
    has_errors: hist.has_errors(),
    final_result: hist.final_result(),
    errors,
    summary: generateSmartStepSummary(hist, intent, lastAction),
  };
}

/** 从 AgentHistoryList 生成结构化摘要（1:1 _generate_smart_step_summary） */
function generateSmartStepSummary(
  history: AgentHistoryList,
  intent: string,
  lastActionHint?: string | null,
): Record<string, unknown> {
  const totalSteps = history.history.length;
  const modelCalls = history.usage.entry_count;
  const isDone = history.is_done();
  const hasErrors = history.has_errors();
  const isSuccessful = history.is_successful();

  // 提取最后一步的 action 描述
  let lastAction: string | null = null;
  if (history.history.length) {
    const lastStep = history.history[history.history.length - 1]!;
    if (lastStep.model_output && lastStep.model_output.actions.length) {
      const names = lastStep.model_output.actions.map((a) => String(a["__name__"] ?? ""));
      lastAction = names.join(" → ");
    }
  }
  if (!lastAction && lastActionHint) lastAction = lastActionHint;

  const errors = history.errors();

  return {
    intent,
    total_steps: totalSteps,
    model_calls: modelCalls,
    is_done: isDone,
    is_successful: isSuccessful,
    has_errors: hasErrors,
    last_action: lastAction,
    errors: errors.slice(0, 5),
    final_result: history.final_result(),
  };
}
