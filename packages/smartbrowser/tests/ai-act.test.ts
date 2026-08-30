import { describe, it, expect } from "vitest";
import { AI_ACT_METHODS, _normalizeActStep, planAiActStep } from "../src/ai-act.js";
import { HEALABLE_METHODS } from "../src/locator-heal.js";
import type { LLMCallFn } from "../src/llm.js";

describe("AI_ACT_METHODS（ai_act.py:19）", () => {
  it("是 HEALABLE_METHODS 的超集且含 5 个扩展方法", () => {
    for (const m of HEALABLE_METHODS) expect(AI_ACT_METHODS.has(m)).toBe(true);
    for (const m of ["drag_and_drop", "frame_drag_and_drop", "press_key", "scroll_to_height", "mouse_click"]) {
      expect(AI_ACT_METHODS.has(m)).toBe(true);
    }
    expect(AI_ACT_METHODS.has("not_a_method")).toBe(false);
  });
});

describe("_normalizeActStep（ai_act.py:56）", () => {
  it("非 dict → null", () => {
    expect(_normalizeActStep(null, { fallback_method: "click_ele" })).toBeNull();
    expect(_normalizeActStep("x", { fallback_method: "click_ele" })).toBeNull();
  });
  it("方法不在白名单 → null（含 fallback 判定）", () => {
    expect(_normalizeActStep({ method: "unknown" }, { fallback_method: "" })).toBeNull();
    expect(_normalizeActStep({}, { fallback_method: "unknown" })).toBeNull();
  });
  it("回退 fallback_method 并规范化定位器键", () => {
    const out = _normalizeActStep(
      { params: { locator: 'get_by_text("登录")', start_selector: "#a", other: 1 } },
      { fallback_method: "click_ele" },
    );
    expect(out).toEqual({
      method: "click_ele",
      keyword: "click_ele",
      desc: "",
      params: { locator: "get_by_text=登录", start_selector: "#a", other: 1 },
      children: [],
    });
  });
  it("params 非 dict → 空 params", () => {
    const out = _normalizeActStep({ method: "press_key", params: "x" }, { fallback_method: "" });
    expect(out!["params"]).toEqual({});
  });
});

const snapshot = '<button> id=btn text=登录系统';

describe("planAiActStep（ai_act.py:76）", () => {
  const base = {
    method: "click_ele",
    failed_locator: "get_by_text=登录",
    step_desc: "点击登录按钮",
    accessibility_snapshot: snapshot,
    call_llm: (async () => ({ content: "", tokens: 0 })) as LLMCallFn,
  };

  it("方法不支持 → 方法 X 不支持 AI Act 兜底", async () => {
    const r = await planAiActStep({ ...base, method: "unknown_method" });
    expect(r).toEqual({ success: false, reason: "方法 unknown_method 不支持 AI Act 兜底" });
  });

  it("缺少业务意图", async () => {
    const r = await planAiActStep({ ...base, step_desc: "", step_intent: null });
    expect(r).toEqual({ success: false, reason: "缺少业务意图（请填写 intent 或操作名称）" });
  });

  it("无 snapshot", async () => {
    const r = await planAiActStep({ ...base, accessibility_snapshot: "", page_elements: [] });
    expect(r).toEqual({ success: false, reason: "无法获取页面 snapshot" });
  });

  it("成功返回规范化 step", async () => {
    const r = await planAiActStep({
      ...base,
      call_llm: async () => ({
        content:
          '{"confidence":"high","reason":"用 id","step":{"method":"click_ele","desc":"点击登录",' +
          '"params":{"locator":"get_by_text(\\"登录\\")"}}}',
        tokens: 5,
      }),
    });
    expect(r["success"]).toBe(true);
    expect(r["step"]).toEqual({
      method: "click_ele",
      keyword: "click_ele",
      desc: "点击登录",
      params: { locator: "get_by_text=登录" },
      children: [],
    });
    expect(r["confidence"]).toBe("high");
    expect(r["snapshot_type"]).toBe("provided");
  });

  it("parsed 顶层即 step 时直接使用", async () => {
    const r = await planAiActStep({
      ...base,
      call_llm: async () => ({ content: '{"method":"click_ele","params":{"locator":"#btn"}}', tokens: 0 }),
    });
    expect(r["success"]).toBe(true);
    expect((r["step"] as Record<string, unknown>)["method"]).toBe("click_ele");
  });

  it("缺少定位器 → AI Act 步骤缺少定位器", async () => {
    const r = await planAiActStep({
      ...base,
      call_llm: async () => ({ content: '{"step":{"method":"click_ele","params":{}}}', tokens: 0 }),
    });
    expect(r).toMatchObject({ success: false, reason: "AI Act 步骤缺少定位器" });
  });

  it("press_key / scroll_to_height / mouse_click 免定位器校验", async () => {
    for (const m of ["press_key", "scroll_to_height", "mouse_click"]) {
      const r = await planAiActStep({
        ...base,
        method: m,
        call_llm: async () => ({ content: `{"step":{"method":"${m}","params":{"key":"Enter"}}}`, tokens: 0 }),
      });
      expect(r["success"]).toBe(true);
    }
  });

  it("LLM 未给出可执行步骤（回退 fallback_method 后因缺定位器被拒，与 Python 一致）", async () => {
    const r = await planAiActStep({
      ...base,
      call_llm: async () => ({ content: '{"reason":"无法完成"}', tokens: 0 }),
    });
    expect(r["success"]).toBe(false);
    expect(r["reason"]).toBe("AI Act 步骤缺少定位器");
  });

  it("LLM 给出不可执行方法（白名单外）→ LLM 未能给出可执行步骤", async () => {
    const r = await planAiActStep({
      ...base,
      call_llm: async () => ({ content: '{"step":{"method":"not_supported","params":{}}}', tokens: 0 }),
    });
    expect(r["success"]).toBe(false);
    expect(r["reason"]).toBe("LLM 未能给出可执行步骤");
  });

  it("LLM 抛错 → LLM 调用失败", async () => {
    const r = await planAiActStep({
      ...base,
      call_llm: async () => {
        throw new Error("nope");
      },
    });
    expect(r["reason"]).toBe("LLM 调用失败: nope");
  });

  it("original_params 序列化截前 4000 字", async () => {
    let user = "";
    await planAiActStep({
      ...base,
      original_params: { value: "x".repeat(5000) },
      call_llm: async (_s, u) => {
        user = u;
        return { content: '{"step":{"method":"click_ele","params":{"locator":"#a"}}}', tokens: 0 };
      },
    });
    expect(user).toContain("原步骤 params（JSON）：");
    expect(user.length).toBeLessThan(20000);
  });
});
