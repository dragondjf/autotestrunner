import { describe, it, expect } from "vitest";
import { Mutex } from "../src/utils/mutex.js";

describe("Mutex（对齐 asyncio.Lock）", () => {
  it("未持有时 locked=false，acquire 后 locked=true", async () => {
    const m = new Mutex();
    expect(m.locked).toBe(false);
    await m.acquire();
    expect(m.locked).toBe(true);
    m.release();
    expect(m.locked).toBe(false);
  });

  it("并发 acquire 串行化（所有权转移）", async () => {
    const m = new Mutex();
    const order: number[] = [];
    const task = async (id: number) => {
      await m.acquire();
      order.push(id);
      await new Promise((r) => setTimeout(r, 10));
      m.release();
    };
    await Promise.all([task(1), task(2), task(3)]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("busy 检测语义：locked 时新 acquire 不立即执行", async () => {
    const m = new Mutex();
    await m.acquire();
    let entered = false;
    const p = m.acquire().then(() => {
      entered = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(entered).toBe(false);
    m.release();
    await p;
    expect(entered).toBe(true);
  });

  it("runExclusive 正常与异常路径都释放", async () => {
    const m = new Mutex();
    await expect(
      m.runExclusive(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(m.locked).toBe(false);
    const v = await m.runExclusive(() => 42);
    expect(v).toBe(42);
  });
});
