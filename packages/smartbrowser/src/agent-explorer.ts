/**
 * MCP 式 UI Agent 探索器：逐步 accessibility snapshot → LLM 规划单步 → 执行 → 循环。
 * 1:1 对照 smartbrowser/src/smartbrowser/agent_explorer.py。
 */
import {
  actionMadeProgress,
  buildNoProgressStuckHint,
  refineAgentStepLocator,
  structuralFingerprint,
  type LocatorElement,
} from "./agent-locator.js";
import { normalizeLocator } from "./locator-utils.js";
import { SmartPageExplorer, captureAccessibilitySnapshot, sleep, type AgentStep, type ExploreResult } from "./page-fetcher.js";
import { HEALABLE_METHODS } from "./locator-heal.js";
import type { RenderPromptFn } from "./locator-heal.js";
import type { PlanFunc } from "./agent-planner.js";

export const _MAX_REPLAN_PER_INDEX = 3;

export const _DUPLICATE_STUCK_HINT =
  "刚规划的操作与最近已执行步骤相同（相同 method+locator），禁止重复。" +
  "请根据 snapshot 规划下一步；点击按钮必须优先使用 snapshot/DOM 中的 " +
  "#id、[data-testid]、get_by_role=button,<完整名称>，勿用 get_by_text 短词。";

export const _NO_PROGRESS_STUCK_HINT =
  "上一步操作后页面结构未变化（URL/主导航未变），说明定位可能点错或前置条件未满足。" +
  "请换用 snapshot 中该控件的 #id 或 get_by_role，勿重复相同 click。";

export type HealFunc = (args: Record<string, unknown>) => Promise<Record<string, any>>;
export type OnStepFn = (event: Record<string, any>) => Promise<void> | void;

export interface AgentExploreOptions {
  llm_plan_func: PlanFunc;
  max_steps?: number;
  heal_func?: HealFunc | null;
  render_prompt?: RenderPromptFn | null;
  on_step?: OnStepFn | null;
  /** True 时复用已有 page 续步（保留登录态），跳过 init/goto */
  resume?: boolean;
  /** True 时结束不关闭浏览器，供多轮会话跨轮复用 */
  keep_alive?: boolean;
}

export class UiMcpAgentExplorer extends SmartPageExplorer {
  static _stepSignature(step: Record<string, unknown>): string {
    const method = String(step["method"] ?? "").trim();
    const params = (step["params"] as Record<string, unknown> | undefined) ?? {};
    const loc = normalizeLocator(
      typeof params === "object" && params !== null ? params["locator"] : "",
    );
    return `${method}|${loc}`;
  }

  static _isDuplicateStep(step: Record<string, unknown>, executed_steps: Record<string, unknown>[]): boolean {
    const sig = UiMcpAgentExplorer._stepSignature(step);
    if (!sig || sig === "|") return false;
    const method = String(step["method"] ?? "").trim();
    // 点击类：与历史任一步相同即视为重复（避免 #8~#15 连点登录）
    if (method === "click_ele") {
      return executed_steps.some((s) => UiMcpAgentExplorer._stepSignature(s) === sig);
    }
    const recent = executed_steps.length ? executed_steps.slice(-5) : [];
    return recent.some((s) => UiMcpAgentExplorer._stepSignature(s) === sig);
  }

  /**
   * 逐步 Agent 探索主循环（1:1 agent_explore）。
   * 返回结构 = SmartPageExplorer._build_result + agent_log/mode/executed_steps。
   */
  async agentExplore(opts: AgentExploreOptions): Promise<ExploreResult & Record<string, unknown>> {
    const {
      llm_plan_func,
      max_steps = 15,
      heal_func = null,
      render_prompt = null,
      on_step = null,
      resume = false,
      keep_alive = false,
    } = opts;

    const agent_log: Record<string, any>[] = [];
    if (!resume) {
      await this._initBrowser();
    }

    try {
      if (!resume) {
        await this.page!.goto(this.start_url, {
          waitUntil: "domcontentloaded",
          timeout: this.timeout * 1000,
        });
        try {
          await this.page!.waitForLoadState("networkidle", { timeout: 5000 });
        } catch {
          /* pass */
        }
        await sleep(1);

        this.urls_visited.push(this.page!.url());
        await this._takeScreenshot(0, 0, `Agent 开始: ${this.page!.url()}`);
      } else {
        try {
          await this.page!.waitForLoadState("networkidle", { timeout: 5000 });
        } catch {
          /* pass */
        }
        await sleep(1);
      }

      // 跨轮续步：步号从已有历史之后开始，all_steps 持续累积
      const step_start = this.all_steps.length;
      let executed_count = step_start;
      for (let step_idx = step_start + 1; step_idx <= step_start + max_steps; step_idx++) {
        let [snap_text, snap_type] = await captureAccessibilitySnapshot(this.page!);
        let current_url = this.page!.url();

        let stuck_hint = "";
        let step_committed = false;
        let task_done = false;
        let step_failed = false;

        for (let replan = 0; replan < _MAX_REPLAN_PER_INDEX; replan++) {
          const plan = await llm_plan_func({
            accessibility_snapshot: snap_text,
            snapshot_type: snap_type,
            description: this.description,
            executed_steps: [...this.all_steps],
            current_url,
            step_index: step_idx,
            stuck_hint,
          });

          if (plan["type"] === "qa") {
            // 问答式交流：用户想了解当前页面，未执行动作，把回答推给前端
            const answer = String(plan["answer"] || plan["message"] || "").trim();
            agent_log.push({
              step: step_idx,
              type: "qa",
              message: answer,
              url: current_url,
              snapshot_type: snap_type,
            });
            step_committed = true;
            task_done = true;
            if (on_step) {
              await on_step({
                type: "qa",
                step: step_idx,
                answer,
                desc: answer,
                url: current_url,
              });
            }
            break;
          }

          if (plan["done"]) {
            agent_log.push({
              step: step_idx,
              done: true,
              message: plan["message"] || "任务完成",
              url: current_url,
              snapshot_type: snap_type,
            });
            console.log(`[UiMcpAgent] 第 ${step_idx} 步标记完成: ${plan["message"]}`);
            step_committed = true;
            task_done = true;
            if (on_step) {
              await on_step({
                type: "status",
                step: step_idx,
                done: true,
                message: plan["message"] || "任务完成",
                desc: plan["message"] || "任务完成",
                url: current_url,
              });
            }
            break;
          }

          let step = plan["step"] as AgentStep | undefined;
          if (!step || typeof step !== "object" || Array.isArray(step)) {
            const msg = `第 ${step_idx} 步 LLM 未返回有效 step`;
            this.errors.push(msg);
            agent_log.push({ step: step_idx, error: msg, url: current_url });
            step_committed = true;
            step_failed = true;
            break;
          }

          if (UiMcpAgentExplorer._isDuplicateStep(step as Record<string, unknown>, this.all_steps as Record<string, unknown>[])) {
            agent_log.push({
              step: step_idx,
              replan: replan + 1,
              duplicate_skipped: true,
              signature: UiMcpAgentExplorer._stepSignature(step as Record<string, unknown>),
              url: current_url,
            });
            stuck_hint = _DUPLICATE_STUCK_HINT;
            console.warn(
              `[UiMcpAgent] 第 ${step_idx} 步重复规划已跳过: ${UiMcpAgentExplorer._stepSignature(step as Record<string, unknown>)}`,
            );
            continue;
          }

          const params = step.params as Record<string, unknown> | undefined;
          if (params && typeof params === "object" && params.locator !== null && typeof params.locator === "object") {
            params["locator"] = this._coerceLocator(params.locator);
            step.params = params;
          }

          const dom_elements = (await this.extractInteractiveElements()) as LocatorElement[];
          const old_loc = normalizeLocator((step.params as Record<string, unknown> | undefined)?.["locator"]);
          step = refineAgentStepLocator(step as Record<string, unknown>, dom_elements) as unknown as AgentStep;
          const new_loc = normalizeLocator((step.params as Record<string, unknown> | undefined)?.["locator"]);
          if (new_loc !== old_loc) {
            console.log(`[UiMcpAgent] 定位优选 ${old_loc.slice(0, 50)} -> ${new_loc.slice(0, 50)}`);
          }

          const url_before = current_url;
          const struct_before = structuralFingerprint(url_before, snap_text);
          console.log(
            `[UiMcpAgent] 执行 step_idx=${step_idx} replan=${replan + 1} method=${step.method} sig=${UiMcpAgentExplorer._stepSignature(step as Record<string, unknown>)}`,
          );
          let [success, error] = await this._executeStep(step);

          // 每步执行后统一截图，保证「步骤描述 + 执行指令 + 截图」完整可回溯
          let shot = await this._takeScreenshot(
            0,
            step_idx,
            `Step${step_idx} ${step.desc || step.method}`,
          );

          const log_entry: Record<string, any> = {
            step: step_idx,
            url: current_url,
            snapshot_type: snap_type,
            planned_method: step.method,
            planned_desc: step.desc,
            locator: new_loc,
            value: (step.params as Record<string, unknown> | undefined)?.["value"],
            screenshot: shot,
            success,
            replan: replan ? replan + 1 : null,
          };

          if (!success && heal_func) {
            const [heal_success, heal_error, heal_info] = await this._tryHealAndRetry({
              step: step as unknown as Record<string, unknown>,
              error: error || "",
              page_url: current_url,
              snap_text,
              snap_type,
              heal_func,
              render_prompt,
            });
            success = heal_success;
            error = heal_error;
            if (heal_info) log_entry["heal"] = heal_info;
          }

          if (!success) {
            log_entry["error"] = error;
            agent_log.push(log_entry);
            this.errors.push(`Agent 第 ${step_idx} 步执行失败: ${error}`);
            shot = await this._takeScreenshot(0, step_idx, `Agent 执行失败: ${error ? error.slice(0, 120) : ""}`);
            if (shot) log_entry["screenshot"] = shot;
            this.all_steps.push(step);
            step_committed = true;
            step_failed = true;
            if (on_step) {
              await on_step({
                ...log_entry,
                type: "step",
                success: false,
                desc: log_entry["planned_desc"],
              });
            }
            break;
          }

          await sleep(0.5);
          [snap_text, snap_type] = await captureAccessibilitySnapshot(this.page!);
          current_url = this.page!.url();
          const struct_after = structuralFingerprint(current_url, snap_text);

          const progressed = actionMadeProgress({
            method: step.method || "",
            url_before,
            url_after: current_url,
            struct_before,
            struct_after,
          });
          const no_progress = !progressed;

          if (no_progress && replan < _MAX_REPLAN_PER_INDEX - 1) {
            agent_log.push({
              step: step_idx,
              replan: replan + 1,
              no_progress_after_action: true,
              signature: UiMcpAgentExplorer._stepSignature(step as Record<string, unknown>),
              struct_before: struct_before.slice(0, 8),
              struct_after: struct_after.slice(0, 8),
              url: current_url,
            });
            // 优先识别"点击父级/分组菜单后未跳转"的情况
            const hint = buildNoProgressStuckHint(step as Record<string, unknown>, dom_elements, this.description);
            stuck_hint = hint || _NO_PROGRESS_STUCK_HINT;
            console.warn(
              `[UiMcpAgent] 第 ${step_idx} 步无结构进展 url=${current_url} sig=${UiMcpAgentExplorer._stepSignature(step as Record<string, unknown>)}`,
            );
            continue;
          }

          if (no_progress) {
            const msg = `第 ${step_idx} 步执行后页面结构无变化（url=${current_url}）`;
            this.errors.push(msg);
            agent_log.push({ step: step_idx, error: msg, url: current_url });
            step_committed = true;
            step_failed = true;
            break;
          }

          this.all_steps.push(step);
          executed_count += 1;
          agent_log.push(log_entry);
          step_committed = true;
          if (on_step) {
            await on_step({
              ...log_entry,
              type: "step",
              success: true,
              desc: log_entry["planned_desc"],
            });
          }

          if (!this.urls_visited.includes(current_url)) {
            this.urls_visited.push(current_url);
          }
          break;
        }

        if (task_done) break;
        if (step_failed) break;
        if (!step_committed) {
          const msg = `第 ${step_idx} 步连续 ${_MAX_REPLAN_PER_INDEX} 次重复或无进展，已中止`;
          this.errors.push(msg);
          agent_log.push({ step: step_idx, error: msg, url: current_url });
          break;
        }

        await sleep(0.4);
      }

      return this._buildAgentResult(executed_count, agent_log);
    } catch (e) {
      console.error(`[UiMcpAgent] 探索异常: ${e instanceof Error ? `${e.message}\n${e.stack}` : e}`);
      this.errors.push(`Agent 探索异常: ${e instanceof Error ? e.message : String(e)}`);
      return this._buildAgentResult(0, agent_log);
    } finally {
      if (!keep_alive) {
        await this._close();
      }
    }
  }

  /** 失败时调用一次定位器自愈并重试执行（1:1 _try_heal_and_retry） */
  async _tryHealAndRetry(args: {
    step: Record<string, unknown>;
    error: string;
    page_url: string;
    snap_text: string;
    snap_type: string;
    heal_func: HealFunc;
    render_prompt?: RenderPromptFn | null;
  }): Promise<[boolean, string | null, Record<string, unknown> | null]> {
    const { step, error, page_url, snap_text, snap_type, heal_func, render_prompt } = args;
    const method = String(step["method"] ?? "").trim();
    const params = (step["params"] as Record<string, unknown> | undefined) ?? {};
    const failed_locator = typeof params === "object" && params !== null ? params["locator"] : "";
    if (!failed_locator || !HEALABLE_METHODS.has(method)) {
      return [false, error, null];
    }

    let heal_result: Record<string, any>;
    try {
      heal_result = await heal_func({
        method,
        failed_locator: String(failed_locator),
        step_desc: step["desc"] || "",
        step_intent: step["intent"] || "",
        error_message: error,
        page_url: page_url,
        accessibility_snapshot: snap_text,
        snapshot_type: snap_type,
        render_prompt,
      });
    } catch (e) {
      console.warn(`[UiMcpAgent] 自愈调用异常: ${e instanceof Error ? e.message : e}`);
      return [false, error, null];
    }

    if (!heal_result["success"] || !heal_result["locator"]) {
      return [
        false,
        error,
        {
          attempted: true,
          success: false,
          reason: heal_result["reason"] || "自愈未给出新定位器",
        },
      ];
    }

    const old_locator = String(failed_locator);
    const new_locator = heal_result["locator"] as string;
    (step["params"] as Record<string, unknown>)["locator"] = new_locator;
    console.log(`[UiMcpAgent] 自愈重试: ${old_locator.slice(0, 60)} -> ${new_locator.slice(0, 60)}`);

    const [success, retry_error] = await this._executeStep(step as unknown as AgentStep);
    const heal_info: Record<string, unknown> = {
      attempted: true,
      success,
      from_locator: old_locator,
      to_locator: new_locator,
      reason: heal_result["reason"] || "",
      confidence: heal_result["confidence"],
    };
    if (success) return [true, null, heal_info];
    return [false, retry_error, heal_info];
  }

  _buildAgentResult(executed_count: number, agent_log: Record<string, any>[]): ExploreResult & Record<string, unknown> {
    const base = this._buildResult(executed_count) as ExploreResult & Record<string, unknown>;
    // Python 侧 steps 为纯 dict 列表，此处按 AgentStep 视图透出（结构由去重函数保序保留）
    base["steps"] = dedupeAgentSteps(base["steps"] ?? []) as unknown as AgentStep[];
    base["agent_log"] = agent_log;
    base["mode"] = "agent_mcp";
    base["executed_steps"] = executed_count;
    return base;
  }
}

/** 合并 Agent 输出中连续/重复的点击（兜底）（1:1 dedupe_agent_steps） */
export function dedupeAgentSteps(steps: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen_click = new Set<string>();
  let prev_sig: string | null = null;
  for (const s of steps) {
    if (typeof s !== "object" || s === null || Array.isArray(s)) continue;
    const step = s as Record<string, unknown>;
    const sig = UiMcpAgentExplorer._stepSignature(step);
    if (sig && sig === prev_sig) continue;
    const method = String(step["method"] ?? "").trim();
    if (method === "click_ele" && sig && seen_click.has(sig)) continue;
    if (method === "click_ele" && sig) seen_click.add(sig);
    out.push(step);
    prev_sig = sig;
  }
  if (out.length < steps.length) {
    console.log(`[UiMcpAgent] 步骤去重 ${steps.length} → ${out.length}`);
  }
  return out;
}
