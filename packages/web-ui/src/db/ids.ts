/**
 * 业务实体前缀短 ID 生成（proj_/task_/plan_/run_/rpt_/file_/upl_/prun_/exp_/sess_）。
 * 设计依据：docs/需求设计/数据库与API设计.md §0.2（ID 策略：前缀 + 12 位随机 base36）。
 */
import { randomBytes } from "node:crypto";

export type IdPrefix =
  | "proj"
  | "task"
  | "plan"
  | "run"
  | "rpt"
  | "file"
  | "upl"
  | "prun"
  | "exp"
  | "sess";

/** 12 位随机 base36（约 62bit 熵），小写字母+数字 */
function randomPart(len = 12): string {
  return randomBytes(len)
    .toString("base64url")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, len)
    .toLowerCase();
}

/** 生成形如 proj_a1b2c3d4e5f6 的 ID；熵不足时补随机 */
export function newId(prefix: IdPrefix): string {
  let part = randomPart();
  while (part.length < 12) part += randomPart(12 - part.length);
  return `${prefix}_${part}`;
}
