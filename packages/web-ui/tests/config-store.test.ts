import { describe, it, expect, beforeEach } from "vitest";
import {
  FALLBACK_CONFIG,
  applyDefaultRule,
  findActiveConfig,
  loadConfigs,
  maskKey,
  normalizeCfg,
  publicCfg,
  runtimeLlmConfig,
  saveConfigs,
} from "../src/config-store.js";

/** 存储已迁 SQLite：seed/清空均通过 saveConfigs（replaceLlmConfigs 全量替换） */
function resetConfigFile(data: unknown = []) {
  saveConfigs(Array.isArray(data) ? data : []);
}

describe("maskKey（core.py:130）", () => {
  it("空 → 空串；<=8 位 → ****；>8 位 → 前6****后4", () => {
    expect(maskKey("")).toBe("");
    expect(maskKey("   ")).toBe("");
    expect(maskKey("12345678")).toBe("****");
    expect(maskKey("123456789")).toBe("123456****6789");
    expect(maskKey("sk-abcdefghijklmn")).toBe("sk-abc****klmn");
  });
});

describe("normalizeCfg（core.py:146）", () => {
  it("非 dict / 空 name 抛错", () => {
    expect(() => normalizeCfg(null)).toThrow("配置数据格式错误");
    expect(() => normalizeCfg("x")).toThrow("配置数据格式错误");
    expect(() => normalizeCfg({ name: "  " })).toThrow("配置名称不能为空");
  });

  it("默认值回填", () => {
    const cfg = normalizeCfg({ name: "测试" });
    expect(cfg).toEqual({
      name: "测试",
      provider: "自定义",
      api_key: "",
      base_url: "",
      model: "",
      thinking: false,
      temperature: 0.7,
      max_tokens: 8192,
      timeout: 60,
      is_default: false,
      enabled: true,
    });
  });

  it("非法数值回退默认", () => {
    const cfg = normalizeCfg({ name: "a", temperature: "x", max_tokens: "y", timeout: "z" });
    expect(cfg["temperature"]).toBe(0.7);
    expect(cfg["max_tokens"]).toBe(8192);
    expect(cfg["timeout"]).toBe(60);
  });

  it("编辑时 api_key 为掩码/空则保留原值", () => {
    const existing = { api_key: "sk-real-key-123456" };
    expect(normalizeCfg({ name: "a", api_key: "abc****1234" }, existing)["api_key"]).toBe("sk-real-key-123456");
    expect(normalizeCfg({ name: "a", api_key: "" }, existing)["api_key"]).toBe("sk-real-key-123456");
    expect(normalizeCfg({ name: "a", api_key: "sk-new" }, existing)["api_key"]).toBe("sk-new");
  });
});

describe("applyDefaultRule（core.py:189）", () => {
  it("指定 default_id：其余全部 false", () => {
    const configs = [
      { id: "a", enabled: true, is_default: true },
      { id: "b", enabled: true, is_default: false },
    ];
    applyDefaultRule(configs, "b");
    expect(configs[0]!["is_default"]).toBe(false);
    expect(configs[1]!["is_default"]).toBe(true);
  });
  it("未指定：启用项中无默认时第一个补位", () => {
    const configs = [
      { id: "a", enabled: false },
      { id: "b", enabled: true },
    ];
    applyDefaultRule(configs, null);
    expect(configs[1]!["is_default"]).toBe(true);
  });
  it("未指定：全部禁用时清空默认标记", () => {
    const configs = [{ id: "a", enabled: false, is_default: true }];
    applyDefaultRule(configs, null);
    expect(configs[0]!["is_default"]).toBe(false);
  });
});

describe("loadConfigs / saveConfigs（SQLite 存储）", () => {
  beforeEach(() => resetConfigFile());

  it("空库返回空列表", () => {
    saveConfigs([]);
    expect(loadConfigs()).toEqual([]);
  });

  it("写入后读回，保留中文名与字段", () => {
    saveConfigs([{ name: "配置", api_key: "k", model: "m" }]);
    const raw = loadConfigs();
    expect(raw).toHaveLength(1);
    expect(raw[0]!["name"]).toBe("配置");
    expect(raw[0]!["model"]).toBe("m");
  });

  it("全量替换：旧记录被清除", () => {
    saveConfigs([{ name: "旧", api_key: "k", model: "m" }]);
    saveConfigs([{ name: "新", api_key: "k2", model: "m2" }]);
    const raw = loadConfigs();
    expect(raw).toHaveLength(1);
    expect(raw[0]!["name"]).toBe("新");
  });
});

describe("findActiveConfig / runtimeLlmConfig（core.py:205/215）", () => {
  beforeEach(() => resetConfigFile());

  it("取启用且默认；无默认取首个启用；无启用返回 null", () => {
    resetConfigFile([
      { id: "a", enabled: false, is_default: true },
      { id: "b", enabled: true },
      { id: "c", enabled: true, is_default: true },
    ]);
    expect(findActiveConfig()!["id"]).toBe("c");

    resetConfigFile([
      { id: "a", enabled: false },
      { id: "b", enabled: true },
    ]);
    expect(findActiveConfig()!["id"]).toBe("b");

    resetConfigFile([{ id: "a", enabled: false }]);
    expect(findActiveConfig()).toBeNull();
  });

  it("无启用但存储非空 → 抛『缺少LLM配置：没有启用的 LLM 配置，请在「LLM 配置」中启用至少一项』", () => {
    resetConfigFile([{ id: "a", enabled: false }]);
    expect(() => runtimeLlmConfig()).toThrow(
      "缺少LLM配置：没有启用的 LLM 配置，请在「LLM 配置」中启用至少一项",
    );
  });

  it("存储为空 → 回退内置配置（base_url/model 兜底）", () => {
    resetConfigFile([]);
    const cfg = runtimeLlmConfig();
    expect(cfg.base_url).toBe(FALLBACK_CONFIG["base_url"]);
    expect(cfg.model).toBe(FALLBACK_CONFIG["model"]);
    expect(cfg.api_key).toBe(FALLBACK_CONFIG["api_key"]);
  });

  it("启用项的空 base_url 回退内置；model 为空白串时不回退（Python `or` 视空白为真值）", () => {
    resetConfigFile([{ id: "a", enabled: true, base_url: "", model: "  ", timeout: 30 }]);
    const cfg = runtimeLlmConfig();
    expect(cfg.base_url).toBe(FALLBACK_CONFIG["base_url"]);
    // 1:1：(cfg["model"] or FALLBACK).strip() —— 空白串是真值，strip 后为空串
    expect(cfg.model).toBe("");
    expect(cfg.timeout).toBe(30);
  });

  it("启用项缺 model 键时回退内置模型", () => {
    resetConfigFile([{ id: "a", enabled: true, base_url: "http://x/v1" }]);
    const cfg = runtimeLlmConfig();
    expect(cfg.model).toBe(FALLBACK_CONFIG["model"]);
    expect(cfg.base_url).toBe("http://x/v1");
  });
});

describe("publicCfg（core.py:139）", () => {
  it("仅掩码 api_key，其它字段原样", () => {
    const out = publicCfg({ id: "a", name: "n", api_key: "sk-1234567890" });
    expect(out["api_key"]).toBe("sk-123****7890");
    expect(out["name"]).toBe("n");
  });
});
