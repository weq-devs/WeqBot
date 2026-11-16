/**
 * 分级结构化日志：终端（彩色）+ 文件（按天）+ 订阅（WebUI 观测流）。
 *
 * 刻意不引第三方：bot 会被打进 WeQ 的 `resources/bot-runtime/bot.mjs`，
 * 每多一个运行时依赖就多一份随包体积。
 *
 * 五级：`trace` < `debug` < `info` < `warn` < `error`。
 *
 * - `trace` 是**收发包**那条高流量流，只进终端与订阅者，**不落盘**（跟
 *   SnowLuma 的约定一致）：开着它排查一次就够，长期写盘只会撑爆磁盘。
 * - 其余级别按 `fileLevel`（默认 `debug`）落盘。
 * - 终端级别与文件级别互不影响：`--verbose` 只让终端更啰嗦。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  ts: number;
  level: LogLevel;
  /** 逻辑来源，例如 `cli` / `bot.event` / `onebot.ws`。 */
  scope: string;
  msg: string;
  fields?: Record<string, unknown>;
}

export type LogSink = (record: LogRecord) => void;

export interface Logger {
  trace(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** 该级别会不会真的输出（终端）；用来跳过昂贵的字段构造。 */
  isEnabled(level: LogLevel): boolean;
  /** 派生一个 `父scope.子scope` 的子日志器，继承级别与 sink。 */
  child(scope: string): Logger;
}

export interface LoggerOptions {
  /** 固定这个日志器的级别；不给则跟随 `configureLogging` 的全局级别。 */
  level?: LogLevel;
  /** 额外的 sink（测试注入用）；默认仍写终端 / 文件。 */
  sink?: LogSink;
}

export interface LoggingOptions {
  /** 终端级别；不给则沿用当前值（`WEQBOT_LOG_LEVEL`，默认 `info`）。 */
  level?: LogLevel;
  /** 文件级别；`trace` 不落盘。不给则沿用当前值（默认 `debug`）。 */
  fileLevel?: LogLevel;
  /** 日志目录；给 `null` 关闭落盘（WeQ 嵌入时由宿主接管）。 */
  dir?: string | null;
  /** 强制开 / 关彩色；默认按 stderr 是否 TTY。 */
  color?: boolean;
}

const ORDER: Record<LogLevel, number> = {
  trace: 5,
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LABEL: Record<LogLevel, string> = {
  trace: 'TRACE',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
};

const LEVEL_COLOR: Record<LogLevel, number> = {
  trace: 90,
  debug: 90,
  info: 36,
  warn: 33,
  error: 31,
};

const COLOR_SCOPE = 35;
const COLOR_DIM = 2;
const COLOR_RESET = '\x1b[0m';

const LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'];

function parseLevel(raw: string | undefined): LogLevel | undefined {
  if (raw === undefined) return undefined;
  const lower = raw.trim().toLowerCase();
  return LEVELS.includes(lower as LogLevel) ? (lower as LogLevel) : undefined;
}

let consoleLevel: LogLevel = parseLevel(process.env.WEQBOT_LOG_LEVEL) ?? 'info';
let fileLevel: LogLevel = parseLevel(process.env.WEQBOT_LOG_FILE_LEVEL) ?? 'debug';
let logDir: string | null = null;
let useColor: boolean | undefined;
let writeFailureReported = false;
let fileDay = '';
let filePath = '';

const sinks = new Set<LogSink>();

/**
 * 配置日志去向。CLI 在启动时调用一次：开启 `logs/` 下的按天文件。
 *
 * 不给 `dir` 就沿用当前状态（默认不落盘）。给 `null` 明确关闭。
 */
export function configureLogging(options: LoggingOptions = {}): void {
  if (options.level) consoleLevel = options.level;
  if (options.fileLevel) fileLevel = options.fileLevel;
  if (options.color !== undefined) useColor = options.color;
  if (options.dir !== undefined) {
    logDir = options.dir;
    fileDay = '';
    filePath = '';
    writeFailureReported = false;
  }
}

/** 当前终端级别。 */
export function getLogLevel(): LogLevel {
  return consoleLevel;
}

/** 运行时切换终端级别；`trace` 打开完整的收发包打印。 */
export function setLogLevel(level: LogLevel): void {
  consoleLevel = level;
}

/** 该级别是否通过终端阈值。 */
export function isLogLevelEnabled(level: LogLevel): boolean {
  return ORDER[level] >= ORDER[consoleLevel];
}

/** 当前落盘的目录（未开启时 `null`）。 */
export function getLogDirectory(): string | null {
  return logDir;
}

/**
 * 订阅所有通过过滤的记录（WebUI 的运行日志流）。
 *
 * `trace` 不进订阅：它的体量按包算，塞进环形缓冲会把正常日志挤掉。
 */
export function subscribeLogs(sink: LogSink): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

/** 彩色只看终端：文件里永远不带 ANSI（`less` / 导出都不会乱）。 */
function colorEnabled(): boolean {
  if (useColor !== undefined) return useColor;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR === '0') return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stderr.isTTY);
}

function ansi(code: number, text: string): string {
  return `\x1b[${code}m${text}${COLOR_RESET}`;
}

function clock(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function dayOf(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 字段的紧凑单行渲染；循环引用 / BigInt 之类一律降级成字符串。 */
function formatFields(fields: Record<string, unknown> | undefined): string {
  if (!fields) return '';
  try {
    const text = JSON.stringify(fields);
    return text === undefined || text === '{}' ? '' : ` ${text}`;
  } catch {
    return ` ${String(fields)}`;
  }
}

function renderConsole(record: LogRecord): string {
  const label = LABEL[record.level].padEnd(5);
  const fields = formatFields(record.fields);
  const message = `${record.msg}${fields}`;
  if (!colorEnabled()) {
    return `${clock(record.ts)} ${label} [${record.scope}] ${message}`;
  }
  return `${ansi(COLOR_DIM, clock(record.ts))} ${ansi(
    LEVEL_COLOR[record.level],
    label,
  )} ${ansi(COLOR_SCOPE, `[${record.scope}]`)} ${message}`;
}

function renderFile(record: LogRecord): string {
  const label = LABEL[record.level].padEnd(5);
  return `${new Date(record.ts).toISOString()} ${label} [${record.scope}] ${record.msg}${formatFields(
    record.fields,
  )}`;
}

/**
 * 写一行到当天文件。失败只报一次：日志写不进去不该把 bot 带下去
 * （只读挂载 / 磁盘满都真实发生过）。
 */
function writeFile(line: string, ts: number): void {
  if (logDir === null) return;
  const day = dayOf(ts);
  if (day !== fileDay) {
    fileDay = day;
    filePath = join(logDir, `weqbot-${day}.log`);
    try {
      mkdirSync(logDir, { recursive: true });
    } catch (cause) {
      reportWriteFailure(cause);
      return;
    }
  }
  try {
    appendFileSync(filePath, `${line}\n`, 'utf8');
  } catch (cause) {
    reportWriteFailure(cause);
  }
}

function reportWriteFailure(cause: unknown): void {
  if (writeFailureReported) return;
  writeFailureReported = true;
  process.stderr.write(
    `日志落盘失败（后续只输出到终端）：${cause instanceof Error ? cause.message : String(cause)}\n`,
  );
}

function emit(
  scope: string,
  level: LogLevel,
  options: LoggerOptions,
  msg: string,
  fields?: Record<string, unknown>,
): void {
  const threshold = ORDER[options.level ?? consoleLevel];
  const passesConsole = ORDER[level] >= threshold;
  const passesFile = level !== 'trace' && ORDER[level] >= ORDER[fileLevel];
  const passesSinks = level !== 'trace' && (passesConsole || passesFile);
  if (!passesConsole && !passesFile && !passesSinks) return;

  const record: LogRecord = {
    ts: Date.now(),
    level,
    scope,
    msg,
    ...(fields ? { fields } : {}),
  };

  if (passesConsole) {
    try {
      process.stderr.write(`${renderConsole(record)}\n`);
    } catch {
      // 终端写失败（docker json-file 写满）也不能影响业务。
    }
  }
  if (passesFile) writeFile(renderFile(record), record.ts);
  if (passesSinks) {
    for (const sink of sinks) {
      try {
        sink(record);
      } catch {
        // 单个订阅者（WebUI 推送）出错不影响其它订阅者。
      }
    }
  }
  options.sink?.(record);
}

export function createLogger(scope: string, options: LoggerOptions = {}): Logger {
  return {
    trace: (msg, fields) => emit(scope, 'trace', options, msg, fields),
    debug: (msg, fields) => emit(scope, 'debug', options, msg, fields),
    info: (msg, fields) => emit(scope, 'info', options, msg, fields),
    warn: (msg, fields) => emit(scope, 'warn', options, msg, fields),
    error: (msg, fields) => emit(scope, 'error', options, msg, fields),
    isEnabled: (level) => ORDER[level] >= ORDER[options.level ?? consoleLevel],
    child: (childScope) => createLogger(`${scope}.${childScope}`, options),
  };
}

/** 收发包的 hex 渲染（trace 专用，不做脱敏）。 */
export function renderHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');
}
