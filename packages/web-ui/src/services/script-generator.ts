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

/** desc 可能含换行（多行页面标题/文本）→ 压成单行，避免撑破 // 注释或字符串字面量 */
function oneLine(s: string): string {
  return String(s ?? "")
    .replace(/\s*\r?\n\s*/g, " ")
    .trim();
}

/** 字符串字面量（单引号包裹）：换行转为 \n 转义序列，保留文本原语义 */
function jsLit(v: string): string {
  return `'${codeEscape(v)}'`;
}

/**
 * 平台定位 DSL → Playwright 原生定位表达式（不含 page. 锚，链式段以 . 连接）。
 * 定位规则（高→低）：getByRole > getByText > getByLabel > getByPlaceholder
 * > getByAltText > getByTitle > getByTestId > CSS > XPath（最后考虑）。
 * 语义与运行时解析器（locator-utils.resolveLocatorOnScope）保持一致。
 */
export function toPlaywrightExpr(loc: string): string {
  const raw = String(loc ?? "").trim();
  if (!raw) return "";
  // DSL 值常带包裹引号（get_by_role=button, "搜索"）→ 去两侧成对引号
  const unq = (v: string): string => {
    const t = v.trim();
    let out = t;
    if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) {
      out = t.slice(1, -1).trim();
    }
    // 录制数据偶见字面 \n（反斜杠+n）序列 → 归一为空格（Playwright 文本匹配做空白归一化）
    return out.replace(/\\n/g, " ");
  };
  const seg = (s: string): string => {
    let m: RegExpExecArray | null;
    if ((m = /^get_by_role=([^,]+),\s*([\s\S]+)$/.exec(s))) {
      const role = m[1]!.trim();
      let name = unq(m[2]!);
      // LLM 变体：name="x" 前缀剥离；title= 非 accessible name → 退 getByTitle（对齐运行时归一化）
      const tm = /^title=["']?([\s\S]*?)["']?$/.exec(name);
      if (tm) return `getByTitle(${jsLit(unq(tm[1]!))})`;
      const nm = /^name=["']?([\s\S]*?)["']?$/.exec(name);
      if (nm) name = unq(nm[1]!);
      return name ? `getByRole('${role}', { name: ${jsLit(name)} })` : `getByRole('${role}')`;
    }
    if ((m = /^get_by_role=(.+)$/.exec(s))) return `getByRole('${unq(m[1]!).trim()}')`;
    if ((m = /^get_by_text=([\s\S]+)$/.exec(s))) return `getByText(${jsLit(unq(m[1]!))})`;
    if ((m = /^get_by_label=([\s\S]+)$/.exec(s))) return `getByLabel(${jsLit(unq(m[1]!))})`;
    if ((m = /^get_by_placeholder=([\s\S]+)$/.exec(s))) return `getByPlaceholder(${jsLit(unq(m[1]!))})`;
    if ((m = /^get_by_alt_text=([\s\S]+)$/.exec(s))) return `getByAltText(${jsLit(unq(m[1]!))})`;
    if ((m = /^get_by_title=([\s\S]+)$/.exec(s))) return `getByTitle(${jsLit(unq(m[1]!))})`;
    if ((m = /^get_by_test_id=([\s\S]+)$/.exec(s))) return `getByTestId(${jsLit(unq(m[1]!))})`;
    if ((m = /^nth\s*=\s*(\d+)$/.exec(s))) return `nth(${m[1]})`;
    // 绝对 XPath（/html/...）必须显式 xpath= 引擎前缀（// 开头 Playwright 可自动识别）
    const css = /^\/(?!\/)/.test(s) ? `xpath=${s}` : s;
    return `locator(${jsLit(css)})`;
  };
  return raw
    .split(" >> ")
    .map((p) => seg(p.trim()))
    .join(".");
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
    "// 每步自动截图（目录由执行器注入 AUTOTEST_SCREENSHOT_DIR）+ 步骤标记（stdout @@STEP@@ 行，供调试时间线实时呈现）\n" +
    "const shotDir = process.env.AUTOTEST_SCREENSHOT_DIR || process.cwd();\n" +
    "const stepGap = Number(process.env.AUTOTEST_STEP_INTERVAL_MS || 0); // 步骤间隔 ms（执行器可配置，0=不等待）\n" +
    "let shotSeq = 0;\n" +
    "async function autoShot(page, tag, meta) {\n" +
    "  shotSeq++;\n" +
    "  const fname = 'step_' + String(shotSeq).padStart(2, '0') + '_' + String(tag || 's').replace(/[^a-z0-9_-]/gi, '_') + '.png';\n" +
    "  try {\n" +
    "    fs.mkdirSync(shotDir, { recursive: true });\n" +
    "    await page.screenshot({ path: path.join(shotDir, fname) });\n" +
    "  } catch (e) { /* 截图失败不中断 */ }\n" +
    "  try {\n" +
    "    const m = meta || {};\n" +
    "    console.log('@@STEP@@' + JSON.stringify({ step: shotSeq, desc: m.desc || tag, method: m.method || '', locator: m.locator || '', url: page.url(), shot: fname }));\n" +
    "  } catch (e) { /* 标记失败不影响执行 */ }\n" +
    "  if (stepGap > 0) await new Promise((r) => setTimeout(r, stepGap));\n" +
    "}\n\n" +
    "const { chromium } = require('playwright');\n\n" +
    "(async () => {\n" +
    "  const browser = await chromium.launch({ headless: false });\n" +
    "  const context = await browser.newContext();\n" +
    "  let page = await context.newPage();\n\n";

  const CLICK_METHODS = new Set(["click", "click_ele", "click_by_text", "double_click_ele"]);

  let npSeq = 0; // 新页变量序号：多次「点击开新页」需唯一变量名，避免重复声明
  let stepSeq = 0; // 注释序号：双通道录制的时间线 step 号可能重复/乱序 → 按输出顺序重编

  // 起始导航兜底：步骤流缺 open_url/navigate（录制时浏览器已停在起始页）→ 取首个带 url 的步骤补 goto，
  // 否则脚本一上来就找元素必然失败
  const hasNavStep = norm.some((s) => ["navigate", "open_url", "goto"].includes(String(s.method || "")));
  const firstUrl = norm.map((s) => (s as { url?: string }).url ?? "").find(Boolean) ?? "";
  const prelude = !hasNavStep && firstUrl ? `  await page.goto('${codeEscape(firstUrl)}');\n` : "";

  let body = "";
  for (let i = 0; i < norm.length; i++) {
    const s = norm[i];
    const next = norm[i + 1];
    stepSeq++;
    body += `  // ===== Step ${stepSeq}${s.desc ? ": " + oneLine(s.desc) : ""} =====\n`;
    const method = s.method || "";
    const ex = toPlaywrightExpr(s.locator || "");
    const val = s.value || "";
    // URL 取值：时间线步骤在 url 字段；项目/任务步骤流（record_config）的 open_url 在 params.value（norm 已并入 val）
    const urlVal = (s as { params?: { url?: string } }).params?.url ?? s.url ?? val ?? "";
    // 点击打开新 tab（target=_blank）：合并「点击 + 等待新页 + 切换」，新页后续步骤作用于 page
    if (CLICK_METHODS.has(method) && next && next.method === "new_page") {
      const clickEx = ex || toPlaywrightExpr(val);
      const np = `newPage${++npSeq}`;
      body += `  const [${np}] = await Promise.all([\n`;
      body += `    context.waitForEvent('page', { timeout: 10000 }).catch(() => null),\n`;
      body += `    ${clickEx ? `page.${clickEx}.click()` : "Promise.resolve()"},\n`;
      body += `  ]);\n`;
      body += `  if (${np}) { page = ${np}; await page.waitForLoadState('domcontentloaded').catch(() => {}); }\n`;
      body += `  await autoShot(page, '${autoTag(s)}', ${autoMeta(s, method)});\n`;
      body += "\n";
      i++; // new_page 步骤已合并处理
      continue;
    }
    switch (method) {
      case "click":
      case "click_ele":
      case "click_by_text":
      case "double_click_ele":
        if (ex || val) body += `  await page.${ex || toPlaywrightExpr(val)}.click();\n`;
        break;
      case "new_page":
        // 新页由之前的点击打开：等待出现并切换到最新页面（点击在前的录制顺序下立即命中）
        {
          const np = `np${++npSeq}`;
          body += `  const prevCount${npSeq} = context.pages().length;\n`;
          body += `  let ${np} = null;\n`;
          body += `  for (let i = 0; i < 20 && !${np}; i++) {\n`;
          body += `    const ps = context.pages();\n`;
          body += `    if (ps.length > prevCount${npSeq}) ${np} = ps[ps.length - 1];\n`;
          body += `    else await page.waitForTimeout(100);\n`;
          body += `  }\n`;
          body += `  if (${np}) { page = ${np}; await page.waitForLoadState('domcontentloaded').catch(() => {}); }\n`;
        }
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
        if (ex) body += `  await page.${ex}.fill(${jsLit(val)});\n`;
        break;
      case "clear_value":
        if (ex) body += `  await page.${ex}.fill('');\n`;
        break;
      case "select":
      case "select_option":
        if (ex) body += `  await page.${ex}.selectOption(${jsLit(val)});\n`;
        break;
      case "navigate":
      case "open_url":
      case "goto":
        // 空地址不生成 goto：goto('') 是 Protocol error，且首步导航缺 URL 必然全链路失败
        if (urlVal) body += `  await page.goto('${codeEscape(urlVal)}');\n`;
        break;
      case "press":
      case "press_key":
        // 无定位时退化为键盘直接按键
        body += ex
          ? `  await page.${ex}.press(${jsLit(val)});\n`
          : `  await page.keyboard.press(${jsLit(val)});\n`;
        break;
      case "hover":
        if (ex) body += `  await page.${ex}.hover();\n`;
        break;
      case "check":
        if (ex) body += `  await page.${ex}.check();\n`;
        break;
      case "uncheck":
        if (ex) body += `  await page.${ex}.uncheck();\n`;
        break;
      case "wait_for_element":
      case "wait_for_selector":
        if (ex) body += `  await page.${ex}.waitFor({ timeout: 5000 });\n`;
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
        if (ex) {
          if (val) body += `  await page.${ex}.fill(${jsLit(val)});\n`;
          else body += `  await page.${ex}.click();\n`;
        }
        break;
    }
    body += `  await autoShot(page, '${autoTag(s)}', ${autoMeta(s, method)});\n`;
    body += "\n";
  }
  const foot = "  await browser.close();\n})();\n";
  return head + prelude + body + foot;
}

/** autoShot 截图文件名 tag（desc/method 压平，去掉引号，截 24 字符） */
function autoTag(s: RecordedStep): string {
  return oneLine(String(s.desc || s.method)).slice(0, 24).replace(/'/g, "");
}

/** autoShot 步骤标记元数据（desc/method/locator → JSON 字面量，供时间线展示） */
function autoMeta(s: RecordedStep, method: string): string {
  return JSON.stringify({
    desc: oneLine(String(s.desc || s.method)).slice(0, 80),
    method: method || "",
    locator: String(s.locator ?? "").slice(0, 300),
  });
}
