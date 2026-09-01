/**
 * AI 录制注入脚本构造器。
 * 1:1 对照 brick_runner_http/runner/recorder_script.py。
 *
 * 产物字段契约（与后端 recorder_converter.py / recorder_quality.py 对齐）：
 *   顶层: action_type / timestamp / selector / element_text / value / url / candidates
 *   meta:  id/cssPath/name/placeholder/accessibleName/text/inputType/tag/class/role/
 *          ariaLabel/dataTestid/popupRoot/source + locatorRankedByRunner=True
 */

/** 规范化定位策略（兼容后端取值） */
export function normalizeStrategy(strategy: string | null | undefined): string {
  const s = String(strategy ?? "default").trim().toLowerCase();
  return ["default", "tolerant", "robust", "semantic_first", "semantic"].includes(s) ? s : "default";
}

const RECORDER_TEMPLATE = String.raw`(function () {
  if (window.__REC_INIT__) return;           // 同一 document 只初始化一次
  window.__REC_INIT__ = true;
  if (!window.__RECORDED__) window.__RECORDED__ = [];
  if (!window.__REC_SUPPRESS_UNTIL__) window.__REC_SUPPRESS_UNTIL__ = 0;
  const STRATEGY = __STRATEGY__;

  const esc = function (v) {
    return String(v == null ? "" : v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  };
  const visibleText = function (el) {
    if (!el) return "";
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return (el.value || "").trim();
    const t = (el.innerText || el.textContent || "").trim();
    return t.slice(0, 60);
  };
  const attr = function (el, name) {
    return el.getAttribute ? (el.getAttribute(name) || "") : "";
  };
  const roleOf = function (el) {
    const r = attr(el, "role");
    if (r) return r;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "button" || tag === "a" && attr(el, "href")) return "button";
    if (tag === "a" && attr(el, "href")) return "link";
    if (tag === "input") {
      const t = (attr(el, "type") || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "button" || t === "submit") return "button";
      if (t === "file") return "file";
      return "textbox";
    }
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "img") return "img";
    return tag;
  };
  const accessibleName = function (el) {
    if (attr(el, "aria-label")) return attr(el, "aria-label").trim();
    if (attr(el, "alt")) return attr(el, "alt").trim();
    if (attr(el, "title")) return attr(el, "title").trim();
    if (attr(el, "placeholder")) return attr(el, "placeholder").trim();
    const label = el.labels && el.labels.length ? el.labels[0].innerText.trim() : "";
    if (label) return label.slice(0, 60);
    const t = visibleText(el);
    return t;
  };
  const cssPath = function (el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return "#" + esc(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 8) {
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift("#" + esc(node.id)); break; }
      if (node.classList && node.classList.length) {
        part += "." + Array.prototype.slice.call(node.classList, 0, 2).map(esc).join(".");
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = parent.children;
        if (siblings.length > 1) {
          const idx = Array.prototype.indexOf.call(siblings, node) + 1;
          part += ":nth-child(" + idx + ")";
        }
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  };
  const absXPath = function (el) {
    if (!el || el.nodeType !== 1) return "";
    const seg = [];
    let node = el;
    while (node && node.nodeType === 1) {
      let idx = 1;
      const parent = node.parentElement;
      if (parent) {
        const sameTag = parent.children;
        for (let i = 0; i < sameTag.length; i++) {
          if (sameTag[i] === node) { idx = i + 1; break; }
        }
      }
      const tag = node.tagName.toLowerCase();
      seg.unshift((parent ? "" : "/") + tag + "[" + idx + "]");
      node = parent;
    }
    return "/" + seg.join("/");
  };

  // 最近的可滚动容器 / 弹窗根
  const nearestScrollable = function (el) {
    let node = el;
    while (node && node !== document.documentElement) {
      const st = window.getComputedStyle(node);
      if (/(auto|scroll)/.test(st.overflowY)) return node;
      node = node.parentElement;
    }
    return null;
  };
  const popupRootOf = function (el) {
    let node = el;
    while (node && node !== document.body && node !== document.documentElement) {
      const tag = (node.tagName || "").toLowerCase();
      const role = attr(node, "role");
      const cls = attr(node, "class") || "";
      if (role === "dialog" || role === "alertdialog") return "get_by_role=" + role;
      if (/modal|dialog|drawer|mask|popover/i.test(cls)) return cssPath(node) || "get_by_role=dialog";
      node = node.parentElement;
    }
    return "";
  };

  // 候选定位生成（按 STRATEGY 排序）
  const buildCandidates = function (el) {
    const cands = [];
    const testId = attr(el, "data-testid") || attr(el, "data-qa") || attr(el, "data-test");
    if (testId) cands.push('[data-testid="' + esc(testId) + '"]');
    if (el.id) cands.push("#" + esc(el.id));
    const role = roleOf(el);
    const name = accessibleName(el);
    // 输入类元素：placeholder / aria-label / name 比 role+name 更精确（has-text 不匹配输入框文本）
    const ph = attr(el, "placeholder");
    if (ph) cands.push("get_by_placeholder=" + JSON.stringify(ph));
    const aria = attr(el, "aria-label");
    if (aria) cands.push('css=[aria-label="' + esc(aria) + '"]');
    const nm = attr(el, "name");
    if (nm) cands.push("css=[name='" + esc(nm) + "']");
    if (role && name) cands.push("get_by_role=" + role + ", " + JSON.stringify(name));
    cands.push(cssPath(el));
    cands.push("xpath=" + absXPath(el));
    const seen = [];
    const out = [];
    for (const c of cands) { if (c && seen.indexOf(c) < 0) { seen.push(c); out.push(c); } }
    return out;
  };
  const buildMeta = function (el) {
    const role = roleOf(el);
    const name = accessibleName(el);
    const cls = attr(el, "class");
    return {
      id: attr(el, "id"),
      cssPath: cssPath(el),
      name: attr(el, "name"),
      placeholder: attr(el, "placeholder"),
      accessibleName: name,
      text: visibleText(el),
      inputType: role === "textbox" ? (el.tagName === "TEXTAREA" ? "textarea" : (attr(el, "type") || "text")) : "",
      tag: (el.tagName || "").toLowerCase(),
      class: cls,
      role: role,
      ariaLabel: attr(el, "aria-label"),
      dataTestid: attr(el, "data-testid") || attr(el, "data-qa") || attr(el, "data-test"),
      popupRoot: popupRootOf(el),
      locatorRankedByRunner: true,
    };
  };
  const emit = function (actionType, el, value, extra) {
    if (window.__REC_PAUSED__) return;
    // 面板程序化执行回声抑制：后端执行 step/坐标点击等动作前会设置 __REC_SUPPRESS_UNTIL__，
    // Playwright 的可信事件会触发本录制器，若不入队则同一动作不会在时间线记录两遍。
    if (window.__REC_SUPPRESS_UNTIL__ && Date.now() < window.__REC_SUPPRESS_UNTIL__) return;
    const candidates = buildCandidates(el);
    const meta = buildMeta(el);
    const act = {
      action_type: actionType,
      timestamp: Date.now(),
      selector: candidates[0] || "",
      element_text: visibleText(el),
      candidates: candidates,
      meta: meta,
    };
    if (value !== undefined) act.value = value;
    if (extra) {
      for (const k in extra) if (extra.hasOwnProperty(k)) act[k] = extra[k];
    }
    window.__RECORDED__.push(act);
  };

  const onUserClick = function (e) {
    const el = e.target && e.target.closest ? (e.target.closest("a,button,select,textarea,input,[role],[onclick]") || e.target) : e.target;
    emit("click", el);
  };
  const onDblClick = function (e) {
    const el = e.target && e.target.closest ? (e.target.closest("a,button,select,textarea,input,[role],[onclick]") || e.target) : e.target;
    emit("dblclick", el);
  };
  const onContextMenu = function (e) {
    const el = e.target && e.target.closest ? (e.target.closest("[role],[oncontextmenu],button,a,li,td,[class*=menu]") || e.target) : e.target;
    emit("contextmenu", el);
  };
  let _lastInputKey = null;
  let _lastInputAt = 0;
  const onInput = function (e) {
    const el = e.target;
    if (!el) return;
    if (el.tagName === "INPUT" && (attr(el, "type") || "").toLowerCase() === "file") {
      emit("file", el);
      return;
    }
    let type = "fill";
    let value = el.value;
    if (el.tagName === "SELECT") {
      const sel = el.options[el.selectedIndex];
      type = "select";
      value = sel ? sel.text : "";
    }
    // input 与 change 会针对同一次用户交互几乎同时触发（如 select_option、
    // checkbox 等），按 (type, 元素, 值) 在很短窗口内去重，避免产生重复步骤。
    const key = type + "|" + (el.id || el.name || el.tagName) + "|" + value;
    const now = Date.now();
    if (_lastInputKey === key && now - _lastInputAt < 120) return;
    _lastInputKey = key;
    _lastInputAt = now;
    emit(type, el, value);
  };
  const onKeydown = function (e) {
    const el = e.target && e.target.closest ? (e.target.closest("input,textarea,select,[contenteditable],[role=textbox]") || document.body) : document.body;
    const keys = ["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "Backspace", "Delete", " "];
    if (keys.indexOf(e.key) >= 0) emit("keydown", el, e.key);
  };
  let scrollTimer = null;
  let lastScrollY = -1;
  const onScroll = function (e) {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(function () {
      const target = (e.target && e.target.nodeType === 1) ? e.target : document.scrollingElement || document.documentElement;
      const scroller = nearestScrollable(target);
      if (scroller && scroller !== document.documentElement) {
        emit("scroll", scroller, Math.round(scroller.scrollTop));
      } else {
        const y = Math.round(window.scrollY || 0);
        if (Math.abs(y - lastScrollY) > 250) {
          emit("scroll", document.body, y);
          lastScrollY = y;
        }
      }
    }, 300);
  };
  onScroll; // 引用防误删

  // 记录最后一个悬停元素（供 save_variable 取 text/value）
  document.addEventListener("mousemove", function (e) {
    const el = e.target;
    if (el !== window.__LAST_TARGET__) {
      window.__LAST_TARGET__ = el;
      window.__LAST_TARGET__IN_MS__ = Date.now();
    }
  }, true);

  document.addEventListener("click", onUserClick, true);
  document.addEventListener("dblclick", onDblClick, true);
  document.addEventListener("contextmenu", onContextMenu, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("change", onInput, true);
  document.addEventListener("keydown", onKeydown, true);
  window.addEventListener("scroll", onScroll, true);

  // 供 Python 侧控制指令（save_variable）复用的定位/元数据工具，与事件采集完全同源
  window.__REC__ = {
    attr: attr,
    visibleText: visibleText,
    cssPath: cssPath,
    absXPath: absXPath,
    roleOf: roleOf,
    accessibleName: accessibleName,
    popupRootOf: popupRootOf,
    buildCandidates: buildCandidates,
    buildMeta: buildMeta,
  };
})();`;

/** 返回可注入页面的脚本字符串（自执行 IIFE，可重复执行且带初始化标记） */
export function buildRecorderScript(locatorStrategy = "default"): string {
  return RECORDER_TEMPLATE.replace("__STRATEGY__", JSON.stringify(normalizeStrategy(locatorStrategy)));
}
