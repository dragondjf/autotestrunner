/**
 * 通用行映射与校验辅助（DAO 层共用）。
 */
export type Row = Record<string, unknown>;

/** JSON 字段安全解析：空/非法时返回 fallback */
export function parseJsonField<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 布尔字段（0/1）转 boolean */
export function toBool(v: unknown): boolean {
  return v === 1 || v === true;
}

/** 当前 ISO 时间戳 */
export function nowIso(): string {
  return new Date().toISOString();
}

/** snake_case 行 -> camelCase 对象（浅层；值保持原样） */
export function camelRow<T>(row: Row): T {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    const ck = k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    out[ck] = v;
  }
  return out as T;
}
