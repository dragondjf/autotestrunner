/**
 * 录制脚本生成器：inspect 时间线步骤 → 可执行 Playwright JS 脚本。
 * 与前端 code-generator.js 同款输出契约（SmartBrowser DSL → Playwright 原生选择器）。
 * 录制保存项目时自动调用（scriptLang=js，scriptContent=可执行脚本）。
 */
export interface RecordedStep {
  step?: number;
  method: string;
  desc?: string;
  locator?: string;
  value?: string;
  url?: string;
  screenshot?: string;
  sx?: number;
  sy?: number;
  ex?: number;
  ey?: number;
}

function codeEscape(s: string): string {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "");
}

/** SmartBrowser 定位 DSL → Playwright 原生选择器 */
export function toPlaywrightSelector(loc: string): string {
  if (!loc) return loc;
  const s = loc.trim();
  let m: RegExpExecArray | null;
  if ((m = /^get_by_placeholder=(.+)$/.exec(s))) return `input[placeholder="${m[1]!.replace(/"/g, '\\"')}"]`;
  if ((m = /^get_by_label=(.+)$/.exec(s))) return `[aria-label="${m[1]!.replace(/"/g, '\\"')}"]`;
  if ((m = /^get_by_title=(.+)$/.exec(s))) return `[title="${m[1]!.replace(/"/g, '\\"')}"]`;
  if ((m = /^get_by_alt_text=(.+)$/.exec(s))) return `img[alt="${m[1]!.replace(/"/g, '\\"')}"]`;
  if ((m = /^get_by_role=([^,]+),\s*(.+)$/.exec(s))) return `[role="${m[1]!.trim()}"]:has-text("${m[2]!.replace(/"/g, '\\"')}")`;
  if ((m = /^get_by_role=(.+)$/.exec(s))) return `[role="${m[1]!.replace(/"/g, '\\"')}"]`;
  if ((m = /^get_by_text=(.+)$/.exec(s))) return `:text-is("${m[1]!.replace(/"/g, '\\"')}")`;
  return s;
}

/**
 * 步骤流 → 完整可执行 Playwright JS 脚本。
 * 兼容两种输入：inspect 时间线步骤（method/locator/value）与标准步骤流
 * （{method, params:{value}, locator:{primary}}）。
 */
export function generatePlaywrightJs(steps: RecordedStep[]): string {
  if (!steps || !steps.length) {
    return "// 暂无执行步骤，请先录制\n";
  }
  // 标准步骤流归一化为时间线形态
  const norm = steps.map((s, i) => {
    if (typeof s.locator === "object" && s.locator !== null) {
      const l = s.locator as { primary?: string };
      return { ...s, step: s.step ?? i + 1, locator: l.primary ?? "", value: (s as { params?: { value?: string } }).params?.value ?? s.value ?? "" };
    }
    return { ...s, step: s.step ?? i + 1 };
  });

  const head =
    "const path = require('path');\n" +
    "const fs = require('fs');\n\n" +
    "// 每步自动截图（目录由执行器注入 AUTOTEST_SCREENSHOT_DIR）\n" +
    "const shotDir = process.env.AUTOTEST_SCREENSHOT_DIR || process.cwd();\n" +
    "let shotSeq = 0;\n" +
    "async function autoShot(page, tag) {\n" +
    "  shotSeq++;\n" +
    "  try {\n" +
    "    fs.mkdirSync(shotDir, { recursive: true });\n" +
    "    await page.screenshot({ path: path.join(shotDir, 'step_' + String(shotSeq).padStart(2, '0') + '_' + String(tag || 's').replace(/[^a-z0-9_-]/gi, '_') + '.png') });\n" +
    "  } catch (e) { /* 截图失败不中断 */ }\n" +
    "}\n\n" +
    "const { chromium } = require('playwright');\n\n" +
    "(async () => {\n" +
    "  const browser = await chromium.launch({ headless: false });\n" +
    "  const context = await browser.newContext();\n" +
    "  const page = await context.newPage();\n\n";

  let body = "";
  for (const s of norm) {
    body += `  // ===== Step ${s.step}${s.desc ? ": " + s.desc : ""} =====\n`;
    const method = s.method || "";
    const loc = toPlaywrightSelector(s.locator || "");
    const val = s.value || "";
    switch (method) {
      case "click":
      case "click_ele":
      case "click_by_text":
      case "double_click_ele":
        body += `  await page.click('${codeEscape(loc || val)}');\n`;
        break;
      case "fill":
      case "type":
      case "fill_value":
      case "type_value":
        body += `  await page.fill('${codeEscape(loc)}', '${codeEscape(val)}');\n`;
        break;
      case "clear_value":
        body += `  await page.fill('${codeEscape(loc)}', '');\n`;
        break;
      case "select":
      case "select_option":
        body += `  await page.selectOption('${codeEscape(loc)}', '${codeEscape(val)}');\n`;
        break;
      case "navigate":
      case "open_url":
      case "goto":
        body += `  await page.goto('${codeEscape(val || s.url || "")}');\n`;
        break;
      case "press":
      case "press_key":
        body += `  await page.press('${codeEscape(loc)}', '${codeEscape(val)}');\n`;
        break;
      case "hover":
        body += `  await page.hover('${codeEscape(loc)}');\n`;
        break;
      case "check":
        body += `  await page.check('${codeEscape(loc)}');\n`;
        break;
      case "uncheck":
        body += `  await page.uncheck('${codeEscape(loc)}');\n`;
        break;
      case "wait_for_element":
      case "wait_for_selector":
        body += `  await page.waitForSelector('${codeEscape(loc)}', { timeout: 5000 });\n`;
        break;
      case "wait_for_time":
        body += `  await page.waitForTimeout(${Number(val) || 1000});\n`;
        break;
      case "refresh":
        body += "  await page.reload();\n";
        break;
      case "go_back":
        body += "  await page.goBack();\n";
        break;
      case "click_at":
        body += `  await page.mouse.click(${(s as { params?: { x?: number } }).params?.x ?? s.sx ?? 0}, ${(s as { params?: { y?: number } }).params?.y ?? s.sy ?? 0});\n`;
        break;
      case "drag":
        body += `  await page.mouse.move(${s.sx ?? 0}, ${s.sy ?? 0});\n`;
        body += "  await page.mouse.down();\n";
        body += `  await page.mouse.move(${s.ex ?? 0}, ${s.ey ?? 0}, { steps: 8 });\n`;
        body += "  await page.mouse.up();\n";
        break;
      default:
        if (loc) {
          if (val) body += `  await page.fill('${codeEscape(loc)}', '${codeEscape(val)}');\n`;
          else body += `  await page.click('${codeEscape(loc)}');\n`;
        }
        break;
    }
    body += "  await autoShot(page, '" + String(s.desc || s.method).slice(0, 24).replace(/'/g, '') + "');" + "\n";
    body += "\n";
  }
  const foot = "  await browser.close();\n})();\n";
  return head + body + foot;
}
