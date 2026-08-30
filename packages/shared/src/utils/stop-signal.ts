/**
 * StopSignal —— 对齐 asyncio.Event 语义（stop_events / recording._stop / debug_session）。
 */
export class StopSignal {
  private flag = false;
  private waiters: Array<() => void> = [];

  /** event.set()：置位并唤醒全部等待者（幂等） */
  set(): void {
    if (this.flag) return;
    this.flag = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  /** event.is_set() */
  get isSet(): boolean {
    return this.flag;
  }

  /** event.wait()：已置位立即返回，否则挂起 */
  wait(): Promise<void> {
    if (this.flag) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}
