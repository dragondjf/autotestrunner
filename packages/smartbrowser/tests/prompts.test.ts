import { describe, it, expect } from "vitest";
import { PromptManager, renderJinja } from "../src/prompts.js";
import { resolveStepIntentFromStep, resolveStepIntentText } from "../src/step-intent.js";
import { SCROLL_PAGE_JS } from "../src/scroll-page-js.js";

describe("PromptManager.getTemplate（prompts.py）", () => {
  it("三条内置模板可获取且 is_default=true", async () => {
    for (const code of ["ui_locator_heal", "ui_ai_act", "ui_agent_plan"]) {
      const t = await PromptManager.getTemplate(code);
      expect(t.code).toBe(code);
      expect(t.version).toBe(1);
      expect(t.is_default).toBe(true);
      expect(t.system_prompt.length).toBeGreaterThan(0);
      expect(t.user_prompt_template.length).toBeGreaterThan(0);
    }
  });

  it("未知编码抛『未知的 Prompt 模板编码: x』", async () => {
    await expect(PromptManager.getTemplate("nope")).rejects.toThrow("未知的 Prompt 模板编码: nope");
  });

  it("自定义模板（is_default=false）优先", async () => {
    PromptManager.setDbTemplateFetcher(async () => ({
      code: "ui_agent_plan",
      name: "自定义",
      system_prompt: "S1",
      user_prompt_template: "U1",
      is_default: false,
      version: 7,
    }));
    const t = await PromptManager.getTemplate("ui_agent_plan");
    expect(t.system_prompt).toBe("S1");
    expect(t.version).toBe(7);
    expect(t.is_default).toBe(false);
    PromptManager.setDbTemplateFetcher(null);
  });

  it("DB 返回 is_default=true 时回退代码版模板", async () => {
    PromptManager.setDbTemplateFetcher(async () => ({
      code: "ui_agent_plan",
      system_prompt: "DB",
      is_default: true,
    }));
    const t = await PromptManager.getTemplate("ui_agent_plan");
    expect(t.system_prompt.startsWith("你是一位 UI 自动化 Agent。")).toBe(true);
    PromptManager.setDbTemplateFetcher(null);
  });
});

describe("PromptManager.render（含 mini-Jinja）", () => {
  it("ui_agent_plan：有 executed_steps 与 stuck_hint 时渲染两段", async () => {
    const [, user] = await PromptManager.render("ui_agent_plan", {
      description: "登录系统",
      current_url: "http://x/#/login",
      step_index: 3,
      snapshot_type: "aria",
      executed_steps: "[]",
      accessibility_snapshot: "- button \"登录\"",
      stuck_hint: "不要重复点击",
      has_stuck_hint: true,
    });
    expect(user).toContain("用户目标：登录系统");
    expect(user).toContain("当前是第 3 步规划");
    expect(user).toContain("【本轮必读】不要重复点击");
    expect(user).toContain("已执行步骤（JSON）：\n[]");
    expect(user).toContain("- button \"登录\"");
  });

  it("ui_agent_plan：无 stuck_hint/executed_steps 时块整体消失", async () => {
    const [, user] = await PromptManager.render("ui_agent_plan", {
      description: "d",
      current_url: "u",
      step_index: 1,
      snapshot_type: "aria",
      accessibility_snapshot: "snap",
    });
    expect(user).not.toContain("【本轮必读】");
    // 注意："已执行步骤" 单独出现在规则 7 文案中，此处断言块特有的完整文案
    expect(user).not.toContain("已执行步骤（JSON）：");
    expect(user).toContain("Snapshot 类型：aria");
    // 空行结构对齐 Jinja2（无 trim_blocks）：两个假块之间的文本段全部保留
    expect(user).toContain("aria\n\n\n\n\n\n页面无障碍树");
  });

  it("未定义变量渲染为空串（对齐 Jinja2 Undefined）", () => {
    expect(renderJinja("a={{nope}}!", {})).toBe("a=!");
  });

  it("渲染异常抛『渲染模板失败: ...』", async () => {
    await expect(PromptManager.render("nope", {})).rejects.toThrow(
      "渲染模板失败: 未知的 Prompt 模板编码: nope",
    );
  });

  it("不支持 else/elif 标签", () => {
    expect(() => renderJinja("{% if a %}x{% else %}y{% endif %}", { a: 1 })).toThrow(
      "不支持的 Jinja2 标签: else",
    );
  });

  it("未闭合 if 报错", () => {
    expect(() => renderJinja("{% if a %}x", { a: 1 })).toThrow("{% if %}");
  });
});

describe("PromptManager 模板逐字校验（验收硬要求：文案逐字）", () => {
  it("ui_agent_plan 关键规则文案逐字存在", async () => {
    const t = await PromptManager.getTemplate("ui_agent_plan");
    // system_prompt 文案（Python 隐式字符串拼接的整段）
    expect(t.system_prompt).toBe(
      "你是一位 UI 自动化 Agent。根据页面无障碍树 snapshot 和用户目标，" +
        "每次只规划**下一步**操作。你必须严格输出 JSON 对象，不要 Markdown 代码块。" +
        "定位器必须来自 snapshot 中当前可见、可交互的元素，严禁编造或对 hidden 元素做 wait。" +
        "定位优先级：data-testid > #id > get_by_role > name/label/placeholder > get_by_text（末选）。" +
        "用户目标可能包含**多个子任务**（例如『登录成功后再遍历点击每个子菜单』），" +
        "必须按顺序逐项执行完毕，绝不可在只完成部分子任务时就判定结束。" +
        "当用户意图只是**了解/询问当前页面**（例如『这页面有什么』『这按钮能点吗』" +
        "『有哪些输入框』『下一步该做什么』）时，不要规划任何操作，" +
        "改为输出 type=qa，并基于 snapshot 用中文向用户说明当前页面的可操作模块、按钮、输入框、链接。",
    );
    const mustContain = [
      "（页面滚动仅用 scroll_to_height + params.height；严禁 scroll / scroll_down / scroll_up / scroll_to）",
      "禁止用「登录」「提交」等短词（易误点说明文字）",
      "get_by_role=button, <按钮完整可见名称>",
      "10. **父级分组菜单**：当 stuck_hint 指明「某词是父级分组/入口菜单项，请直接点击其下子项」时，必须点击该子项，禁止再点父级分组；子项可用「父级 >> 子级」链式定位或 get_by_role=menuitem, 子项名",
      "11. 只输出 JSON 对象",
    ];
    for (const s of mustContain) expect(t.user_prompt_template).toContain(s);
  });

  it("ui_locator_heal 关键规则文案逐字存在", async () => {
    const t = await PromptManager.getTemplate("ui_locator_heal");
    const mustContain = [
      "- 错误：get_by_placeholder(\"密码\")、page.get_by_role(...)、get_by_role='row'（role/name 禁止加引号）、get_by_role=button, name=\"登入\"（禁止写 name= 前缀，应写 get_by_role=button, 登入）、row=0302（必须用 get_by_role=row, 0302）",
      "- **文本含 $ 或反斜杠时禁止** `tag:has-text(\"...\")`（Playwright CSS 会报 BADSTRING），必须用 `get_by_text=` 或 `父级 >> get_by_text=`",
      "- 只输出 JSON 对象",
    ];
    for (const s of mustContain) expect(t.user_prompt_template).toContain(s);
  });

  it("ui_ai_act 关键规则文案逐字存在", async () => {
    const t = await PromptManager.getTemplate("ui_ai_act");
    const mustContain = [
      "1. 只输出**一步**，method 仅限：click_ele, fill_value, double_click_ele, clear_value, hover, select_option, type_value, drag_and_drop, wait_for_element, press_key",
      "9. 只输出 JSON 对象",
    ];
    for (const s of mustContain) expect(t.user_prompt_template).toContain(s);
  });

  it("模板以非换行字符结尾（对齐 Python 三引号收尾）", async () => {
    for (const code of ["ui_locator_heal", "ui_ai_act", "ui_agent_plan"]) {
      const t = await PromptManager.getTemplate(code);
      expect(t.user_prompt_template.endsWith("\n")).toBe(false);
    }
  });
});

describe("PromptManager.extractVariables", () => {
  it("提取并去重保序", () => {
    expect(
      PromptManager.extractVariables("{{ a }} {{b}} {{ a }} {{c_1}} {{ 9bad }} {{x-y}}"),
    ).toEqual(["a", "b", "c_1"]);
  });
});

describe("step_intent（step_intent.py）", () => {
  it("优先 intent，回退 desc/keyword", () => {
    expect(resolveStepIntentText({ step_intent: " 点登录 ", step_desc: "desc" })).toBe("点登录");
    expect(resolveStepIntentText({ step_intent: "", step_desc: " desc " })).toBe("desc");
    expect(resolveStepIntentText({})).toBe("");
    expect(resolveStepIntentFromStep({ intent: "i", desc: "d" })).toBe("i");
    expect(resolveStepIntentFromStep({ keyword: "kw" })).toBe("kw");
    expect(resolveStepIntentFromStep("not-dict")).toBe("");
  });
});

describe("SCROLL_PAGE_JS（scroll_page_js.py 原样复用）", () => {
  it("包含核心滚动模式分支", () => {
    for (const s of ["'top'", "'bottom'", "'middle'", "'down'", "'up'", "'to'", "'xy'", "findScrollRoot"]) {
      expect(SCROLL_PAGE_JS).toContain(s);
    }
    expect(SCROLL_PAGE_JS.startsWith("([mode, value]) => {")).toBe(true);
  });
});
