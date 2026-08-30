/**
 * 日志：对齐 Python logging.basicConfig 输出格式
 *   "%(asctime)s %(levelname)s [%(name)s] %(message)s"，logger 名 agent_web_ui。
 * 支持 %s / %r 占位符（Python 惰性格式化语义）。
 */

const PAD3 = (n: number) => String(n).padStart(3, "0");
const PAD2 = (n: number) => String(n).padStart(2, "0");

function asctime(d = new Date()): string {
  return (
    `${d.getFullYear()}-${PAD2(d.getMonth() + 1)}-${PAD2(d.getDate())} ` +
    `${PAD2(d.getHours())}:${PAD2(d.getMinutes())}:${PAD2(d.getSeconds())},${PAD3(d.getMilliseconds())}`
  );
}

function formatMsg(msg: string, args: unknown[]): string {
  if (!args.length) return msg;
  let i = 0;
  // %r 用 JSON 表示；%s 用字符串表示
  return msg.replace(/%[rs]/g, (m) => {
    const v = args[i++];
    return m === "%r" ? JSON.stringify(v) : String(v);
  });
}

function emit(level: string, msg: string, args: unknown[]): string {
  const line = `${asctime()} ${level} [agent_web_ui] ${formatMsg(msg, args)}`;
  if (level === "ERROR") console.error(line);
  else if (level === "WARNING") console.warn(line);
  else console.log(line);
  return line;
}

export const logger = {
  info(msg: string, ...args: unknown[]): void {
    emit("INFO", msg, args);
  },
  warning(msg: string, ...args: unknown[]): void {
    emit("WARNING", msg, args);
  },
  error(msg: string, ...args: unknown[]): void {
    emit("ERROR", msg, args);
  },
  debug(msg: string, ...args: unknown[]): void {
    if (process.env.LOG_LEVEL === "DEBUG") emit("DEBUG", msg, args);
  },
  /** logging.exception：ERROR 级别 + 堆栈 */
  exception(msg: string, ...args: unknown[]): void {
    const line = `${asctime()} ERROR [agent_web_ui] ${formatMsg(msg, args)}`;
    console.error(line);
  },
};
