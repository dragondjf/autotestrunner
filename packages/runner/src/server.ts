/**
 * Runner HTTP 服务入口（Express）。
 * 1:1 对照 brick_runner_http/runner_server.py（9 个端点 + 注册/心跳 + lifespan）。
 */
import express, { type Express } from "express";
import { pathToFileURL } from "node:url";
import type { SuitePayload } from "@brickcore/shared";
import { settings } from "@brickcore/shared";
import { ExecutionEngine } from "./engine.js";
import { recordingManager } from "./recording.js";
import { debugSessionManager } from "./debug-session.js";

export const engine = new ExecutionEngine();

/** 定期向 Backend 发送心跳（携带完整注册信息，便于 Backend 重启后重建 Runner） */
export async function heartbeatLoop(intervalSeconds = settings.heartbeatInterval): Promise<void> {
  while (true) {
    try {
      const resp = await fetch(settings.heartbeatUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": settings.apiKey },
        body: JSON.stringify({
          runner_id: settings.runnerId,
          running_tasks: engine.runningCount(),
          status: "online",
          host: settings.runnerHost,
          port: settings.runnerPort,
          version: settings.runnerVersion,
          max_concurrent: settings.maxConcurrent,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (resp.status !== 200) {
        console.warn(`心跳回传异常: status=${resp.status}`);
      }
    } catch (e) {
      console.debug(`心跳失败 (Backend 可能未就绪): ${e instanceof Error ? e.message : e}`);
    }
    await new Promise((r) => setTimeout(r, intervalSeconds * 1000));
  }
}

/** 注册到 Backend（失败仅告警） */
export async function registerToBackend(): Promise<void> {
  try {
    const resp = await fetch(settings.registerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": settings.apiKey },
      body: JSON.stringify({
        runner_id: settings.runnerId,
        host: settings.runnerHost,
        port: settings.runnerPort,
        version: settings.runnerVersion,
        max_concurrent: settings.maxConcurrent,
      }),
      signal: AbortSignal.timeout(10000),
    });
    console.info(`注册到 Backend: status=${resp.status}`);
  } catch (e) {
    console.warn(`注册失败 (Backend 未就绪时可忽略): ${e instanceof Error ? e.message : e}`);
  }
}

export function createRunnerApp(): Express {
  const app = express();
  app.use(express.json({ limit: "50mb" }));

  app.post("/run", (req, res) => {
    void (async () => {
      const taskId = await engine.execute(req.body as SuitePayload);
      res.json({ task_id: taskId, status: "accepted" });
    })();
  });

  // 注意：/stop/all 必须先于 /stop/:execution_id 注册（对齐 FastAPI 定义顺序）
  app.post("/stop/all", (_req, res) => {
    const count = engine.signalStopAll();
    res.json({ status: "stopping", stopped: count });
  });

  app.post("/stop/:execution_id", (req, res) => {
    void (async () => {
      /** 停止执行（套件用 suite_execution_id；单用例/调试执行用 case_execution_id） */
      await engine.signalStop(Number(req.params.execution_id));
      res.json({ status: "stopping" });
    })();
  });

  app.get("/health", (_req, res) => {
    res.json(engine.health());
  });

  app.post("/record/start", (req, res) => {
    void (async () => {
      res.json(await recordingManager.start(req.body ?? {}));
    })();
  });

  app.post("/record/:record_session_id/stop", (req, res) => {
    void (async () => {
      res.json(await recordingManager.stop(Number(req.params.record_session_id)));
    })();
  });

  app.post("/record/:record_session_id/control", (req, res) => {
    void (async () => {
      const body = (req.body ?? {}) as Record<string, any>;
      res.json(
        await recordingManager.control(Number(req.params.record_session_id), String(body["command"] ?? ""), {
          var_name: body["var_name"],
          source: body["source"] || "text",
          frame_url: body["frame_url"],
          frame_name: body["frame_name"],
          slot_id: body["slot_id"],
        }),
      );
    })();
  });

  app.post("/debug/session/start", (req, res) => {
    void (async () => {
      res.json(await debugSessionManager.start(req.body ?? {}));
    })();
  });

  app.post("/debug/session/:debug_session_id/stop", (req, res) => {
    void (async () => {
      res.json(await debugSessionManager.stop(Number(req.params.debug_session_id)));
    })();
  });

  // 未匹配路由：对齐 FastAPI 默认 {"detail": "Not Found"}
  app.use((_req, res) => {
    res.status(404).json({ detail: "Not Found" });
  });

  return app;
}

export async function startRunnerServer(
  port = settings.runnerPort,
  host = settings.runnerHost,
): Promise<{ port: number; close: () => Promise<void> }> {
  const app = createRunnerApp();
  const server = app.listen(port, host, () => {
    console.info(`[runner] BrickCore HTTP Runner 启动: http://${host}:${port}`);
  });

  // 启动: 初始化 Playwright 浏览器
  await engine.start();
  // 注册到 Backend
  await registerToBackend();
  // 启动心跳
  let heartbeatStopped = false;
  void (async () => {
    while (!heartbeatStopped) {
      await heartbeatLoop().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    heartbeatStopped = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await engine.shutdown();
    await recordingManager.shutdown();
    await debugSessionManager.shutdown();
  };

  process.on("SIGINT", () => {
    void close().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void close().finally(() => process.exit(0));
  });

  return { port, close };
}

// 直接执行时启动（node server.ts / tsx src/server.ts）
const invokedSelf =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedSelf) {
  void startRunnerServer();
}
