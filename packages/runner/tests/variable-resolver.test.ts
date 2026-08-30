import { describe, it, expect } from "vitest";
import { resolve, resolveValue } from "../src/variable-resolver.js";

const vars = {
  username: "alice",
  count: 5,
  env: { url: "http://x.com", port: 8080 },
  global: { base_url: "http://g.com" },
  nested: { a: { b: "deep" } },
};

describe("resolve（variable_resolver.py:11）", () => {
  it("替换普通变量", () => {
    expect(resolveValue("hi ${{username}}", vars)).toBe("hi alice");
  });

  it("点路径逐级下钻（env.url / global.base_url / 深层）", () => {
    expect(resolveValue("${{env.url}}", vars)).toBe("http://x.com");
    expect(resolveValue("${{global.base_url}}", vars)).toBe("http://g.com");
    expect(resolveValue("${{nested.a.b}}", vars)).toBe("deep");
  });

  it("未命中保留原文；值为 null 保留原文", () => {
    expect(resolveValue("${{not_exist}}", vars)).toBe("${{not_exist}}");
    expect(resolveValue("x ${{env.missing}} y", vars)).toBe("x ${{env.missing}} y");
    expect(resolveValue("${{nullVar}}", { nullVar: null })).toBe("${{nullVar}}");
  });

  it("非 dict 中间层返回原文", () => {
    expect(resolveValue("${{username.sub}}", vars)).toBe("${{username.sub}}");
  });

  it("数值转为字符串", () => {
    expect(resolveValue("n=${{count}}", vars)).toBe("n=5");
  });

  it("递归 dict / list", () => {
    expect(
      resolveValue({ a: "${{username}}", b: ["${{env.url}}", 1, { c: "${{global.base_url}}" }] }, vars),
    ).toEqual({ a: "alice", b: ["http://x.com", 1, { c: "http://g.com" }] });
  });

  it("step 结构：method/params/keyword + branches 保留 condition 并递归 steps", () => {
    const out = resolve(
      {
        method: "fill_value",
        keyword: "输入",
        params: { locator: "#u", value: "${{username}}" },
        branches: [
          {
            condition: { variable: "username", operator: "equals", value: "alice" },
            steps: [{ method: "click_ele", params: { locator: "${{env.url}}" } }],
          },
        ],
      },
      vars,
    );
    expect(out.method).toBe("fill_value");
    expect(out.keyword).toBe("输入");
    expect(out.params).toEqual({ locator: "#u", value: "alice" });
    expect(out.branches).toHaveLength(1);
    expect(out.branches![0]!.condition).toEqual({
      variable: "username",
      operator: "equals",
      value: "alice",
    });
    expect(out.branches![0]!.steps[0]!.params).toEqual({ locator: "http://x.com" });
  });

  it("无 params / 无 keyword 时补默认值", () => {
    expect(resolve({ method: "refresh" }, vars)).toEqual({
      method: "refresh",
      params: {},
      keyword: "",
    });
  });
});
