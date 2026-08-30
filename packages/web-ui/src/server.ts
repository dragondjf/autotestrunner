/**
 * web-ui 服务入口（端口 PORT，默认 25000；HOST 默认 0.0.0.0）。
 * 对齐 core.py 的 lifespan：启动空闲会话回收后台任务；应用关闭时回收所有会话。
 */
import { createApp } from "./app.js";
import { closeSession, startSessionGc } from "./agent-runner.js";
import { attachInspectWebSocket, closeAllInspectSessions, startInspectGc } from "./routes/inspect.routes.js";
import { SESSIONS } from "./state.js";
import { onShutdown, runShutdown } from "./shutdown.js";
import { logger } from "./logging.js";
import { runMigrations } from "./db/migrate.js";
import { closeDb } from "./db/connection.js";
import { startCronScheduler, stopCronScheduler } from "./services/plan-executor.js";
import { startRetentionScheduler, stopRetentionScheduler } from "./services/retention-cleaner.js";
import { stopAllExecutions } from "./services/runner-client.js";
import { recoverInterruptedRuns } from "./services/recovery.js";

const PORT = Number(process.env.PORT ?? 25000);
const HOST = process.env.HOST ?? "0.0.0.0";

export async function startServer(port = PORT, host = HOST): Promise<{ port: number; close: () => Promise<void> }> {
  // 启动即应用数据库迁移（幂等；llm_configs.json 自动搬迁）+ 重启恢复
  const ran = runMigrations();
  if (ran.length) logger.info("[server] 已应用数据库迁移: %s", ran.join(","));
  recoverInterruptedRuns();

  const app = createApp();
  const server = app.listen(port, host, () => {
    logger.info("[server] AutoTest Runner 已启动: http://%s:%s （管理台 /app）", host, String(port));
  });

  // 每 30 秒回收空闲会话（对齐 _gc_sessions）；inspect 会话每 60 秒回收（B2 空闲超时）
  const gcTimer = startSessionGc(30000);
  const inspectGcTimer = startInspectGc(60000);
  // Cron 定时调度（PLN-06，每分钟 tick）+ 报告保留清理（RPT-06，默认每日 02:00）
  const cronTimer = startCronScheduler(60_000);
  const retentionTimer = startRetentionScheduler(60_000);
  attachInspectWebSocket(server);
  // 应用关闭时回收全部 inspect 会话（落盘 + 关浏览器）
  onShutdown(closeAllInspectSessions);
  // 停止 Runner 残留执行 + 调度器 + 数据库连接（WAL checkpoint）
  onShutdown(() => stopAllExecutions());
  onShutdown(() => stopCronScheduler());
  onShutdown(() => stopRetentionScheduler());
  onShutdown(() => closeDb());

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info("[server] 收到 %s，正在关闭会话…", signal);
    clearInterval(gcTimer);
    clearInterval(inspectGcTimer);
    clearInterval(cronTimer);
    clearInterval(retentionTimer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // 回收所有会话（persist 由各清理钩子负责）
    for (const sid of Array.from(SESSIONS.keys())) {
      await closeSession(sid);
    }
    await runShutdown();
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT").finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM").finally(() => process.exit(0));
  });

  return {
    port,
    close: async () => {
      await shutdown("MANUAL");
    },
  };
}

// 直接执行时启动
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!)) {
  void startServer();
}
