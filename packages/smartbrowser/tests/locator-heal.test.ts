import { describe, it, expect } from "vitest";
import {
  HEALABLE_METHODS,
  _extractTargetFromStepDesc,
  _extractTextFromLocator,
  _rejectShortenedTextMatch,
  healLocator,
} from "../src/locator-heal.js";
import type { LLMCallFn } from "../src/llm.js";

describe("HEALABLE_METHODS（locator_heal.py:15）", () => {
  it("包含核心可自愈方法", () => {
    for (const m of ["click_ele", "fill_value", "hover", "select_option", "wait_for_element", "extract_text"]) {
      expect(HEALABLE_METHODS.has(m)).toBe(true);
    }
    expect(HEALABLE_METHODS.has("press_key")).toBe(false); // 仅 AI_ACT 支持
  });
});

describe("_extractTextFromLocator（locator_heal.py:28）", () => {
  it("get_by_text / get_by_role / has-text", () => {
    expect(_extractTextFromLocator("get_by_text=登录")).toBe("登录");
    expect(_extractTextFromLocator('get_by_role=button, name="登入"')).toBe("登入");
    expect(_extractTextFromLocator('div:has-text("执行记录")')).toBe("执行记录");
    expect(_extractTextFromLocator("#id")).toBeNull();
    expect(_extractTextFromLocator("")).toBeNull();
  });
});

describe("_extractTargetFromStepDesc（locator_heal.py:45）", () => {
  it("点击『X』/点击'X'/点击 X 按钮", () => {
    expect(_extractTargetFromStepDesc("点击「登录」")).toBe("登录");
    expect(_extractTargetFromStepDesc("点击'登录'")).toBe("登录");
    expect(_extractTargetFromStepDesc("点击 登录 按钮")).toBe("登录");
    expect(_extractTargetFromStepDesc("双击「删除」")).toBe("删除");
    expect(_extractTargetFromStepDesc("悬停到「设置」")).toBe("设置");
    expect(_extractTargetFromStepDesc("")).toBeNull();
  });
});

describe("_rejectShortenedTextMatch（locator_heal.py:65）", () => {
  it("新定位器文本更短 → 拒绝", () => {
    const reason = _rejectShortenedTextMatch({
      failed_locator: "get_by_text=基础设置",
      new_locator: "get_by_text=设置",
      step_desc: "点击「基础设置」",
    });
    expect(reason).toContain("比步骤意图「基础设置」匹配范围更小");
    expect(reason).toContain("可能点到页面上其他相似按钮");
  });
  it("文本更长或相同 → 放行", () => {
    expect(
      _rejectShortenedTextMatch({
        failed_locator: "get_by_text=设置",
        new_locator: "get_by_text=基础设置",
        step_desc: "点击「基础设置」",
      }),
    ).toBeNull();
    expect(
      _rejectShortenedTextMatch({
        failed_locator: "get_by_text=登录",
        new_locator: "get_by_text=登录",
        step_desc: "点击「登录」",
      }),
    ).toBeNull();
  });
  it("新定位器无文本 → 放行", () => {
    expect(
      _rejectShortenedTextMatch({ failed_locator: "get_by_text=登录", new_locator: "#btn", step_desc: "点击「登录」" }),
    ).toBeNull();
  });
});

const snapshot = '<button> id=btn text=登录\n<input> placeholder=账号';

function llmReturning(content: string): LLMCallFn {
  return async () => ({ content, tokens: 3 });
}

describe("healLocator（locator_heal.py:115）", () => {
  const baseArgs = {
    method: "click_ele",
    failed_locator: "get_by_text=登录",
    step_desc: "点击「登录」",
    accessibility_snapshot: snapshot,
    call_llm: llmReturning(""),
  };

  it("方法不支持自愈", async () => {
    const r = await healLocator({ ...baseArgs, method: "press_key" });
    expect(r).toEqual({ success: false, reason: "方法 press_key 不支持 AI 自愈" });
  });

  it("缺少 failed_locator", async () => {
    const r = await healLocator({ ...baseArgs, failed_locator: "" });
    expect(r).toEqual({ success: false, reason: "缺少 failed_locator" });
  });

  it("无 snapshot 且无 page_url", async () => {
    const r = await healLocator({
      ...baseArgs,
      accessibility_snapshot: "",
      page_elements: [],
    });
    expect(r).toEqual({
      success: false,
      reason: "无法获取页面 snapshot，请提供 page_url 或页面 snapshot",
    });
  });

  it("成功返回新定位器（含 confidence/snapshot_type/tokens）", async () => {
    const r = await healLocator({
      ...baseArgs,
      call_llm: llmReturning('{"locator":"#btn-login","confidence":"high","reason":"id 更稳定"}'),
    });
    expect(r).toMatchObject({
      success: true,
      locator: "#btn-login",
      confidence: "high",
      reason: "id 更稳定",
      snapshot_type: "provided",
      tokens_used: 3,
    });
  });

  it("LLM 未给出定位器", async () => {
    const r = await healLocator({ ...baseArgs, call_llm: llmReturning('{"reason":"页面没有该元素"}') });
    expect(r["success"]).toBe(false);
    expect(r["reason"]).toBe("页面没有该元素");
  });

  it("建议定位器与原定位器相同 → 拒绝", async () => {
    const r = await healLocator({
      ...baseArgs,
      call_llm: llmReturning('{"locator":"get_by_text=登录"}'),
    });
    expect(r["success"]).toBe(false);
    expect(r["reason"]).toBe("建议定位器与原定位器相同");
  });

  it("缩短文本 → 拒绝", async () => {
    const r = await healLocator({
      method: "click_ele",
      failed_locator: "get_by_text=基础设置",
      step_desc: "点击「基础设置」",
      accessibility_snapshot: snapshot,
      call_llm: llmReturning('{"locator":"get_by_text=设置"}'),
    });
    expect(r["success"]).toBe(false);
    expect(String(r["reason"])).toContain("匹配范围更小");
  });

  it("LLM 抛错 → LLM 调用失败", async () => {
    const r = await healLocator({
      ...baseArgs,
      call_llm: async () => {
        throw new Error("boom");
      },
    });
    expect(r["success"]).toBe(false);
    expect(r["reason"]).toBe("LLM 调用失败: boom");
  });

  it("page_elements 兜底生成 dom 类型快照", async () => {
    const r = await healLocator({
      method: "fill_value",
      failed_locator: "get_by_placeholder=账号",
      step_desc: "输入账号",
      accessibility_snapshot: "",
      page_elements: [{ tag: "input", placeholder: "请输入账号" }],
      call_llm: llmReturning('{"locator":"get_by_placeholder=请输入账号"}'),
    });
    expect(r["success"]).toBe(true);
    expect(r["snapshot_type"]).toBe("dom");
  });

  it("快照超 14000 字符截断", async () => {
    let captured = "";
    const r = await healLocator({
      ...baseArgs,
      accessibility_snapshot: "x".repeat(20000),
      call_llm: async (_s, user) => {
        captured = user;
        return { content: '{"locator":"#a"}', tokens: 0 };
      },
    });
    expect(r["success"]).toBe(true);
    expect(captured).toContain("\n... (truncated)");
  });

  it("注入 render_prompt 时走自定义渲染", async () => {
    let called = false;
    await healLocator({
      ...baseArgs,
      render_prompt: async (code, ctx) => {
        called = true;
        expect(code).toBe("ui_locator_heal");
        expect(ctx["method"]).toBe("click_ele");
        return ["S", "U"];
      },
      call_llm: llmReturning('{"locator":"#x"}'),
    });
    expect(called).toBe(true);
  });
});
