/**
 * 录制器回声抑制协议（__REC_SUPPRESS_UNTIL__）。
 * 面板程序化执行的动作会在页面触发真实可信事件，后端在执行期间设置抑制截止时间，
 * 注入录制器必须丢弃窗口内事件（避免同一动作在时间线记录两遍），窗口过期后恢复采集。
 */
import { describe, it, expect, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { buildRecorderScript } from "@brickcore/shared";

describe("录制器回声抑制协议（__REC_SUPPRESS_UNTIL__）", () => {
  let browser: Browser | null = null;

  afterAll(async () => {
    await browser?.close();
  });

  it("抑制窗口内 DOM 事件不入队，窗口过期后恢复采集", async () => {
    browser = browser ?? (await chromium.launch());
    const page = await browser.newPage();
    await page.setContent(`<button id="b">登录</button>`);
    await page.evaluate(buildRecorderScript());
    const count = (): Promise<number> =>
      page.evaluate(() => (window as unknown as { __RECORDED__: unknown[] }).__RECORDED__.length);

    // 窗口外：正常采集
    await page.click("#b");
    expect(await count()).toBe(1);

    // 窗口内：事件被丢弃（模拟面板程序化执行回声）
    await page.evaluate(() => {
      (window as unknown as { __REC_SUPPRESS_UNTIL__?: number }).__REC_SUPPRESS_UNTIL__ =
        Date.now() + 800;
    });
    await page.click("#b");
    await page.click("#b");
    expect(await count()).toBe(1);

    // 窗口过期：恢复采集
    await page.waitForTimeout(900);
    await page.click("#b");
    expect(await count()).toBe(2);
    await page.close();
  });

  it("构造脚本包含初始化与 emit 护栏", () => {
    const script = buildRecorderScript();
    expect(script).toContain("__REC_SUPPRESS_UNTIL__ = 0");
    expect(script).toContain("Date.now() < window.__REC_SUPPRESS_UNTIL__");
  });
});
