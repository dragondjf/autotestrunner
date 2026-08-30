/**
 * 页面与 LLM 配置 CRUD 路由。
 * 1:1 对照 agent_web_ui/server_pkg/page_routes.py。
 */
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { createLlmCall } from "@brickcore/smartbrowser";
import { CODE_GENERATOR_JS, INDEX_HTML, APP_HTML } from "../paths.js";
import {
  FALLBACK_CONFIG,
  LLM_PROVIDERS,
  applyDefaultRule,
  loadConfigs,
  normalizeCfg,
  publicCfg,
  runtimeLlmConfig,
  saveConfigs,
  type LlmConfigRecord,
} from "../config-store.js";
import { HttpError, httpError, readJsonBody, wrap } from "../http-error.js";

export const pageRouter: Router = Router();

// ---------------- 页面 ----------------
pageRouter.get(
  "/",
  wrap((_req, res) => {
    res.sendFile(INDEX_HTML);
  }),
);

pageRouter.get(
  "/session/:session_id",
  wrap((_req, res) => {
    /** SPA 深链：按会话 id 直达页面（URL 体现当前会话，刷新后可重载对应历史）。 */
    res.sendFile(INDEX_HTML);
  }),
);

pageRouter.get(
  "/code-generator.js",
  wrap((_req, res) => {
    res.sendFile(CODE_GENERATOR_JS);
  }),
);

// 管理台（AutoTest Console：看板/项目/任务/计划/报告/监控，真实 API 数据）
pageRouter.get(
  "/app",
  wrap((_req, res) => {
    res.sendFile(APP_HTML);
  }),
);

// ---------------- LLM 配置 CRUD ----------------
pageRouter.get(
  "/api/llm-configs",
  wrap((_req, res) => {
    // 注意：1:1 保留 Python 行为——列表返回原始配置（含明文 api_key，不做掩码）
    res.json(loadConfigs());
  }),
);

pageRouter.get(
  "/api/llm-configs/options",
  wrap((_req, res) => {
    res.json(LLM_PROVIDERS);
  }),
);

pageRouter.post(
  "/api/llm-configs",
  wrap(async (req, res) => {
    const raw = await readJsonBody(req);
    let cfg: LlmConfigRecord;
    try {
      cfg = normalizeCfg(raw);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
    cfg["id"] = "cfg_" + randomUUID().replace(/-/g, "").slice(0, 8);
    const configs = loadConfigs();
    if (cfg["is_default"]) {
      applyDefaultRule(configs, "__none__");
    }
    configs.push(cfg);
    applyDefaultRule(configs, null);
    saveConfigs(configs);
    res.status(201).json(publicCfg(cfg));
  }),
);

pageRouter.put(
  "/api/llm-configs/:cid",
  wrap(async (req, res) => {
    const raw = await readJsonBody(req);
    const cid = req.params.cid!;
    const configs = loadConfigs();
    const existing = configs.find((c) => c["id"] === cid) ?? null;
    if (existing === null) throw httpError(404, "配置不存在");
    let updated: LlmConfigRecord;
    try {
      updated = normalizeCfg(raw, existing);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
    updated["id"] = cid;
    const next = configs.filter((c) => c["id"] !== cid);
    next.push(updated);
    applyDefaultRule(next, updated["is_default"] ? cid : null);
    saveConfigs(next);
    res.json(publicCfg(updated));
  }),
);

pageRouter.delete(
  "/api/llm-configs/:cid",
  wrap((req, res) => {
    const cid = req.params.cid!;
    const configs = loadConfigs();
    const filtered = configs.filter((c) => c["id"] !== cid);
    if (filtered.length === configs.length) throw httpError(404, "配置不存在");
    applyDefaultRule(filtered, null);
    saveConfigs(filtered);
    res.json({ ok: true });
  }),
);

pageRouter.post(
  "/api/llm-configs/:cid/toggle",
  wrap((req, res) => {
    const cid = req.params.cid!;
    const configs = loadConfigs();
    const target = configs.find((c) => c["id"] === cid) ?? null;
    if (target === null) throw httpError(404, "配置不存在");
    target["enabled"] = !Boolean(target["enabled"] ?? true);
    if (target["enabled"] && !configs.some((c) => c["is_default"])) {
      target["is_default"] = true;
    }
    if (!target["enabled"] && target["is_default"]) {
      target["is_default"] = false;
      applyDefaultRule(configs, null);
    }
    saveConfigs(configs);
    res.json(publicCfg(target));
  }),
);

pageRouter.post(
  "/api/llm-configs/:cid/default",
  wrap((req, res) => {
    const cid = req.params.cid!;
    const configs = loadConfigs();
    const target = configs.find((c) => c["id"] === cid) ?? null;
    if (target === null) throw httpError(404, "配置不存在");
    if (!target["enabled"]) throw httpError(400, "请先启用该配置再设为默认");
    applyDefaultRule(configs, cid);
    saveConfigs(configs);
    res.json(publicCfg(target));
  }),
);

pageRouter.post(
  "/api/llm-configs/:cid/test",
  wrap(async (req, res) => {
    /** 连通性测试：用该配置发一条极小的 chat 请求，返回成功/失败+耗时。 */
    const cid = req.params.cid!;
    const configs = loadConfigs();
    const target = configs.find((c) => c["id"] === cid) ?? null;
    if (target === null) throw httpError(404, "配置不存在");
    const baseUrl = String(target["base_url"] ?? "").trim() || FALLBACK_CONFIG["base_url"];
    const cfg = {
      base_url: baseUrl as string,
      api_key: String(target["api_key"] ?? "").trim(),
      model: (String(target["model"] ?? "").trim() || FALLBACK_CONFIG["model"]) as string,
      temperature: Number(target["temperature"] ?? 0.7),
      max_tokens: Number.parseInt(String(target["max_tokens"] ?? 8192), 10),
      timeout: Number(target["timeout"] ?? 120),
      extra_headers: {},
    };
    const t0 = performance.now();
    try {
      const callLlm = createLlmCall(cfg);
      const payload = await callLlm(
        "你是连通性测试助手，请只回复：OK",
        "这是一条连通性测试消息，请直接回复 OK。",
      );
      const latencyMs = Math.trunc(performance.now() - t0);
      res.json({
        ok: true,
        latency_ms: latencyMs,
        model: cfg.model,
        sample: String(payload.content ?? "").slice(0, 60),
      });
    } catch (exc) {
      const latencyMs = Math.trunc(performance.now() - t0);
      res.json({
        ok: false,
        latency_ms: latencyMs,
        model: cfg.model,
        error: exc instanceof Error ? exc.message : String(exc),
      });
    }
  }),
);

// runtimeLlmConfig 在此引用仅为保持与 core 的导入语义一致（运行时配置组装入口）
void runtimeLlmConfig;
