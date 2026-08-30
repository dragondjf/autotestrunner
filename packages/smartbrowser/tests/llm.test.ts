import { describe, it, expect } from "vitest";
import {
  createLlmCall,
  createLlmStream,
  defaultEndpoint,
  extractTokens,
  llmConfigFromEnv,
  makeLLMConfig,
  LLMStatusError,
} from "../src/llm.js";

function jsonRes(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("defaultEndpoint（llm.py _default_endpoint）", () => {
  it("容忍末尾斜杠", () => {
    expect(defaultEndpoint(makeLLMConfig({ base_url: "https://api.x.com/v1/" }))).toBe(
      "https://api.x.com/v1/chat/completions",
    );
    expect(defaultEndpoint(makeLLMConfig({ base_url: "https://api.x.com/v1" }))).toBe(
      "https://api.x.com/v1/chat/completions",
    );
  });
  it("base_url 为空抛『LLMConfig.base_url 不能为空』", () => {
    expect(() => defaultEndpoint(makeLLMConfig({ base_url: "  " }))).toThrow(
      "LLMConfig.base_url 不能为空",
    );
  });
});

describe("extractTokens（llm.py _extract_tokens）", () => {
  it("total_tokens 优先", () => {
    expect(extractTokens({ usage: { total_tokens: 123 } })).toBe(123);
  });
  it("无 total 时 prompt+completion", () => {
    expect(extractTokens({ usage: { prompt_tokens: 10, completion_tokens: 5 } })).toBe(15);
  });
  it("无 usage 时为 0", () => {
    expect(extractTokens({})).toBe(0);
  });
});

describe("createLlmCall（llm.py create_llm_call）", () => {
  const cfg = makeLLMConfig({ base_url: "https://api.x.com/v1", api_key: "sk-1", model: "m-1" });

  it("成功返回 content 与 tokens", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push({ url, init });
      return jsonRes({
        choices: [{ message: { content: "hello" } }],
        usage: { total_tokens: 42 },
      });
    }) as typeof fetch;

    const fn = createLlmCall(cfg, { fetchImpl });
    const r = await fn("sys", "usr");
    expect(r).toEqual({ content: "hello", tokens: 42 });

    const body = JSON.parse(String(calls[0]!.init.body));
    expect(calls[0]!.url).toBe("https://api.x.com/v1/chat/completions");
    expect(body).toEqual({
      model: "m-1",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "usr" },
      ],
      temperature: 0.0,
    });
    expect((calls[0]!.init.headers as any)["Authorization"]).toBe("Bearer sk-1");
  });

  it("content 为 null 时返回空串", async () => {
    const fetchImpl = (async () =>
      jsonRes({ choices: [{ message: { content: null } }] })) as typeof fetch;
    const r = await createLlmCall(cfg, { fetchImpl })("s", "u");
    expect(r.content).toBe("");
  });

  it("缺 choices 抛『LLM 响应缺少 choices[0].message.content: ...』", async () => {
    const fetchImpl = (async () => jsonRes({ error: "x" })) as typeof fetch;
    await expect(createLlmCall(cfg, { fetchImpl })("s", "u")).rejects.toThrow(
      /^LLM 响应缺少 choices\[0\]\.message\.content: /,
    );
  });

  it("max_tokens 设置时进入请求体；null 时不带", async () => {
    let body: any;
    const fetchImpl = (async (_u: any, init: any) => {
      body = JSON.parse(String(init.body));
      return jsonRes({ choices: [{ message: { content: "ok" } }] });
    }) as typeof fetch;
    await createLlmCall({ ...cfg, max_tokens: 100 }, { fetchImpl })("s", "u");
    expect(body.max_tokens).toBe(100);
    await createLlmCall({ ...cfg, max_tokens: null }, { fetchImpl })("s", "u");
    expect("max_tokens" in body).toBe(false);
  });

  it("可重试 503：按 (n+1)*backoff 退避后成功", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls <= 2) return jsonRes({ err: "unavailable" }, 503);
      return jsonRes({ choices: [{ message: { content: "ok" } }] });
    }) as typeof fetch;
    const r = await createLlmCall(cfg, { fetchImpl, maxRetries: 3, retryBackoff: 0.01 })("s", "u");
    expect(calls).toBe(3);
    expect(r.content).toBe("ok");
  });

  it("不可重试 401 立即抛 LLMStatusError", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonRes({ detail: "bad key" }, 401);
    }) as typeof fetch;
    await expect(
      createLlmCall(cfg, { fetchImpl, maxRetries: 3, retryBackoff: 0.01 })("s", "u"),
    ).rejects.toThrow(LLMStatusError);
    expect(calls).toBe(1);
  });

  it("重试耗尽后抛最后一次错误", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonRes({}, 500);
    }) as typeof fetch;
    await expect(
      createLlmCall(cfg, { fetchImpl, maxRetries: 1, retryBackoff: 0.01 })("s", "u"),
    ).rejects.toThrow(LLMStatusError);
    expect(calls).toBe(2); // 1 + 1 retry
  });

  it("extra_headers 合并进请求头", async () => {
    let seen: any;
    const fetchImpl = (async (_u: any, init: any) => {
      seen = init.headers;
      return jsonRes({ choices: [{ message: { content: "x" } }] });
    }) as typeof fetch;
    await createLlmCall({ ...cfg, extra_headers: { "X-K": "V" } }, { fetchImpl })("s", "u");
    expect(seen["X-K"]).toBe("V");
  });

  it("无 api_key 时不带 Authorization", async () => {
    let seen: any;
    const fetchImpl = (async (_u: any, init: any) => {
      seen = init.headers;
      return jsonRes({ choices: [{ message: { content: "x" } }] });
    }) as typeof fetch;
    await createLlmCall({ ...cfg, api_key: "" }, { fetchImpl })("s", "u");
    expect("Authorization" in seen).toBe(false);
  });

  it("llmConfigFromEnv 读取环境变量", () => {
    const prev = { ...process.env };
    process.env.LLM_BASE_URL = "https://env.x.com/v1";
    process.env.LLM_API_KEY = "env-key";
    process.env.LLM_MODEL = "env-model";
    const c = llmConfigFromEnv();
    expect(c).toMatchObject({
      base_url: "https://env.x.com/v1",
      api_key: "env-key",
      model: "env-model",
      temperature: 0,
      timeout: 60,
    });
    process.env = prev;
  });
});

describe("createLlmStream（llm.py create_llm_stream）", () => {
  const cfg = makeLLMConfig({ base_url: "https://api.x.com/v1" });

  function sseRes(lines: string[]): Response {
    const body = lines.join("\n") + "\n";
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }

  it("逐段 yield delta content，[DONE] 终止", async () => {
    const fetchImpl = (async () =>
      sseRes([
        'data: {"choices":[{"delta":{"content":"你"}}]}',
        "",
        'data: {"choices":[{"delta":{"content":"好"}}]}',
        "data: [DONE]",
        'data: {"choices":[{"delta":{"content":"不应出现"}}]}',
      ])) as typeof fetch;
    const got: string[] = [];
    for await (const tok of createLlmStream(cfg, { fetchImpl })("s", "u")) {
      got.push(tok);
    }
    expect(got).toEqual(["你", "好"]);
  });

  it("非法 JSON 行与缺 delta 的行被跳过", async () => {
    const fetchImpl = (async () =>
      sseRes([
        "data: not-json",
        'data: {"choices":[]}',
        'data: {"choices":[{"delta":{}}]}',
        'data: {"choices":[{"delta":{"content":"ok"}}]}',
      ])) as typeof fetch;
    const got: string[] = [];
    for await (const tok of createLlmStream(cfg, { fetchImpl })("s", "u")) {
      got.push(tok);
    }
    expect(got).toEqual(["ok"]);
  });

  it("非 2xx 抛 LLMStatusError", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 502 })) as typeof fetch;
    await expect(
      (async () => {
        for await (const _ of createLlmStream(cfg, { fetchImpl })("s", "u")) {
          void _;
        }
      })(),
    ).rejects.toThrow(LLMStatusError);
  });
});
