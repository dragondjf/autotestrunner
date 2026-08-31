/**
 * Runner HTTP 客户端（Backend → Runner :9377/:8900）。
 * 职责：执行派发（/run）、停止（/stop/*）、健康检查（/health）；
 * 回调 URL 与鉴权令牌由本模块统一注入（Runner 侧零配置）。
 * 设计依据：docs/需求设计/数据库与API设计.md §2.14。
 */
import type { RunnerStep, SuitePayload } from "@brickcore/shared";

/** Runner 服务地址（惰性读取，支持运行时覆盖） */
export function runnerUrl(): string {
  return (process.env.RUNNER_URL ?? "http://127.0.0.1:8900").replace(/\/+$/, "");
}

/** Backend 对外可达地址（Runner 用它回调本服务；默认本机） */
export function backendPublicUrl(): string {
  return (process.env.PUBLIC_BACKEND_URL ?? `http://127.0.0.1:${process.env.PORT ?? 25000}`).replace(/\/+$/, "");
}

/** 执行进度回传令牌（X-API-Key，与 Runner env API_KEY 一致） */
function runnerApiKey(): string {
  return process.env.API_KEY ?? "brickcore-runner-secret";
}

/** 构造执行派发 payload（注入 callback：progress 回 /internal/runner/progress） */
export function buildSuitePayload(input: {
  executionId: number;
  runId: string;
  taskName: string;
  steps: unknown[];
  env?: Record<string, unknown>;
}): SuitePayload {
  const steps = input.steps as RunnerStep[];
  const backend = backendPublicUrl();
  return {
    suite_execution_id: input.executionId,
    env: input.env ?? {},
    suite: {
      suite_execution_id: input.executionId,
      name: input.taskName,
      cases: [
        {
          execution_id: input.executionId,
          name: input.taskName,
          steps,
        },
      ],
    },
    callback: {
      report_url: `${backend}/internal/runner/progress`,
      progress_url: `${backend}/internal/runner/progress`,
      api_key: runnerApiKey(),
    },
  };
}

async function runnerFetch(path: string, init?: RequestInit): Promise<unknown> {
  const resp = await fetch(`${runnerUrl()}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`Runner ${path} 响应 ${resp.status}`);
  return resp.json();
}

/** 派发执行（Runner 异步执行，立即返回） */
export async function dispatchRun(payload: SuitePayload): Promise<{ taskId: string }> {
  const result = (await runnerFetch("/run", {
    method: "POST",
    body: JSON.stringify(payload),
  })) as { task_id?: string };
  return { taskId: String(result?.task_id ?? "") };
}

/** 停止单个执行 */
export async function stopExecution(executionId: number): Promise<void> {
  try {
    await runnerFetch(`/stop/${executionId}`, { method: "POST" });
  } catch {
    /* Runner 不可达/已结束时忽略 */
  }
}

/** 停止全部（服务关闭兜底） */
export async function stopAllExecutions(): Promise<void> {
  try {
    await runnerFetch("/stop/all", { method: "POST" });
  } catch {
    /* pass */
  }
}

export interface RunnerHealth {
  runner_id?: string;
  status?: string;
  running_tasks?: number;
  max_concurrent?: number;
  browser_ready?: boolean;
}

/** 健康检查（E3：Runner 不可达检测） */
export async function runnerHealth(): Promise<RunnerHealth | null> {
  try {
    return (await runnerFetch("/health")) as RunnerHealth;
  } catch {
    return null;
  }
}
