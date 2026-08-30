/**
 * 步骤分发器：将 method 映射到 Playwright API。
 * 1:1 对照 brick_runner_http/runner/step_executor.py。
 */
import type { Frame, Page } from "playwright";
import { resolve as resolveLocator } from "./locator-utils.js";
import { runSmartStep } from "./smart-step.js";
import { toPageFunction } from "@brickcore/smartbrowser";

export type Variables = Record<string, unknown>;
export type EnvConfig = Record<string, any>;

/**
 * 断言失败专用错误：对应 Python `assert ..., "msg"` 抛出的 AssertionError，
 * 引擎据此区分 failed（断言失败）与 error（其它异常）。
 */
export class AssertionError extends Error {
  constructor(message?: string) {
    super(message ?? "");
    this.name = "AssertionError";
  }
}

export class StepExecutor {
  /**
   * 执行单步。
   * @returns smart_step 返回结构化结果；其他步骤返回 null（undefined）
   */
  async execute(
    page: Page | Frame,
    step: Record<string, any>,
    env: EnvConfig,
    variables: Variables,
  ): Promise<Record<string, unknown> | null> {
    const method = step["method"] as string;
    const params = (step["params"] ?? {}) as Record<string, any>;
    const pageApi = page as Page;

    // ================================================================
    // 1. 页面操作
    // ================================================================
    if (method === "open_browser") {
      // 浏览器上下文已由引擎创建，此处无需新建；
      // 初始导航地址优先取步骤 url，否则回退到环境/项目默认起始 URL / target_host
      let url: string | undefined = params["url"];
      if (!url) url = env["env_default_start_url"] || env["project_default_start_url"];
      if (!url) {
        const host = env["target_host"];
        if (host) {
          url = String(host).startsWith("http://") || String(host).startsWith("https://")
            ? String(host)
            : `https://${host}`;
        }
      }
      if (url) {
        const waitUntil = params["wait_until"] || env["ui_nav_wait_until"] || "domcontentloaded";
        await pageApi.goto(url, { waitUntil });
      }
    } else if (method === "open_url") {
      const waitUntil = params["wait_until"] || env["ui_nav_wait_until"] || "domcontentloaded";
      await pageApi.goto(params["url"], { waitUntil });
    } else if (method === "refresh") {
      await pageApi.reload({ waitUntil: env["ui_nav_wait_until"] || "domcontentloaded" });
    } else if (method === "go_back") {
      await pageApi.goBack();
    } else if (method === "close_page") {
      await pageApi.close();

    // ================================================================
    // 2. 元素操作
    // ================================================================
    } else if (method === "click_ele") {
      const locator = resolveLocator(page, params["locator"], params["index"] ?? 1);
      if (params["ready_selector"]) {
        await pageApi.waitForSelector(params["ready_selector"], {
          timeout: params["ready_timeout"] ?? 30000,
        });
      }
      await locator.click({ force: params["force"] ?? false });
      if (params["expected_selector"]) {
        await pageApi.waitForSelector(params["expected_selector"], {
          timeout: params["expected_timeout"] ?? 30000,
        });
      }
    } else if (method === "fill_value") {
      const locator = resolveLocator(page, params["locator"], params["index"] ?? 1);
      await locator.fill(params["value"]);
    } else if (method === "click_by_text") {
      await pageApi.getByText(params["text"], { exact: params["exact"] ?? false }).click();
    } else if (method === "hover") {
      const locator = resolveLocator(page, params["locator"], params["index"] ?? 1);
      await locator.hover();
    } else if (method === "select_option") {
      const locator = resolveLocator(page, params["locator"], params["index"] ?? 1);
      await locator.selectOption(params["value"]);

    // ================================================================
    // 3. 鼠标键盘
    // ================================================================
    } else if (method === "mouse_click") {
      await pageApi.mouse.click(params["x"], params["y"]);
    } else if (method === "press_key") {
      await pageApi.keyboard.press(params["key"]);
    } else if (method === "press_type") {
      await pageApi.keyboard.type(params["text"]);

    // ================================================================
    // 4. 等待
    // ================================================================
    } else if (method === "wait_for_time") {
      await new Promise((r) => setTimeout(r, Number(params["timeout"]) / 1000));
    } else if (method === "wait_for_element") {
      const locator = resolveLocator(page, params["locator"], params["index"] ?? 1);
      await locator.waitFor({ state: "visible", timeout: params["timeout"] ?? 30000 });
    } else if (method === "wait_for_network") {
      await pageApi.waitForLoadState("networkidle");

    // ================================================================
    // 5. 断言
    // ================================================================
    } else if (method === "kw_assert_element_text") {
      const locator = resolveLocator(page, params["locator"], params["index"] ?? 1);
      const text = await locator.textContent();
      const actual = (text ?? "").trim();
      const expected = String(params["text"]);
      if (actual !== expected) {
        throw new AssertionError(`文本断言失败: 期望='${expected}', 实际='${actual}'`);
      }
    } else if (method === "kw_assert_visible") {
      const locator = resolveLocator(page, params["locator"], params["index"] ?? 1);
      const visible = await locator.isVisible();
      if (!visible) {
        throw new AssertionError(`元素可见性断言失败: ${params["locator"]}`);
      }
    } else if (method === "kw_assert_not_visible") {
      const locator = resolveLocator(page, params["locator"], params["index"] ?? 1);
      const visible = await locator.isVisible();
      if (visible) {
        throw new AssertionError(`元素应不可见: ${params["locator"]}`);
      }

    // ================================================================
    // 6. 变量提取
    // ================================================================
    } else if (method === "extract_text") {
      const locator = resolveLocator(page, params["locator"], params["index"] ?? 1);
      const text = await locator.textContent();
      variables[params["var_name"]] = (text ?? "").trim();

    // ================================================================
    // 7. 截图
    // ================================================================
    } else if (method === "save_page_img") {
      // 主引擎已统一截图，此处无需额外操作
    } else if (method === "condition_branch") {
      for (const branch of (step["branches"] ?? []) as Record<string, any>[]) {
        if (this.evaluateCondition(variables, (branch["condition"] ?? {}) as Record<string, any>)) {
          for (const subStep of (branch["steps"] ?? []) as Record<string, any>[]) {
            await this.execute(page, subStep, env, variables);
          }
          break;
        }
      }

    // ================================================================
    // 9. iframe 操作
    // ================================================================
    } else if (method.startsWith("frame_")) {
      // 对齐 Python page.frame 语义：空 name 不匹配任何 frame（if name and ...），
      // url 为子串包含匹配（url_matches）；Node page.frame({url}) 是 glob 精确匹配，
      // 用 predicate 复现子串语义
      const frameName = String(params["frame"] ?? "");
      const frameUrl = String(params["frame_url"] ?? "");
      let frame: Frame | null = null;
      if (frameName) frame = pageApi.frame({ name: frameName });
      if (!frame && frameUrl) frame = pageApi.frame({ url: (u: URL) => u.href.includes(frameUrl) });
      if (frame) {
        const innerMethod = method.slice(6); // frame_click → click
        await this.execute(frame, { method: innerMethod, params }, env, variables);
      }

    // ================================================================
    // 10. 其他
    // ================================================================
    } else if (method === "upload_file") {
      const locator = resolveLocator(page, params["locator"], params["index"] ?? 1);
      if (params["upload_mode"] === "single") {
        await locator.setInputFiles(params["file_path"]);
      }
    } else if (method === "execute_script") {
      // Python playwright 对字符串脚本自动检测函数形式并调用；Node 字符串一律
      // 按表达式求值。toPageFunction 复现 Python 行为（函数形式 → 真函数调用）。
      await pageApi.evaluate(
        toPageFunction(String(params["script"] ?? "")) as never,
        params["args"] ?? [],
      );
    } else if (method === "set_local_storage") {
      await pageApi.evaluate(
        `localStorage.setItem('${params["key"]}', '${params["value"]}')`,
      );
    } else if (method === "scroll_to_element") {
      const locator = resolveLocator(page, params["locator"], params["index"] ?? 1);
      await locator.scrollIntoViewIfNeeded();
    } else if (method === "scroll_to") {
      await pageApi.evaluate(
        `window.scrollTo(${params["x"] ?? 0}, ${params["y"] ?? 0})`,
      );
    } else if (method === "smart_step") {
      return await runSmartStep(pageApi, params, env, variables);
    } else {
      console.warn(`未知步骤类型: ${method}, 跳过执行`);
    }

    return null;
  }

  /** 条件评估（1:1 _evaluate_condition） */
  evaluateCondition(variables: Variables, condition: Record<string, any>): boolean {
    const op = condition["operator"] ?? "equals";
    const varName = String(condition["variable"] ?? "");
    const varValue = variables[varName] ?? "";
    const target = condition["value"] ?? "";

    if (op === "equals") return varValue === target;
    if (op === "not_equals") return varValue !== target;
    if (op === "contains") return String(target) === "" ? true : String(varValue).includes(String(target));
    if (op === "not_contains") return !String(varValue).includes(String(target));
    if (op === "exists") return varName in variables;
    if (op === "not_exists") return !(varName in variables);
    if (op === "greater_than") {
      const a = Number(varValue);
      const b = Number(target);
      return Number.isFinite(a) && Number.isFinite(b) ? a > b : false;
    }
    if (op === "less_than") {
      const a = Number(varValue);
      const b = Number(target);
      return Number.isFinite(a) && Number.isFinite(b) ? a < b : false;
    }
    return true;
  }
}
