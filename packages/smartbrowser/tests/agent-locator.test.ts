import { describe, it, expect } from "vitest";
import {
  _findParentScopedChild,
  _hintsFromStep,
  _parentHintsFromStep,
  _scoreElement,
  _semanticFillLocator,
  _targetChildHintsFromStep,
  actionMadeProgress,
  buildCandidatesFromElement,
  buildNoProgressStuckHint,
  findBestElement,
  isWeakLocator,
  pickStableLocator,
  refineAgentStepLocator,
  structuralFingerprint,
} from "../src/agent-locator.js";
import { coerceBool, formatElementsForPrompt } from "../src/page-fetcher.js";

describe("structuralFingerprint（agent_locator.py:47）", () => {
  it("主干节点参与指纹，短 alert/toast 行被忽略", () => {
    const snap = '- button "登录"\n- alert "错误提示"\n- textbox "账号"';
    const a = structuralFingerprint("http://X.com/#/login", snap);
    const b = structuralFingerprint("http://x.com/#/login/", snap);
    expect(a).toBe(b); // URL 归一化（大小写/尾斜杠）
    const c = structuralFingerprint("http://x.com/home", snap);
    expect(c).not.toBe(a);
    // 注意：Python urlparse 丢弃 fragment，#/login 与 #/home 归一化后相同（同指纹）
    expect(structuralFingerprint("http://x.com/#/home", snap)).toBe(a);
  });
  it("长 alert 行（≥100）不忽略", () => {
    const longAlert = '- alert "' + "x".repeat(120) + '"';
    const snapA = longAlert;
    const snapB = longAlert + "\n- button \"other\"";
    expect(structuralFingerprint("u", snapA)).not.toBe(structuralFingerprint("u", snapB));
  });
});

describe("actionMadeProgress（agent_locator.py:71）", () => {
  it("URL 变化即进展", () => {
    expect(actionMadeProgress({ method: "click_ele", url_before: "a", url_after: "b", struct_before: "x", struct_after: "x" })).toBe(true);
  });
  it("导航类方法恒为进展", () => {
    for (const m of ["open_url", "refresh", "go_back", "wait_for_load"]) {
      expect(actionMadeProgress({ method: m, url_before: "a", url_after: "a", struct_before: "x", struct_after: "x" })).toBe(true);
    }
  });
  it("click/fill 结构变化算进展；结构不变不算", () => {
    expect(actionMadeProgress({ method: "click_ele", url_before: "a", url_after: "a", struct_before: "x", struct_after: "y" })).toBe(true);
    expect(actionMadeProgress({ method: "click_ele", url_before: "a", url_after: "a", struct_before: "x", struct_after: "x" })).toBe(false);
    expect(actionMadeProgress({ method: "fill_value", url_before: "a", url_after: "a", struct_before: "x", struct_after: "y" })).toBe(true);
    expect(actionMadeProgress({ method: "press_key", url_before: "a", url_after: "a", struct_before: "x", struct_after: "y" })).toBe(false);
  });
});

describe("buildCandidatesFromElement（agent_locator.py:110）", () => {
  it("优先级顺序：testid > #id > role > text > name > placeholder > aria > selector", () => {
    const cands = buildCandidatesFromElement({
      tag: "button",
      id: "btn-login",
      data_testid: "login-btn",
      text: "登录系统",
      role: "button",
      name: "user",
      placeholder: "请输入",
      aria_label: "登录",
      selector: "button.x",
    });
    expect(cands[0]).toBe('[data-testid="login-btn"]');
    expect(cands).toContain("#btn-login");
    expect(cands).toContain("//button[@id='btn-login']");
    expect(cands).toContain("get_by_role=button, 登录系统");
    expect(cands).toContain("get_by_text=登录系统");
    expect(cands).toContain('button[name="user"]');
    // placeholder 候选仅限 input/textarea（button 不生成）
    expect(cands).not.toContain("get_by_placeholder=请输入");
    expect(cands).toContain("get_by_label=登录");
    expect(cands).toContain("button.x");
  });
  it("input 的 placeholder 候选", () => {
    expect(buildCandidatesFromElement({ tag: "input", placeholder: "请输入" })).toContain(
      "get_by_placeholder=请输入",
    );
  });
  it("短词黑名单默认排除 text 候选", () => {
    const cands = buildCandidatesFromElement({ tag: "button", text: "登录" });
    expect(cands.some((c) => c.startsWith("get_by_text=") || c.startsWith("get_by_role="))).toBe(false);
    const cands2 = buildCandidatesFromElement({ tag: "button", text: "登录" }, true);
    expect(cands2).toContain("get_by_text=登录");
  });
  it("动态 el-id 不生成 #id 候选", () => {
    const cands = buildCandidatesFromElement({ tag: "input", id: "el-id-12-34" });
    expect(cands.some((c) => c.startsWith("#"))).toBe(false);
  });
  it("parent_selector 生成链式增强候选", () => {
    const cands = buildCandidatesFromElement({
      tag: "li",
      role: "menuitem",
      text: "执行记录",
      parent_selector: ".el-menu",
    });
    expect(cands[cands.length - 1]).toBe(".el-menu >> get_by_role=menuitem, 执行记录");
  });
});

describe("_hintsFromStep / _parentHintsFromStep", () => {
  it("引号词与动词目标", () => {
    expect(_hintsFromStep({ desc: "点击「登录」按钮" })).toContain("登录");
    expect(_hintsFromStep({ desc: "打开'设置'页面" })).toContain("设置");
    expect(_hintsFromStep({ desc: "在输入框输入内容" })).toEqual([]);
  });
  it("描述无词时回退定位器", () => {
    expect(_hintsFromStep({ desc: "", params: { locator: "get_by_text=登录" } })).toEqual(["登录"]);
    expect(_hintsFromStep({ desc: "", params: { locator: "#username" } })).toEqual(["username"]);
    expect(_hintsFromStep({ desc: "", params: { locator: "#el-id-1-2" } })).toEqual([]); // 动态 id 忽略
    expect(_hintsFromStep({ desc: "", params: { locator: "get_by_role=button, 登入" } })).toEqual(["登入"]);
  });
  it("父级锚点：X下的Y（regex1 因『下的』的『的』无法回溯而不命中引号组，仅 regex2 命中——与 Python 一致）", () => {
    expect(_parentHintsFromStep({ desc: "点击「智能浏览器」下的「执行记录」" })).toContain(
      "点击「智能浏览器」",
    );
    expect(_parentHintsFromStep({ desc: "智能浏览器下的执行记录" })).toContain("智能浏览器");
  });
  it("目标子项提取", () => {
    expect(_targetChildHintsFromStep({ desc: "点击「智能浏览器」下的「执行记录」" })).toContain("执行记录");
  });
});

describe("_scoreElement / findBestElement", () => {
  const els = [
    { tag: "input", id: "el-id-9-9", text: "" }, // 空文本 input（虚假分守卫对象）
    { tag: "li", role: "menuitem", text: "用例库", parent_text: "智能浏览器" },
    { tag: "div", text: "智能浏览器" },
  ];
  it("menuitem 目标在空文本守卫下胜出", () => {
    const best = findBestElement(els, ["用例库"], {
      prefer_tags: ["button", "a", "input"],
      prefer_roles: ["button", "link", "menuitem", "menuitemcheckbox", "tab"],
      parent_hints: ["智能浏览器"],
    });
    expect(best?.["text"]).toBe("用例库");
  });
  it("白名单不命中者计 0 分排除", () => {
    expect(
      _scoreElement({ tag: "div", text: "x" }, ["x"], { prefer_tags: ["button", "a", "input"], prefer_roles: ["menuitem"] }),
    ).toBe(0);
  });
  it("完全匹配时三个分支同时命中：12+8+6+2=28（对齐 Python h==text 且 h in text 且去空格包含）", () => {
    const s = _scoreElement({ tag: "button", text: "登录" }, ["登录"], { prefer_tags: [] });
    expect(s).toBe(28);
  });
  it("findBestElement 阈值 8 分", () => {
    // 无任何包含关系的 hint 得 0 分 → null
    expect(findBestElement([{ tag: "span", text: "无关" }], ["xyzabc"], { prefer_tags: [] })).toBeNull();
    // text 是 hint 子串 → +8 → 恰达阈值返回（对齐 Python text in h）
    expect(findBestElement([{ tag: "span", text: "无关" }], ["完全无关词"], { prefer_tags: [] })).not.toBeNull();
  });
});

describe("isWeakLocator（agent_locator.py:295）", () => {
  it("click_ele 短词/≤4 字 get_by_text 为弱", () => {
    expect(isWeakLocator("get_by_text=登录", { method: "click_ele" })).toBe(true);
    expect(isWeakLocator("get_by_text=设置中心站", { method: "click_ele" })).toBe(false);
    expect(isWeakLocator("get_by_text=登录", { method: "fill_value" })).toBe(true);
    expect(isWeakLocator("#btn", { method: "click_ele" })).toBe(false);
    expect(isWeakLocator("", { method: "click_ele" })).toBe(true);
  });
});

describe("_semanticFillLocator（agent_locator.py:308）", () => {
  const els = [
    { tag: "input", placeholder: "请输入账号" },
    { tag: "input", placeholder: "请输入密码" },
  ];
  it("按描述语义词匹配 placeholder", () => {
    expect(
      _semanticFillLocator({ method: "fill_value", desc: "在密码框输入密码" }, els),
    ).toBe("get_by_placeholder=请输入密码");
  });
  it("非 fill_value 返回空", () => {
    expect(_semanticFillLocator({ method: "click_ele", desc: "密码" }, els)).toBe("");
  });
});

describe("pickStableLocator / refineAgentStepLocator", () => {
  const els = [
    { tag: "input", id: "username", placeholder: "请输入账号", aria_label: "账号" },
    { tag: "button", id: "loginBtn", text: "登录系统", role: "button" },
  ];
  it("click_ele 优选 #id 候选首位", () => {
    const r = pickStableLocator({ method: "click_ele", desc: "点击「登录系统」按钮", params: { locator: "get_by_text=登录" } }, els);
    expect(r).toBe("#loginBtn");
  });
  it("fill_value 语义词优先", () => {
    const r = pickStableLocator({ method: "fill_value", desc: "输入账号", params: { locator: "#el-id-3-4" } }, els);
    expect(r).toBe("get_by_placeholder=请输入账号");
  });
  it("refineAgentStepLocator 就地替换弱定位器", () => {
    const step: Record<string, unknown> = { method: "click_ele", desc: "点击「登录系统」按钮", params: { locator: "get_by_text=登录" } };
    refineAgentStepLocator(step, els);
    expect((step["params"] as Record<string, unknown>)["locator"]).toBe("#loginBtn");
  });
  it("非目标 method 不替换", () => {
    const step: Record<string, unknown> = { method: "press_key", params: { locator: "x" } };
    refineAgentStepLocator(step, els);
    expect((step["params"] as Record<string, unknown>)["locator"]).toBe("x");
  });
});

describe("buildNoProgressStuckHint（agent_locator.py:500）", () => {
  const els = [
    { tag: "li", role: "menuitem", text: "执行记录", parent_text: "智能浏览器", parent_selector: ".el-menu" },
    { tag: "div", text: "智能浏览器" },
  ];
  it("生成强引导 hint 文案（click_word 取 regex2 的完整短语，与 Python 一致）", () => {
    const hint = buildNoProgressStuckHint(
      { method: "click_ele", desc: "点击「智能浏览器」下的「执行记录」", params: { locator: "get_by_text=智能浏览器" } },
      els,
      "浏览执行记录",
    );
    expect(hint).toContain("刚点击的「点击「智能浏览器」」是父级分组/入口菜单项");
    expect(hint).toContain("改为直接点击其下的「执行记录」子项");
    expect(hint).toContain("候选稳定定位：get_by_role=menuitem, 执行记录");
    expect(hint).toContain("也可用 get_by_role=menuitem, 执行记录 或「父级 >> 子级」链式定位。");
  });
  it("非 click 方法返回空", () => {
    expect(buildNoProgressStuckHint({ method: "fill_value", desc: "x", params: {} }, els)).toBe("");
  });
  it("找不到子项返回空", () => {
    expect(buildNoProgressStuckHint({ method: "click_ele", desc: "点击「不存在」", params: {} }, els)).toBe("");
  });
});

describe("_findParentScopedChild 阈值", () => {
  it("得分 <10 返回 null", () => {
    expect(_findParentScopedChild([{ tag: "li", role: "menuitem", text: "别的" }], ["执行记录"], "父")).toBeNull();
  });
});

describe("page-fetcher 纯函数", () => {
  it("coerceBool 全分支", () => {
    expect(coerceBool(null, true)).toBe(true);
    expect(coerceBool(undefined, false)).toBe(false);
    expect(coerceBool(true)).toBe(true);
    expect(coerceBool(0)).toBe(false);
    expect(coerceBool(2)).toBe(true);
    expect(coerceBool("FALSE")).toBe(false);
    expect(coerceBool("Yes")).toBe(true);
    expect(coerceBool("whatever", true)).toBe(true);
  });
  it("formatElementsForPrompt 格式与空值省略", () => {
    const out = formatElementsForPrompt([
      { tag: "button", id: "b1", text: "提交", role: "button" },
      { tag: "input" },
    ]);
    // 空元素也输出纯 tag 行（对齐 Python parts=["<input>"]）
    expect(out).toBe("<button> id=b1 role=button text=提交\n<input>");
  });
  it("formatElementsForPrompt 空列表返回空串", () => {
    expect(formatElementsForPrompt([])).toBe("");
    expect(formatElementsForPrompt(null)).toBe("");
  });
});
