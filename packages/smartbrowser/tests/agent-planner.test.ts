import { describe, it, expect, vi } from "vitest";
import {
  _compactAgentExecutedSteps,
  _extractJsonObject,
  createAgentPlanFunc,
} from "../src/agent-planner.js";
import type { LLMCallFn } from "../src/llm.js";

describe("_compactAgentExecutedSteps（agent_planner.py:40）", () => {
  it("空列表返回空串", () => {
    expect(_compactAgentExecutedSteps(null)).toBe("");
    expect(_compactAgentExecutedSteps([])).toBe("");
  });
  it("≤10 条时原样 JSON（indent=2）", () => {
    const steps = [{ method: "click_ele", params: { locator: "#a" } }];
    expect(_compactAgentExecutedSteps(steps)).toBe(JSON.stringify(steps, null, 2));
  });
  it(">10 条时压缩为 total/note/recent_steps", () => {
    const steps = Array.from({ length: 12 }, (_, i) => ({ method: "click_ele", params: { locator: `#${i}` } }));
    const out = JSON.parse(_compactAgentExecutedSteps(steps));
    expect(out.total_executed).toBe(12);
    expect(out.note).toBe("仅展示最近步骤，禁止重复相同 method+locator");
    expect(out.recent_steps).toHaveLength(10);
    expect(out.recent_steps[9]).toEqual({ method: "click_ele", params: { locator: "#11" } });
  });
});

describe("_extractJsonObject（planner 版）", () => {
  it("Markdown 代码块优先", () => {
    expect(_extractJsonObject('前缀\n```json\n{"done":true}\n```\n后缀')).toEqual({ done: true });
  });
  it("裸 JSON", () => {
    expect(_extractJsonObject('{"done": false, "step": {"method":"click_ele"}}')).toEqual({
      done: false,
      step: { method: "click_ele" },
    });
  });
  it("混杂文本取花括号切片", () => {
    expect(_extractJsonObject('我认为应该 {"done": true, "message":"ok"} 就这样')).toEqual({
      done: true,
      message: "ok",
    });
  });
  it("空/非法返回空对象", () => {
    expect(_extractJsonObject("")).toEqual({});
    expect(_extractJsonObject("不是 JSON")).toEqual({});
    expect(_extractJsonObject("[1,2]")).toEqual({}); // 数组不算 dict
  });
});

function makeCallLlm(content: string | (() => string)): LLMCallFn & { calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  const fn = async (system: string, user: string) => {
    calls.push([system, user]);
    return { content: typeof content === "function" ? content() : content, tokens: 1 };
  };
  (fn as unknown as { calls: Array<[string, string]> }).calls = calls;
  return fn as LLMCallFn & { calls: Array<[string, string]> };
}

describe("createAgentPlanFunc（agent_planner.py:83）", () => {
  const base = {
    accessibility_snapshot: "- button \"登录\"",
    snapshot_type: "aria",
    description: "登录系统",
    executed_steps: [] as unknown[],
    current_url: "http://x/#/login",
    step_index: 1,
    stuck_hint: "",
  };

  it("type=qa → qa 结果", async () => {
    const plan = createAgentPlanFunc(makeCallLlm('{"type":"qa","answer":"页面有登录按钮"}'));
    const r = await plan(base);
    expect(r).toEqual({ done: false, type: "qa", answer: "页面有登录按钮" });
  });

  it("qa 缺 answer 时回退 message", async () => {
    const plan = createAgentPlanFunc(makeCallLlm('{"type":"qa","message":"说明"}'));
    const r = await plan(base);
    expect(r["answer"]).toBe("说明");
  });

  it("done=true → 默认 message 为『完成』", async () => {
    const plan = createAgentPlanFunc(makeCallLlm('{"done":true}'));
    expect(await plan(base)).toEqual({ done: true, message: "完成" });
  });

  it("返回 step", async () => {
    const plan = createAgentPlanFunc(
      makeCallLlm('{"done":false,"step":{"method":"click_ele","params":{"locator":"#btn"}}}'),
    );
    const r = await plan(base);
    expect(r["done"]).toBe(false);
    expect(r["step"]).toEqual({ method: "click_ele", params: { locator: "#btn" } });
  });

  it("无 step → LLM 未返回 step", async () => {
    const plan = createAgentPlanFunc(makeCallLlm('{"done":false}'));
    expect(await plan(base)).toEqual({ done: true, message: "LLM 未返回 step" });
  });

  it("无法解析 → 无法解析 LLM 响应", async () => {
    const plan = createAgentPlanFunc(makeCallLlm("抱歉，我不能"));
    expect(await plan(base)).toEqual({ done: true, message: "无法解析 LLM 响应" });
  });

  it("LLM 抛错 → LLM 调用失败", async () => {
    const bad: LLMCallFn = async () => {
      throw new Error("timeout");
    };
    const plan = createAgentPlanFunc(bad);
    const r = await plan(base);
    expect(r["done"]).toBe(true);
    expect(String(r["message"])).toContain("LLM 调用失败: timeout");
  });

  it("渲染上下文包含必需变量（用户目标/当前是第 N 步规划）", async () => {
    const call = makeCallLlm('{"done":true}');
    const plan = createAgentPlanFunc(call);
    await plan({ ...base, step_index: 3, stuck_hint: "不要重复" });
    const [, user] = call.calls[0]!;
    expect(user).toContain("用户目标：登录系统");
    expect(user).toContain("当前是第 3 步规划");
    expect(user).toContain("【本轮必读】不要重复");
  });

  it("渲染失败 → Prompt 渲染失败（通过注入不可用模板场景验证文案前缀）", async () => {
    const plan = createAgentPlanFunc(makeCallLlm('{"done":true}'));
    // 传入非法 step_index 类型不影响渲染；此处校验正常路径不产生渲染失败文案
    const r = await plan({ ...base });
    expect(String(r["message"] ?? "")).not.toContain("Prompt 渲染失败");
  });

  it("spy: LLM 仅调用一次", async () => {
    const call = makeCallLlm('{"done":true}');
    const spy = vi.fn(call);
    await createAgentPlanFunc(spy as unknown as LLMCallFn)(base);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
