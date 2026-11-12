/**
 * 极简结构化日志。
 *
 * 刻意不引第三方：bot 会被打进 WeQ 的 `resources/bot-runtime/bot.mjs`，
 * 每多一个运行时依赖就多一份随包体积。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  ts: number;
  level: LogLevel;
  /** 逻辑来源，例如 `session.online` / `onebot.ws`。 */
  scope: string;
  msg: string;
  fields?: Record<string, unknown>;
}

export type LogSink = (record: LogRecord) => void;

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** 派生一个 `父scope.子scope` 的子日志器，继承 level 与 sink。 */
  child(scope: string): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 默认 sink：写 stderr。WeQ 嵌入时由宿主换成自己的日志通道。 */
const stderrSink: LogSink = (record) => {
  const tail = record.fields ? ` ${JSON.stringify(record.fields)}` : '';
  process.stderr.write(`[${record.level}] ${record.scope}: ${record.msg}${tail}\n`);
};

export function createLogger(scope: string, options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const sink = options.sink ?? stderrSink;
  const threshold = ORDER[level];

  const emit = (recordLevel: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[recordLevel] < threshold) return;
    sink({ ts: Date.now(), level: recordLevel, scope, msg, ...(fields ? { fields } : {}) });
  };

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (childScope) => createLogger(`${scope}.${childScope}`, { level, sink }),
  };
}
