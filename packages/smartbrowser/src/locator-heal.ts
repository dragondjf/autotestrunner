/**
 * UI 步骤定位器自愈（MCP snapshot + 文本 LLM）。
 * 1:1 对照 smartbrowser/src/smartbrowser/locator_heal.py。
 */
import { PromptManager } from "./prompts.js";
import { normalizeLocator, stripRoleNamePart } from "./locator-utils.js";
import { fetchPageStructure, formatElementsForPrompt, MAX_ARIA_SNAPSHOT_CHARS } from "./page-fetcher.js";
import { resolveStepIntentText } from "./step-intent.js";
import type { LLMCallFn, LLMCallResult } from "./llm.js";

export const HEALABLE_METHODS = new Set([
  "click_ele", "fill_value", "double_click_ele", "clear_value", "set_checked",
  "hover", "focus_element", "select_option", "type_value", "long_click_element",
  "upload_file", "wait_for_element",
  "frame_fill_value", "frame_click_element", "frame_hover", "frame_focus_element",
  "frame_select_option", "frame_type_value", "frame_long_click_element",
  "kw_assert_visible", "kw_assert_hidden", "kw_assert_element_text", "kw_assert_value",
  "kw_assert_attribute", "kw_assert_enabled", "kw_assert_disabled",
  "kw_assert_checked", "kw_assert_empty", "kw_assert_editable", "kw_assert_focused",
  "extract_text", "extract_attribute",
]);

/** 从定位表达式中提取目标可见文案（1:1 _extract_text_from_locator） */
export function _extractTextFromLocator(locator: string): string | null {
  const l = (locator || "").trim();
  if (!l) return null;
  if (l.startsWith("get_by_text=")) return l.slice("get_by_text=".length).trim();
  if (l.startsWith("get_by_role=")) {
    const rest = l.slice("get_by_role=".length);
    const idx = rest.indexOf(",");
    if (idx >= 0) return stripRoleNamePart(rest.slice(idx + 1));
  }
  const m = /:has-text\("([^"]+)"\)/.exec(l);
  if (m) return m[1]!;
  return null;
}

/** 从步骤描述中提取用户意图点击/操作的目标文案（1:1 _extract_target_from_step_desc） */
export function _extractTargetFromStepDesc(stepDesc: string): string | null {
  const d = (stepDesc || "").trim();
  if (!d) return null;
  const patterns = [
    /点击['「]([^'」]+)['」]/,
    /悬停到\s*['「]([^'」]+)['」]/,
    /双击['「]([^'」]+)['」]/,
    /点击\s+(.+?)(?:\s*按钮|\s*链接|$)/,
    /点击\s*(\S+)/,
  ];
  for (const pattern of patterns) {
    const m = pattern.exec(d);
    if (m) {
      const target = m[1]!.trim();
      if (target) return target;
    }
  }
  return null;
}

/** 若新定位器把目标文案缩短，返回拒绝原因（1:1 _reject_shortened_text_match） */
export function _rejectShortenedTextMatch(args: {
  failed_locator: string;
  new_locator: string;
  step_desc?: string | null;
}): string | null {
  const failed_text = _extractTextFromLocator(args.failed_locator);
  const new_text = _extractTextFromLocator(args.new_locator);
  if (!new_text) return null;

  const desc_target = _extractTargetFromStepDesc(args.step_desc || "");
  for (const expected of [desc_target, failed_text]) {
    if (!expected || expected === new_text) continue;
    if (expected.includes(new_text) || new_text.includes(expected)) {
      if (new_text.length < expected.length && new_text !== expected) {
        return (
          `新定位器「${args.new_locator}」比步骤意图「${expected}」匹配范围更小，` +
          "可能点到页面上其他相似按钮"
        );
      }
    }
  }
  return null;
}

/** heal 版 _extract_json_object（与 planner 版差异：无整体 json.loads，仅 code-block + 花括号切片） */
function extractJsonObjectHeal(text: string): Record<string, unknown> {
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
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const data = JSON.parse(t.slice(start, end + 1));
      if (typeof data === "object" && data !== null && !Array.isArray(data)) return data;
    } catch {
      /* pass */
    }
  }
  return {};
}

export type RenderPromptFn = (code: string, context: Record<string, unknown>) => Promise<[string, string]>;

export interface HealLocatorArgs {
  method: string;
  failed_locator: string;
  step_desc?: string | null;
  step_intent?: string | null;
  error_message?: string | null;
  page_url?: string | null;
  accessibility_snapshot?: string | null;
  page_elements?: unknown[] | null;
  call_llm: LLMCallFn;
  ai_config_id?: number | null;
  render_prompt?: RenderPromptFn | null;
}

export interface HealResult {
  success: boolean;
  reason?: string;
  locator?: string;
  confidence?: string;
  snapshot_type?: string;
  tokens_used?: unknown;
  raw_response?: string;
}

/** 基于页面 snapshot 为失败步骤推荐新 locator（1:1 heal_locator） */
export async function healLocator(args: HealLocatorArgs): Promise<HealResult> {
  const method = (args.method || "").trim();
  const failed_locator = (args.failed_locator || "").trim();
  if (!HEALABLE_METHODS.has(method)) {
    return { success: false, reason: `方法 ${method} 不支持 AI 自愈` };
  }
  if (!failed_locator) {
    return { success: false, reason: "缺少 failed_locator" };
  }

  let snap_type = "provided";
  let snapshot_text = (args.accessibility_snapshot || "").trim();

  if (!snapshot_text && args.page_elements && args.page_elements.length) {
    snapshot_text = formatElementsForPrompt(args.page_elements);
    snap_type = "dom";
  }

  if (!snapshot_text && args.page_url) {
    let page_data: Awaited<ReturnType<typeof fetchPageStructure>> = null;
    try {
      page_data = await fetchPageStructure(args.page_url, 15);
    } catch (exc) {
      console.warn(`[ui_locator_heal] fetch_page_structure failed: ${exc instanceof Error ? exc.message : exc}`);
      page_data = null;
    }
    if (page_data) {
      snapshot_text = formatElementsForPrompt(page_data.elements ?? []);
      snap_type = "dom_fetched";
    }
  }

  if (!snapshot_text) {
    return {
      success: false,
      reason: "无法获取页面 snapshot，请提供 page_url 或页面 snapshot",
    };
  }

  if (snapshot_text.length > MAX_ARIA_SNAPSHOT_CHARS) {
    snapshot_text = snapshot_text.slice(0, MAX_ARIA_SNAPSHOT_CHARS) + "\n... (truncated)";
  }

  const intent_text = resolveStepIntentText({ step_intent: args.step_intent, step_desc: args.step_desc });

  let systemPrompt: string;
  let userPrompt: string;
  try {
    const renderPrompt = args.render_prompt ?? ((code, ctx) => PromptManager.render(code, ctx));
    [systemPrompt, userPrompt] = await renderPrompt("ui_locator_heal", {
      method,
      failed_locator,
      step_intent: intent_text,
      step_desc: (args.step_desc || "").trim(),
      error_message: args.error_message || "",
      page_url: args.page_url || "",
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
    console.warn(`[ui_locator_heal] LLM 调用失败: ${exc instanceof Error ? exc.message : exc}`);
    return { success: false, reason: `LLM 调用失败: ${exc instanceof Error ? exc.message : exc}` };
  }
  const raw = resp.content ?? "";
  const tokens = resp.tokens ?? 0;
  const parsed = extractJsonObjectHeal(raw);

  const new_locator = normalizeLocator(
    (parsed["locator"] as string) || (parsed["new_locator"] as string) || "",
  );
  if (!new_locator) {
    return {
      success: false,
      reason: (parsed["reason"] as string) || "LLM 未能给出新定位器",
      raw_response: raw,
      tokens_used: tokens,
    };
  }

  if (new_locator === failed_locator) {
    return {
      success: false,
      reason: "建议定位器与原定位器相同",
      locator: new_locator,
      raw_response: raw,
      tokens_used: tokens,
    };
  }

  const shorten_reason = _rejectShortenedTextMatch({
    failed_locator,
    new_locator,
    step_desc: intent_text,
  });
  if (shorten_reason) {
    return {
      success: false,
      reason: shorten_reason,
      locator: new_locator,
      raw_response: raw,
      tokens_used: tokens,
    };
  }

  return {
    success: true,
    locator: new_locator,
    confidence: (parsed["confidence"] as string) || "medium",
    reason: (parsed["reason"] as string) || "",
    snapshot_type: snap_type,
    tokens_used: tokens,
    raw_response: raw,
  };
}
