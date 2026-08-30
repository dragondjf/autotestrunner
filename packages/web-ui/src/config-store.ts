/**
 * LLM 配置存储与运行时配置组装。
 * 1:1 对照 agent_web_ui/server_pkg/core.py 的
 * _load_configs / _save_configs / _mask_key / _public_cfg / _normalize_cfg /
 * _apply_default_rule / _find_active_config / _runtime_llm_config。
 * 存储已迁移至 SQLite（llm_configs 表，docs/需求设计/数据库与API设计.md §1.4）；
 * loadConfigs/saveConfigs 签名保持不变，page.routes.ts 调用方零改动。
 */
import type { LLMConfig } from "@brickcore/smartbrowser";
import {
  listLlmConfigs,
  llmDbRowToRecord,
  replaceLlmConfigs,
} from "./db/dao/configs.js";
import { ensureMigrated } from "./db/ensure.js";

export type LlmConfigRecord = Record<string, any>;

/** 内置兜底配置：仅当配置存储为空（从未新增过）时使用，保证开箱可跑。 */
export const FALLBACK_CONFIG: LlmConfigRecord = {
  name: "内置默认",
  provider: "自定义",
  api_key: "sk-tp-NzUwLTExMjc2OTE5NTU3LTE3ODcxOTA4NDYyOTI=",
  base_url: "https://api.scnet.cn/api/llm/v1",
  model: "DeepSeek-V4-Flash",
  temperature: 0.1,
  max_tokens: 8192,
  timeout: 120,
  thinking: false,
  is_default: true,
  enabled: true,
};

export const LLM_PROVIDERS = ["通义千问", "DeepSeek", "智谱", "月之暗面", "OpenAI", "自定义"];

export const DEFAULT_START_URL = "http://localhost:8000/#/login";

/** 对齐 Python threading.Lock：单线程事件循环内同步写入即可保证串行 */

export function loadConfigs(): LlmConfigRecord[] {
  try {
    ensureMigrated();
    return listLlmConfigs().map(llmDbRowToRecord);
  } catch {
    return [];
  }
}

export function saveConfigs(configs: LlmConfigRecord[]): void {
  ensureMigrated();
  replaceLlmConfigs(configs);
}

/** api_key 掩码：<=8 位全遮，否则 前6****后4 */
export function maskKey(key: string): string {
  const k = (key || "").trim();
  if (!k) return "";
  if (k.length <= 8) return "****";
  return `${k.slice(0, 6)}****${k.slice(-4)}`;
}

/** 对外输出：api_key 掩码，避免明文泄漏 */
export function publicCfg(cfg: LlmConfigRecord): LlmConfigRecord {
  const out = { ...cfg };
  out["api_key"] = maskKey(String(cfg["api_key"] ?? ""));
  return out;
}

/**
 * 校验并回填字段。编辑时 api_key 为掩码/留空则保留原值。
 * 抛 Error 消息对齐 Python ValueError（调用方转为 400 detail）。
 */
export function normalizeCfg(raw: unknown, existing?: LlmConfigRecord | null): LlmConfigRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("配置数据格式错误");
  }
  const r = raw as Record<string, unknown>;
  const name = String(r["name"] ?? "").trim();
  if (!name) throw new Error("配置名称不能为空");

  let api_key = String(r["api_key"] ?? "").trim();
  if (existing != null) {
    if (!api_key || api_key.includes("*")) {
      api_key = String(existing["api_key"] ?? "");
    }
  }
  const base_url = String(r["base_url"] ?? "").trim();
  const model = String(r["model"] ?? "").trim();

  let temperature = 0.7;
  try {
    const t = Number(r["temperature"] ?? 0.7);
    temperature = Number.isFinite(t) ? t : 0.7;
  } catch {
    temperature = 0.7;
  }
  let max_tokens = 8192;
  try {
    const m = Number.parseInt(String(r["max_tokens"] ?? 8192), 10);
    max_tokens = Number.isFinite(m) ? m : 8192;
  } catch {
    max_tokens = 8192;
  }
  let timeout = 60;
  try {
    const t = Number.parseInt(String(r["timeout"] ?? 60), 10);
    timeout = Number.isFinite(t) ? t : 60;
  } catch {
    timeout = 60;
  }

  return {
    name,
    provider: String(r["provider"] ?? "自定义").trim() || "自定义",
    api_key,
    base_url,
    model,
    thinking: Boolean(r["thinking"] ?? false),
    temperature,
    max_tokens,
    timeout,
    is_default: Boolean(r["is_default"] ?? false),
    enabled: Boolean(r["enabled"] ?? true),
  };
}

/**
 * 保证至多一条 is_default；若指定 default_id 则其它全部置 False。
 * 未指定时仅在"启用"的配置中补一条默认，若全部禁用则清空默认标记。
 */
export function applyDefaultRule(
  configs: LlmConfigRecord[],
  defaultId?: string | null,
): LlmConfigRecord[] {
  if (defaultId) {
    for (const c of configs) c["is_default"] = c["id"] === defaultId;
  } else {
    const enabled = configs.filter((c) => c["enabled"]);
    if (enabled.length && !enabled.some((c) => c["is_default"])) {
      enabled[0]!["is_default"] = true;
    } else if (!enabled.length) {
      for (const c of configs) c["is_default"] = false;
    }
  }
  return configs;
}

/** 取启用且默认的配置；无默认则取首个启用；无启用返回 None */
export function findActiveConfig(): LlmConfigRecord | null {
  const configs = loadConfigs();
  const enabled = configs.filter((c) => c["enabled"]);
  for (const c of enabled) {
    if (c["is_default"]) return c;
  }
  return enabled.length ? enabled[0]! : null;
}

/** 组装运行时 LLMConfig：优先配置存储，store 为空回退内置，无启用报错。 */
export function runtimeLlmConfig(): LLMConfig {
  let cfg = findActiveConfig();
  if (cfg === null) {
    const existing = loadConfigs();
    if (existing.length) {
      throw new Error("缺少LLM配置：没有启用的 LLM 配置，请在「LLM 配置」中启用至少一项");
    }
    cfg = { ...FALLBACK_CONFIG };
  }
  const baseUrl = String(cfg["base_url"] ?? "").trim() || FALLBACK_CONFIG["base_url"];
  const model = String(cfg["model"] ?? FALLBACK_CONFIG["model"]).trim();
  const temperature = Number(cfg["temperature"] ?? 0.7);
  const maxTokens = Number.parseInt(String(cfg["max_tokens"] ?? 8192), 10);
  const timeout = Number(cfg["timeout"] ?? 120);
  return {
    base_url: baseUrl as string,
    api_key: String(cfg["api_key"] ?? "").trim(),
    model: model as string,
    temperature: Number.isFinite(temperature) ? temperature : 0.7,
    max_tokens: Number.isFinite(maxTokens) ? maxTokens : 8192,
    timeout: Number.isFinite(timeout) ? timeout : 120,
    extra_headers: {},
  };
}

export function normalizeStartUrl(url: string): string {
  const u = (url || "").trim();
  return u || DEFAULT_START_URL;
}
