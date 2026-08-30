/**
 * Agent / MCP 探索：通用定位器优选与页面进展判断。
 * 1:1 对照 smartbrowser/src/smartbrowser/agent_locator.py。
 */
import { createHash } from "node:crypto";
import { normalizeLocator } from "./locator-utils.js";

/** 短词黑名单（易误匹配页面说明） */
const COMMON_SHORT_TEXTS = new Set([
  "登录", "提交", "确定", "取消", "保存", "删除", "编辑", "新增", "查询", "搜索",
  "OK", "ok", "Yes", "No",
]);

/** 表单输入框语义词：用于在 fill_value 时根据步骤描述匹配 placeholder/label */
const FILL_SEMANTIC_HINTS = [
  "账号", "账户", "用户名", "用户", "密码", "口令", "邮箱", "电子邮件", "手机", "验证码", "手机号",
] as const;

/** Element Plus 等框架渲染时生成的临时自增 id，交互/重渲染后会漂移，不可作为稳定定位符 */
const DYNAMIC_ID_RE = /^#?el-id-\d+-\d+$/;

/** 可点击元素的 tag 白名单（第一层） */
const CLICKABLE_TAGS = ["button", "a", "input", "select", "textarea"] as const;
/** 可点击元素的 role 白名单 */
const CLICKABLE_ROLES = ["button", "link", "menuitem", "menuitemcheckbox", "tab"] as const;

export type LocatorElement = Record<string, unknown>;

function isDynamicElId(loc: string): boolean {
  return DYNAMIC_ID_RE.test((loc || "").trim());
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url || "about:blank");
    return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, "").toLowerCase();
  } catch {
    return (url || "").trim().toLowerCase();
  }
}

/**
 * 页面结构指纹：URL + snapshot 中导航/按钮/表单等主干节点。
 * 用于判断 click 后是否真正换屏（忽略仅 Toast/alert 文案变化）。
 */
export function structuralFingerprint(url: string, snapText: string): string {
  const lines: string[] = [];
  for (const line of (snapText || "").split("\n")) {
    const low = line.toLowerCase();
    if (["alert", "toast", "role=alert", "错误", "成功提示"].some((k) => low.includes(k))) {
      if (line.length < 100) continue;
    }
    if (
      ["button", "role=button", "menu", "nav", "link", "textbox", "combobox", " id=", "data-testid", "data_testid"].some(
        (k) => low.includes(k),
      )
    ) {
      lines.push(line.trim().slice(0, 120));
    }
  }
  const key = normalizeUrl(url);
  const body = Array.from(new Set(lines)).sort().slice(0, 40).join("\n");
  return createHash("md5").update(`${key}\n${body}`, "utf8").digest("hex");
}

/** 操作后是否有可识别的页面进展（1:1 action_made_progress） */
export function actionMadeProgress(args: {
  method: string;
  url_before: string;
  url_after: string;
  struct_before: string;
  struct_after: string;
}): boolean {
  if (normalizeUrl(args.url_before) !== normalizeUrl(args.url_after)) return true;
  if (["open_url", "refresh", "go_back", "wait_for_load"].includes(args.method)) return true;
  if (args.method === "click_ele" && args.struct_before !== args.struct_after) return true;
  if (["fill_value", "select_option", "type_value"].includes(args.method) && args.struct_before !== args.struct_after) {
    return true;
  }
  return false;
}

function inferRole(el: LocatorElement): string {
  const tag = String(el["tag"] ?? "").toLowerCase();
  if (tag === "button") return "button";
  if (tag === "a") return "link";
  if (tag === "input" || tag === "textarea") {
    const t = String(el["type"] ?? "").toLowerCase();
    if (t === "submit" || t === "button") return "button";
    return "textbox";
  }
  if (tag === "select") return "combobox";
  const role = String(el["role"] ?? "").toLowerCase();
  if (["button", "link", "textbox", "combobox", "menuitem", "tab"].includes(role)) return role;
  return "";
}

/** 按定位优先级生成候选定位器（1:1 build_candidates_from_element） */
export function buildCandidatesFromElement(el: LocatorElement, includeShort = false): string[] {
  const tag = String(el["tag"] ?? "").toLowerCase();
  const text = String(el["text"] ?? "").trim();
  const isShort = COMMON_SHORT_TEXTS.has(text) && !includeShort;
  const candidates: string[] = [];

  const testid = String(el["data_testid"] ?? el["data-testid"] ?? "").trim();
  if (testid) candidates.push(`[data-testid="${testid}"]`);

  const elemId = String(el["id"] ?? "").trim();
  if (elemId && !isDynamicElId(elemId)) {
    candidates.push(`#${elemId}`);
    if (tag === "button") candidates.push(`//button[@id='${elemId}']`);
  }

  if (text && !isShort && 1 < text.length && text.length < 40) {
    const role = inferRole(el);
    if (role) candidates.push(`get_by_role=${role}, ${text}`);
  }

  if (text && 1 < text.length && text.length < 40 && !isShort) {
    candidates.push(`get_by_text=${text}`);
  }

  const name = String(el["name"] ?? "").trim();
  if (name) candidates.push(`${tag}[name="${name}"]`);

  const placeholder = String(el["placeholder"] ?? "").trim();
  if (placeholder && (tag === "input" || tag === "textarea")) {
    candidates.push(`get_by_placeholder=${placeholder}`);
  }

  const aria = String(el["aria_label"] ?? "").trim();
  if (aria) candidates.push(`get_by_label=${aria}`);

  const selector = String(el["selector"] ?? "").trim();
  if (selector && !candidates.includes(selector)) candidates.push(selector);

  // 父级作用域链式定位器：借助父容器限定作用域，规避同名元素 strict 冲突
  const parentSel = String(el["parent_selector"] ?? "").trim();
  if (parentSel && candidates.length && !candidates.some((c) => c.includes(" >> "))) {
    const base = candidates[0]!;
    const chain = `${parentSel} >> ${base}`;
    if (!candidates.includes(chain)) candidates.push(chain);
  }

  return candidates;
}

/** 从步骤描述/定位器提取用于匹配 DOM 的文本片段（1:1 _hints_from_step） */
export function _hintsFromStep(step: LocatorElement): string[] {
  const hints: string[] = [];
  const desc = String(step["desc"] ?? "").trim();
  for (const m of desc.matchAll(/[「『"']([^」』"']+)[」』"']/g)) {
    hints.push(m[1]!.trim());
  }
  for (const m of desc.matchAll(/(?:点击|选择|打开|进入)\s*[「『"]?\s*([^，。；\s]+)/g)) {
    const t = m[1]!.trim();
    if (t && t.length <= 20) hints.push(t);
  }
  // 定位器可能是 LLM 的弱猜测；描述无可提取词时才回退到定位器
  if (!hints.length) {
    const loc = normalizeLocator((step["params"] as LocatorElement | undefined)?.["locator"]);
    if (loc.startsWith("get_by_text=")) {
      hints.push(loc.slice("get_by_text=".length).trim());
    } else if (loc.startsWith("get_by_role=")) {
      const rest = loc.slice(12);
      const idx = rest.indexOf(",");
      if (idx >= 0) hints.push(rest.slice(idx + 1).trim());
    } else if (loc.startsWith("#")) {
      // 忽略 Element Plus 等框架生成的临时动态 id
      if (!isDynamicElId(loc)) hints.push(loc.slice(1));
    }
  }
  return hints.filter((h) => h);
}

/** 从步骤描述中提取"父级锚点"词（1:1 _parent_hints_from_step） */
export function _parentHintsFromStep(step: LocatorElement): string[] {
  const desc = String(step["desc"] ?? "").trim();
  const parents: string[] = [];
  // 引号包裹结构：'X'下的'Y' 或 "X"里的"Y"
  for (const m of desc.matchAll(
    /[「『"']([^」』"']+)[」』"']?\s*(?:下|里的|中的|的)\s*[「『"']([^」』"']+)[」』"']/g,
  )) {
    parents.push(m[1]!.trim());
  }
  // 无引号结构：如"智能浏览器下的执行记录"
  for (const m of desc.matchAll(
    /([^，。；\s]{2,20})\s*下的\s*(?:「[^」]*」|『[^』]*』|[^，。；\s]{1,20})/g,
  )) {
    const p = m[1]!.trim();
    if (p) parents.push(p);
  }
  return parents.filter((p) => p && p.length <= 20);
}

/** 元素打分（1:1 _score_element） */
export function _scoreElement(
  el: LocatorElement,
  hints: string[],
  opts: {
    prefer_tags: readonly string[];
    prefer_roles?: readonly string[];
    parent_hints?: readonly string[];
  },
): number {
  const tag = String(el["tag"] ?? "").toLowerCase();
  const role = String(el["role"] ?? "").toLowerCase();
  // tag 与 role 任选其一命中白名单即放行，否则排除
  if (
    (opts.prefer_tags.length || (opts.prefer_roles?.length ?? 0)) &&
    !opts.prefer_tags.includes(tag) &&
    !(opts.prefer_roles ?? []).includes(role) &&
    !opts.prefer_tags.includes(role)
  ) {
    return 0;
  }
  const text = String(el["text"] ?? "").trim();
  const elId = String(el["id"] ?? "").trim();
  let score = 0;
  if (elId && !isDynamicElId(elId)) score += 4;
  for (const h of hints) {
    if (!h) continue;
    if (h === elId || h === text) score += 12;
    // 空文本守卫：text='' 的 input 不得获得虚假包含分
    if (text && (text.includes(h) || h.includes(text))) score += 8;
    if (text.replace(/ /g, "").includes(h.replace(/ /g, ""))) score += 6;
  }
  if ((CLICKABLE_TAGS as readonly string[]).includes(tag) || (CLICKABLE_ROLES as readonly string[]).includes(role)) {
    score += 2;
  }
  if (role === "menuitem" || role === "menuitemcheckbox") score += 2;
  // 父级作用域加权：命中父级锚点者加分
  if (opts.parent_hints?.length) {
    const parentText = String(el["parent_text"] ?? "").trim();
    const parentSel = String(el["parent_selector"] ?? "").trim();
    for (const ph of opts.parent_hints) {
      if (ph && (parentText.includes(ph) || parentSel.includes(ph))) {
        score += 6;
        break;
      }
    }
  }
  return score;
}

/** 找出打分最高且 ≥8 分的元素（1:1 find_best_element） */
export function findBestElement(
  elements: LocatorElement[],
  hints: string[],
  opts: {
    prefer_tags?: readonly string[];
    prefer_roles?: readonly string[];
    parent_hints?: readonly string[];
  } = {},
): LocatorElement | null {
  let best: LocatorElement | null = null;
  let bestScore = 0;
  for (const el of elements) {
    if (typeof el !== "object" || el === null) continue;
    const s = _scoreElement(el, hints, {
      prefer_tags: opts.prefer_tags ?? ["button", "a", "input"],
      prefer_roles: opts.prefer_roles,
      parent_hints: opts.parent_hints,
    });
    if (s > bestScore) {
      bestScore = s;
      best = el;
    }
  }
  return bestScore >= 8 ? best : null;
}

/** 弱定位器判定（1:1 is_weak_locator） */
export function isWeakLocator(loc: unknown, opts: { method: string }): boolean {
  const l = normalizeLocator(loc);
  if (!l) return true;
  if (opts.method === "click_ele" && l.startsWith("get_by_text=")) {
    const text = l.slice("get_by_text=".length).trim();
    if (COMMON_SHORT_TEXTS.has(text) || text.length <= 4) return true;
  }
  if (opts.method === "fill_value" && l.startsWith("get_by_text=")) return true;
  return false;
}

/** 根据语义词匹配输入框生成稳定定位（1:1 _semantic_fill_locator） */
export function _semanticFillLocator(step: LocatorElement, elements: LocatorElement[]): string {
  if (String(step["method"] ?? "").trim() !== "fill_value") return "";
  const desc = String(step["desc"] ?? "").trim();
  if (!desc) return "";
  const matched = FILL_SEMANTIC_HINTS.filter((w) => desc.includes(w));
  if (!matched.length) return "";
  for (const el of elements) {
    if (typeof el !== "object" || el === null) continue;
    const tag = String(el["tag"] ?? "").toLowerCase();
    if (tag !== "input" && tag !== "textarea") continue;
    const ph = String(el["placeholder"] ?? "").trim();
    const label = String(el["aria_label"] ?? "").trim();
    const name = String(el["name"] ?? "").trim();
    const haystack = `${ph} ${label} ${name}`;
    for (const w of matched) {
      if (haystack.includes(w)) {
        if (ph) return `get_by_placeholder=${ph}`;
        if (label) return `get_by_label=${label}`;
        if (name) return `${el["tag"]}[name="${name}"]`;
      }
    }
  }
  return "";
}

/** 为 Agent 规划步骤优选稳定 locator（1:1 pick_stable_locator） */
export function pickStableLocator(step: LocatorElement, elements: LocatorElement[]): string {
  const method = String(step["method"] ?? "").trim();
  const params = (step["params"] as LocatorElement | undefined) ?? {};
  const current = normalizeLocator(typeof params === "object" && params !== null ? params["locator"] : "");
  if (!elements.length) return current;

  // 对填值：优先用语义词匹配 placeholder/label，规避动态 id 漂移
  if (method === "fill_value" || method === "type_value" || method === "clear_value") {
    const semantic = _semanticFillLocator(step, elements);
    if (semantic) return semantic;
  }

  const hints = _hintsFromStep(step);
  const parent_hints = _parentHintsFromStep(step);

  if (method === "click_ele") {
    const el = findBestElement(elements, hints, {
      prefer_tags: ["button", "a", "input"],
      prefer_roles: CLICKABLE_ROLES,
      parent_hints,
    });
    if (el) {
      const cands = buildCandidatesFromElement(el);
      if (cands.length) return cands[0]!;
    }
    // 文本匹配兜底 —— 菜单/分组/导航等非 button/a/input 元素
    if (hints.length) {
      const mel = findBestElement(elements, hints, { prefer_tags: [], parent_hints });
      if (mel) {
        for (const c of buildCandidatesFromElement(mel)) {
          if (c.startsWith("get_by_text=") || c.includes(":has-text(")) return c;
        }
      }
    }
  } else if (method === "fill_value" || method === "type_value" || method === "clear_value") {
    const el = findBestElement(elements, hints, { prefer_tags: ["input", "textarea"] });
    if (el) {
      const cands = buildCandidatesFromElement(el);
      for (const c of cands) {
        if (c.startsWith("#") || c.startsWith("get_by_placeholder=") || c.startsWith("get_by_label=") || c.startsWith("[")) {
          return c;
        }
      }
      if (cands.length) return cands[0]!;
    }
  }

  if (isWeakLocator(current, { method }) && hints.length) {
    const el = findBestElement(elements, hints, {
      prefer_tags: method === "click_ele" ? ["button", "a"] : ["input", "textarea"],
      parent_hints,
    });
    if (el) {
      const cands = buildCandidatesFromElement(el);
      if (cands.length) return cands[0]!;
    }
  }

  return current;
}

/** 执行前将 LLM 给出的弱定位器替换为 DOM 提取的稳定候选（1:1 refine_agent_step_locator） */
export function refineAgentStepLocator<T extends LocatorElement>(step: T, elements: LocatorElement[]): T {
  if (typeof step !== "object" || step === null || !elements.length) return step;
  const method = String(step["method"] ?? "").trim();
  if (!["click_ele", "fill_value", "type_value", "clear_value", "select_option"].includes(method)) {
    return step;
  }

  if (typeof (step as Record<string, unknown>)["params"] !== "object" || (step as Record<string, unknown>)["params"] === null) {
    (step as Record<string, unknown>)["params"] = {};
  }
  const params = (step as Record<string, unknown>)["params"] as LocatorElement;
  if (typeof params !== "object" || params === null) return step;

  const old = normalizeLocator(params["locator"]);
  const newLoc = pickStableLocator(step, elements);
  if (newLoc && newLoc !== old) {
    params["locator"] = newLoc;
  }
  return step;
}

/** 从步骤描述/用户目标中提取「父级下的目标子项」词（1:1 _target_child_hints_from_step） */
export function _targetChildHintsFromStep(step: LocatorElement, description?: string | null): string[] {
  const desc = String(step["desc"] ?? "").trim();
  const text = `${desc}\n${(description || "").trim()}`;
  const targets: string[] = [];
  const patterns = [
    /[「『"']([^」』"']+)[」』"']?\s*(?:下|里的|中的|的)\s*[「『"']([^」』"']+)[」』"']/g,
    /([^，。；\s]{2,20})\s*下的\s*(「[^」]*」|『[^』]*』|[^，。；\s]{1,20})/g,
  ];
  for (const pat of patterns) {
    for (const m of text.matchAll(pat)) {
      const child = m[2]!.trim().replace(/^["'「」『』]+|["'「」『』]+$/g, "");
      if (child && child.length <= 20 && !targets.includes(child)) targets.push(child);
    }
  }
  return targets;
}

/** 在 DOM 中定位「父级分组下」的目标子项（1:1 _find_parent_scoped_child） */
export function _findParentScopedChild(
  elements: LocatorElement[],
  targetHints: string[],
  parentWord: string,
): LocatorElement | null {
  if (!targetHints.length) return null;
  let best: LocatorElement | null = null;
  let bestScore = 0;
  for (const el of elements) {
    if (typeof el !== "object" || el === null) continue;
    const text = String(el["text"] ?? "").trim();
    if (!text) continue;
    // 排除父级分组自身
    if (parentWord && (text === parentWord || text.includes(parentWord))) continue;
    const role = String(el["role"] ?? "").toLowerCase();
    const tag = String(el["tag"] ?? "").toLowerCase();
    if (!(CLICKABLE_ROLES as readonly string[]).includes(role) && !(CLICKABLE_TAGS as readonly string[]).includes(tag)) {
      continue;
    }
    let score = 0;
    for (const h of targetHints) {
      if (!h) continue;
      if (h === text) score += 20;
      else if (h.includes(text) || text.includes(h)) score += 14;
      else if (text.replace(/ /g, "").includes(h.replace(/ /g, ""))) score += 10;
    }
    if (score === 0) continue;
    // 命中父级作用域者加权
    const pt = String(el["parent_text"] ?? "").trim();
    const ps = String(el["parent_selector"] ?? "").trim();
    if (parentWord && (pt.includes(parentWord) || ps.includes(parentWord))) score += 4;
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return bestScore >= 10 ? best : null;
}

/** 无进展时生成「直接点击子项」指导（1:1 build_no_progress_stuck_hint） */
export function buildNoProgressStuckHint(
  step: LocatorElement,
  elements: LocatorElement[],
  description?: string | null,
): string {
  if (typeof step !== "object" || step === null || !elements.length) return "";
  const method = String(step["method"] ?? "").trim();
  if (!method || !method.includes("click")) return "";
  let clicked = _parentHintsFromStep(step);
  if (!clicked.length) clicked = _hintsFromStep(step);
  if (!clicked.length) return "";
  const click_word = clicked[0]!;
  const targets = _targetChildHintsFromStep(step, description);
  const child = _findParentScopedChild(elements, targets, click_word);
  if (!child) return "";
  const child_text = String(child["text"] ?? "").trim();
  const cands = buildCandidatesFromElement(child);
  const loc_part = cands.length ? cands[0]! : "";
  // 优先用 DOM 精确实例文本，避免自然语言解析出的短语偏差
  const target_word = child_text || (targets.length ? targets[0]! : "");
  return (
    `刚点击的「${click_word}」是父级分组/入口菜单项，点击后页面未跳转(URL/主导航未变)，` +
    `说明它不是直接入口。用户目标是在其下操作「${target_word}」，请不要重复点击父级「${click_word}」，` +
    `改为直接点击其下的「${child_text}」子项。候选稳定定位：${loc_part}；` +
    `也可用 get_by_role=menuitem, ${child_text} 或「父级 >> 子级」链式定位。`
  );
}
