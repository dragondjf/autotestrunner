/**
 * 通用重试 + sleep。
 *
 * 对照点（smartbrowser llm.py create_llm_call）：
 * - 仅 408/425/429/500/502/503/504 与超时/网络错误可重试
 * - 退避 (attempt+1) * backoffSeconds 秒，共 maxRetries+1 次尝试
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 可重试的 HTTP 状态码（smartbrowser llm.py RETRYABLE_STATUS） */
export const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface RetryOptions {
  /** 最大重试次数（总尝试 = retries + 1） */
  retries: number;
  /** 基础退避秒数：第 n 次重试等待 (n)*backoffSeconds */
  backoffSeconds: number;
  /** 判断错误是否可重试 */
  isRetryable: (err: unknown) => boolean;
  /** 重试前回调（日志用） */
  onRetry?: (err: unknown, attempt: number, waitMs: number) => void;
}

export async function retryAsync<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === opts.retries || !opts.isRetryable(err)) break;
      const waitMs = (attempt + 1) * opts.backoffSeconds * 1000;
      opts.onRetry?.(err, attempt, waitMs);
      await sleep(waitMs);
    }
  }
  throw lastErr;
}
