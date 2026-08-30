/**
 * 定位器解析工具（runner 侧，与后端 resolve_locator_on_page 语义保持一致）。
 * 1:1 对照 brick_runner_http/runner/locator_utils.py。
 */
import type { Frame, Locator, Page } from "playwright";

type Scope = Page | Locator | Frame;

const NATIVE_PREFIXES = [
  "get_by_role=",
  "get_by_text=",
  "get_by_label=",
  "get_by_placeholder=",
  "get_by_alt_text=",
  "get_by_title=",
];

const NTH_SEGMENT_RE = /^nth\s*=\s*(\d+)$/i;

/** 去掉包裹引号，如 '"请输入账号"' → '请输入账号'。 */
export function stripWrappingQuotes(value: string): string {
  const s = (value ?? "").trim();
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    return s.slice(1, -1).trim();
  }
  return s;
}

/** 解析单个定位片段（根 scope 或链式子 scope）。 */
function resolveRootLocator(scope: Scope, sel: string): Locator {
  const anyScope = scope as any;
  if (sel.startsWith("get_by_role=")) {
    const rolePart = sel.slice("get_by_role=".length);
    const idx = rolePart.indexOf(",");
    if (idx >= 0) {
      return anyScope.getByRole(
        rolePart.slice(0, idx).trim(),
        { name: stripWrappingQuotes(rolePart.slice(idx + 1)) },
      );
    }
    return anyScope.getByRole(rolePart.trim());
  }
  const prefix = (p: string): string => stripWrappingQuotes(sel.slice(p.length));
  if (sel.startsWith("get_by_text=")) return anyScope.getByText(prefix("get_by_text="));
  if (sel.startsWith("get_by_label=")) return anyScope.getByLabel(prefix("get_by_label="));
  if (sel.startsWith("get_by_placeholder=")) {
    return anyScope.getByPlaceholder(prefix("get_by_placeholder="));
  }
  if (sel.startsWith("get_by_alt_text=")) return anyScope.getByAltText(prefix("get_by_alt_text="));
  if (sel.startsWith("get_by_title=")) return anyScope.getByTitle(prefix("get_by_title="));
  // 兼容历史写法
  if (sel.startsWith("css=")) return anyScope.locator(sel.slice(4));
  if (sel.startsWith("xpath=")) return anyScope.locator("xpath=" + sel.slice("xpath=".length));
  if (sel.startsWith("//") || sel.startsWith(".//") || sel.startsWith("(//") || sel.startsWith("(/")) {
    return anyScope.locator(`xpath=${sel}`);
  }
  if (sel.startsWith("text=")) return anyScope.locator(sel);
  if (sel.startsWith("role=")) {
    return anyScope.getByRole(stripWrappingQuotes(sel.slice("role=".length)));
  }
  if (sel.startsWith("label=")) {
    return anyScope.getByLabel(stripWrappingQuotes(sel.slice("label=".length)));
  }
  if (sel.startsWith("placeholder=")) {
    return anyScope.getByPlaceholder(stripWrappingQuotes(sel.slice("placeholder=".length)));
  }
  if (sel.startsWith("testid=")) {
    return anyScope.getByTestId(stripWrappingQuotes(sel.slice("testid=".length)));
  }
  return anyScope.locator(sel);
}

/** 递归解析定位字符串，支持 >> 链式与 nth 链尾。 */
function resolveLocatorOnScope(scope: Scope, locatorStr: string): Locator {
  const s = (locatorStr ?? "").trim();
  if (s.includes(" >> ")) {
    const idx = s.indexOf(" >> ");
    const parentSel = s.slice(0, idx).trim();
    const childSel = s.slice(idx + 4).trim();
    if (parentSel && childSel) {
      const parent = resolveLocatorOnScope(scope, parentSel);
      return resolveLocatorOnScope(parent, childSel);
    }
  }
  const nthM = NTH_SEGMENT_RE.exec(s);
  if (nthM) {
    const anyScope = scope as any;
    if (typeof anyScope.nth === "function") {
      return anyScope.nth(parseInt(nthM[1]!, 10)) as Locator;
    }
    throw new Error(`定位链无效：根节点上不能单独使用 ${s}`);
  }
  return resolveRootLocator(scope, s);
}

/**
 * 解析定位器字符串，返回 Playwright Locator 对象。
 * 参数 index > 1 时对结果取 nth(index-1)；空定位器回退 body。
 */
export function resolve(page: Page | Frame | Locator, locatorStr: string, index = 1): Locator {
  const s = (locatorStr ?? "").trim();
  if (!s) return (page as Page).locator("body");
  let loc = resolveLocatorOnScope(page as Scope, s);
  if (index > 1) loc = loc.nth(index - 1);
  return loc;
}

// NATIVE_PREFIXES 供类型/文档对齐（Python 版用于分支判断，此处由前缀判断替代）
export { NATIVE_PREFIXES };
