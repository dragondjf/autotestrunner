/**
 * 跨包契约类型定义。
 * 对照来源：node-backend/docs/ACCEPTANCE.md（验收基准）。
 */

// ============================================================
// LLM（smartbrowser/llm.py 契约）
// ============================================================

export interface LLMConfig {
  base_url: string;
  api_key: string;
  model: string;
  temperature?: number;
  max_tokens?: number | null;
  timeout?: number;
  extra_headers?: Record<string, string> | null;
}

export interface LLMResult {
  content: string;
  tokens: unknown;
}

/** create_llm_call 返回的可调用：fn(system, user) */
export type LLMCallFn = (system: string, user: string) => Promise<LLMResult>;

// 可重试 HTTP 状态码定义在 utils/retry.ts，此处转出保持单一来源
export { RETRYABLE_HTTP_STATUS } from "./utils/retry.js";

// ============================================================
// LLM 配置存储（agent_web_ui core.py _normalize_cfg 契约）
// ============================================================

export interface LlmConfigRecord {
  id: string;
  name: string;
  provider: string;
  api_key: string;
  base_url: string;
  model: string;
  thinking: boolean;
  temperature: number;
  max_tokens: number;
  timeout: number;
  is_default: boolean;
  enabled: boolean;
}

// ============================================================
// Agent 步骤与规划结果（smartbrowser agent_planner 契约）
// ============================================================

export interface AgentStep {
  method: string;
  params: Record<string, unknown>;
  desc?: string;
}

export type PlanFuncResult =
  | { done: false; type: "qa"; answer: string }
  | { done: false; step: AgentStep }
  | { done: true; message?: string };

// ============================================================
// Runner（brick_runner_http 契约）
// ============================================================

export interface BranchCondition {
  variable?: string;
  operator?: string;
  value?: unknown;
}

export interface Branch {
  condition: BranchCondition;
  steps: RunnerStep[];
}

export interface RunnerStep {
  method: string;
  keyword?: string;
  params?: Record<string, unknown>;
  branches?: Branch[];
}

export interface RunnerCase {
  execution_id: number;
  case_id?: string | number;
  name?: string;
  steps: RunnerStep[];
  skip?: boolean;
  stop_on_failure?: boolean;
}

export interface RunnerCallbackConfig {
  report_url?: string;
  progress_url?: string;
  api_key?: string;
}

export interface SuitePayload {
  suite_execution_id?: number;
  env?: Record<string, unknown>;
  suite?: {
    suite_execution_id?: number;
    name?: string;
    suite_name?: string;
    pre_actions?: RunnerStep[];
    cases?: RunnerCase[];
  };
  callback?: RunnerCallbackConfig;
}

export type StepStatus = "passed" | "failed" | "error" | "skipped" | "pending" | "stopped";
export type CaseStatus = "passed" | "failed" | "error" | "skipped" | "stopped" | "pending";

export interface StepResult {
  step_index: number;
  method: string;
  keyword: string;
  status: StepStatus;
  error: string | null;
  screenshot: string | null;
  duration_ms: number;
  smart_step?: SmartStepResult;
  detail?: unknown;
}

/** smart_step 返回契约（step_executor.py 3.4-a） */
export interface SmartStepResult {
  smart_step: true;
  total_steps: number;
  model_calls: number;
  is_done: boolean;
  has_errors: boolean;
  final_result: unknown;
  errors: string[];
  summary: {
    intent: string;
    total_steps: number;
    model_calls: number;
    is_done: boolean;
    is_successful: boolean;
    has_errors: boolean;
    last_action: unknown;
    errors: string[];
    final_result: unknown;
  };
}

/** 进度回传消息（progress_reporter.py 契约，X-API-Key） */
export type ProgressMessage =
  | { type: "suite_start"; suite_execution_id: number }
  | { type: "suite_end"; suite_execution_id: number }
  | { type: "suite_error"; suite_execution_id: number; error: string }
  | { type: "case_start"; execution_id: number }
  | { type: "case_end"; execution_id: number }
  | { type: "case_status"; execution_id: number; status: string; error?: string }
  | { type: "case_skip"; execution_id: number }
  | { type: "case_stop"; execution_id: number; reason: string }
  | { type: "step_progress"; execution_id: number; step_result: StepResult };

// ============================================================
// 录制（recording.py / recorder_script.py 契约）
// ============================================================

export interface RecordCallbackConfig {
  callback_url?: string;
  heartbeat_url?: string;
  api_key?: string;
}

export interface RecordStartPayload {
  record_session_id: number;
  device_id?: string;
  url?: string;
  description?: string;
  max_record_time?: number;
  hover_delay_ms?: number;
  recording_locator_strategy?: string;
  callback?: RecordCallbackConfig;
}

export interface RecordedAction {
  action_type: string;
  timestamp: number;
  selector?: string;
  element_text?: string;
  value?: string;
  url?: string;
  candidates?: string[];
  meta?: Record<string, unknown>;
}

export interface RecordFrames {
  total: number;
  listening: number;
  items: Array<{ url: string; name: string; listening: boolean }>;
}

export interface RecordHeartbeatBody {
  actions_count: number;
  raw_actions: RecordedAction[];
  paused: boolean;
  last_control_result: unknown;
  frames: RecordFrames;
}

// ============================================================
// 交互调试（debug_session.py 契约）
// ============================================================

export interface DebugCallbackConfig {
  callback_base?: string;
}

export interface DebugSessionPayload {
  debug_session_id: number;
  steps?: RunnerStep[];
  callback_base?: string;
  max_idle_seconds?: number;
  auto_navigate?: boolean;
  initial_url?: string;
  hotkeys?: Record<string, unknown>;
}

/** debug_session.py 事件常量（与后端 ui_debug_command.py 对齐） */
export const DEBUG_EVENTS = {
  READY: "ready",
  STEP_RESULT: "step_result",
  HIGHLIGHT_RESULT: "highlight_result",
  VERIFY_RESULT: "verify_result",
  PICK_RESULT: "pick_result",
  PICK_MODE: "pick_mode",
  HOTKEYS_UPDATED: "hotkeys_updated",
  SELECT_STEP: "select_step",
  STEPS_SYNCED: "steps_synced",
  CLEAR_HIGHLIGHT_RESULT: "clear_highlight_result",
  CLOSED: "closed",
  ERROR: "error",
} as const;

export type DebugEventName = (typeof DEBUG_EVENTS)[keyof typeof DEBUG_EVENTS];

/** 调试命令 action（runner-command data 节点） */
export type DebugCommandAction =
  | "run"
  | "highlight"
  | "verify_locator"
  | "pick_mode"
  | "set_hotkeys"
  | "select_step"
  | "sync_steps"
  | "clear_highlight"
  | "close"
  | "save";

export interface DebugCommand {
  command_id?: string;
  action: DebugCommandAction;
  payload: Record<string, unknown>;
  [key: string]: unknown;
}
