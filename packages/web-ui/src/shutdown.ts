/**
 * 关闭钩子注册表（对齐 FastAPI lifespan 的 finally 段）。
 * 各路由模块可注册清理逻辑（如 inspect 会话落盘关闭），由 server.ts 统一触发。
 */
type ShutdownHandler = () => Promise<void> | void;

const handlers: ShutdownHandler[] = [];

export function onShutdown(fn: ShutdownHandler): void {
  handlers.push(fn);
}

/** 逆序执行所有关闭钩子 */
export async function runShutdown(): Promise<void> {
  while (handlers.length) {
    const fn = handlers.pop()!;
    try {
      await fn();
    } catch {
      /* pass */
    }
  }
}
