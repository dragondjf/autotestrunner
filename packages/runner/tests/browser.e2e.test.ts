/**
 * 真实 chromium 对拍测试（ACCEPTANCE.md C 类 19/22 浏览器部分）
 * - 19: frame_* iframe 操作、condition_branch 条件分支、extract_text 变量贯通
 * - 22: 真实截图文件名与产物
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { StepExecutor, AssertionError, type Variables } from "../src/step-executor.js";
import { capture } from "../src/screenshot-manager.js";
import { ExecutionRecorder } from "../src/execution-recorder.js";

let browser: Browser;
let page: Page;
const executor = new StepExecutor();
const env: Record<string, any> = {};

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  page = await context.newPage();
  await page.setDefaultTimeout(3000);
});

afterAll(async () => {
  await browser.close();
});

const PAGE_HTML = `
<div id="log"></div>
<script>function log(x){ document.getElementById('log').textContent += x + ';'; }</script>
<div id="price">¥ 199.00</div>
<input id="out" />
<button id="btn" onclick="log('clicked')">按钮</button>
<iframe name="panel" srcdoc="
  <input id='inner' value='' />
  <div id='inner-text'>iframe 内文本</div>
  <button id='inner-btn' onclick='parent.document.getElementById(\`log\`).textContent += \`inner-clicked;\`' >内按钮</button>
"></iframe>
`;

describe("C19: frame_* / condition_branch / extract_text（真实 chromium）", () => {
  it("extract_text 提取变量 → fill_value 贯通使用", async () => {
    await page.setContent(PAGE_HTML);
    const vars: Variables = {};

    await executor.execute(page, { method: "extract_text", params: { locator: "#price", var_name: "price" } }, env, vars);
    expect(vars["price"]).toBe("¥ 199.00");

    // 变量替换后填充（模拟引擎的变量替换逻辑：{{price}}）
    await executor.execute(
      page,
      { method: "fill_value", params: { locator: "#out", value: String(vars["price"]) } },
      env,
      vars,
    );
    expect(await page.locator("#out").inputValue()).toBe("¥ 199.00");
  });

  it("frame_fill_value / frame_extract_text / frame_click 在命名 iframe 内执行", async () => {
    await page.setContent(PAGE_HTML);
    const frame = page.frame({ name: "panel" })!;
    expect(frame).toBeTruthy();
    const vars: Variables = {};

    await executor.execute(
      page,
      { method: "frame_fill_value", params: { frame: "panel", locator: "#inner", value: "hello-frame" } },
      env,
      vars,
    );
    expect(await frame.locator("#inner").inputValue()).toBe("hello-frame");

    await executor.execute(
      page,
      { method: "frame_extract_text", params: { frame: "panel", locator: "#inner-text", var_name: "inner" } },
      env,
      vars,
    );
    expect(vars["inner"]).toBe("iframe 内文本");

    await executor.execute(
      page,
      { method: "frame_click_ele", params: { frame: "panel", locator: "#inner-btn" } },
      env,
      vars,
    );
    expect(await page.locator("#log").textContent()).toContain("inner-clicked");
  });

  it("frame_url 匹配兜底：无 name 时按 URL 匹配", async () => {
    await page.setContent(PAGE_HTML);
    const vars: Variables = {};
    await executor.execute(
      page,
      { method: "frame_extract_text", params: { frame_url: "about:srcdoc", locator: "#inner-text", var_name: "u" } },
      env,
      vars,
    );
    expect(vars["u"]).toBe("iframe 内文本");
  });

  it("condition_branch：命中分支执行子步骤，未命中跳过", async () => {
    await page.setContent(PAGE_HTML);
    const vars: Variables = { level: "vip" };

    // 命中 vip 分支
    await executor.execute(
      page,
      {
        method: "condition_branch",
        branches: [
          {
            condition: { variable: "level", operator: "equals", value: "vip" },
            steps: [{ method: "fill_value", params: { locator: "#out", value: "vip-price" } }],
          },
          {
            condition: { variable: "level", operator: "equals", value: "normal" },
            steps: [{ method: "fill_value", params: { locator: "#out", value: "normal-price" } }],
          },
        ],
      },
      env,
      vars,
    );
    expect(await page.locator("#out").inputValue()).toBe("vip-price");

    // 无分支命中 → 不执行任何子步骤
    await page.setContent(PAGE_HTML);
    await executor.execute(
      page,
      {
        method: "condition_branch",
        branches: [
          {
            condition: { variable: "level", operator: "equals", value: "none" },
            steps: [{ method: "fill_value", params: { locator: "#out", value: "x" } }],
          },
        ],
      },
      env,
      vars,
    );
    expect(await page.locator("#out").inputValue()).toBe("");
  });

  it("kw_assert_element_text 断言失败抛 AssertionError（failed 而非 error）", async () => {
    await page.setContent(PAGE_HTML);
    await expect(
      executor.execute(page, { method: "kw_assert_element_text", params: { locator: "#price", text: "999" } }, env, {}),
    ).rejects.toThrow(AssertionError);
    // 通过断言（Python 版为精确匹配：text.strip() == params["text"]）
    await expect(
      executor.execute(page, { method: "kw_assert_element_text", params: { locator: "#price", text: "¥ 199.00" } }, env, {}),
    ).resolves.toBe(null);
  });
});

describe("C22: 真实截图产物", () => {
  it("capture 返回 base64 PNG 数据", async () => {
    await page.setContent(PAGE_HTML);
    const b64 = await capture(page);
    expect(b64).toBeTruthy();
    const buf = Buffer.from(b64, "base64");
    // PNG 魔数
    expect(buf[0]).toBe(0x89);
    expect(buf.subarray(1, 4).toString()).toBe("PNG");
  });

  it("ExecutionRecorder 真实截图落盘：文件名 <execution_id>_s<index>.png", async () => {
    await page.setContent(PAGE_HTML);
    const rec = new ExecutionRecorder(4242, { name: "截图套件" }, {}, "e2e-runner");
    rec.beginCase(9, "c9", "截图用例", page);
    const b64 = await capture(page);
    rec.recordStep(
      9,
      { _step_index: 0, method: "open_url", params: { url: "http://x" } },
      "passed",
      null,
      12,
      b64,
    );
    rec.endCase(9, "passed", null);
    rec.save();

    const shotFile = path.join(rec.dir, "screenshots", "9_s0.png");
    expect(fs.existsSync(shotFile)).toBe(true);
    const buf = fs.readFileSync(shotFile);
    expect(buf[0]).toBe(0x89);
    expect(buf.subarray(1, 4).toString()).toBe("PNG");

    const json = JSON.parse(fs.readFileSync(path.join(rec.dir, "execution.json"), "utf-8"));
    expect(json.cases[0].steps[0].screenshot).toBe("screenshots/9_s0.png");
    fs.rmSync(rec.dir, { recursive: true, force: true });
  });
});
