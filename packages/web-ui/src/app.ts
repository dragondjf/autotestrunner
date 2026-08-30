/**
 * Express 应用装配。
 * 1:1 对照 agent_web_ui/server_pkg/core.py 的 app 实例与中间件：
 *   - /static → node-backend/static（smartbrowser 截图）
 *   - /assets → packages/web-ui/frontend/assets（前端模块化资源）
 *   - /assets/* 响应强制 Cache-Control: no-cache
 *   - 错误响应体 {"detail": ...}、未匹配路由 404 {"detail": "Not Found"}
 */
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { ASSETS_DIR, STATIC_DIR } from "./paths.js";
import { pageRouter } from "./routes/page.routes.js";
import { execRouter } from "./routes/exec.routes.js";
import { agentRouter } from "./routes/agent.routes.js";
import { inspectRouter } from "./routes/inspect.routes.js";
import { projectRouter } from "./routes/project.routes.js";
import { uploadRouter } from "./routes/upload.routes.js";
import { taskRouter } from "./routes/task.routes.js";
import { planRouter } from "./routes/plan.routes.js";
import { reportRouter } from "./routes/report.routes.js";
import { configRouter } from "./routes/config.routes.js";
import { dashboardRouter } from "./routes/dashboard.routes.js";
import { fileRouter } from "./routes/file.routes.js";
import { runRouter } from "./routes/run.routes.js";
import { internalRouter } from "./routes/internal.routes.js";
import { recordRouter } from "./routes/record.routes.js";
import { debugWorkbenchRouter } from "./routes/debug-workbench.routes.js";
import { bizErrorMiddleware } from "./api/respond.js";
import { errorMiddleware, notFoundMiddleware } from "./http-error.js";

export function createApp(): Express {
  const app = express();

  // FastAPI 依据参数类型解析 JSON body；这里统一解析，非法 JSON 转 400
  app.use(express.json({ limit: "50mb" }));

  // 开发期强制 /assets 资源 revalidate(no-cache)，避免前端改动后浏览器缓存旧 JS/CSS
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/assets/")) {
      res.setHeader("Cache-Control", "no-cache");
    }
    next();
  });

  app.use("/static", express.static(STATIC_DIR));
  app.use("/assets", express.static(ASSETS_DIR));

  app.use(pageRouter);
  app.use(execRouter);
  app.use(agentRouter);
  app.use(inspectRouter);
  app.use(projectRouter);
  app.use(uploadRouter);
  app.use(taskRouter);
  app.use(planRouter);
  app.use(reportRouter);
  app.use(configRouter);
  app.use(dashboardRouter);
  app.use(runRouter);
  app.use(fileRouter);
  app.use(recordRouter);
  app.use(debugWorkbenchRouter);
  // 内部回调（Runner → Backend）挂在最后：404 之前、带独立鉴权
  app.use(internalRouter);

  app.use(notFoundMiddleware);
  // BizError（新业务路由 {code,message,data} 包络）优先于通用 {detail} 错误中间件
  app.use(bizErrorMiddleware);
  app.use(errorMiddleware);

  return app;
}
