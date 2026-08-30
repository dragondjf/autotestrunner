import { describe, it, expect } from "vitest";
import { AsyncQueue, QueueTimeoutError } from "../src/utils/async-queue.js";

describe("AsyncQueue（对齐 asyncio.Queue）", () => {
  it("put 后 get 按 FIFO 取出", async () => {
    const q = new AsyncQueue<number>();
    q.put(1);
    q.put(2);
    expect(await q.get()).toBe(1);
    expect(await q.get()).toBe(2);
    expect(q.size).toBe(0);
  });

  it("队列为空时 get 挂起，put 唤醒等待者", async () => {
    const q = new AsyncQueue<string>();
    const p = q.get(); // 挂起
    let resolved: string | undefined;
    p.then((v) => (resolved = v));
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBeUndefined();
    q.put("hello");
    expect(await p).toBe("hello");
  });

  it("get(timeoutMs) 超时抛 QueueTimeoutError", async () => {
    const q = new AsyncQueue<number>();
    await expect(q.get(30)).rejects.toThrow(QueueTimeoutError);
  });

  it("超时后等待者被移除，之后 put 的元素不被消费", async () => {
    const q = new AsyncQueue<number>();
    await expect(q.get(10)).rejects.toThrow(QueueTimeoutError);
    q.put(7); // 超时之后才到达
    expect(await q.get()).toBe(7);
    expect(q.size).toBe(0);
  });

  it("put 直接交付等待者（不经过队列）", async () => {
    const q = new AsyncQueue<number>();
    const p = q.get(1000);
    q.put(42);
    expect(await p).toBe(42);
    expect(q.size).toBe(0);
  });
});
