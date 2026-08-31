/**
 * 页面抓取模块 + SmartPageExplorer。
 * 1:1 对照 smartbrowser/src/smartbrowser/page_fetcher.py。
 */
import path from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { normalizeLocator, preferPopupElements, resolveLocatorOnPage } from "./locator-utils.js";
import { extractLocatorText } from "./locator-utils.js";
import { SCROLL_PAGE_FN } from "./scroll-page-js.js";

// ============================================================
// 日志（对齐 Python logging 文案）
// ============================================================

function logInfo(msg: string): void {
  console.log(msg);
}
function logWarn(msg: string): void {
  console.warn(msg);
}
function logDebug(_msg: string): void {
  // Python logger.debug：默认不输出
}

// ============================================================
// 常量与工具
// ============================================================

export function coerceBool(value: unknown, def = false): boolean {
  if (value === null || value === undefined) return def;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (["", "0", "false", "no", "off"].includes(text)) return false;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  return def;
}

/** 最大返回元素数量 */
export const MAX_ELEMENTS = 100;

export function formatTimestamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ============================================================
// 页面抓取 JS：提取可交互元素的关键信息（原样复用 EXTRACT_ELEMENTS_JS）
// ============================================================

const EXTRACT_ELEMENTS_JS_SRC = String.raw`() => {
    const elements = [];
    const seen = new Set();

    function isVisible(el) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        // 祖先链检测：识别被折叠容器(如菜单 is-collapsed: max-height:0 + overflow:hidden + opacity:0)裁剪/透明隐藏的子元素
        let node = el.parentElement;
        while (node) {
            const ns = window.getComputedStyle(node);
            if (ns.display === 'none' || ns.visibility === 'hidden') return false;
            if (ns.opacity === '0') return false;
            const nr = node.getBoundingClientRect();
            if ((ns.overflow === 'hidden' || ns.overflow === 'clip') && nr.height === 0) return false;
            node = node.parentElement;
        }
        return rect.top < window.innerHeight && rect.bottom > 0;
    }

    function getUniqueKey(el) {
        // 必须包含能区分同类元素的属性，否则账号框和密码框（同class、同tag、无id、无text）会被去重
        const tag = el.tagName;
        const id = el.id || '';
        const cls = ((el.className || '').toString());
        const text = (el.textContent || '').slice(0, 30);
        const name = el.name || '';
        const ph = el.placeholder || '';
        const type = el.type || '';
        const title = el.getAttribute('title') || '';
        const role = el.getAttribute('role') || '';
        return tag + '|' + id + '|' + cls + '|' + text + '|' + name + '|' + ph + '|' + type + '|' + title + '|' + role;
    }

    function escapeQuotes(str) {
        return (str || '').replace(/"/g, '\\"');
    }

    function isInsidePopup(el) {
        var node = el;
        var depth = 0;
        while (node && node !== document.body && depth < 14) {
            if (!node.tagName) break;
            var role = node.getAttribute('role') || '';
            var cls = (node.className || '').toString();
            var style = window.getComputedStyle(node);
            var isFixed = style.position === 'fixed' || style.position === 'absolute';
            var looksModal = role === 'dialog' || role === 'alertdialog' ||
                /modal|popup|dialog|overlay|mask|drawer|uni-popup|pay-|recharge/i.test(cls);
            var rect = node.getBoundingClientRect();
            if (looksModal && rect.width >= 120 && rect.height >= 60 && (isFixed || role === 'dialog')) {
                return true;
            }
            node = node.parentElement;
            depth++;
        }
        return false;
    }

    // 计算元素的"父级作用域"：回溯到最近的、能区分不同分组/容器的祖先
    // （菜单组、选项卡组、列表、侧边栏、弹窗、卡片、标题栏等）。
    // 用于同名元素（如多个"执行记录"菜单项）被折叠隐藏、需借助父容器来限定作用域时快速匹配。
    function getParentScope(el) {
        let node = el.parentElement;
        let depth = 0;
        while (node && node !== document.body && depth < 6) {
            if (!node.tagName) break;
            const role = (node.getAttribute('role') || '').toLowerCase();
            const cls = (node.className || '').toString().toLowerCase();
            const tag = node.tagName.toLowerCase();
            const looksGroup = role === 'menu' || role === 'listbox' || role === 'tablist' ||
                role === 'list' || role === 'navigation' || role === 'toolbar' ||
                /menu|nav|list-group|dropdown|group|panel|header|card|tabs|sidebar|submenu|modal|popup|dialog|drawer/i.test(cls) ||
                ['ul', 'nav', 'aside', 'header'].includes(tag);
            if (looksGroup && node.getBoundingClientRect().width > 0) {
                const sel = getSelector(node);
                const txt = (node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
                return { selector: sel, text: txt };
            }
            node = node.parentElement;
            depth++;
        }
        return { selector: '', text: '' };
    }

    function getSelector(el) {
        const tag = el.tagName.toLowerCase();
        // 1. data-testid（最稳定）
        const testid = el.getAttribute('data-testid');
        if (testid) return '[data-testid="' + escapeQuotes(testid) + '"]';
        // 2. id
        if (el.id) return '#' + el.id;
        // 3. name
        if (el.name) return tag + '[name="' + escapeQuotes(el.name) + '"]';
        // 4. placeholder（仅 input/textarea）
        if (tag === 'input' && el.placeholder) {
            return 'input[placeholder="' + escapeQuotes(el.placeholder.slice(0, 30)) + '"]';
        }
        // 5. aria-label
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) return '[aria-label="' + escapeQuotes(ariaLabel) + '"]';
        // 6. role + text（Playwright get_by_role 风格，转换为 CSS 选择器）
        const role = el.getAttribute('role');
        const text = (el.textContent || '').trim();
        if (role && text && text.length > 1 && text.length < 30 && !/^\d+$/.test(text)) {
            return tag + '[role="' + escapeQuotes(role) + '"]:has-text("' + escapeQuotes(text) + '")';
        }
        if (role) {
            return tag + '[role="' + escapeQuotes(role) + '"]';
        }
        // 7. title 属性（常用于图标按钮、卡片等）
        const title = el.getAttribute('title');
        if (title) return tag + '[title="' + escapeQuotes(title.slice(0, 30)) + '"]';
        // 8. has-text 兜底
        if (text && text.length > 1 && text.length < 30 && !/^\d+$/.test(text)) {
            return tag + ':has-text("' + escapeQuotes(text) + '")';
        }
        // 9. class（排除 ng-* 等 Angular/Vue/React 动态类）
        const classes = (el.className || '').toString().split(' ').filter(c => c && !c.startsWith('ng-') && !c.startsWith('v-') && c.length < 30);
        if (classes.length > 0) {
            return tag + '.' + classes[0];
        }
        // 10. 最兜底：纯 tag
        return tag;
    }

    function processElement(el) {
        if (!isVisible(el)) return;
        const key = getUniqueKey(el);
        if (seen.has(key)) return;
        seen.add(key);

        const tag = el.tagName.toLowerCase();
        const text = (el.textContent || el.value || el.title || '').trim().slice(0, 100);
        const selector = getSelector(el);
        const role = el.getAttribute('role') || '';
        const title = el.getAttribute('title') || '';
        const testid = el.getAttribute('data-testid') || '';
        // 父级作用域锚点：用于同名元素的父子级快速匹配
        const scope = getParentScope(el);
        // 判断是否为可交互元素
        const clickable = tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'textarea' ||
                          role === 'button' || role === 'link' || role === 'tab' || role === 'menuitem' ||
                          el.getAttribute('onclick') !== null;

        elements.push({
            tag: tag,
            id: el.id || '',
            class: (el.className || '').toString().split(' ').slice(0, 3).join(' ').trim(),
            name: el.name || '',
            type: el.type || '',
            placeholder: el.getAttribute('placeholder') || '',
            aria_label: el.getAttribute('aria-label') || '',
            data_testid: testid,
            title: title,
            role: role,
            text: text,
            selector: selector,
            clickable: clickable,
            in_popup: isInsidePopup(el),
            parent_selector: scope.selector,
            parent_text: scope.text,
        });
    }

    // 1. 标准交互标签
    ['input', 'button', 'a', 'select', 'textarea'].forEach(tag => {
        document.querySelectorAll(tag).forEach(processElement);
    });

    // 2. 带有可交互属性的元素（卡片、图标按钮、自定义组件等）
    document.querySelectorAll('[role]:not([role="presentation"]):not([role="none"]), [onclick], [tabindex]:not([tabindex="-1"]), [title]').forEach(processElement);

    // 3. 文本元素（用于 text 定位器参考）
    document.querySelectorAll('h1, h2, h3, h4, h5, h6, label, li, dt, dd').forEach(processElement);

    // 4. 有可见文本的 span（如 <span class="show-name">控制台</span>）
    document.querySelectorAll('span').forEach(el => {
        const text = (el.textContent || '').trim();
        if (text.length > 0 && text.length < 50 && el.offsetParent !== null) {
            processElement(el);
        }
    });

    // 按优先级排序：data-testid > 可交互 > 有 id > 有 name/aria-label/title > 有 role > 有 text
    elements.sort((a, b) => {
        const scoreA = (a.data_testid ? 6 : 0) + (a.clickable ? 5 : 0) + (a.id ? 3 : 0) + (a.name ? 2 : 0) + (a.aria_label ? 2 : 0) + (a.title ? 2 : 0) + (a.role ? 1 : 0) + (a.text ? 1 : 0);
        const scoreB = (b.data_testid ? 6 : 0) + (b.clickable ? 5 : 0) + (b.id ? 3 : 0) + (b.name ? 2 : 0) + (b.aria_label ? 2 : 0) + (b.title ? 2 : 0) + (b.role ? 1 : 0) + (b.text ? 1 : 0);
        return scoreB - scoreA;
    });

    return elements.slice(0, 100);
}
`;

// Node playwright 的字符串 evaluate 一律按表达式处理（isFunction=false），
// 与 Python 客户端行为不同（Python 不发 isFunction 标志，服务端 eval 后
// 若结果为函数则自动调用）。这里在模块加载时把函数源码解析为真函数，
// 保证 evaluate 走 isFunction=true 路径；new Function 创建的函数
// toString() 保留原始源文本，序列化行为与直接传函数一致。
export const EXTRACT_ELEMENTS_JS: () => unknown[] = new Function(
  `return (${EXTRACT_ELEMENTS_JS_SRC});`,
)();

/**
 * Python playwright 兼容的 evaluate 参数转换：
 * Python 客户端对字符串脚本会自动检测函数形式并调用（服务端 isFunction=undefined），
 * Node 客户端字符串一律按表达式求值。此处在 Node 侧把函数形式的字符串
 * 解析为真函数以复现 Python 行为；非函数形式原样返回（表达式模式）。
 */
export function toPageFunction(script: string): unknown {
  const s = script.trim();
  // 函数形式：function 声明/表达式、箭头函数（含 async 变体）
  if (
    /^(async\s+)?function[\s(]/.test(s) ||
    /^(async\s+)?(\((?:[^()]|\([^()]*\))*\)|[A-Za-z_$][\w$]*)\s*=>/.test(s)
  ) {
    try {
      return new Function(`return (${s});`)();
    } catch {
      return script;
    }
  }
  return script;
}

// ============================================================
// fetch_page_structure / format_elements_for_prompt
// ============================================================

export interface PageElement {
  tag: string;
  id: string;
  class: string;
  name: string;
  type: string;
  placeholder: string;
  aria_label: string;
  data_testid: string;
  title: string;
  role: string;
  text: string;
  selector: string;
}

export interface PageStructure {
  title: string;
  url: string;
  elements: PageElement[];
  status_code: number;
}

function cleanElement(el: Record<string, unknown>): PageElement | null {
  const cleaned: PageElement = {
    tag: (el["tag"] as string) ?? "",
    id: (el["id"] as string) ?? "",
    class: (el["class"] as string) ?? "",
    name: (el["name"] as string) ?? "",
    type: (el["type"] as string) ?? "",
    placeholder: (el["placeholder"] as string) ?? "",
    aria_label: (el["aria_label"] as string) ?? "",
    data_testid: (el["data_testid"] as string) ?? "",
    title: (el["title"] as string) ?? "",
    role: (el["role"] as string) ?? "",
    text: (el["text"] as string) ?? "",
    selector: (el["selector"] as string) ?? "",
  };
  const hasAny =
    cleaned.id || cleaned.name || cleaned.class || cleaned.aria_label || cleaned.selector ||
    cleaned.text || cleaned.data_testid || cleaned.title || cleaned.role;
  return hasAny ? cleaned : null;
}

/** 抓取目标页面的简化 DOM 结构；失败时返回 None（1:1 fetch_page_structure） */
export async function fetchPageStructure(url: string, timeout = 15): Promise<PageStructure | null> {
  if (!url || !(url.startsWith("http://") || url.startsWith("https://"))) {
    logWarn(`[page_fetcher] 无效的 URL: ${url}`);
    return null;
  }

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-web-security",
        "--disable-features=IsolateOrigins,site-per-process",
        "--lang=zh-CN",
      ],
    });
    context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      locale: "zh-CN",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    page = await context.newPage();
    page.setDefaultTimeout(timeout * 1000);

    logInfo(`[page_fetcher] 开始抓取页面: ${url}`);
    const startTime = Date.now();

    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeout * 1000 });
    try {
      await page.waitForLoadState("networkidle", { timeout: 5000 });
    } catch {
      /* pass */
    }
    await sleep(1);

    let rawElements = (await page.evaluate(EXTRACT_ELEMENTS_JS)) as Record<string, unknown>[];
    rawElements = preferPopupElements(rawElements);
    const title = await page.title();
    const currentUrl = page.url();

    const elapsed = Math.round(((Date.now() - startTime) / 1000) * 100) / 100;
    logInfo(
      `[page_fetcher] 抓取完成: ${currentUrl}, title=${title}, elements=${rawElements.length}, elapsed=${elapsed}s`,
    );

    const elements: PageElement[] = [];
    for (const el of rawElements) {
      const cleaned = cleanElement(el);
      if (cleaned) elements.push(cleaned);
    }

    return {
      title,
      url: currentUrl,
      elements: elements.slice(0, MAX_ELEMENTS),
      status_code: response ? response.status() : 0,
    };
  } catch (e) {
    logWarn(`[page_fetcher] 抓取页面失败: ${url}, error=${e instanceof Error ? e.message : e}`);
    return null;
  } finally {
    for (const obj of [page, context, browser]) {
      try {
        await obj?.close();
      } catch {
        /* pass */
      }
    }
  }
}

/** 将元素列表格式化为适合 Prompt 的文本（1:1 format_elements_for_prompt） */
export function formatElementsForPrompt(elements: unknown): string {
  if (!Array.isArray(elements) || elements.length === 0) return "";
  const lines: string[] = [];
  for (const item of elements) {
    if (typeof item !== "object" || item === null) continue;
    const el = item as Record<string, unknown>;
    const tag = (el["tag"] as string) || "?";
    const parts = [`<${tag}>`];
    for (const key of [
      "id", "class", "name", "type", "placeholder", "aria_label", "data_testid", "title", "role", "text", "selector",
    ]) {
      const v = el[key];
      if (v) parts.push(`${key}=${v}`);
    }
    lines.push(parts.join(" "));
  }
  return lines.join("\n");
}

export function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

// ============================================================
// capture_accessibility_snapshot
// ============================================================

export const MAX_ARIA_SNAPSHOT_CHARS = 14000;

/** 抓取页面无障碍树快照，失败则降级为 DOM 元素列表。返回 [text, "aria"|"dom"] */
export async function captureAccessibilitySnapshot(page: Page): Promise<[string, string]> {
  try {
    const snap = await page.locator("body").ariaSnapshot();
    if (snap && snap.trim()) {
      let text = snap.trim();
      if (text.length > MAX_ARIA_SNAPSHOT_CHARS) {
        text = text.slice(0, MAX_ARIA_SNAPSHOT_CHARS) + "\n... (truncated)";
      }
      return [text, "aria"];
    }
  } catch (e) {
    logDebug(`[page_fetcher] aria_snapshot 不可用，降级 DOM: ${e instanceof Error ? e.message : e}`);
  }

  try {
    const rawElements = (await page.evaluate(EXTRACT_ELEMENTS_JS)) as Record<string, unknown>[];
    const elements: PageElement[] = [];
    for (const el of rawElements) {
      const cleaned = cleanElement(el);
      // 注意：此处 Python 原文为 if any([...])（与 _extract_current_snapshot 的 not any 相反）
      if (cleaned) elements.push(cleaned);
    }
    const domText = formatElementsForPrompt(elements.slice(0, MAX_ELEMENTS));
    if (domText) return [domText, "dom"];
  } catch (e) {
    logWarn(`[page_fetcher] DOM 降级抓取失败: ${e instanceof Error ? e.message : e}`);
  }

  return ["(empty snapshot)", "dom"];
}

// ============================================================
// SmartPageExplorer：有状态多轮生成
// ============================================================

export interface AgentStep {
  method: string;
  params: Record<string, unknown>;
  desc?: string;
  keyword?: string;
  [key: string]: unknown;
}

export interface ExploreResult {
  steps: AgentStep[];
  rounds: number;
  page_changes: number;
  urls_visited: string[];
  errors: string[];
  screenshots: Array<{ url: string; round: number; step: number; reason: string }>;
}

const BROWSER_LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-web-security",
  "--disable-features=IsolateOrigins,site-per-process",
  "--lang=zh-CN",
  // 可选 CDP 调试端口（SMARTBROWSER_CDP_PORT>0 时开启，供自动化/调试连接操作浏览器）
  ...(Number(process.env.SMARTBROWSER_CDP_PORT) > 0 ? [`--remote-debugging-port=${process.env.SMARTBROWSER_CDP_PORT}`] : []),
];

/** 默认截图目录：node-backend/static/screenshots/explore（从包位置向上 3 级到 node-backend 项目根） */
function defaultScreenshotsDir(): string {
  if (process.env.SMARTBROWSER_SCREENSHOTS_DIR) {
    return path.resolve(process.env.SMARTBROWSER_SCREENSHOTS_DIR);
  }
  const here = path.dirname(fileURLToPath(import.meta.url)); // node-backend/packages/smartbrowser/src
  return path.resolve(here, "..", "..", "..", "static", "screenshots", "explore");
}

export class SmartPageExplorer {
  start_url: string;
  description: string;
  max_rounds: number;
  timeout: number;

  playwright: null = null;
  browser: Browser | null = null;
  context: BrowserContext | null = null;
  page: Page | null = null;

  /** 浏览器无头模式（调试工作台可配置；默认 true 保持既有行为） */
  headless: boolean = true;

  all_steps: AgentStep[] = [];
  errors: string[] = [];
  urls_visited: string[] = [];
  page_changes = 0;
  screenshots: Array<{ url: string; path: string; round: number; step: number; reason: string }> = [];

  screenshots_dir: string;

  constructor(
    start_url: string,
    description: string,
    max_rounds = 3,
    timeout = 15,
    screenshots_dir?: string,
  ) {
    this.start_url = start_url;
    this.description = description;
    this.max_rounds = max_rounds;
    this.timeout = timeout;
    this.screenshots_dir = screenshots_dir || defaultScreenshotsDir();
    // os.makedirs(exist_ok=True)
    try {
      mkdirSync(this.screenshots_dir, { recursive: true });
    } catch {
      /* pass */
    }
  }

  /** 执行多轮探索（1:1 explore） */
  async explore(
    llmGenerateFunc: (args: {
      dom_text: string;
      description: string;
      executed_steps: AgentStep[];
      current_url: string;
      round_index: number;
    }) => Promise<AgentStep[]>,
  ): Promise<ExploreResult> {
    await this._initBrowser();
    let round_idx = 0;
    try {
      await this.page!.goto(this.start_url, { waitUntil: "domcontentloaded", timeout: this.timeout * 1000 });
      try {
        await this.page!.waitForLoadState("networkidle", { timeout: 5000 });
      } catch {
        /* pass */
      }
      await sleep(1);

      for (round_idx = 1; round_idx <= this.max_rounds; round_idx++) {
        logInfo(`[SmartPageExplorer] 开始第 ${round_idx}/${this.max_rounds} 轮探索`);

        const snapshot = await this._extractCurrentSnapshot();
        this.urls_visited.push(snapshot.url);
        await this._takeScreenshot(
          round_idx,
          0,
          `第 ${round_idx} 轮开始，页面: ${snapshot.url}`,
        );

        const dom_text = formatElementsForPrompt(snapshot.elements);
        const steps = await llmGenerateFunc({
          dom_text,
          description: this.description,
          executed_steps: [...this.all_steps],
          current_url: snapshot.url,
          round_index: round_idx,
        });

        if (!steps || steps.length === 0) {
          logInfo(`[SmartPageExplorer] 第 ${round_idx} 轮 AI 返回空步骤，探索完成`);
          break;
        }

        let page_changed_in_round = false;
        let step_executed_count = 0;
        for (const step of steps) {
          const [success, error] = await this._executeStep(step);
          step_executed_count += 1;
          if (!success) {
            this.errors.push(`第 ${round_idx} 轮第 ${step_executed_count} 步执行失败: ${error}`);
            logWarn(`[SmartPageExplorer] 步骤执行失败: ${error}`);
            const screenshot_url = await this._takeScreenshot(
              round_idx,
              step_executed_count,
              `执行失败: ${step.method} - ${(error || "").slice(0, 100)}`,
            );
            if (screenshot_url) this.errors.push(`截图已保存: ${screenshot_url}`);
            this.all_steps.push(...steps);
            logInfo(`[SmartPageExplorer] 保留该轮全部 ${steps.length} 个步骤（含未执行部分），终止探索`);
            return this._buildResult(round_idx);
          }

          const [changed, reason] = await this._isPageChanged(snapshot);
          if (changed) {
            this.page_changes += 1;
            page_changed_in_round = true;
            logInfo(`[SmartPageExplorer] 页面变化 detected: ${reason}`);
            await this._takeScreenshot(
              round_idx,
              steps.indexOf(step) + 1,
              `页面变化: ${reason}`,
            );
            const executed_count = steps.indexOf(step) + 1;
            this.all_steps.push(...steps.slice(0, executed_count));
            if (executed_count < steps.length) {
              logInfo(`[SmartPageExplorer] 已执行 ${executed_count} 步，剩余 ${steps.length - executed_count} 步将在下一轮重新生成`);
            }
            break;
          }
        }

        if (!page_changed_in_round) {
          this.all_steps.push(...steps);
        }

        if (!page_changed_in_round) {
          logInfo(`[SmartPageExplorer] 第 ${round_idx} 轮无页面变化，探索完成`);
          break;
        }

        await this._waitForDomStable(10);
      }

      return this._buildResult(Math.min(round_idx, this.max_rounds));
    } catch (e) {
      logWarn(`[SmartPageExplorer] 探索异常: ${e instanceof Error ? `${e.message}\n${e.stack}` : e}`);
      this.errors.push(`探索异常: ${e instanceof Error ? e.message : String(e)}`);
      return this._buildResult(0);
    } finally {
      await this._close();
    }
  }

  async _waitForDomStable(maxWait = 10): Promise<void> {
    /** 连续 2 次元素数变化<10% + 最少 3 秒 + 额外 2 秒（1:1 _wait_for_dom_stable） */
    let prev_count = -1;
    let stable_count = 0;
    const min_wait_seconds = 3;
    for (let i = 0; i < maxWait; i++) {
      let current_count = 0;
      try {
        const raw_elements = (await this.page!.evaluate(EXTRACT_ELEMENTS_JS)) as unknown[];
        current_count = raw_elements.length;
      } catch {
        current_count = 0;
      }

      if (prev_count >= 0) {
        const change_ratio = Math.abs(current_count - prev_count) / Math.max(prev_count, 1);
        if (change_ratio < 0.1) {
          stable_count += 1;
          if (stable_count >= 2 && i + 1 >= min_wait_seconds) {
            logInfo(`[SmartPageExplorer] DOM 已稳定，元素数: ${current_count}，共等待 ${i + 1} 秒`);
            await sleep(2);
            logInfo(`[SmartPageExplorer] 额外等待 2 秒完成，开始抓取`);
            return;
          }
        } else {
          stable_count = 0;
        }
      }

      prev_count = current_count;
      await sleep(1);
    }
    logInfo(`[SmartPageExplorer] DOM 等待超时（${maxWait}秒），当前元素数: ${prev_count}`);
  }

  async _initBrowser(): Promise<void> {
    this.browser = await chromium.launch({ headless: this.headless, args: BROWSER_LAUNCH_ARGS });
    this.context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
      // 高清采样: inspect 会话可置 2；默认 1 保持既有行为
      deviceScaleFactor: (this as unknown as { device_scale_factor?: number }).device_scale_factor ?? 1,
      locale: "zh-CN",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(this.timeout * 1000);
  }

  async _extractCurrentSnapshot(): Promise<{ title: string; url: string; elements: PageElement[] }> {
    let raw_elements = (await this.page!.evaluate(EXTRACT_ELEMENTS_JS)) as Record<string, unknown>[];
    const title = await this.page!.title();
    const current_url = this.page!.url();

    const popup_only = preferPopupElements(Array.isArray(raw_elements) ? raw_elements : []);
    if (popup_only !== raw_elements && popup_only.length) {
      logInfo(`[SmartPageExplorer] 快照优先弹窗内 ${popup_only.length} 个元素`);
      raw_elements = popup_only;
    }

    const elements: PageElement[] = [];
    for (const el of raw_elements) {
      const cleaned = cleanElement(el);
      if (cleaned) elements.push(cleaned);
    }
    return { title, url: current_url, elements: elements.slice(0, MAX_ELEMENTS) };
  }

  _coerceLocator(locator: unknown): string {
    return normalizeLocator(locator);
  }

  _resolveLocator(locator: unknown): Locator | null {
    const locator_str = this._coerceLocator(locator);
    if (!locator_str) return null;
    const loc = resolveLocatorOnPage(this.page!, locator_str);
    if (loc === null) return null;
    return loc.first();
  }

  /** 提取当前页可见可交互元素（1:1 extract_interactive_elements） */
  async extractInteractiveElements(): Promise<Record<string, unknown>[]> {
    if (!this.page) return [];
    try {
      const raw = (await this.page.evaluate(EXTRACT_ELEMENTS_JS)) as Record<string, unknown>[];
      if (!Array.isArray(raw)) return [];
      const filtered = preferPopupElements(raw);
      if (filtered !== raw) {
        logInfo(`[page_fetcher] 检测到弹窗层，优先使用弹窗内 ${filtered.length} 个元素`);
      }
      return filtered.slice(0, MAX_ELEMENTS);
    } catch (e) {
      logDebug(`[page_fetcher] extract_interactive_elements: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  /** 点击时优先匹配可点击控件（1:1 _resolve_click_locator） */
  async _resolveClickLocator(locator: unknown): Promise<Locator | null> {
    const locator_str = this._coerceLocator(locator);
    if (locator_str.includes(" >> ") || locator_str.includes("||")) {
      return this._resolveLocator(locator_str);
    }
    const is_text = locator_str.startsWith("get_by_text=");
    const is_role = locator_str.startsWith("get_by_role=");
    if (!(is_text || is_role)) return this._resolveLocator(locator_str);
    let selected_role: string | null = null;
    let text: string;
    if (is_text) {
      text = locator_str.slice("get_by_text=".length).trim().replace(/^['"]+|['"]+$/g, "");
    } else {
      const role_part = locator_str.slice("get_by_role=".length);
      const [roleRaw, nameRest] = splitFirstStr(role_part, ",");
      selected_role = roleRaw.trim().replace(/^['"]+|['"]+$/g, "");
      text = nameRest !== undefined ? nameRest.trim().replace(/^['"]+|['"]+$/g, "") : "";
    }
    if (!text) return this._resolveLocator(locator_str);
    // 仅对菜单/标签类 role 做可见收敛；其余保持原生解析
    const menu_roles = ["menuitem", "menuitemcheckbox", "tab", "button", "link"];
    if (is_role && !menu_roles.includes(selected_role!)) return this._resolveLocator(locator_str);

    const clickable_selector =
      "button:visible, [role='button']:visible, [role='menuitem']:visible, " +
      ".el-menu-item:visible, [role='menuitemcheckbox']:visible, [role='tab']:visible";
    const candidates: Locator[] = [];
    if (is_role && selected_role) {
      candidates.push(this.page!.getByRole(selected_role as never).filter({ hasText: text }));
    }
    candidates.push(
      this.page!.getByRole("menuitem").filter({ hasText: text }),
      this.page!.getByRole("tab").filter({ hasText: text }),
      this.page!.locator(clickable_selector).filter({ hasText: text }),
      this.page!.getByRole("button").filter({ hasText: text }),
      this.page!.getByRole("link").filter({ hasText: text }),
    );
    for (const loc of candidates) {
      try {
        const n = await loc.count();
        for (let i = 0; i < n; i++) {
          const item = loc.nth(i);
          try {
            if (await item.isVisible()) return item;
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }
    return this._resolveLocator(locator_str);
  }

  /** 从 locator 字符串提取可用于文本/title 匹配的片段（1:1 _extract_locator_text） */
  _extractLocatorText(locator: unknown): string | null {
    const text = extractLocatorText(locator);
    if (text) return text;

    const locator_str = this._coerceLocator(locator);
    if (!locator_str) return null;
    if (locator_str.startsWith("get_by_label=")) return locator_str.slice(13).trim();
    if (locator_str.startsWith("get_by_placeholder=")) return locator_str.slice(19).trim();
    for (const pattern of [/\[title="([^"]+)"\]/, /text="([^"]+)"/]) {
      const m = pattern.exec(locator_str);
      if (m) return m[1]!;
    }
    return null;
  }

  /** 等待元素可见；失败时 scroll、文本/title 可见匹配、JS 点击、降级 attached（1:1 _wait_for_element_with_fallback） */
  async _waitForElementWithFallback(locator: string, timeout_ms = 20000): Promise<void> {
    const loc = this._resolveLocator(locator)!;
    const chunk = Math.min(Math.max(Math.floor(timeout_ms / 3), 3000), 10000);

    try {
      await loc.waitFor({ timeout: chunk, state: "visible" });
      return;
    } catch (e1) {
      logDebug(`[wait_for_element] visible 等待失败: ${e1 instanceof Error ? e1.message : e1}`);
    }

    try {
      await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
      await loc.waitFor({ timeout: chunk, state: "visible" });
      logInfo(`[wait_for_element] scroll 后可见`);
      return;
    } catch {
      /* pass */
    }

    const text_content = this._extractLocatorText(locator);
    if (text_content) {
      try {
        await this.page!.getByText(text_content, { exact: false }).first().waitFor({
          timeout: chunk,
          state: "visible",
        });
        logInfo(`[wait_for_element] get_by_text 可见兜底: ${text_content.slice(0, 40)}`);
        return;
      } catch {
        /* pass */
      }
      try {
        await this.page!.locator(`[title="${text_content}"]`).first().waitFor({
          timeout: chunk,
          state: "visible",
        });
        logInfo(`[wait_for_element] title 可见兜底: ${text_content.slice(0, 40)}`);
        return;
      } catch {
        /* pass */
      }
      try {
        const result = await this.page!.evaluate((text: string) => {
          const isVis = (el: Element) => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return false;
            const s = getComputedStyle(el);
            if (s.display === "none" || s.visibility === "hidden") return false;
            return r.top < innerHeight && r.bottom > 0;
          };
          const nodes = Array.from(
            document.querySelectorAll<HTMLElement>(
              '[title], a, button, div, span, li, [role="button"], [role="link"]',
            ),
          );
          for (const el of nodes) {
            const t = (el.getAttribute("title") || el.textContent || "").trim();
            if (!t.includes(text)) continue;
            if (isVis(el)) {
              el.scrollIntoView({ block: "center" });
              el.click();
              return "click";
            }
          }
          return null;
        }, text_content);
        if (result) {
          await sleep(0.5);
          logInfo(`[wait_for_element] JS 点击可见元素兜底: ${text_content.slice(0, 40)}`);
          return;
        }
      } catch (e_js) {
        logDebug(`[wait_for_element] JS 兜底失败: ${e_js instanceof Error ? e_js.message : e_js}`);
      }
    }

    try {
      await loc.waitFor({ timeout: chunk, state: "attached" });
      logInfo(`[wait_for_element] 降级为 attached（元素已在 DOM）`);
      return;
    } catch (e_final) {
      throw e_final;
    }
  }

  /** 在当前 page 上执行单个步骤，返回 [是否成功, 错误信息]（1:1 _execute_step） */
  async _executeStep(step: AgentStep): Promise<[boolean, string | null]> {
    const method = step.method ?? "";
    let params: Record<string, unknown> = step.params ?? {};
    if (params.locator !== null && typeof params.locator === "object") {
      params = { ...params, locator: this._coerceLocator(params.locator) };
    }

    try {
      if (method === "fill_value") {
        const locator = (params.locator as string) ?? "";
        const value = String(params.value ?? "");
        if (locator) {
          try {
            await this._resolveLocator(locator)!.fill(value);
          } catch (e1) {
            logDebug(`[fill_value] 第一层 fill 失败: ${e1 instanceof Error ? e1.message : e1}`);
            // 兜底：locator 含 placeholder 时用 JS 搜索 placeholder 包含关键文本的 input
            const placeholder_match = /placeholder="([^"]+)"/.exec(locator);
            if (placeholder_match) {
              const placeholder_text = placeholder_match[1]!;
              const result = await this.page!.evaluate((args: string[]) => {
                const [phText, inputValue] = args;
                const inputs = Array.from(
                  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
                    "input, textarea",
                  ),
                );
                for (const input of inputs) {
                  if (input.offsetParent === null) continue;
                  const rect = input.getBoundingClientRect();
                  if (rect.width === 0 || rect.height === 0) continue;
                  // 部分匹配 placeholder
                  if (input.placeholder && input.placeholder.includes(phText)) {
                    input.value = inputValue;
                    input.dispatchEvent(new Event("input", { bubbles: true }));
                    input.dispatchEvent(new Event("change", { bubbles: true }));
                    return true;
                  }
                  // 如果是 password 类型且预期是密码输入，直接匹配 type
                  if (input.type === "password" && inputValue.length > 3) {
                    input.value = inputValue;
                    input.dispatchEvent(new Event("input", { bubbles: true }));
                    input.dispatchEvent(new Event("change", { bubbles: true }));
                    return true;
                  }
                }
                return false;
              }, [placeholder_text, value]);
              if (result) {
                logInfo(`[fill_value] JS 兜底成功: placeholder 包含 '${placeholder_text}'`);
              } else {
                throw e1;
              }
            } else {
              throw e1;
            }
          }
        }
      } else if (method === "click_ele") {
        await this._executeClickEle(params);
      } else if (method === "double_click_ele") {
        const locator = (params.locator as string) ?? "";
        if (locator) {
          try {
            await this._resolveLocator(locator)!.dblclick();
          } catch (e1) {
            logDebug(`[double_click_ele] 第一层失败: ${e1 instanceof Error ? e1.message : e1}`);
            try {
              await this._resolveLocator(locator)!.dblclick({ force: true });
            } catch (e2) {
              logDebug(`[double_click_ele] 第二层 force 失败: ${e2 instanceof Error ? e2.message : e2}`);
              await this._resolveLocator(locator)!.evaluate((el: Element) => {
                const ev = new MouseEvent("dblclick", { bubbles: true });
                el.dispatchEvent(ev);
              });
            }
          }
        }
      } else if (method === "hover") {
        const locator = (params.locator as string) ?? "";
        if (locator) {
          try {
            await this._resolveLocator(locator)!.hover();
          } catch (e1) {
            logDebug(`[hover] 第一层失败: ${e1 instanceof Error ? e1.message : e1}`);
            try {
              await this._resolveLocator(locator)!.hover({ force: true });
            } catch (e2) {
              logDebug(`[hover] 第二层 force 失败: ${e2 instanceof Error ? e2.message : e2}`);
              await this._resolveLocator(locator)!.evaluate((el: Element) => {
                const ev = new MouseEvent("mouseover", { bubbles: true });
                el.dispatchEvent(ev);
              });
            }
          }
        }
      } else if (method === "clear_value") {
        const locator = (params.locator as string) ?? "";
        if (locator) await this._resolveLocator(locator)!.fill("");
      } else if (method === "type_value") {
        const locator = (params.locator as string) ?? "";
        const value = String(params.value ?? "");
        if (locator) await this._resolveLocator(locator)!.type(value);
      } else if (method === "select_option") {
        const locator = (params.locator as string) ?? "";
        const value = params.value ?? "";
        if (locator) await this._resolveLocator(locator)!.selectOption(value as never);
      } else if (method === "open_url") {
        const url = (params.url as string) ?? "";
        if (url) await this.page!.goto(url, { waitUntil: "domcontentloaded", timeout: this.timeout * 1000 });
      } else if (method === "refresh") {
        await this.page!.reload({ waitUntil: "domcontentloaded", timeout: this.timeout * 1000 });
      } else if (method === "wait_for_time") {
        const ms = Number(params.timeout ?? 2000);
        await sleep(ms / 1000);
      } else if (method === "wait_for_element") {
        const locator = (params.locator as string) ?? "";
        const ms = Number(params.timeout ?? 20000);
        if (locator) await this._waitForElementWithFallback(locator, ms);
      } else if (method === "wait_for_load") {
        await this.page!.waitForLoadState("load", { timeout: this.timeout * 1000 });
      } else if (method === "scroll_to_height") {
        await this._executeScrollToHeight(params);
      } else if (method === "scroll_to_element") {
        const locator = (params.locator as string) ?? "";
        if (locator) {
          const loc = this.page!.locator(locator);
          await loc.first().scrollIntoViewIfNeeded({ timeout: Number(params.timeout ?? 20000) });
        }
      } else if (method === "click_by_text") {
        const text = (params.text as string) ?? "";
        const exact = coerceBool(params.exact ?? false);
        const index = Math.max(Number(params.index ?? 1) - 1, 0);
        if (text) {
          const loc = this.page!.getByText(text, { exact }).nth(index);
          await loc.click({ timeout: Number(params.timeout ?? 20000) });
        }
      } else if (method === "wait_for_element_hidden") {
        const locator = (params.locator as string) ?? "";
        const ms = Number(params.timeout ?? 20000);
        if (locator) {
          const loc = this.page!.locator(locator);
          await loc.first().waitFor({ state: "hidden", timeout: ms });
        }
      } else if (method === "wait_for_url_contains") {
        const fragment = (params.url as string) ?? "";
        const ms = Number(params.timeout ?? 20000);
        const use_regex = coerceBool(params.use_regex ?? false);
        if (fragment) {
          const pattern = use_regex ? new RegExp(fragment) : new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
          await this.page!.waitForURL(pattern, { timeout: ms });
        }
      } else if (method === "switch_to_latest_page") {
        const pages = this.context!.pages();
        if (pages.length) this.page = pages[pages.length - 1]!;
      } else if (method === "execute_script") {
        const script = (params.script as string) ?? "";
        if (script) await this.page!.evaluate(toPageFunction(script) as never);
      } else if (method === "press_key") {
        const key = (params.key as string) ?? "";
        if (key) await this.page!.keyboard.press(key);
      } else if (method === "go_back") {
        await this.page!.goBack({ waitUntil: "domcontentloaded", timeout: this.timeout * 1000 });
      } else {
        // 不支持的 method，跳过但不报错（如断言、提取等不需要执行）
        logDebug(`[SmartPageExplorer] 跳过不需要执行的 method: ${method}`);
        return [true, null];
      }

      return [true, null];
    } catch (e) {
      return [false, `${method} 执行失败: ${e instanceof Error ? e.message : String(e)}`];
    }
  }

  /** click_ele 主路径 + 多层兜底（1:1 page_fetcher.py 942-1049） */
  private async _executeClickEle(params: Record<string, unknown>): Promise<void> {
    const locator = (params.locator as string) ?? "";
    if (!locator) return;
    try {
      // 用 .first 避免 strict mode violation；get_by_text 优先收敛到 button
      await (await this._resolveClickLocator(locator))!.click();
    } catch (e1) {
      logDebug(`[click_ele] 第一层点击失败: ${e1 instanceof Error ? e1.message : e1}`);
      // 提取 has-text 中的文本，尝试 title 定位器兜底（兼容单/双引号两种写法）
      const has_text_match = /:has-text\((["'])([^"']+)\1\)/.exec(locator);
      let text_content: string | null = has_text_match ? has_text_match[2]! : null;
      if (!text_content) {
        const loc_norm = this._coerceLocator(locator);
        if (loc_norm.startsWith("get_by_text=")) {
          text_content = loc_norm.slice("get_by_text=".length).trim().replace(/^['"]+|['"]+$/g, "");
        } else if (loc_norm.startsWith("get_by_role=") && loc_norm.includes(",")) {
          // get_by_role=role, name 多元素匹配(strict)时，提取 name 作为可见文本兜底
          text_content = splitFirstStr(loc_norm, ",")[1]!.trim().replace(/^['"]+|['"]+$/g, "");
        }
      }
      let fallback_ok = false;
      if (text_content) {
        try {
          // 扩展为可点击控件（含菜单项 el-menu-item / role=menuitem）；加 :visible 过滤隐藏同名项
          const clickable = this.page!.locator(
            "button:visible, [role='button']:visible, [role='menuitem']:visible, " +
              ".el-menu-item:visible, [role='menuitemcheckbox']:visible, [role='tab']:visible",
          ).filter({ hasText: text_content });
          if ((await clickable.count()) > 0) {
            await clickable.first().click();
            logInfo(`[click_ele] clickable 兜底成功: ${text_content.slice(0, 40)}`);
            fallback_ok = true;
          }
        } catch {
          /* pass */
        }
      }
      if (text_content && !fallback_ok) {
        // 尝试 [title="xxx"]（仅可见项）
        try {
          await this.page!.locator(`[title="${text_content}"]:visible`).first().click();
          logInfo(`[click_ele] title 兜底成功: [title="${text_content}"]:visible`);
          fallback_ok = true;
        } catch {
          /* pass */
        }
        // 含 $ 时 :has-text 会解析失败，优先 get_by_text（逐项收敛到首个可见匹配，≤20）
        if (!fallback_ok && text_content) {
          try {
            const gb = this.page!.getByText(text_content, { exact: false });
            const gb_n = await gb.count();
            for (let gi = 0; gi < Math.min(gb_n, 20); gi++) {
              const gitem = gb.nth(gi);
              try {
                if (!(await gitem.isVisible())) continue;
                await gitem.click();
                logInfo(`[click_ele] get_by_text 兜底成功(第${gi}项,可见): ${text_content.slice(0, 40)}`);
                fallback_ok = true;
                break;
              } catch {
                continue;
              }
            }
          } catch {
            /* pass */
          }
        }
        // 尝试 tag:has-text("xxx")（文本不含 $ 或 \ 时）；div 排末位
        if (!fallback_ok && text_content && !text_content.includes("$") && !text_content.includes("\\")) {
          for (const tag of ["a", "span", "i", "div"]) {
            try {
              await this.page!.locator(`${tag}:has-text("${text_content}"):visible`).first().click();
              logInfo(`[click_ele] ${tag}:has-text 兜底成功: ${tag}:has-text("${text_content}"):visible`);
              fallback_ok = true;
              break;
            } catch {
              /* pass */
            }
          }
        }
        // JS 兜底：title 优先，再按文本长度升序点击
        if (!fallback_ok) {
          try {
            const result = await this.page!.evaluate((text: string) => {
              // 优先找 title 匹配
              let el = document.querySelector<HTMLElement>(
                '[title="' + text + '"], [title*="' + text + '"]',
              );
              if (el && el.offsetParent !== null) { el.click(); return "title"; }
              // 再找 button/a/div/span/i 中包含文本的
              const candidates = Array.from(
                document.querySelectorAll<HTMLElement>("button, a, div, span, i, svg, path"),
              ).filter((e) => e.offsetParent !== null && e.textContent.includes(text));
              candidates.sort((a, b) => a.textContent.trim().length - b.textContent.trim().length);
              if (candidates.length > 0) { candidates[0].click(); return "text"; }
              return null;
            }, text_content);
            if (result) {
              logInfo(`[click_ele] JS 兜底成功 (${result}): '${text_content}'`);
              fallback_ok = true;
            }
          } catch (e_js) {
            logDebug(`[click_ele] JS 兜底失败: ${e_js instanceof Error ? e_js.message : e_js}`);
          }
        }
        if (!fallback_ok) {
          const _loc = this._resolveLocator(locator);
          if (_loc === null) {
            throw new Error("页面上下文已失效（浏览器已关闭或对应页面不存在），无法定位元素");
          }
          try {
            await _loc.click({ force: true });
          } catch (e2) {
            logDebug(`[click_ele] force 点击失败: ${e2 instanceof Error ? e2.message : e2}`);
            await _loc.evaluate((el: HTMLElement) => el.click());
          }
        }
      }
    }
  }

  /** scroll_to_height（1:1 page_fetcher.py 1121-1145） */
  private async _executeScrollToHeight(params: Record<string, unknown>): Promise<void> {
    const mode = String(params.position || params.scroll_mode || "").trim().toLowerCase();
    const height = params.height ?? 0;
    if (mode === "top" || mode === "start") {
      await this.page!.evaluate(SCROLL_PAGE_FN, ["top", null]);
    } else if (mode === "bottom" || mode === "end") {
      await this.page!.evaluate(SCROLL_PAGE_FN, ["bottom", null]);
    } else if (mode === "middle" || mode === "center" || mode === "mid") {
      await this.page!.evaluate(SCROLL_PAGE_FN, ["middle", null]);
    } else if (mode === "down" || mode === "page_down") {
      const delta = coerceDelta(height);
      const info = (await this.page!.evaluate(SCROLL_PAGE_FN, ["down", delta])) as { moved: boolean };
      if (!(info ?? { moved: false }).moved) {
        const vp = this.page!.viewportSize() ?? { width: 1280, height: 720 };
        await this.page!.mouse.move(Math.floor(vp.width / 2), Math.floor(vp.height / 2));
        await this.page!.mouse.wheel(0, delta);
      }
    } else if (mode === "up" || mode === "page_up") {
      const delta = coerceDelta(height);
      const info = (await this.page!.evaluate(SCROLL_PAGE_FN, ["up", delta])) as { moved: boolean };
      if (!(info ?? { moved: false }).moved) {
        const vp = this.page!.viewportSize() ?? { width: 1280, height: 720 };
        await this.page!.mouse.move(Math.floor(vp.width / 2), Math.floor(vp.height / 2));
        await this.page!.mouse.wheel(0, -delta);
      }
    } else {
      await this.page!.evaluate(SCROLL_PAGE_FN, ["to", Number(height || 0)]);
    }
  }

  /** 检测页面是否发生显著变化（1:1 _is_page_changed） */
  async _isPageChanged(snapshot_before: { url: string; elements: unknown[] }): Promise<[boolean, string]> {
    const current_url = this.page!.url();
    if (current_url !== snapshot_before.url) {
      return [true, `url_changed: ${snapshot_before.url} -> ${current_url}`];
    }

    await sleep(0.5);
    const raw_elements = (await this.page!.evaluate(EXTRACT_ELEMENTS_JS)) as unknown[];
    const current_count = raw_elements.length;
    const before_count = snapshot_before.elements.length;

    const ratio = before_count === 0 ? current_count : current_count / before_count;
    if (ratio > 1.5 || ratio < 0.5) {
      return [true, `dom_ratio_changed: ${before_count} -> ${current_count} (ratio=${ratio.toFixed(2)})`];
    }

    if (before_count > 0 && current_count > 0) {
      const before = snapshot_before.elements.slice(0, 5) as Record<string, unknown>[];
      const before_ids = new Set(before.map((e) => (e["id"] as string) ?? ""));
      const current_ids = new Set((raw_elements.slice(0, 5) as Record<string, unknown>[]).map((e) => (e["id"] as string) ?? ""));
      const hasIntersection = [...before_ids].some((id) => current_ids.has(id));
      if (before_ids.size && current_ids.size && !hasIntersection) {
        return [true, "dom_structure_changed"];
      }
    }

    return [false, "no_change"];
  }

  /** 截取当前页面截图，返回 /static/... URL（1:1 _take_screenshot） */
  async _takeScreenshot(round_index: number, step_index: number, reason: string): Promise<string | null> {
    if (!this.page) return null;
    try {
      await this._waitForDomStable();
      const filename = `explore_${formatTimestamp()}_r${round_index}_s${step_index}.png`;
      const filepath = path.join(this.screenshots_dir, filename);
      await this.page.screenshot({ path: filepath, fullPage: false });
      const url_path = `/static/screenshots/explore/${filename}`;
      this.screenshots.push({ url: url_path, path: filepath, round: round_index, step: step_index, reason });
      logInfo(`[SmartPageExplorer] 截图已保存: ${url_path}`);
      return url_path;
    } catch (e) {
      logWarn(`[SmartPageExplorer] 截图失败: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  _buildResult(rounds: number): ExploreResult {
    const unique_urls: string[] = [];
    for (const url of this.urls_visited) {
      if (!unique_urls.includes(url)) unique_urls.push(url);
    }
    return {
      steps: this.all_steps,
      rounds,
      page_changes: this.page_changes,
      urls_visited: unique_urls,
      errors: this.errors,
      screenshots: this.screenshots.map((s) => ({ url: s.url, round: s.round, step: s.step, reason: s.reason })),
    };
  }

  async _close(): Promise<void> {
    for (const obj of [this.page, this.context, this.browser]) {
      try {
        await obj?.close();
      } catch {
        /* pass */
      }
    }
    this.page = null;
    this.context = null;
    this.browser = null;
  }
}

// ============================================================
// 辅助
// ============================================================

/** Python s.split(sep, 1) 语义 */
export function splitFirstStr(s: string, sep: string): [string, string | undefined] {
  const idx = s.indexOf(sep);
  if (idx < 0) return [s, undefined];
  return [s.slice(0, idx), s.slice(idx + sep.length)];
}

function coerceDelta(height: unknown): number {
  // Python: abs(int(height)) if height not in (None, "") else 600；int 失败会抛错
  if (height === null || height === undefined || height === "") return 600;
  const n = Number.parseInt(String(height), 10);
  if (Number.isNaN(n)) {
    throw new Error(`invalid literal for int() with base 10: '${height}'`);
  }
  return Math.abs(n);
}
