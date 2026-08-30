/**
 * 默认 UI Agent 规划器（开箱即用）。
 * 1:1 对照 smartbrowser/src/smartbrowser/agent_planner.py。
 */
import { PromptManager } from "./prompts.js";
import type { LLMCallFn } from "./llm.js";

const AGENT_EXECUTED_STEPS_TAIL = 10;

/** Agent 规划时压缩已执行步骤，避免 prompt 膨胀导致重复规划（1:1 _compact_agent_executed_steps） */
export function _compactAgentExecutedSteps(steps: unknown[] | null, tail = AGENT_EXECUTED_STEPS_TAIL): string {
  if (!steps || steps.length === 0) return "";
  if (steps.length <= tail) return JSON.stringify(steps, null, 2);
  const payload = {
    total_executed: steps.length,
    note: "仅展示最近步骤，禁止重复相同 method+locator",
    recent_steps: steps.slice(-tail),
  };
  return JSON.stringify(payload, null, 2);
}

/** 从 LLM 原始输出中提取第一个 JSON 对象（1:1 planner 版 _extract_json_object） */
export function _extractJsonObject(text: string): Record<string, unknown> {
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

export type PlanFunc = (args: {
  accessibility_snapshot: string;
  snapshot_type: string;
  description: string;
  executed_steps: unknown[];
  current_url: string;
  step_index: number;
  stuck_hint?: string;
}) => Promise<Record<string, any>>;

/**
 * 返回默认 llm_plan_func，供 UiMcpAgentExplorer.agentExplore 直接使用（1:1 create_agent_plan_func）。
 */
export function createAgentPlanFunc(callLlm: LLMCallFn): PlanFunc {
  return async function llmPlanFunc({
    accessibility_snapshot,
    snapshot_type,
    description,
    executed_steps,
    current_url,
    step_index,
    stuck_hint = "",
  }): Promise<Record<string, any>> {
    const hint = (stuck_hint || "").trim();
    let systemPrompt: string;
    let userPrompt: string;
    try {
      [systemPrompt, userPrompt] = await PromptManager.render("ui_agent_plan", {
        description,
        accessibility_snapshot,
        snapshot_type,
        executed_steps: _compactAgentExecutedSteps(executed_steps),
        current_url,
        step_index,
        stuck_hint: hint,
        has_stuck_hint: Boolean(hint),
      });
    } catch (exc) {
      return { done: true, message: `Prompt 渲染失败: ${exc instanceof Error ? exc.message : exc}` };
    }

    let resp: { content?: string } | null;
    try {
      resp = await callLlm(systemPrompt, userPrompt);
    } catch (exc) {
      console.error(
        `[ui_agent_plan] LLM 调用失败, step_index=${step_index}, url=${current_url}, user_prompt_chars=${userPrompt.length}, exc=${JSON.stringify(
          exc instanceof Error ? exc.message : String(exc),
        )}`,
      );
      return { done: true, message: `LLM 调用失败: ${exc instanceof Error ? exc.message : exc}` };
    }

    const content = (resp ?? {})["content"] ?? "";
    const parsed = _extractJsonObject(content);
    if (!parsed || Object.keys(parsed).length === 0) {
      return { done: true, message: "无法解析 LLM 响应" };
    }
    if (parsed["type"] === "qa") {
      return { done: false, type: "qa", answer: (parsed["answer"] as string) || (parsed["message"] as string) || "" };
    }
    if (parsed["done"]) {
      return { done: true, message: (parsed["message"] as string) || "完成" };
    }
    const step = parsed["step"];
    if (!step) {
      return { done: true, message: "LLM 未返回 step" };
    }
    return { done: false, step };
  };
}
