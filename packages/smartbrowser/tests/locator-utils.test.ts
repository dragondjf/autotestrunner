import { describe, it, expect } from "vitest";
import {
  coerceUnsafeHasTextLocator,
  ensureXpathEnginePrefix,
  extractLocatorText,
  normalizeLocator,
  preferPopupElements,
  textUnsafeForCssHasText,
} from "../src/locator-utils.js";

describe("ensureXpathEnginePrefix（locator_utils.py:10）", () => {
  it("绝对路径加 xpath= 前缀", () => {
    expect(ensureXpathEnginePrefix("/html/body/div")).toBe("xpath=/html/body/div");
  });
  it("// 与 .// 开头不加前缀", () => {
    expect(ensureXpathEnginePrefix("//div")).toBe("//div");
    expect(ensureXpathEnginePrefix(".//div")).toBe(".//div");
    expect(ensureXpathEnginePrefix("(//div)[1]")).toBe("(//div)[1]");
    expect(ensureXpathEnginePrefix("(/html)[1]")).toBe("(/html)[1]");
  });
  it("带引擎前缀的原样返回", () => {
    expect(ensureXpathEnginePrefix("xpath=//div")).toBe("xpath=//div");
    expect(ensureXpathEnginePrefix("css=.a")).toBe("css=.a");
    expect(ensureXpathEnginePrefix("internal:has-text=x")).toBe("internal:has-text=x");
  });
  it("空串返回空串", () => {
    expect(ensureXpathEnginePrefix("")).toBe("");
  });
});

describe("textUnsafeForCssHasText（locator_utils.py:29）", () => {
  it("$ 或反斜杠视为不安全", () => {
    expect(textUnsafeForCssHasText("价格$99")).toBe(true);
    expect(textUnsafeForCssHasText("a\\b")).toBe(true);
    expect(textUnsafeForCssHasText("普通文本")).toBe(false);
  });
});

describe("coerceUnsafeHasTextLocator（locator_utils.py:160）", () => {
  it("含 $ 的 tag:has-text 转为链式 get_by_text（保留 tag 前缀，对齐 Python m.start() 行为）", () => {
    expect(coerceUnsafeHasTextLocator('div.list:has-text("价格$99")')).toBe(
      "div.list >> get_by_text=价格$99",
    );
    expect(coerceUnsafeHasTextLocator('button:has-text("A$B")')).toBe(
      "button >> get_by_text=A$B",
    );
    expect(coerceUnsafeHasTextLocator(':has-text("A$B")')).toBe("get_by_text=A$B");
  });
  it("不含 $ 原样返回", () => {
    expect(coerceUnsafeHasTextLocator('div:has-text("普通")')).toBe('div:has-text("普通")');
  });
  it("转义引号还原", () => {
    expect(coerceUnsafeHasTextLocator('div:has-text("a\\"$b")')).toBe(
      'div >> get_by_text=a"$b',
    );
  });
});

describe("normalizeLocator（locator_utils.py:204）", () => {
  it("None/空串 → 空串", () => {
    expect(normalizeLocator(null)).toBe("");
    expect(normalizeLocator(undefined)).toBe("");
    expect(normalizeLocator("   ")).toBe("");
  });

  it("函数写法转 DSL", () => {
    expect(normalizeLocator('get_by_text("登录")')).toBe("get_by_text=登录");
    expect(normalizeLocator("get_by_placeholder('密码')")).toBe("get_by_placeholder=密码");
    expect(normalizeLocator('get_by_label("用户名")')).toBe("get_by_label=用户名");
    expect(normalizeLocator('get_by_title("标题")')).toBe("get_by_title=标题");
  });

  it("get_by_role 函数写法（含/不含 name）", () => {
    expect(normalizeLocator('get_by_role("button")')).toBe("get_by_role=button");
    expect(normalizeLocator('get_by_role("button", name="登入")')).toBe(
      "get_by_role=button, 登入",
    );
  });

  it("name= 前缀剥离与包裹引号剥离", () => {
    expect(normalizeLocator('get_by_role=button, name="登入"')).toBe("get_by_role=button, 登入");
    expect(normalizeLocator("get_by_role='row', '0302'")).toBe("get_by_role=row, 0302");
    expect(normalizeLocator("get_by_role=row, 0302")).toBe("get_by_role=row, 0302");
  });

  it("title= 转换：保留元素类型", () => {
    expect(normalizeLocator('get_by_role=button, title="配置"')).toBe('button[title="配置"]');
    expect(normalizeLocator('get_by_role=unknown, title="配置"')).toBe("get_by_title=配置");
  });

  it("role 简写纠正", () => {
    expect(normalizeLocator("row=0302")).toBe("get_by_role=row, 0302");
    expect(normalizeLocator("cell=4")).toBe("get_by_role=cell, 4");
    expect(normalizeLocator("button=提交")).toBe("get_by_role=button, 提交");
  });

  it("get_by_text/role 值包裹引号剥离", () => {
    expect(normalizeLocator("get_by_text='登录'")).toBe("get_by_text=登录");
    expect(normalizeLocator('get_by_text="登录"')).toBe("get_by_text=登录");
  });

  it("链式逐段规范化", () => {
    expect(normalizeLocator("div.list >> get_by_text('登录')")).toBe(
      "div.list >> get_by_text=登录",
    );
    expect(normalizeLocator("row=a >> cell=b")).toBe("get_by_role=row, a >> get_by_role=cell, b");
  });

  it("含 $ 的 has-text 被纠正", () => {
    expect(normalizeLocator('div:has-text("价格$1")')).toBe("div >> get_by_text=价格$1");
  });

  it("dict 形式：role/name → text → placeholder → selector", () => {
    expect(normalizeLocator({ get_by_role: "button", name: " 登入 " })).toBe(
      "get_by_role=button, 登入",
    );
    expect(normalizeLocator({ role: "row" })).toBe("get_by_role=row");
    expect(normalizeLocator({ text: " 登录 " })).toBe("get_by_text=登录");
    expect(normalizeLocator({ get_by_text: "登录" })).toBe("get_by_text=登录");
    expect(normalizeLocator({ placeholder: "请输入" })).toBe("get_by_placeholder=请输入");
    expect(normalizeLocator({ selector: " //div " })).toBe("//div");
    expect(normalizeLocator({ css: "#id" })).toBe("#id");
  });

  it("dict 带函数污染值也被规范化", () => {
    expect(normalizeLocator({ role: "button", name: 'name="登入"' })).toBe(
      "get_by_role=button, 登入",
    );
  });
});

describe("extractLocatorText（locator_utils.py:179）", () => {
  it("链式 get_by_text 取尾段", () => {
    expect(extractLocatorText("div >> get_by_text=登录")).toBe("登录");
  });
  it("纯 get_by_text 取值", () => {
    expect(extractLocatorText("get_by_text=登录")).toBe("登录");
  });
  it("has-text 取内层", () => {
    expect(extractLocatorText('div:has-text("登录")')).toBe("登录");
  });
  it("其它返回空串", () => {
    expect(extractLocatorText("#id")).toBe("");
    expect(extractLocatorText(null)).toBe("");
  });
});

describe("preferPopupElements（locator_utils.py:194）", () => {
  it("有弹窗元素时只返回弹窗内元素", () => {
    const raw = [{ in_popup: false, id: 1 }, { in_popup: true, id: 2 }];
    expect(preferPopupElements(raw)).toEqual([{ in_popup: true, id: 2 }]);
  });
  it("无弹窗元素时原样返回", () => {
    const raw = [{ in_popup: false, id: 1 }];
    expect(preferPopupElements(raw)).toEqual(raw);
  });
  it("非列表返回空列表", () => {
    expect(preferPopupElements("x")).toEqual([]);
  });
});
