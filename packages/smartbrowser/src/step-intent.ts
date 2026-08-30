/**
 * 步骤业务意图（intent）解析，供定位器自愈等场景使用。
 * 1:1 对照 smartbrowser/src/smartbrowser/step_intent.py。
 */

export function resolveStepIntentText(opts: {
  step_intent?: string | null;
  step_desc?: string | null;
}): string {
  /** 优先使用 intent，否则回退到 desc（兼容旧用例）。 */
  const intent = (opts.step_intent || "").trim();
  if (intent) return intent;
  return (opts.step_desc || "").trim();
}

export function resolveStepIntentFromStep(step: unknown): string {
  if (typeof step !== "object" || step === null) return "";
  const s = step as Record<string, unknown>;
  return resolveStepIntentText({
    step_intent: (s["intent"] as string) ?? null,
    step_desc: ((s["desc"] as string) || (s["keyword"] as string)) ?? null,
  });
}
