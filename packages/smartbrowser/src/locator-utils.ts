/**
 * 定位器字符串规范化与解析。
 * 1:1 对照 smartbrowser/src/smartbrowser/locator_utils.py。
 */
import type { Locator as PwLocator, Page as PwPage, FrameLocator as PwFrameLocator } from "playwright";

// ============================================================
// 正则（对齐 Python re 定义）
// ============================================================

const HAS_TEXT_INNER_RE = /:has-text\("((?:[^"\\]|\\.)*)"\)/;

function makeNamePrefixRe(): RegExp {
  return /^name\s*=\s*([\s\S]+)$/i;
}
function makeTitlePrefixRe(): RegExp {
  return /^title\s*=\s*([\s\S]+)$/i;
}
const FUNC_GET_BY_RE = /^get_by_(text|label|placeholder|title|alt_text)\s*\(\s*['"](.+?)['"]\s*\)$/i;
const FUNC_GET_BY_ROLE_RE = /^get_by_role\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*name\s*=\s*['"](.+?)['"]\s*)?\)$/i;
const ROLE_SHORTHAND_RE = /^(row|cell|columnheader|gridcell|button|link|menuitem|tab|textbox)=(.+)$/i;
const NTH_SEGMENT_RE = /^nth\s*=\s*(\d+)$/i;
const GET_BY_PLACEHOLDER_FUNC_RE = /^get_by_placeholder\s*\(\s*['"](.+?)['"]\s*\)$/;
const GET_BY_TEXT_FUNC_RE = /^get_by_text\s*\(\s*['"](.+?)['"]\s*\)$/;
const GET_BY_LABEL_FUNC_RE = /^get_by_label\s*\(\s*['"](.+?)['"]\s*\)$/;
const GET_BY_TITLE_FUNC_RE = /^get_by_title\s*\(\s*['"](.+?)['"]\s*\)$/;
const GET_BY_ROLE_FUNC_RE = /^get_by_role\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*name\s*=\s*['"](.+?)['"]\s*)?\)$/;

/** get_by_role + title= 时尽量保留元素类型，降低仅 get_by_title 的误点面 */
const ROLE_TITLE_TAG: Record<string, string> = {
  button: "button",
  link: "a",
  img: "img",
  checkbox: "input",
  radio: "input",
  textbox: "input",
  option: "option",
  tab: "[role=tab]",
};

const NATIVE_PREFIXES = [
  "get_by_role=",
  "get_by_text=",
  "get_by_label=",
  "get_by_placeholder=",
  "get_by_alt_text=",
  "get_by_title=",
];

// ============================================================
// 工具函数
// ============================================================

/**
 * Python s.split(sep, 1) 语义：返回 [头, 余部]；无分隔符时余部为 undefined。
 * （JS 原生 split(sep, 1) 会丢弃余部，与 Python 不同，禁止直接使用）
 */
function splitFirst(s: string, sep: string): [string, string | undefined] {
  const idx = s.indexOf(sep);
  if (idx < 0) return [s, undefined];
  return [s.slice(0, idx), s.slice(idx + sep.length)];
}

/** 绝对 XPath（/html/...）必须加 xpath= 前缀（对齐 ensure_xpath_engine_prefix） */
export function ensureXpathEnginePrefix(locator: string): string {
  const s = (locator || "").trim();
  if (!s) return s;
  const head = s.split("=", 1)[0]!.trim().toLowerCase();
  if (
    ["xpath", "css", "id", "text", "internal:control", "internal:has-text", "internal:attr"].includes(
      head,
    )
  ) {
    return s;
  }
  if (s.startsWith("//") || s.startsWith(".//") || s.startsWith("(//") || s.startsWith("(/")) {
    return s;
  }
  if (s.startsWith("/") && !s.startsWith("//")) {
    return `xpath=${s}`;
  }
  return s;
}

/** Playwright 将 :has-text() 走 CSS 解析时，$ 等字符会触发 BADSTRING */
export function textUnsafeForCssHasText(text: string): boolean {
  return /[$\\]/.test(text || "");
}

/** 去掉 LLM 偶发写入的包裹引号，如 'row' / "0302" */
function stripWrappingQuotes(value: string): string {
  const s = (value || "").trim();
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    return s.slice(1, -1).trim();
  }
  return s;
}

/** 去掉 get_by_role 名称段的 name= 前缀，如 name="登入" → 登入（对齐 _strip_role_name_part） */
export function stripRoleNamePart(value: string): string {
  const s = stripWrappingQuotes(value);
  const m = makeNamePrefixRe().exec(s);
  if (m) return stripWrappingQuotes(m[1]!.trim());
  return s;
}

/** LLM/Act 偶发 get_by_text("x") → get_by_text=x（含链式片段） */
function coerceFunctionLocatorSegment(segment: string): string {
  const s = (segment || "").trim();
  const m = FUNC_GET_BY_RE.exec(s);
  if (m) {
    const kind = m[1]!.toLowerCase();
    return `get_by_${kind}=${m[2]}`;
  }
  const m2 = FUNC_GET_BY_ROLE_RE.exec(s);
  if (m2) {
    const role = m2[1]!;
    const name = m2[2];
    return name ? `get_by_role=${role}, ${name}` : `get_by_role=${role}`;
  }
  return s;
}

/** 规范化 get_by_role=role, name 片段（含链式子段） */
function normalizeGetByRoleSegment(segment: string): string {
  if (!segment.startsWith("get_by_role=")) return segment;
  const rolePart = segment.slice("get_by_role=".length);
  const [roleRaw, nameRest] = splitFirst(rolePart, ",");
  const role = stripWrappingQuotes(roleRaw);
  if (nameRest !== undefined) {
    const rawName = nameRest.trim();
    // LLM: get_by_role=button, title="配置" → 优先保留元素类型的 title 属性选择器
    // （title 不是 accessible name，不能当 get_by_role 的 name）
    const tm = makeTitlePrefixRe().exec(rawName);
    if (tm) {
      const titleVal = stripWrappingQuotes(tm[1]!.trim());
      const tag = ROLE_TITLE_TAG[role.toLowerCase()];
      if (tag && titleVal) {
        const safe = titleVal.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        return `${tag}[title="${safe}"]`;
      }
      return `get_by_title=${titleVal}`;
    }
    const name = stripRoleNamePart(rawName);
    return `get_by_role=${role}, ${name}`;
  }
  return `get_by_role=${role}`;
}

/** 规范化单段原生定位写法（去引号等） */
function normalizeNativeValueSegment(segment: string): string {
  const coerced = coerceFunctionLocatorSegment(segment);
  for (const prefix of [
    "get_by_text=",
    "get_by_label=",
    "get_by_placeholder=",
    "get_by_alt_text=",
    "get_by_title=",
  ]) {
    if (coerced.startsWith(prefix)) {
      return prefix + stripWrappingQuotes(coerced.slice(prefix.length));
    }
  }
  if (coerced.startsWith("get_by_role=")) {
    return normalizeGetByRoleSegment(coerced);
  }
  return coerced;
}

/** LLM 偶发 row=名称 / cell=4 写法 → get_by_role=row, 名称 */
function coerceRoleShorthandSegment(segment: string): string {
  const s = (segment || "").trim();
  const m = ROLE_SHORTHAND_RE.exec(s);
  if (m) {
    const role = m[1]!.toLowerCase();
    const name = stripWrappingQuotes(m[2]!.trim());
    return `get_by_role=${role}, ${name}`;
  }
  return s;
}

function normalizeChainSegment(segment: string): string {
  const seg = coerceRoleShorthandSegment(segment.trim());
  return ensureXpathEnginePrefix(normalizeNativeValueSegment(seg));
}

/** 规范化链式定位器中的原生写法片段 */
function normalizeNativeLocatorSegments(locator: string): string {
  if (locator.includes(" >> ")) {
    return locator
      .split(" >> ")
      .map((part) => normalizeChainSegment(part.trim()))
      .join(" >> ");
  }
  return normalizeChainSegment(locator);
}

/** 将含 $ 等字符的 tag:has-text("...") 转为 tag >> get_by_text=... 或 get_by_text=... */
export function coerceUnsafeHasTextLocator(locator: string): string {
  const s = (locator || "").trim();
  if (!s || !s.includes(":has-text(")) return s;
  const m = HAS_TEXT_INNER_RE.exec(s);
  if (!m) return s;
  const text = m[1]!.replace(/\\"/g, '"');
  if (!textUnsafeForCssHasText(text)) return s;
  const before = s.slice(0, m.index ?? 0).trimEnd();
  if (before) return `${before} >> get_by_text=${text}`;
  return `get_by_text=${text}`;
}

/** 从定位字符串提取可用于文本匹配的片段（含链式 get_by_text） */
export function extractLocatorText(locator: unknown): string {
  const locatorStr = normalizeLocator(locator);
  if (!locatorStr) return "";
  if (locatorStr.includes(" >> get_by_text=")) {
    return locatorStr.split(" >> get_by_text=").slice(-1)[0]!.trim();
  }
  if (locatorStr.startsWith("get_by_text=")) {
    return locatorStr.slice(12).trim();
  }
  const m = HAS_TEXT_INNER_RE.exec(locatorStr);
  if (m) return m[1]!.replace(/\\"/g, '"');
  return "";
}

/** 页面存在弹窗层时，优先返回弹窗内元素列表 */
export function preferPopupElements<T extends { in_popup?: boolean }>(raw: unknown): T[] {
  if (!Array.isArray(raw)) return [];
  const popupOnly = (raw as T[]).filter((el) => el?.in_popup);
  if (popupOnly.length) return popupOnly;
  return raw as T[];
}

// ============================================================
// normalize_locator
// ============================================================

export function normalizeLocator(locator: unknown): string {
  if (locator === null || locator === undefined) return "";
  if (typeof locator === "object" && !Array.isArray(locator)) {
    const d = locator as Record<string, unknown>;
    const role = d["get_by_role"] ?? d["role"];
    if (role) {
      const name = String(d["name"] ?? d["label"] ?? "").trim();
      return normalizeNativeValueSegment(
        name ? `get_by_role=${role}, ${name}` : `get_by_role=${role}`,
      );
    }
    const text = d["get_by_text"] ?? d["text"];
    if (text) return normalizeNativeValueSegment(`get_by_text=${text}`);
    const ph = d["get_by_placeholder"] ?? d["placeholder"];
    if (ph) return normalizeNativeValueSegment(`get_by_placeholder=${ph}`);
    for (const key of ["selector", "css", "locator", "value"]) {
      const val = d[key];
      if (val && typeof val === "string") {
        return ensureXpathEnginePrefix(coerceUnsafeHasTextLocator(val.trim()));
      }
    }
    // Python str(dict) 的 JS 等价（退化分支）
    return JSON.stringify(locator).trim();
  }

  const s = String(locator).trim();
  if (!s) return "";

  const s1 = coerceUnsafeHasTextLocator(s);

  let m = GET_BY_PLACEHOLDER_FUNC_RE.exec(s1);
  if (m) return `get_by_placeholder=${m[1]}`;

  m = GET_BY_TEXT_FUNC_RE.exec(s1);
  if (m) return `get_by_text=${m[1]}`;

  m = GET_BY_LABEL_FUNC_RE.exec(s1);
  if (m) return `get_by_label=${m[1]}`;

  m = GET_BY_TITLE_FUNC_RE.exec(s1);
  if (m) return `get_by_title=${m[1]}`;

  m = GET_BY_ROLE_FUNC_RE.exec(s1);
  if (m) {
    const role = m[1]!;
    const name = m[2];
    return normalizeNativeLocatorSegments(
      coerceUnsafeHasTextLocator(name ? `get_by_role=${role}, ${name}` : `get_by_role=${role}`),
    );
  }

  return normalizeNativeLocatorSegments(coerceUnsafeHasTextLocator(s1));
}

// ============================================================
// 解析为 Playwright Locator
// ============================================================

type AnyScope = PwPage | PwLocator | PwFrameLocator;

function resolveRootLocator(scope: AnyScope, sel: string): PwLocator {
  if (sel.startsWith("get_by_role=")) {
    const rolePart = sel.slice(12);
    const [roleRaw, nameRest] = splitFirst(rolePart, ",");
    const role = roleRaw.trim();
    const name = nameRest !== undefined ? stripWrappingQuotes(nameRest) : undefined;
    const anyScope = scope as any;
    return name ? anyScope.getByRole(role as any, { name }) : anyScope.getByRole(role as any);
  }
  // Python sel.split("=", 1)[1] 等价于 sel.slice(prefix.length)（仅切第一个 =）
  if (sel.startsWith("get_by_text=")) {
    return (scope as any).getByText(stripWrappingQuotes(sel.slice("get_by_text=".length)));
  }
  if (sel.startsWith("get_by_label=")) {
    return (scope as any).getByLabel(stripWrappingQuotes(sel.slice("get_by_label=".length)));
  }
  if (sel.startsWith("get_by_placeholder=")) {
    return (scope as any).getByPlaceholder(stripWrappingQuotes(sel.slice("get_by_placeholder=".length)));
  }
  if (sel.startsWith("get_by_alt_text=")) {
    return (scope as any).getByAltText(stripWrappingQuotes(sel.slice("get_by_alt_text=".length)));
  }
  if (sel.startsWith("get_by_title=")) {
    return (scope as any).getByTitle(stripWrappingQuotes(sel.slice("get_by_title=".length)));
  }
  return scope.locator(sel);
}

function resolveChildLocator(parentLoc: PwLocator, childSel: string): PwLocator {
  if (childSel.startsWith("get_by_role=")) {
    const rolePart = childSel.slice(12);
    const [roleRaw, nameRest] = splitFirst(rolePart, ",");
    const role = roleRaw.trim();
    const name = nameRest !== undefined ? stripWrappingQuotes(nameRest) : undefined;
    const anyParent = parentLoc as any;
    return name ? anyParent.getByRole(role as any, { name }) : anyParent.getByRole(role as any);
  }
  if (childSel.startsWith("get_by_text=")) {
    return parentLoc.getByText(stripWrappingQuotes(childSel.slice("get_by_text=".length)));
  }
  if (childSel.startsWith("get_by_label=")) {
    return parentLoc.getByLabel(stripWrappingQuotes(childSel.slice("get_by_label=".length)));
  }
  if (childSel.startsWith("get_by_placeholder=")) {
    return parentLoc.getByPlaceholder(stripWrappingQuotes(childSel.slice("get_by_placeholder=".length)));
  }
  if (childSel.startsWith("get_by_alt_text=")) {
    return parentLoc.getByAltText(stripWrappingQuotes(childSel.slice("get_by_alt_text=".length)));
  }
  if (childSel.startsWith("get_by_title=")) {
    return parentLoc.getByTitle(stripWrappingQuotes(childSel.slice("get_by_title=".length)));
  }
  return parentLoc.locator(childSel);
}

function resolveLocatorOnScope(scope: AnyScope, locatorStr: string): PwLocator {
  locatorStr = (locatorStr || "").trim();
  // iframe|| 链必须经拆分解析；整段进 locator() 会被当 XPath/CSS 炸
  if (locatorStr.includes("||")) {
    throw new Error(
      `含 iframe|| 的定位不能直接解析，请先按 || 拆分 frame 与元素: ${locatorStr.slice(0, 160)}`,
    );
  }
  if (locatorStr.includes(" >> ")) {
    const [parentSelRaw, ...rest] = locatorStr.split(" >> ");
    const parentSel = parentSelRaw!.trim();
    const childSel = rest.join(" >> ").trim();
    if (parentSel && childSel) {
      const parentLoc = resolveLocatorOnScope(scope, parentSel);
      return resolveLocatorOnScope(parentLoc, childSel);
    }
  }
  // LLM/Act 偶发 Playwright 链尾：get_by_text=x >> .. >> div >> nth=0
  const nthM = NTH_SEGMENT_RE.exec(locatorStr);
  if (nthM) {
    const anyScope = scope as any;
    if (typeof anyScope.nth === "function") {
      return anyScope.nth(parseInt(nthM[1]!, 10)) as PwLocator;
    }
    throw new Error(`定位链无效：根节点上不能单独使用 ${locatorStr}`);
  }
  if (NATIVE_PREFIXES.some((p) => locatorStr.startsWith(p))) {
    return resolveRootLocator(scope, locatorStr);
  }
  return scope.locator(locatorStr);
}

/** 将平台定位字符串解析为 Playwright Locator（不含 .first / iframe） */
export function resolveLocatorOnPage(page: PwPage | null, locator: unknown): PwLocator | null {
  const locatorStr = normalizeLocator(locator);
  if (!locatorStr || !page) return null;
  return resolveLocatorOnScope(page, locatorStr);
}

/** 在 FrameLocator 内解析平台定位字符串（支持 get_by_text= 等原生写法） */
export function resolveLocatorOnFrame(
  frameLocator: PwFrameLocator | null,
  locator: unknown,
): PwLocator | null {
  const locatorStr = normalizeLocator(locator);
  if (!locatorStr || !frameLocator) return null;
  return resolveLocatorOnScope(frameLocator, locatorStr);
}
