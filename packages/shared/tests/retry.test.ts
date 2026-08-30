import { describe, it, expect, vi } from "vitest";
import { retryAsync, sleep, RETRYABLE_HTTP_STATUS } from "../src/utils/retry.js";

describe("retryAsync（对齐 create_llm_call 重试规则）", () => {
  it("成功则不重试", async () => {
    let calls = 0;
    const r = await retryAsync(
      async () => {
        calls++;
        return "ok";
      },
      { retries: 3, backoffSeconds: 0, isRetryable: () => true },
    );
    expect(r).toBe("ok");
    expect(calls).toBe(1);
  });

  it("可重试错误按 (attempt+1)*backoff 退避，共 retries+1 次", async () => {
    let calls = 0;
    const onRetry = vi.fn();
    const p = retryAsync(
      async () => {
        calls++;
        throw new Error("503");
      },
      { retries: 2, backoffSeconds: 0.01, isRetryable: () => true, onRetry },
    );
    await expect(p).rejects.toThrow("503");
    expect(calls).toBe(3); // 1 + 2 retries
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]?.[2]).toBe(10); // 1 * 0.01s = 10ms
    expect(onRetry.mock.calls[1]?.[2]).toBe(20); // 2 * 0.01s = 20ms
  });

  it("不可重试错误立即抛出", async () => {
    let calls = 0;
    await expect(
      retryAsync(
        async () => {
          calls++;
          throw new Error("401 unauthorized");
        },
        { retries: 3, backoffSeconds: 0, isRetryable: () => false },
      ),
    ).rejects.toThrow("401");
    expect(calls).toBe(1);
  });
});

describe("RETRYABLE_HTTP_STATUS（llm.py 可重试状态码）", () => {
  it("包含 408/425/429/500/502/503/504，不含 400/401/403/404/422", () => {
    for (const s of [408, 425, 429, 500, 502, 503, 504]) {
      expect(RETRYABLE_HTTP_STATUS.has(s)).toBe(true);
    }
    for (const s of [400, 401, 403, 404, 422]) {
      expect(RETRYABLE_HTTP_STATUS.has(s)).toBe(false);
    }
  });
});

describe("sleep", () => {
  it("等待指定毫秒", async () => {
    const start = Date.now();
    await sleep(30);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });
});
