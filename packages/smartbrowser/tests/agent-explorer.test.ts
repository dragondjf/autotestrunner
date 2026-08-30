import { describe, it, expect } from "vitest";
import { UiMcpAgentExplorer, dedupeAgentSteps, _MAX_REPLAN_PER_INDEX, _DUPLICATE_STUCK_HINT } from "../src/agent-explorer.js";
import type { AgentStep, ExploreResult } from "../src/page-fetcher.js";

describe("_stepSignature / _isDuplicateStep（agent_explorer.py:39/46）", () => {
  it("签名为 method|normalized_locator", () => {
    expect(
      UiMcpAgentExplorer._stepSignature({ method: "click_ele", params: { locator: 'get_by_text("登录")' } }),
    ).toBe("click_ele|get_by_text=登录");
    expect(UiMcpAgentExplorer._stepSignature({})).toBe("|");
  });

  it("空签名不判重", () => {
    expect(UiMcpAgentExplorer._isDuplicateStep({}, [{ method: "click_ele", params: { locator: "#a" } }])).toBe(false);
  });

  it("click_ele 与全部历史比对", () => {
    const history = [
      { method: "fill_value", params: { locator: "#user" } },
      { method: "click_ele", params: { locator: "#old" } },
    ];
    expect(
      UiMcpAgentExplorer._isDuplicateStep({ method: "click_ele", params: { locator: "#old" } }, history),
    ).toBe(true);
  });

  it("非 click 仅与最近 5 条比对", () => {
    const history = Array.from({ length: 6 }, (_, i) => ({
      method: "fill_value",
      params: { locator: `#f${i}` },
    }));
    // 第 1 条（超出最近 5 条窗口）不判重
    expect(
      UiMcpAgentExplorer._isDuplicateStep({ method: "fill_value", params: { locator: "#f0" } }, history),
    ).toBe(false);
    // 第 6 条（窗口内）判重
    expect(
      UiMcpAgentExplorer._isDuplicateStep({ method: "fill_value", params: { locator: "#f5" } }, history),
    ).toBe(true);
  });
});

describe("dedupeAgentSteps（agent_explorer.py:419）", () => {
  it("连续同签名与重复 click 被合并", () => {
    const steps: Record<string, unknown>[] = [
      { method: "click_ele", params: { locator: "#a" } },
      { method: "click_ele", params: { locator: "#a" } },
      { method: "fill_value", params: { locator: "#u" } },
      { method: "fill_value", params: { locator: "#u" } }, // 连续同签名 → 合并
      { method: "click_ele", params: { locator: "#b" } },
    ];
    const out = dedupeAgentSteps(steps);
    expect(out).toHaveLength(3);
    expect(out[0]!["params"]).toEqual({ locator: "#a" });
    expect(out[1]!["method"]).toBe("fill_value");
    expect(out[2]!["params"]).toEqual({ locator: "#b" });
  });

  it("非 dict 项跳过", () => {
    expect(dedupeAgentSteps(["x", null, { method: "press_key", params: {} }])).toHaveLength(1);
  });
});

// ============================================================
// 主循环冒烟：注入假 page，避免依赖真实浏览器
// ============================================================

/** 构造假 page：支持 url()/waitForLoadState()/locator().ariaSnapshot()/evaluate() */
function makeFakePage(url = "http://fake/") {
  return {
    url: () => url,
    waitForLoadState: async () => undefined,
    evaluate: async () => [],
    locator: () => ({ ariaSnapshot: async () => '- button "登录"' }),
    setDefaultTimeout: () => undefined,
  } as unknown as NonNullable<UiMcpAgentExplorer["page"]>;
}

class FakeExplorer extends UiMcpAgentExplorer {
  executed: AgentStep[] = [];

  /** 预置假 page（resume 模式不调用 _initBrowser，需手动注入） */
  attach(url = "http://fake/"): void {
    this.page = makeFakePage(url);
    this.context = { pages: () => [this.page] } as unknown as NonNullable<UiMcpAgentExplorer["context"]>;
  }

  async _initBrowser(): Promise<void> {
    this.attach();
  }

  async _takeScreenshot(): Promise<string | null> {
    return null;
  }

  async _executeStep(step: AgentStep): Promise<[boolean, string | null]> {
    this.executed.push(step);
    if (step.method === "failing_method") return [false, "模拟失败"];
    return [true, null];
  }

  async extractInteractiveElements(): Promise<Record<string, unknown>[]> {
    return [];
  }

  async _close(): Promise<void> {
    /* 不真正关闭 */
  }
}

describe("agentExplore 主循环冒烟（假 page）", () => {
  it("正常路径：执行一步后 done，事件序列正确", async () => {
    const ex = new FakeExplorer("http://fake/", "登录系统", 1, 15);
    ex.attach(); // resume 模式跳过 _initBrowser，需预置假 page
    const events: Record<string, any>[] = [];
    let planCalls = 0;
    const result = (await ex.agentExplore({
      llm_plan_func: async () => {
        planCalls += 1;
        if (planCalls === 1) {
          return { done: false, step: { method: "open_url", params: { url: "http://fake/home" }, desc: "打开首页" } };
        }
        return { done: true, message: "任务完成" };
      },
      max_steps: 5,
      resume: true,
      keep_alive: true,
      on_step: async (ev) => {
        events.push(ev);
      },
    })) as ExploreResult & Record<string, unknown>;

    expect(planCalls).toBe(2);
    expect(events[0]!["type"]).toBe("step");
    expect(events[0]).toMatchObject({
      step: 1,
      url: "http://fake/",
      snapshot_type: "aria",
      planned_method: "open_url",
      planned_desc: "打开首页",
      success: true,
      desc: "打开首页",
    });
    expect(events[1]!["type"]).toBe("status");
    expect(events[1]!["done"]).toBe(true);
    expect(events[1]!["message"]).toBe("任务完成");

    expect(result["mode"]).toBe("agent_mcp");
    expect(result["executed_steps"]).toBe(1);
    expect(result["agent_log"]).toHaveLength(2);
    expect(ex.executed).toHaveLength(1);
  });

  it("qa 分支：推送 qa 事件并终止", async () => {
    const ex = new FakeExplorer("http://fake/", "这页面有什么", 1, 5);
    ex.attach();
    const events: Record<string, any>[] = [];
    await ex.agentExplore({
      llm_plan_func: async () => ({ done: false, type: "qa", answer: "页面有登录按钮和输入框" }),
      max_steps: 3,
      resume: true,
      keep_alive: true,
      on_step: async (ev) => events.push(ev),
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "qa",
      step: 1,
      answer: "页面有登录按钮和输入框",
      desc: "页面有登录按钮和输入框",
    });
  });

  it("步骤失败：推 step(success=false) 并记录错误", async () => {
    const ex = new FakeExplorer("http://fake/", "点击某按钮", 1, 5);
    ex.attach();
    const events: Record<string, any>[] = [];
    const result = (await ex.agentExplore({
      llm_plan_func: async () => ({ done: false, step: { method: "failing_method", params: { locator: "#x" }, desc: "点击" } }),
      max_steps: 3,
      resume: true,
      keep_alive: true,
      on_step: async (ev) => events.push(ev),
    })) as ExploreResult & Record<string, unknown>;

    expect(events[0]).toMatchObject({ type: "step", success: false, error: "模拟失败" });
    expect(ex.errors.some((e) => e.includes("Agent 第 1 步执行失败: 模拟失败"))).toBe(true);
    expect(result["executed_steps"]).toBe(0);
  });

  it("LLM 未返回 step：记录错误并终止", async () => {
    const ex = new FakeExplorer("http://fake/", "x", 1, 5);
    ex.attach();
    const result = (await ex.agentExplore({
      llm_plan_func: async () => ({ done: false }),
      max_steps: 3,
      resume: true,
      keep_alive: true,
    })) as ExploreResult & Record<string, unknown>;
    expect(ex.errors).toContain("第 1 步 LLM 未返回有效 step");
    expect(result["executed_steps"]).toBe(0);
  });

  it("重复规划：已提交步骤被再次规划时触发 _DUPLICATE_STUCK_HINT", async () => {
    const ex = new FakeExplorer("http://fake/", "打开首页", 1, 5);
    ex.attach();
    let calls = 0;
    const seenHints: string[] = [];
    const result = (await ex.agentExplore({
      llm_plan_func: async ({ stuck_hint }) => {
        calls += 1;
        seenHints.push(stuck_hint || "");
        // open_url 命中「导航类方法恒为进展」→ 步骤会被提交进 all_steps
        if (calls <= 2) {
          return { done: false, step: { method: "open_url", params: { url: "http://fake/home" }, desc: "打开首页" } };
        }
        return { done: true, message: "任务完成" };
      },
      max_steps: 3,
      resume: true,
      keep_alive: true,
    })) as ExploreResult & Record<string, unknown>;

    // stuck_hint 在每个 step_idx 开始时重置（对齐 Python）：
    // 第 1 步执行并提交 → 第 2 步首次规划即判重 → 置 _DUPLICATE_STUCK_HINT → 第 3 次规划返回 done
    expect(calls).toBe(3);
    expect(seenHints[0]).toBe("");
    expect(seenHints[1]).toBe("");
    expect(seenHints[2]).toBe(_DUPLICATE_STUCK_HINT);
    // 重复被跳过，只真正执行了 1 步
    expect(ex.executed).toHaveLength(1);
    expect(result["executed_steps"]).toBe(1);
  });

  it("无进展耗尽：连续 no_progress 后中止并写入错误", async () => {
    const ex = new FakeExplorer("http://fake/", "点击无反应按钮", 1, 5);
    ex.attach();
    let calls = 0;
    const seenHints: string[] = [];
    const result = (await ex.agentExplore({
      llm_plan_func: async ({ stuck_hint }) => {
        calls += 1;
        seenHints.push(stuck_hint || "");
        // click_ele 且快照不变 → action_made_progress=false → 无进展
        return { done: false, step: { method: "click_ele", params: { locator: "#noop" }, desc: "点击" } };
      },
      max_steps: 3,
      resume: true,
      keep_alive: true,
    })) as ExploreResult & Record<string, unknown>;

    expect(calls).toBe(_MAX_REPLAN_PER_INDEX);
    expect(seenHints[1]).toContain("上一步操作后页面结构未变化");
    expect(ex.errors.some((e) => e.includes("第 1 步执行后页面结构无变化"))).toBe(true);
    expect(result["executed_steps"]).toBe(0);
  });
});
