/**
 * UI 步骤 AI Act 兜底：自愈失败后由 LLM 基于页面 snapshot 规划并返回可执行步骤。
 * 1:1 对照 smartbrowser/src/smartbrowser/ai_act.py。
 */
import { PromptManager } from "./prompts.js";
import { normalizeLocator } from "./locator-utils.js";
import { formatElementsForPrompt, MAX_ARIA_SNAPSHOT_CHARS } from "./page-fetcher.js";
import { resolveStepIntentText } from "./step-intent.js";
import { HEALABLE_METHODS } from "./locator-heal.js";
import type { LLMCallFn, LLMCallResult } from "./llm.js";
import type { RenderPromptFn } from "./locator-heal.js";

export const AI_ACT_METHODS = new Set([
  ...HEALABLE_METHODS,
  "drag_and_drop",
  "frame_drag_and_drop",
  "press_key",
  "scroll_to_height",
  "mouse_click",
]);

/** planner 同款 _extract_json_object（code-block → 整体 json.loads → 正则切片） */
function extractJsonObject(text: string): Record<string, unknown> {
  if (!text) return {};
  const t = text.trim();
  for (const block of [...t.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]!)) {
    try {
      const data = JSON.parse(block.trim());
      if (typeof data === "object" && data !== null && !Array.isArray(data)) return data;
    } catch {
      continue;
    }
  }
  try {
    const data = JSON.parse(t);
    if (typeof data === "object" && data !== null && !Array.isArray(data)) return data;
  } catch {
    /* pass */
  }
  const m = /\{[\s\S]*\}/.exec(t);
  if (m) {
    try {
      const data = JSON.parse(m[0]);
      if (typeof data === "object" && data !== null && !Array.isArray(data)) return data;
    } catch {
      /* pass */
    }
  }
  return {};
}

/** 1:1 _normalize_act_step */
export function _normalizeActStep(
  step: unknown,
  opts: { fallback_method: string },
): Record<string, unknown> | null {
  if (typeof step !== "object" || step === null || Array.isArray(step)) return null;
  const s = step as Record<string, unknown>;
  const method = (String(s["method"] ?? "") || opts.fallback_method || "").trim();
  if (!AI_ACT_METHODS.has(method)) return null;
  let params: Record<string, unknown> =
    typeof s["params"] === "object" && s["params"] !== null && !Array.isArray(s["params"])
      ? { ...(s["params"] as Record<string, unknown>) }
      : {};
  for (const key of ["locator", "selector", "start_selector", "end_selector", "first_locator", "second_locator"]) {
    if (key in params && params[key]) {
      params[key] = normalizeLocator(String(params[key]));
    }
  }
  return {
    method,
    keyword: s["keyword"] || method,
    desc: s["desc"] || "",
    params,
    children: [],
  };
}

export interface PlanAiActStepArgs {
  method: string;
  failed_locator?: string;
  step_desc?: string | null;
  step_intent?: string | null;
  original_params?: Record<string, unknown> | null;
  error_message?: string | null;
  page_url?: string | null;
  accessibility_snapshot?: string | null;
  page_elements?: unknown[] | null;
  call_llm: LLMCallFn;
  render_prompt?: RenderPromptFn | null;
}

export interface AiActResult {
  success: boolean;
  reason?: string;
  step?: Record<string, unknown>;
  confidence?: string;
  snapshot_type?: string;
  tokens_used?: unknown;
  raw_response?: string;
}

/** 规划一步 AI Act 并返回可执行 step 对象（1:1 plan_ai_act_step） */
export async function planAiActStep(args: PlanAiActStepArgs): Promise<AiActResult> {
  const method = (args.method || "").trim();
  if (method && !AI_ACT_METHODS.has(method)) {
    return { success: false, reason: `方法 ${method} 不支持 AI Act 兜底` };
  }

  const intent_text = resolveStepIntentText({ step_intent: args.step_intent, step_desc: args.step_desc });
  if (!intent_text) {
    return { success: false, reason: "缺少业务意图（请填写 intent 或操作名称）" };
  }

  let snapshot_text = (args.accessibility_snapshot || "").trim();
  let snap_type = "provided";
  if (!snapshot_text && args.page_elements && args.page_elements.length) {
    snapshot_text = formatElementsForPrompt(args.page_elements);
    snap_type = "dom";
  }
  if (!snapshot_text) {
    return { success: false, reason: "无法获取页面 snapshot" };
  }

  if (snapshot_text.length > MAX_ARIA_SNAPSHOT_CHARS) {
    snapshot_text = snapshot_text.slice(0, MAX_ARIA_SNAPSHOT_CHARS) + "\n... (truncated)";
  }

  const orig_params =
    typeof args.original_params === "object" && args.original_params !== null && !Array.isArray(args.original_params)
      ? args.original_params
      : {};

  let systemPrompt: string;
  let userPrompt: string;
  try {
    const renderPrompt = args.render_prompt ?? ((code, ctx) => PromptManager.render(code, ctx));
    [systemPrompt, userPrompt] = await renderPrompt("ui_ai_act", {
      method: method || "click_ele",
      failed_locator: args.failed_locator || "",
      step_intent: intent_text,
      step_desc: (args.step_desc || "").trim(),
      error_message: args.error_message || "",
      page_url: args.page_url || "",
      original_params: JSON.stringify(orig_params).slice(0, 4000),
      accessibility_snapshot: snapshot_text,
      snapshot_type: snap_type,
    });
  } catch (exc) {
    return { success: false, reason: exc instanceof Error ? exc.message : String(exc) };
  }

  let resp: LLMCallResult;
  try {
    resp = await args.call_llm(systemPrompt, userPrompt);
  } catch (exc) {
    console.warn(`[ui_ai_act] LLM 调用失败: ${exc instanceof Error ? exc.message : exc}`);
    return { success: false, reason: `LLM 调用失败: ${exc instanceof Error ? exc.message : exc}` };
  }

  const raw = resp.content ?? "";
  const tokens = resp.tokens ?? 0;
  const parsed = extractJsonObject(raw);

  const step_raw =
    typeof parsed["step"] === "object" && parsed["step"] !== null && !Array.isArray(parsed["step"])
      ? parsed["step"]
      : parsed;
  const act_step = _normalizeActStep(step_raw, { fallback_method: method });
  if (!act_step) {
    return {
      success: false,
      reason: (parsed["reason"] as string) || "LLM 未能给出可执行步骤",
      raw_response: raw,
      tokens_used: tokens,
    };
  }

  const locator_keys = ["locator", "selector", "start_selector", "end_selector"] as const;
  const params = act_step["params"] as Record<string, unknown>;
  const hasLocator = locator_keys.some((k) => params[k]);
  if (!hasLocator && !["press_key", "scroll_to_height", "mouse_click"].includes(method)) {
    return {
      success: false,
      reason: "AI Act 步骤缺少定位器",
      raw_response: raw,
      tokens_used: tokens,
    };
  }

  return {
    success: true,
    step: act_step,
    confidence: (parsed["confidence"] as string) || "medium",
    reason: (parsed["reason"] as string) || "",
    snapshot_type: snap_type,
    tokens_used: tokens,
    raw_response: raw,
  };
}
