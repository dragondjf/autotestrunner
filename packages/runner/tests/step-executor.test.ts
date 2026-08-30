import { describe, it, expect } from "vitest";
import { StepExecutor } from "../src/step-executor.js";

interface Call {
  op: string;
  args: unknown[];
}

/** 记录型假 page/locator：把 Playwright 调用记成可读操作序列 */
function makePage(opts: { text?: string; visible?: boolean } = {}) {
  const calls: Call[] = [];
  const log = (op: string, ...args: unknown[]) => calls.push({ op, args });
  const mkLoc = (sel: string) => ({
    __sel: sel,
    nth: (i: number) => mkLoc(`${sel}>>nth(${i})`),
    click: async (o?: unknown) => log(`click(${sel})`, o),
    fill: async (v: string) => log(`fill(${sel})`, v),
    hover: async () => log(`hover(${sel})`),
    selectOption: async (v: string) => log(`selectOption(${sel})`, v),
    setInputFiles: async (v: string) => log(`setInputFiles(${sel})`, v),
    waitFor: async (o?: unknown) => log(`waitFor(${sel})`, o),
    textContent: async () => opts.text ?? "hello",
    isVisible: async () => opts.visible ?? true,
    scrollIntoViewIfNeeded: async () => log(`scrollIntoView(${sel})`),
    evaluate: async (js: string) => log(`locatorEval(${sel})`, js),
  });

  const frame = {
    locator: (sel: string) => mkLoc(sel),
    getByText: (t: string) => mkLoc(`text=${t}`),
    getByRole: (r: string) => mkLoc(`role=${r}`),
  };

  const page = {
    calls,
    url: () => "http://fake/",
    locator: (sel: string) => mkLoc(sel),
    getByText: (t: string, o?: { exact?: boolean }) => {
      log(`getByText(${t})`, o);
      return mkLoc(`text=${t}`);
    },
    goto: async (url: string, o?: unknown) => log("goto", url, o),
    reload: async (o?: unknown) => log("reload", o),
    goBack: async () => log("goBack"),
    close: async () => log("close"),
    waitForSelector: async (sel: string, o?: unknown) => log("waitForSelector", sel, o),
    waitForLoadState: async (s: string) => log("waitForLoadState", s),
    evaluate: async (js: string, args?: unknown) => log("evaluate", js, args),
    keyboard: {
      press: async (k: string) => log("keyboard.press", k),
      type: async (t: string) => log("keyboard.type", t),
    },
    mouse: {
      click: async (x: number, y: number) => log("mouse.click", x, y),
    },
    frame: (q: { name?: string; url?: string }) => (q.name === "f1" ? frame : null),
  };
  return page as unknown as import("playwright").Page & { calls: Call[] };
}

const exec = new StepExecutor();

describe("StepExecutor 页面/元素/键盘操作", () => {
  it("open_browser：url 优先，其次 env/project 默认，最后 target_host 补协议", async () => {
    const p1 = makePage();
    await exec.execute(p1, { method: "open_browser", params: { url: "http://a" } }, {}, {});
    expect(p1.calls[0]!.args[0]).toBe("http://a");

    const p2 = makePage();
    await exec.execute(
      p2,
      { method: "open_browser", params: {} },
      { env_default_start_url: "http://env", project_default_start_url: "http://proj" },
      {},
    );
    expect(p2.calls[0]!.args[0]).toBe("http://env");

    const p3 = makePage();
    await exec.execute(p3, { method: "open_browser", params: {} }, { target_host: "x.com" }, {});
    expect(p3.calls[0]!.args[0]).toBe("https://x.com");

    const p4 = makePage();
    await exec.execute(p4, { method: "open_browser", params: {} }, {}, {});
    expect(p4.calls).toHaveLength(0); // 无地址 → 不导航
  });

  it("open_url / refresh 使用 ui_nav_wait_until", async () => {
    const p = makePage();
    await exec.execute(p, { method: "open_url", params: { url: "http://b" } }, { ui_nav_wait_until: "load" }, {});
    expect(p.calls[0]).toEqual({ op: "goto", args: ["http://b", { waitUntil: "load" }] });
  });

  it("click_ele：ready_selector 先等、expected_selector 后等、force 传参", async () => {
    const p = makePage();
    await exec.execute(
      p,
      {
        method: "click_ele",
        params: { locator: "#btn", ready_selector: ".r", expected_selector: ".e", force: true },
      },
      {},
      {},
    );
    expect(p.calls.map((c) => c.op)).toEqual(["waitForSelector", "click(#btn)", "waitForSelector"]);
    expect(p.calls[1]!.args[0]).toEqual({ force: true });
  });

  it("fill_value / hover / select_option / click_by_text", async () => {
    const p = makePage();
    await exec.execute(p, { method: "fill_value", params: { locator: "#u", value: "abc" } }, {}, {});
    await exec.execute(p, { method: "hover", params: { locator: "#h" } }, {}, {});
    await exec.execute(p, { method: "select_option", params: { locator: "#s", value: "A" } }, {}, {});
    await exec.execute(p, { method: "click_by_text", params: { text: "登录" } }, {}, {});
    expect(p.calls.map((c) => c.op)).toEqual([
      "fill(#u)",
      "hover(#h)",
      "selectOption(#s)",
      "getByText(登录)",
      "click(text=登录)",
    ]);
  });

  it("go_back / close_page / press_key / press_type / mouse_click", async () => {
    const p = makePage();
    await exec.execute(p, { method: "go_back", params: {} }, {}, {});
    await exec.execute(p, { method: "press_key", params: { key: "Enter" } }, {}, {});
    await exec.execute(p, { method: "press_type", params: { text: "hi" } }, {}, {});
    await exec.execute(p, { method: "mouse_click", params: { x: 1, y: 2 } }, {}, {});
    expect(p.calls.map((c) => c.op)).toEqual([
      "goBack",
      "keyboard.press",
      "keyboard.type",
      "mouse.click",
    ]);
  });
});

describe("StepExecutor 等待/断言/提取", () => {
  it("wait_for_element 默认 30s visible；wait_for_network 用 networkidle", async () => {
    const p = makePage();
    await exec.execute(p, { method: "wait_for_element", params: { locator: "#w" } }, {}, {});
    await exec.execute(p, { method: "wait_for_network", params: {} }, {}, {});
    expect(p.calls[0]!.args[0]).toEqual({ state: "visible", timeout: 30000 });
    expect(p.calls[1]).toEqual({ op: "waitForLoadState", args: ["networkidle"] });
  });

  it("kw_assert_element_text 失败文案逐字", async () => {
    const p = makePage({ text: "  hi  " });
    await expect(
      exec.execute(p, { method: "kw_assert_element_text", params: { locator: "#t", text: "hi" } }, {}, {}),
    ).resolves.toBeNull();
    await expect(
      exec.execute(p, { method: "kw_assert_element_text", params: { locator: "#t", text: "no" } }, {}, {}),
    ).rejects.toThrow("文本断言失败: 期望='no', 实际='hi'");
  });

  it("kw_assert_visible / kw_assert_not_visible", async () => {
    const visible = makePage({ visible: true });
    await expect(
      exec.execute(visible, { method: "kw_assert_visible", params: { locator: "#v" } }, {}, {}),
    ).resolves.toBeNull();
    await expect(
      exec.execute(visible, { method: "kw_assert_not_visible", params: { locator: "#v" } }, {}, {}),
    ).rejects.toThrow("元素应不可见: #v");

    const hidden = makePage({ visible: false });
    await expect(
      exec.execute(hidden, { method: "kw_assert_visible", params: { locator: "#h" } }, {}, {}),
    ).rejects.toThrow("元素可见性断言失败: #h");
    await expect(
      exec.execute(hidden, { method: "kw_assert_not_visible", params: { locator: "#h" } }, {}, {}),
    ).resolves.toBeNull();
  });

  it("extract_text 写入 variables（strip）", async () => {
    const p = makePage({ text: "  abc  " });
    const vars: Record<string, unknown> = {};
    await exec.execute(p, { method: "extract_text", params: { locator: "#e", var_name: "v1" } }, {}, vars);
    expect(vars["v1"]).toBe("abc");
  });

  it("save_page_img 为 no-op；execute_script / set_local_storage / scroll_to", async () => {
    const p = makePage();
    await exec.execute(p, { method: "save_page_img", params: {} }, {}, {});
    expect(p.calls).toHaveLength(0);
    await exec.execute(p, { method: "execute_script", params: { script: "1+1", args: [1] } }, {}, {});
    await exec.execute(p, { method: "set_local_storage", params: { key: "k", value: "v" } }, {}, {});
    await exec.execute(p, { method: "scroll_to", params: { x: 0, y: 10 } }, {}, {});
    expect(p.calls[0]!.args[0]).toBe("1+1");
    expect(p.calls[1]!.args[0]).toBe("localStorage.setItem('k', 'v')");
    expect(p.calls[2]!.args[0]).toBe("window.scrollTo(0, 10)");
  });
});

describe("StepExecutor 条件分支与 iframe", () => {
  it("_evaluate_condition 9 种操作符 + 未知操作符返回 true", () => {
    const vars = { a: "1", s: "abcdef", n: 10 };
    const ev = (op: string, value?: unknown, variable = "s") =>
      exec.evaluateCondition(vars, { variable, operator: op, value });
    expect(exec.evaluateCondition(vars, { variable: "a", operator: "equals", value: "1" })).toBe(true);
    expect(ev("not_equals", "abc")).toBe(true);
    expect(ev("contains", "cd")).toBe(true);
    expect(ev("not_contains", "zz")).toBe(true);
    expect(ev("exists", undefined, "a")).toBe(true);
    expect(ev("not_exists", undefined, "zzz")).toBe(true);
    expect(exec.evaluateCondition(vars, { variable: "n", operator: "greater_than", value: 5 })).toBe(true);
    expect(exec.evaluateCondition(vars, { variable: "n", operator: "less_than", value: 5 })).toBe(false);
    expect(exec.evaluateCondition(vars, { variable: "s", operator: "greater_than", value: 5 })).toBe(false); // 转换失败
    expect(ev("unknown_op", "x")).toBe(true);
  });

  it("condition_branch 只执行第一个命中的分支", async () => {
    const p = makePage();
    await exec.execute(
      p,
      {
        method: "condition_branch",
        branches: [
          {
            condition: { variable: "x", operator: "equals", value: "1" },
            steps: [{ method: "fill_value", params: { locator: "#b1", value: "1" } }],
          },
          {
            condition: { variable: "x", operator: "equals", value: "1" },
            steps: [{ method: "fill_value", params: { locator: "#b2", value: "2" } }],
          },
        ],
      },
      {},
      { x: "1" },
    );
    expect(p.calls.map((c) => c.op)).toEqual(["fill(#b1)"]);
  });

  it("frame_ 前缀：先按 name 找 frame，剥前缀递归执行", async () => {
    const p = makePage();
    await exec.execute(
      p,
      { method: "frame_fill_value", params: { frame: "f1", locator: "#u", value: "abc" } },
      {},
      {},
    );
    expect(p.calls.map((c) => c.op)).toEqual(["fill(#u)"]);
  });

  it("frame_ 找不到 frame 时静默跳过", async () => {
    const p = makePage();
    await exec.execute(
      p,
      { method: "frame_click_ele", params: { frame: "nope", locator: "#u" } },
      {},
      {},
    );
    expect(p.calls).toHaveLength(0);
  });

  it("upload_file 仅 single 模式执行；未知 method 跳过并返回 null", async () => {
    const p = makePage();
    await exec.execute(
      p,
      { method: "upload_file", params: { locator: "#f", file_path: "a.png", upload_mode: "single" } },
      {},
      {},
    );
    expect(p.calls.map((c) => c.op)).toEqual(["setInputFiles(#f)"]);

    const p2 = makePage();
    await exec.execute(p2, { method: "upload_file", params: { locator: "#f", file_path: "a.png" } }, {}, {});
    expect(p2.calls).toHaveLength(0);

    const p3 = makePage();
    const r = await exec.execute(p3, { method: "not_a_method", params: {} }, {}, {});
    expect(r).toBeNull();
    expect(p3.calls).toHaveLength(0);
  });
});

describe("StepExecutor smart_step 入口", () => {
  it("缺 intent 时返回 {smart_step_error: 缺少 intent 参数}（不抛异常）", async () => {
    const p = makePage();
    const r = await exec.execute(p, { method: "smart_step", params: {} }, {}, {});
    expect(r).toEqual({ smart_step_error: "缺少 intent 参数" });
  });

  it("无 API Key 时抛出固定文案（逐字对齐）", async () => {
    const p = makePage();
    const prev = process.env.BROWSER_USE_API_KEY;
    const prev2 = process.env.OPENAI_API_KEY;
    delete process.env.BROWSER_USE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    await expect(
      exec.execute(p, { method: "smart_step", params: { intent: "登录" } }, {}, {}),
    ).rejects.toThrow(
      "smart_step 需要配置 LLM API Key。请设置以下环境变量之一：\n" +
        "  1) BROWSER_USE_API_KEY — 从 https://cloud.browser-use.com 获取\n" +
        "  2) OPENAI_API_KEY — OpenAI API Key\n" +
        "或在平台配置中设置 LLM 模型并确保已设为默认配置。",
    );
    if (prev !== undefined) process.env.BROWSER_USE_API_KEY = prev;
    if (prev2 !== undefined) process.env.OPENAI_API_KEY = prev2;
  });
});
