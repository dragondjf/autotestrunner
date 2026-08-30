/**
 * Mutex —— 对齐 asyncio.Lock / threading.Lock 语义。
 *
 * 对照点（agent_web_ui core.py / inspect_routes.py）：
 * - `lock.locked()` 判断忙（session_lock.locked() → 409/提示）
 * - acquire() 挂起等待、release() 释放（所有权转移给队首等待者）
 */
export class Mutex {
  private _locked = false;
  private queue: Array<() => void> = [];

  /** 是否已被持有（对齐 asyncio.Lock.locked()） */
  get locked(): boolean {
    return this._locked;
  }

  /** 获取锁（已持有时挂起排队） */
  async acquire(): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  /** 释放锁；有等待者时所有权直接转移 */
  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this._locked = false;
  }

  /** 以独占方式执行 fn，结束后释放 */
  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
