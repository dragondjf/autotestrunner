import { describe, it, expect } from "vitest";
import { resolve, stripWrappingQuotes } from "../src/locator-utils.js";

/** 记录型假 page：记录所有定位调用与结果链 */
function makePage() {
  const calls: string[] = [];
  // locator 作为子 scope 时也需支持 get_by_*（链式解析会递归调用）
  const mk = (sel: string): any => ({
    __sel: sel,
    nth: (i: number) => mk(`${sel}>>nth(${i})`),
    locator: (s: string) => mk(s),
    getByText: (t: string, o?: { exact?: boolean; name?: string }) => {
      calls.push(`getByText(${t},exact=${o?.exact})`);
      return mk(`text=${t}`);
    },
    getByRole: (r: string, o?: { name?: string }) => {
      calls.push(`getByRole(${r},name=${o?.name ?? ""})`);
      return mk(`role=${r}`);
    },
    getByLabel: (t: string) => {
      calls.push(`getByLabel(${t})`);
      return mk(`label=${t}`);
    },
    getByPlaceholder: (t: string) => {
      calls.push(`getByPlaceholder(${t})`);
      return mk(`placeholder=${t}`);
    },
    getByAltText: (t: string) => {
      calls.push(`getByAltText(${t})`);
      return mk(`alt=${t}`);
    },
    getByTitle: (t: string) => {
      calls.push(`getByTitle(${t})`);
      return mk(`title=${t}`);
    },
    getByTestId: (t: string) => {
      calls.push(`getByTestId(${t})`);
      return mk(`testid=${t}`);
    },
  });
  const page = {
    calls,
    locator: (sel: string) => {
      calls.push(`locator(${sel})`);
      return mk(sel);
    },
    getByText: (t: string, o?: { exact?: boolean; name?: string }) => {
      calls.push(`getByText(${t},exact=${o?.exact})`);
      return mk(`text=${t}`);
    },
    getByRole: (r: string, o?: { name?: string }) => {
      calls.push(`getByRole(${r},name=${o?.name ?? ""})`);
      return mk(`role=${r}`);
    },
    getByLabel: (t: string) => {
      calls.push(`getByLabel(${t})`);
      return mk(`label=${t}`);
    },
    getByPlaceholder: (t: string) => {
      calls.push(`getByPlaceholder(${t})`);
      return mk(`placeholder=${t}`);
    },
    getByAltText: (t: string) => {
      calls.push(`getByAltText(${t})`);
      return mk(`alt=${t}`);
    },
    getByTitle: (t: string) => {
      calls.push(`getByTitle(${t})`);
      return mk(`title=${t}`);
    },
    getByTestId: (t: string) => {
      calls.push(`getByTestId(${t})`);
      return mk(`testid=${t}`);
    },
  };
  return page as unknown as import("playwright").Page & { calls: string[] };
}

describe("stripWrappingQuotes（locator_utils.py:50）", () => {
  it("去掉成对包裹引号", () => {
    expect(stripWrappingQuotes('"请输入账号"')).toBe("请输入账号");
    expect(stripWrappingQuotes("'请输入账号'")).toBe("请输入账号");
    expect(stripWrappingQuotes("请输入账号")).toBe("请输入账号");
    expect(stripWrappingQuotes("")).toBe("");
  });
});

describe("resolve（locator_utils.py:21）", () => {
  it("空定位器回退 body", () => {
    const page = makePage();
    const loc = resolve(page, "");
    expect(page.calls.at(-1)).toBe("locator(body)");
    expect(loc).toBeTruthy();
  });

  it("get_by_role= 含 name", () => {
    const page = makePage();
    resolve(page, 'get_by_role=button, "登录"');
    expect(page.calls.at(-1)).toBe('getByRole(button,name=登录)');
  });

  it("get_by_role= 不含 name", () => {
    const page = makePage();
    resolve(page, "get_by_role=button");
    expect(page.calls.at(-1)).toBe("getByRole(button,name=)");
  });

  it("get_by_text / label / placeholder / alt_text / title", () => {
    const page = makePage();
    resolve(page, 'get_by_text="登录"');
    resolve(page, 'get_by_label="用户名"');
    resolve(page, 'get_by_placeholder="请输入"');
    resolve(page, 'get_by_alt_text="图标"');
    resolve(page, 'get_by_title="标题"');
    expect(page.calls).toEqual([
      "getByText(登录,exact=undefined)",
      "getByLabel(用户名)",
      "getByPlaceholder(请输入)",
      "getByAltText(图标)",
      "getByTitle(标题)",
    ]);
  });

  it("历史写法 css= / xpath= / text= / role= / label= / placeholder= / testid=", () => {
    const page = makePage();
    resolve(page, "css=#id");
    resolve(page, "xpath=//div");
    resolve(page, "text=登录");
    resolve(page, 'role="button"');
    resolve(page, 'label="用户名"');
    resolve(page, 'placeholder="请输入"');
    resolve(page, 'testid="tid"');
    expect(page.calls).toEqual([
      "locator(#id)",
      "locator(xpath=//div)",
      "locator(text=登录)",
      "getByRole(button,name=)",
      "getByLabel(用户名)",
      "getByPlaceholder(请输入)",
      "getByTestId(tid)",
    ]);
  });

  it("// 开头自动补 xpath=", () => {
    const page = makePage();
    resolve(page, "//div[@id='a']");
    resolve(page, ".//span");
    resolve(page, "(//a)[1]");
    expect(page.calls).toEqual([
      "locator(xpath=//div[@id='a'])",
      "locator(xpath=.//span)",
      "locator(xpath=(//a)[1])",
    ]);
  });

  it("未知写法交给原生解析", () => {
    const page = makePage();
    resolve(page, "#loginBtn");
    resolve(page, ".el-menu-item");
    expect(page.calls).toEqual(["locator(#loginBtn)", "locator(.el-menu-item)"]);
  });

  it("index>1 时取 nth(index-1)", () => {
    const page = makePage();
    const loc = resolve(page, "#a", 3) as unknown as { __sel: string };
    expect(loc.__sel).toBe("#a>>nth(2)");
  });

  it("index=1 时不取 nth", () => {
    const page = makePage();
    const loc = resolve(page, "#a", 1) as unknown as { __sel: string };
    expect(loc.__sel).toBe("#a");
  });

  it(">> 链式：先父后子", () => {
    const page = makePage();
    resolve(page, ".menu >> get_by_text=执行记录");
    expect(page.calls).toEqual(["locator(.menu)", "getByText(执行记录,exact=undefined)"]);
  });

  it("链尾 nth=N", () => {
    const page = makePage();
    const loc = resolve(page, ".list >> nth=1") as unknown as { __sel: string };
    expect(page.calls[0]).toBe("locator(.list)");
    expect(loc.__sel).toBe(".list>>nth(1)");
  });

  it("根 scope 上单独 nth 抛『定位链无效：根节点上不能单独使用 ...』", () => {
    const page = makePage();
    // 根 Page 无 nth 方法 → 抛错（与 Python hasattr 判断一致）
    expect(() => resolve(page, "nth=0")).toThrow(/定位链无效：根节点上不能单独使用 nth=0/);
  });
});
