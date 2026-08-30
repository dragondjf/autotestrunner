/**
 * 截图管理。
 * 1:1 对照 brick_runner_http/runner/screenshot_manager.py。
 */
import type { Page } from "playwright";

/** 截取当前页面截图，返回 base64 编码的 PNG 数据 */
export async function capture(page: Page, fullPage = false): Promise<string> {
  const bytes = await page.screenshot({ fullPage, type: "png" });
  return Buffer.from(bytes).toString("base64");
}
