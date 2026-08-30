import { describe, it, expect } from "vitest";
import { StopSignal } from "../src/utils/stop-signal.js";

describe("StopSignal（对齐 asyncio.Event）", () => {
  it("set 后 isSet=true，wait 立即返回", async () => {
    const s = new StopSignal();
    expect(s.isSet).toBe(false);
    s.set();
    expect(s.isSet).toBe(true);
    await s.wait(); // 已置位立即 resolve
  });

  it("wait 挂起直到 set", async () => {
    const s = new StopSignal();
    const p = s.wait();
    let done = false;
    p.then(() => (done = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    s.set();
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(true);
  });

  it("set 幂等且唤醒全部等待者", async () => {
    const s = new StopSignal();
    const p1 = s.wait();
    const p2 = s.wait();
    s.set();
    s.set();
    await Promise.all([p1, p2]);
  });
});
