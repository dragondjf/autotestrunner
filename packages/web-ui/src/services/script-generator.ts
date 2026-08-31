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
  // DSL 值常带 JSON 引号（get_by_role=textbox, "搜索"）→ 去两侧引号
  const unquote = (v: string) => String(v).trim().replace(/^"|"$/g, "").replace(/"/g, '\\"');
  let m: RegExpExecArray | null;
  if ((m = /^get_by_placeholder=(.+)$/.exec(s))) return `input[placeholder="${unquote(m[1]!)}"]`;
  if ((m = /^get_by_label=(.+)$/.exec(s))) return `[aria-label="${unquote(m[1]!)}"]`;
  if ((m = /^get_by_title=(.+)$/.exec(s))) return `[title="${unquote(m[1]!)}"]`;
  if ((m = /^get_by_alt_text=(.+)$/.exec(s))) return `img[alt="${unquote(m[1]!)}"]`;
  if ((m = /^get_by_role=([^,]+),\s*(.+)$/.exec(s))) {
    const role = m[1]!.trim();
    const name = unquote(m[2]!);
    // 输入类元素：CSS [role] 属性选择器匹配不到无显式 role 的 input → 用 input/textarea 组合
    if (role === "textbox" || role === "searchbox") {
      return `input[placeholder="${name}"], textarea[placeholder="${name}"], [role="${role}"][placeholder="${name}"], input[aria-label="${name}"], [role="${role}"][aria-label="${name}"], [role="${role}"]:has-text("${name}")`;
    }
    // 常见 role → 原生标签候选（无显式 role 属性的元素同样可命中）
    const roleTag: Record<string, string> = {
      button: "button",
      link: "a",
      checkbox: 'input[type="checkbox"]',
      radio: 'input[type="radio"]',
      combobox: "select",
      option: "option",
      heading: "h1,h2,h3,h4,h5,h6",
    };
    if (roleTag[role]) return `${roleTag[role]}:has-text("${name}"), [role="${role}"]:has-text("${name}")`;
    return `[role="${role}"]:has-text("${name}")`;
  }
  if ((m = /^get_by_role=(.+)$/.exec(s))) return `[role="${m[1]!.trim()}"]`;
  if ((m = /^get_by_text=(.+)$/.exec(s))) return `:text-is("${unquote(m[1]!)}")`;
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
    "  let page = await context.newPage();\n\n";

  const CLICK_METHODS = new Set(["click", "click_ele", "click_by_text", "double_click_ele"]);

  let body = "";
  for (let i = 0; i < norm.length; i++) {
    const s = norm[i];
    const next = norm[i + 1];
    body += `  // ===== Step ${s.step}${s.desc ? ": " + s.desc : ""} =====\n`;
    const method = s.method || "";
    const loc = toPlaywrightSelector(s.locator || "");
    const val = s.value || "";
    const urlVal = (s as { params?: { url?: string } }).params?.url ?? s.url ?? "";
    // 点击打开新 tab（target=_blank）：合并「点击 + 等待新页 + 切换」，新页后续步骤作用于 page
    if (CLICK_METHODS.has(method) && next && next.method === "new_page") {
      body += `  const [newPage] = await Promise.all([\n`;
      body += `    context.waitForEvent('page', { timeout: 10000 }).catch(() => null),\n`;
      body += `    page.click('${codeEscape(loc || val)}'),\n`;
      body += `  ]);\n`;
      body += `  if (newPage) { page = newPage; await page.waitForLoadState('domcontentloaded').catch(() => {}); }\n`;
      body += "  await autoShot(page, '" + String(s.desc || s.method).slice(0, 24).replace(/'/g, '') + "');\n";
      body += "\n";
      i++; // new_page 步骤已合并处理
      continue;
    }
    switch (method) {
      case "click":
      case "click_ele":
      case "click_by_text":
      case "double_click_ele":
        body += `  await page.click('${codeEscape(loc || val)}');\n`;
        break;
      case "new_page":
        // 新页由之前的点击打开：等待出现并切换到最新页面（点击在前的录制顺序下立即命中）
        body += `  const prevCount = context.pages().length;\n`;
        body += `  let np = null;\n`;
        body += `  for (let i = 0; i < 20 && !np; i++) {\n`;
        body += `    const ps = context.pages();\n`;
        body += `    if (ps.length > prevCount) np = ps[ps.length - 1];\n`;
        body += `    else await page.waitForTimeout(100);\n`;
        body += `  }\n`;
        body += `  if (np) { page = np; await page.waitForLoadState('domcontentloaded').catch(() => {}); }\n`;
        break;
      case "switch_page":
        // 按 tab 序号/url 切换（录制协议 new_page 的 tab_index）
        body += `  page = context.pages()[${Number(val) || 0}] || page;\n`;
        body += `  await page.waitForLoadState('domcontentloaded').catch(() => {});\n`;
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
        body += `  await page.goto('${codeEscape(urlVal)}');\n`;
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
