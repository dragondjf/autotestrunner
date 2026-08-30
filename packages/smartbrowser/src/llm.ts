/**
 * OpenAI 兼容的 LLM 调用封装。
 * 1:1 对照 smartbrowser/src/smartbrowser/llm.py。
 *
 * 环境变量（不传 config 时的默认来源）：
 *   LLM_BASE_URL  默认 https://api.openai.com/v1
 *   LLM_API_KEY
 *   LLM_MODEL     默认 gpt-4o-mini
 */
import { RETRYABLE_HTTP_STATUS, retryAsync } from "@brickcore/shared";

export interface LLMConfig {
  base_url: string;
  api_key: string;
  model: string;
  temperature: number;
  timeout: number;
  max_tokens: number | null;
  extra_headers: Record<string, string>;
}

export interface LLMCallResult {
  content: string;
  tokens: number;
}

/** 符合 smartbrowser 约定签名的 call_llm 类型：async (system, user) => {content, tokens} */
export type LLMCallFn = (system: string, user: string) => Promise<LLMCallResult>;

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";

export class LLMStatusError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`LLM HTTP ${status}: ${body.slice(0, 500)}`);
    this.name = "LLMStatusError";
  }
}

/** 对齐 LLMConfig dataclass 默认值 */
export function makeLLMConfig(overrides: Partial<LLMConfig> = {}): LLMConfig {
  return {
    base_url: DEFAULT_BASE_URL,
    api_key: "",
    model: DEFAULT_MODEL,
    temperature: 0.0,
    timeout: 60.0,
    max_tokens: null,
    extra_headers: {},
    ...overrides,
  };
}

/** 对齐 LLMConfig.from_env：环境变量为底，overrides 优先 */
export function llmConfigFromEnv(overrides: Partial<LLMConfig> = {}): LLMConfig {
  return makeLLMConfig({
    base_url: process.env.LLM_BASE_URL || DEFAULT_BASE_URL,
    api_key: process.env.LLM_API_KEY || "",
    model: process.env.LLM_MODEL || DEFAULT_MODEL,
    ...overrides,
  });
}

/** base_url 规范化为 /chat/completions 端点（容忍带/不带末尾斜杠） */
export function defaultEndpoint(cfg: LLMConfig): string {
  const base = (cfg.base_url || "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("LLMConfig.base_url 不能为空");
  return `${base}/chat/completions`;
}

export function extractTokens(payload: any): number {
  const usage = payload?.usage ?? {};
  const total = usage.total_tokens;
  if (total !== undefined && total !== null) return parseInt(total, 10);
  const prompt = usage.prompt_tokens || 0;
  const completion = usage.completion_tokens || 0;
  return parseInt(prompt, 10) + parseInt(completion, 10);
}

export interface CreateLlmCallOptions {
  /** 遇到限流/服务端错误/超时/网络错误时的最大重试次数（默认 3） */
  maxRetries?: number;
  /** 退避基数（秒），第 n 次重试前等待 (n+1) * retryBackoff（默认 1.0） */
  retryBackoff?: number;
  /** 测试注入的 fetch 实现 */
  fetchImpl?: typeof fetch;
  /** 测试注入的 base config（等价 transport 注入位） */
  config?: LLMConfig | null;
}

function buildHeaders(cfg: LLMConfig): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.api_key) headers["Authorization"] = `Bearer ${cfg.api_key}`;
  for (const [k, v] of Object.entries(cfg.extra_headers || {})) {
    headers[String(k)] = String(v);
  }
  return headers;
}

/** 重试判定：可重试状态码 / 网络·超时错误 → 重试；其余 4xx 与 JSON 解析失败 → 直接抛出 */
function isRetryableLlmError(err: unknown): boolean {
  if (err instanceof LLMStatusError) return RETRYABLE_HTTP_STATUS.has(err.status);
  if (err instanceof SyntaxError) return false; // resp.json() 失败，对齐 Python 不重试
  return true; // fetch TypeError（网络）/ AbortError（超时）等传输层错误
}

export function createLlmCall(
  config?: LLMConfig | null,
  options: CreateLlmCallOptions = {},
): LLMCallFn {
  const cfg = config ?? options.config ?? llmConfigFromEnv();
  const maxRetries = options.maxRetries ?? 3;
  const retryBackoff = options.retryBackoff ?? 1.0;
  const fetchImpl = options.fetchImpl ?? fetch;

  return async function callLlm(system: string, user: string): Promise<LLMCallResult> {
    const headers = buildHeaders(cfg);
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: cfg.temperature,
    };
    if (cfg.max_tokens !== null && cfg.max_tokens !== undefined) {
      body["max_tokens"] = cfg.max_tokens;
    }
    const endpoint = defaultEndpoint(cfg);

    const payload = await retryAsync(
      async () => {
        const resp = await fetchImpl(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(cfg.timeout * 1000),
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          throw new LLMStatusError(resp.status, text);
        }
        return (await resp.json()) as any;
      },
      { retries: maxRetries, backoffSeconds: retryBackoff, isRetryable: isRetryableLlmError },
    );

    let content: unknown;
    try {
      content = payload["choices"][0]["message"]["content"];
    } catch {
      throw new Error(`LLM 响应缺少 choices[0].message.content: ${JSON.stringify(payload)}`);
    }
    if (typeof content !== "string" && content !== null) {
      // content 键缺失（undefined）对齐 Python KeyError → 抛错；null/字符串放行
      if (content === undefined) {
        throw new Error(`LLM 响应缺少 choices[0].message.content: ${JSON.stringify(payload)}`);
      }
    }

    return {
      content: (content as string) || "",
      tokens: extractTokens(payload),
    };
  };
}

export interface CreateLlmStreamOptions {
  fetchImpl?: typeof fetch;
  config?: LLMConfig | null;
}

/**
 * 构造 token 流式 async generator：`for await (const token of createLlmStream()(system, user))`。
 * 基于 OpenAI 兼容 /chat/completions 的 SSE（stream=true），逐段 yield delta content。
 */
export function createLlmStream(
  config?: LLMConfig | null,
  options: CreateLlmStreamOptions = {},
): (system: string, user: string) => AsyncGenerator<string> {
  const cfg = config ?? options.config ?? llmConfigFromEnv();
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = defaultEndpoint(cfg);

  return async function* llmStream(system: string, user: string): AsyncGenerator<string> {
    const headers = buildHeaders(cfg);
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: cfg.temperature,
      stream: true,
    };
    if (cfg.max_tokens !== null && cfg.max_tokens !== undefined) {
      body["max_tokens"] = cfg.max_tokens;
    }

    const resp = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeout * 1000),
    });
    if (!resp.ok) {
      throw new LLMStatusError(resp.status, await resp.text().catch(() => ""));
    }

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice("data:".length).trim();
        if (data === "[DONE]") {
          done = true;
          break;
        }
        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        let delta: string;
        try {
          delta = parsed["choices"][0]["delta"]["content"] || "";
        } catch {
          continue;
        }
        if (delta) yield delta;
      }
    }
  };
}
