import { describe, it, expect } from "vitest";
import { buildRecorderScript, normalizeStrategy } from "../src/recorder-script.js";

describe("normalizeStrategy", () => {
  it("合法值原样返回（大小写不敏感）", () => {
    expect(normalizeStrategy("default")).toBe("default");
    expect(normalizeStrategy("Tolerant")).toBe("tolerant");
    expect(normalizeStrategy("ROBUST")).toBe("robust");
    expect(normalizeStrategy("semantic_first")).toBe("semantic_first");
    expect(normalizeStrategy("Semantic")).toBe("semantic");
  });

  it("非法/空值回退 default", () => {
    expect(normalizeStrategy("xxx")).toBe("default");
    expect(normalizeStrategy("")).toBe("default");
    expect(normalizeStrategy(null)).toBe("default");
    expect(normalizeStrategy(undefined)).toBe("default");
  });
});

describe("buildRecorderScript", () => {
  it("注入规范化后的策略常量", () => {
    expect(buildRecorderScript("robust")).toContain('"robust"');
    expect(buildRecorderScript("TOLERANT")).toContain('"tolerant"');
    expect(buildRecorderScript("bogus")).toContain('"default"');
    expect(buildRecorderScript()).toContain('"default"');
  });

  it("自执行 IIFE 且带初始化防重入标记", () => {
    const s = buildRecorderScript();
    expect(s.startsWith("(function () {")).toBe(true);
    expect(s.trimEnd().endsWith("})();")).toBe(true);
    expect(s).toContain("window.__REC_INIT__");
    expect(s).toContain("window.__RECORDED__");
  });

  it("包含全部事件监听与 __REC__ 工具集", () => {
    const s = buildRecorderScript();
    for (const frag of [
      'document.addEventListener("click"',
      'document.addEventListener("dblclick"',
      'document.addEventListener("contextmenu"',
      'document.addEventListener("input"',
      'document.addEventListener("change"',
      'document.addEventListener("keydown"',
      'window.addEventListener("scroll"',
      "window.__REC__",
      "buildCandidates",
      "buildMeta",
      "locatorRankedByRunner",
      "__REC_PAUSED__",
      "__LAST_TARGET__",
    ]) {
      expect(s).toContain(frag);
    }
  });

  it("脚本是合法 JS（new Function 仅解析不执行）", () => {
    expect(() => new Function(buildRecorderScript())).not.toThrow();
    expect(() => new Function(buildRecorderScript("semantic_first"))).not.toThrow();
  });
});
