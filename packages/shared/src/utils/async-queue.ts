/**
 * AsyncQueue —— 对齐 asyncio.Queue（无界）语义。
 *
 * 对照点（agent_routes SSE 泵 / inspect_routes 帧流）：
 * - put() = put_nowait
 * - get(timeoutMs) 对齐 asyncio.wait_for(queue.get(), timeout)，超时抛 QueueTimeoutError
 *   （Python 端 0.5s / 1s 轮询模式：超时视为"暂无事件"，继续循环；Node 端调用方 catch 处理）
 */
export class QueueTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`queue.get timeout after ${timeoutMs}ms`);
    this.name = "QueueTimeoutError";
  }
}

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Waiter<T>[] = [];

  get size(): number {
    return this.items.length;
  }

  /** put_nowait：有等待者时直接交付，否则入队 */
  put(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(item);
      return;
    }
    this.items.push(item);
  }

  /**
   * 取出一个元素；队列为空时挂起等待。
   * @param timeoutMs 超时毫秒数；超时抛 QueueTimeoutError（不消费元素）
   */
  async get(timeoutMs?: number): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) return item;

    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter<T> = { resolve, reject };
      if (timeoutMs !== undefined && timeoutMs > 0) {
        const timer = setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new QueueTimeoutError(timeoutMs));
        }, timeoutMs);
        timer.unref();
        waiter.timer = timer;
      }
      this.waiters.push(waiter);
    });
  }

  /** 清空队列（对齐 asyncio.Queue 无该方法，但 Node 侧清理用；不影响契约） */
  clear(): void {
    this.items = [];
  }
}
