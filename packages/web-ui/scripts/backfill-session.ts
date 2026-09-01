/** 一次性补同步：把已结束的 inspect 会话时间线生成到绑定项目（结束保存发生在旧代码时期时用）。 */
import { syncRecordingToProject } from "../src/routes/inspect.routes.js";

const sid = process.argv[2] ?? "";
if (!sid) {
  console.error("用法: npx tsx scripts/backfill-session.ts <sid>");
  process.exit(1);
}
const r = syncRecordingToProject(sid);
console.log(r ? `已生成: 项目「${r.projectName}」 ${r.steps} 步，补齐 ${r.tasksRefreshed} 个空快照任务` : "未同步（无绑定项目/无步骤/项目不存在）");
process.exit(0);
