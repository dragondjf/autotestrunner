/**
 * 变量替换工具。
 * 1:1 对照 brick_runner_http/runner/variable_resolver.py。
 */

const VARIABLE_PATTERN = /\$\{\{([^}]+)\}\}/g;

export interface ResolvedStep {
  method: string;
  params: Record<string, unknown>;
  keyword: string;
  branches?: ResolvedBranch[];
}

export interface ResolvedBranch {
  condition: Record<string, unknown>;
  steps: ResolvedStep[];
}

/** 递归替换 step.params 中所有 ${{variable_name}} 为实际值 */
export function resolve(step: Record<string, any>, variables: Record<string, any>): ResolvedStep {
  const resolved: ResolvedStep = {
    method: step["method"],
    params: {},
    keyword: step["keyword"] ?? "",
  };
  if ("branches" in step) {
    resolved.branches = ((step["branches"] ?? []) as Record<string, any>[]).map((b) =>
      resolveConditionBranch(b, variables),
    );
  }
  for (const [key, value] of Object.entries((step["params"] ?? {}) as Record<string, unknown>)) {
    resolved.params[key] = resolveValue(value, variables);
  }
  return resolved;
}

export function resolveValue(value: unknown, variables: Record<string, any>): unknown {
  if (typeof value === "string") {
    return value.replace(VARIABLE_PATTERN, (match, group1: string) => {
      const varPath = group1.trim();
      const parts = varPath.split(".");
      let current: unknown = variables;
      for (const part of parts) {
        if (typeof current === "object" && current !== null && !Array.isArray(current)) {
          current = (current as Record<string, unknown>)[part] ?? match;
        } else {
          return match;
        }
      }
      return current !== null && current !== undefined ? String(current) : match;
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveValue(v, variables));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveValue(v, variables);
    }
    return out;
  }
  return value;
}

function resolveConditionBranch(
  branch: Record<string, any>,
  variables: Record<string, any>,
): ResolvedBranch {
  return {
    condition: (branch["condition"] ?? {}) as Record<string, unknown>,
    steps: ((branch["steps"] ?? []) as Record<string, any>[]).map((s) => resolve(s, variables)),
  };
}
