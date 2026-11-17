/**
 * 有头模式（attach）的进程层实现：找运行中的 QQ、提权、读一次会话物料。
 *
 * 为什么需要提权：`scanSessionMaterial` 要 `ptrace` 附加到 QQ 进程读它的堆。
 * Linux 的内核门禁是 `PTRACE_MODE_ATTACH`（root 或 CAP_SYS_PTRACE，且
 * `yama/ptrace_scope` 放行），macOS 要 root（QQ 有强化运行时，实际还要调试签名），
 * Windows 同用户进程免提权 —— 这个差异由 {@link describeElevation} 表达给页面。
 *
 * 阶梯（与 WeQ 的 `attach_elevation` 同一套思路，去掉长期授权那一层）：
 *
 *   1. **先在本进程试一次**。控制台跑在 root 下（headless 机器）或 yama 放行时
 *      直接成功，不该白让用户输一次密码。
 *   2. 只有**权限错误**（EPERM / EACCES / 「不允许的操作」）才回 `ELEVATION_REQUIRED`，
 *      由页面弹提权框收密码。
 *   3. 密码只用来起一个短命的 root 子进程（`sudo -S`，密码走 stdin），子进程里
 *      加载 native、扫一次、把 JSON 打到 stdout、退出。密码不落盘、不进日志、
 *      不进环境变量。
 *
 * 子进程复用**同一个入口**（`weqbot --attach-worker`），不额外打一个 bundle：
 * dev（tsx）与打包（单文件 mjs）都能直接跑，避免两条入口慢慢漂移。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Logger } from '@weqbot/common';
import type { RawNativeBinding } from '@weqbot/wire';
import { resolveNativePath } from '../loader';

/** 读一次内存的产出。字段与 native 的 `SessionMaterial` 同形（hex 串）。 */
export interface ScannedMaterial {
  a2?: string;
  d2?: string;
  d2Key?: string;
  secToken?: string;
  secTokenExpire?: number;
  secTokenSource?: string;
}

/** 提权方式：`sudo`（linux / darwin 密码）、`uac`（Windows 系统弹窗）、`none`（不需要）。 */
export type ElevationMechanism = 'none' | 'sudo' | 'uac';

export interface ElevationState {
  platform: NodeJS.Platform;
  /** 当前进程已是 root：读内存不需要再提权。 */
  elevated: boolean;
  /** `sudo -n true` 通过：密码还在 sudo 的时间戳缓存里，这次多半不用再输。 */
  cached: boolean;
  mechanism: ElevationMechanism;
  /** Linux 的 `yama/ptrace_scope`；读不到就是 undefined。0 = 不限制。 */
  ptraceScope?: number;
  /** 页面直接显示的一句话。 */
  hint: string;
}

/**
 * 有头模式的预期内失败。
 *
 * `code` 会原样成为 HTTP 错误码，页面据此决定弹提权框还是普通报错 —— 提权不是
 * 「未知错误」，不能让用户看到一句 INTERNAL。
 */
export class AttachError extends Error {
  constructor(
    readonly code: AttachErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'AttachError';
  }
}

export type AttachErrorCode =
  /** 内核拒绝了读取：需要提权（页面弹密码框 / 提示管理员运行）。 */
  | 'ELEVATION_REQUIRED'
  /** 用户取消了 sudo 认证，或密码错误。 */
  | 'ELEVATION_FAILED'
  /** native 没有 `scanSessionMaterial`（旧构建）。 */
  | 'NATIVE_MISSING_CAPABILITY'
  /** QQ 进程没了 / pid 不对。 */
  | 'PROCESS_GONE'
  /** 扫出来了但没有 a2/d2/d2key（QQ 还没登录完）。 */
  | 'NO_SESSION_MATERIAL';

/** 一次 sudo 扫描的超时：sudo 认证 + native 加载 + ptrace 扫描。 */
const WORKER_TIMEOUT_MS = 25_000;

/** 子进程里那一层的入口参数；`cli.ts` 见到它就只做扫描然后退出。 */
export const ATTACH_WORKER_FLAG = '--attach-worker';

/** 进程名像不像 QQ（`QQ.exe` / `qq` / `QQ`）。 */
export function looksLikeQqProcess(name: string): boolean {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) return false;
  return (trimmed.endsWith('.exe') ? trimmed.slice(0, -4) : trimmed) === 'qq';
}

function isRoot(): boolean {
  const getuid = process.getuid;
  return typeof getuid === 'function' && getuid() === 0;
}

/** Linux 的 yama 门禁；非 Linux / 没装 yama 时读不到。 */
function readPtraceScope(): number | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const value = Number(readFileSync('/proc/sys/kernel/yama/ptrace_scope', 'utf8').trim());
    return Number.isInteger(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 内核拒绝读取的错误。
 *
 * 只把「权限」类错误当成需要提权：进程不存在、wrapper 没映射、版本对不上这些
 * 提权也修不好，重试只会让用户白输一次密码。
 */
export function isPermissionError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return (
    /operation not permitted|permission denied|not permitted|permission/i.test(message) ||
    /不允许的操作|权限不足|没有权限|操作不允许/i.test(message) ||
    /EPERM|EACCES/i.test(message) ||
    /os error (1|13)\b/i.test(message) ||
    /PTRACE_ATTACH|ptrace attach|task_for_pid (?:失败|failed)/i.test(message) ||
    /\/proc\/\d+\/mem|ptrace_scope/i.test(message)
  );
}

/** `sudo` 可执行文件；`WEQBOT_SUDO` 可覆盖（测试 / 非标准 PATH）。 */
function sudoPath(): string {
  return process.env.WEQBOT_SUDO?.trim() || 'sudo';
}

/**
 * `sudo -n true` 的结果缓存。
 *
 * 登录页每 4 秒轮询一次实例列表，每次都 fork 一个 `sudo` 去问「凭据还在不在」
 * 是不可接受的（每次都是一个真实进程）。代价是「刚输完密码」的 15 秒内页面可能
 * 还会问一次密码 —— 用户最多多输一次，而多输一次比每 4 秒一个进程好得多。
 */
let sudoCachedUntil = 0;
let sudoCachedValue = false;

function sudoCredentialsCached(): Promise<boolean> {
  const now = Date.now();
  if (now < sudoCachedUntil) return Promise.resolve(sudoCachedValue);
  return probeSudoCredentials().then((value) => {
    sudoCachedValue = value;
    sudoCachedUntil = now + 15_000;
    return value;
  });
}

/** `sudo -n true`：凭据还在缓存里时立刻成功，且**绝不**弹提示。 */
function probeSudoCredentials(): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      resolve(false);
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(sudoPath(), ['-n', 'true'], { stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, 2000);
    timer.unref?.();
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/** 页面需要的提权状态（登录页「有头模式」卡片顶部显示）。 */
export async function describeElevation(): Promise<ElevationState> {
  const platform = process.platform;
  const elevated = isRoot();
  const ptraceScope = readPtraceScope();

  if (platform === 'win32') {
    return {
      platform,
      elevated,
      cached: false,
      mechanism: 'none',
      hint: 'Windows 读取同用户进程的内存不需要提权；如果被系统策略拦住，用管理员身份运行 weqbot。',
    };
  }

  const mechanism: ElevationMechanism = 'sudo';
  const cached = elevated ? true : await sudoCredentialsCached();
  const hint = elevated
    ? '当前进程已以 root 运行，读取 QQ 内存不需要再输密码。'
    : ptraceScope === 0
      ? '内核放行了同用户进程的 ptrace 附加，通常不需要提权；被拒时再输入管理员密码。'
      : '读取运行中 QQ 的内存需要一次管理员授权（sudo）。密码只用于这一次读取，不会保存。';

  return {
    platform,
    elevated,
    cached,
    mechanism,
    ...(ptraceScope !== undefined ? { ptraceScope } : {}),
    hint,
  };
}

// ─────────────────────────── 运行中的 QQ 实例 ───────────────────────────

export interface QqInstance {
  pid: number;
  ppid: number;
  /** 进程名（`QQ.exe` / `qq`）。 */
  name: string;
  /** 运行中那一个 QQ 的 `wrapper.node`（签名用）。 */
  wrapperPath?: string;
  /** 运行中那一个 QQ 的 `major.node`（读 subAppId / 版本）。 */
  majorPath?: string;
}

/**
 * 列出正在运行的 QQ 主进程。
 *
 * 用 `listProcessesWithModule('wrapper.node')` 而不是按进程名扫：QQ 的
 * 子进程（渲染 / 通话）也带 `qq` 字样，只有主进程映射了 `wrapper.node`。
 * 拿不到 native 能力时返回空数组 —— 有头模式整体不可用，页面据此隐藏入口。
 */
export function listQqInstances(binding: RawNativeBinding): QqInstance[] {
  if (!binding.listProcessesWithModule) return [];
  const found = binding.listProcessesWithModule('wrapper.node');
  const seen = new Set<number>();
  const instances: QqInstance[] = [];
  for (const entry of found) {
    if (entry.pid <= 0 || seen.has(entry.pid)) continue;
    // 只认进程名像 QQ 的：WeQ / WeqBot 自己的进程不映射 wrapper.node，但白名单
    // 比黑名单稳 —— 名字不对的一律不碰。
    if (!looksLikeQqProcess(entry.name)) continue;
    seen.add(entry.pid);
    let modules: { wrapperPath: string; majorPath: string } | null = null;
    try {
      modules = binding.resolveQqRuntimeModules?.(entry.pid) ?? null;
    } catch {
      modules = null;
    }
    instances.push({
      pid: entry.pid,
      ppid: entry.ppid,
      name: entry.name,
      ...(modules ? { wrapperPath: modules.wrapperPath, majorPath: modules.majorPath } : {}),
    });
  }
  return instances.sort((a, b) => a.pid - b.pid);
}

// ─────────────────────────── 扫描 ───────────────────────────

export interface ScanRequest {
  pid: number;
  uin?: string;
  uid?: string;
  /** 用户刚输入的 sudo 密码；没有且需要提权时抛 `ELEVATION_REQUIRED`。 */
  password?: string;
}

export interface ScanOptions extends ScanRequest {
  binding: RawNativeBinding;
  logger: Logger;
  /** 注入点：测试替身（避免测试真的 fork 一个 sudo）。 */
  runElevated?: (request: ScanRequest & { password: string }) => Promise<ScannedMaterial>;
  /** 注入点：sudo 凭据缓存探测；默认走 `sudo -n true`。 */
  sudoCached?: () => Promise<boolean>;
}

/**
 * 先确认进程还在。
 *
 * 不先查一步的话，一个刚退出的 pid 会拿到「/proc/<pid>/mem 不可读」—— 那串
 * 文案与「权限不足」长得一样，页面会去弹提权框，用户输完密码才发现 QQ 早退出了。
 * Linux 有 `/proc`，查一下是零成本的；其它平台没有等价的免提权手段，交给 native 报。
 */
function assertProcessAlive(pid: number): void {
  if (process.platform !== 'linux') return;
  if (!existsSync(`/proc/${pid}`)) {
    throw new AttachError(
      'PROCESS_GONE',
      `pid ${pid} 已经不存在了（QQ 可能刚退出），刷新实例列表再试`,
    );
  }
}

/**
 * 读一次会话物料：先本进程，权限错误再（有密码时）提权。
 *
 * 返回前会校验 a2/d2/d2Key 都在 —— 只缺 secToken 是允许的（native 扫不到就是
 * `undefined`，那一层退回固定间隔重扫）。
 */
export async function scanSessionMaterial(options: ScanOptions): Promise<ScannedMaterial> {
  const { binding, logger } = options;
  assertProcessAlive(options.pid);
  if (!binding.scanSessionMaterial) {
    throw new AttachError(
      'NATIVE_MISSING_CAPABILITY',
      '当前原生组件不支持读取运行中 QQ 的会话（缺少 scanSessionMaterial）',
    );
  }

  const attempt = async (): Promise<ScannedMaterial> => {
    try {
      return (await binding.scanSessionMaterial!(
        options.pid,
        options.uin ?? undefined,
        options.uid ?? undefined,
      )) as ScannedMaterial;
    } catch (cause) {
      if (!isPermissionError(cause)) {
        const message = cause instanceof Error ? cause.message : String(cause);
        // 进程没了与「扫不到物料」是两件事，但都靠 native 的文案判断；进程不在
        // 时 /proc 读取会报 No such process。
        throw new AttachError(
          /no such process|not found|不存在/i.test(message)
            ? 'PROCESS_GONE'
            : 'NO_SESSION_MATERIAL',
          message,
        );
      }
      logger.info('读取 QQ 内存被内核拒绝，需要提权', { pid: options.pid });
      // sudo 的时间戳还在时不弹框：`sudo -S` 在这种情况下不会读 stdin，直接起
      // 子进程就能成 —— 让人再输一遍密码是最没必要的摩擦。
      // 只在没拿到密码时才去问 sudo（那是一次真实 fork）：用户已经填了就直接用。
      let password = options.password;
      if (password === undefined && process.platform !== 'win32') {
        const cached = await (options.sudoCached ?? sudoCredentialsCached)();
        if (cached) password = '';
      }
      if (password === undefined) {
        throw new AttachError(
          'ELEVATION_REQUIRED',
          '读取运行中 QQ 的内存需要管理员权限',
          '这是一次性的：同一次 QQ 登录只需要读一次，之后复用内存里的会话。',
        );
      }
      const elevated = options.runElevated ?? runElevatedScan;
      return elevated({ ...options, password });
    }
  };

  const material = await attempt();
  if (!material.a2 || !material.d2 || !material.d2Key) {
    throw new AttachError(
      'NO_SESSION_MATERIAL',
      '没有读到完整的会话物料：QQ 可能还没登录完成，或这个版本的内存结构变了',
    );
  }
  return material;
}

/**
 * 起一个 root 子进程读一次。
 *
 * 密码走 stdin（`sudo -S`），**不出现在 argv / 环境变量 / 日志**里。子进程用完
 * 即退，不留后台 root 进程。所有输入都是 argv：sudo 会重置环境，靠 env 传值
 * 在真机上必然失效一次。
 */
function runElevatedScan(request: ScanRequest & { password: string }): Promise<ScannedMaterial> {
  if (process.platform === 'win32') {
    // Windows 没有 `sudo -S`；同用户读取本来就不需要提权，走到这里说明是策略
    // 级拒绝，提权子进程也解决不了。
    throw new AttachError(
      'ELEVATION_FAILED',
      'Windows 下无法为单次读取提权，请用管理员身份运行 weqbot',
    );
  }

  const entry = process.argv[1];
  if (!entry) {
    throw new AttachError('ELEVATION_FAILED', '找不到 weqbot 入口文件，无法起提权子进程');
  }
  const ntHelperPath = resolveNativePath();

  // 嵌入 Electron（WeQ）时 `process.execPath` 是 electron 本体，必须显式告诉它
  // “当 node 跑”，否则 sudo 起来的是一个 GUI 进程。独立 CLI 形态下用 node 本身。
  const underElectron = Boolean(process.versions.electron);
  const runtime = underElectron
    ? ['/usr/bin/env', 'ELECTRON_RUN_AS_NODE=1', process.execPath]
    : [process.execPath];

  const args = [
    '-S',
    '-p',
    '',
    ...runtime,
    // dev 下 `--import tsx` 在这里，打包后为空数组：两条形态用同一份入口。
    ...process.execArgv,
    entry,
    ATTACH_WORKER_FLAG,
    ntHelperPath,
    String(request.pid),
    request.uin ?? '',
    request.uid ?? '',
  ];

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(sudoPath(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (cause) {
      reject(
        new AttachError(
          'ELEVATION_FAILED',
          `起不了提权子进程：${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      );
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        child.kill('SIGKILL');
        reject(new AttachError('ELEVATION_FAILED', '提权读取超时（sudo 认证或 native 加载失败）'));
      });
    }, WORKER_TIMEOUT_MS);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (cause) => {
      finish(() =>
        reject(
          new AttachError(
            'ELEVATION_FAILED',
            `提权子进程启动失败：${cause instanceof Error ? cause.message : String(cause)}`,
          ),
        ),
      );
    });
    child.on('close', (code) => {
      finish(() => {
        const payload = parseWorkerOutput(stdout);
        if (payload?.ok && payload.material) {
          resolve(payload.material);
          return;
        }
        if (/incorrect password|Sorry, try again|密码/i.test(stderr) || code === 1) {
          reject(new AttachError('ELEVATION_FAILED', '管理员密码不正确，或认证被取消'));
          return;
        }
        reject(
          new AttachError(
            'ELEVATION_FAILED',
            payload?.error ?? stderr.trim().split('\n').pop() ?? `提权子进程退出（code ${code}）`,
          ),
        );
      });
    });

    // 密码 + 换行；`-p ''` 让 sudo 不打印提示到 stderr。
    child.stdin?.end(`${request.password}\n`);
  });
}

interface WorkerPayload {
  ok: boolean;
  material?: ScannedMaterial;
  error?: string;
}

/** 子进程可能被 native 的日志污染 stdout：取最后一行能解析的 JSON。 */
function parseWorkerOutput(stdout: string): WorkerPayload | undefined {
  const lines = stdout.trim().split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line?.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as WorkerPayload;
      if (typeof parsed.ok === 'boolean') return parsed;
    } catch {
      // 继续往前找。
    }
  }
  return undefined;
}

/**
 * `weqbot --attach-worker` 的实现（root 侧的那一半）。
 *
 * 只做一件事：加载 native、扫一次、把结果作为单行 JSON 打到 stdout。任何失败
 * 都写进 `{ok:false,error}` 并以非零码退出 —— 父进程靠这一行判结果，不解析
 * stderr 的自由文本。
 *
 * 必须在 `require` 之前 chdir 到 addon 目录：nt_helper 加载时会从 cwd 往上找
 * LICENSE，打包后的路径与 dev 不同，往上找是唯一两种布局都成立的姿势。
 */
export async function runAttachWorker(argv: string[]): Promise<void> {
  const [ntHelperArg, pidRaw, uin, uid] = argv;
  // **先转绝对路径再 chdir**：父进程传进来的可能是相对路径，chdir 到 addon 目录
  // 之后同一个字符串会指向 addon 目录下的另一个位置（真机上会报「找不到原生组件」）。
  const ntHelperPath = ntHelperArg ? resolve(ntHelperArg) : '';
  // 用函数声明而不是 const 箭头：只有前者的 `never` 会参与控制流窄化，箭头函数
  // 在 `if (!x) fail()` 之后仍会把 x 当成没被排除的 undefined。
  function fail(error: string, code = 1): never {
    process.stderr.write(`${JSON.stringify({ ok: false, error })}\n`);
    return process.exit(code);
  }

  const pid = Number(pidRaw);
  if (!ntHelperPath || !existsSync(ntHelperPath)) {
    fail(`原生组件不存在：${ntHelperPath ?? '(missing)'}`, 2);
  }
  if (!Number.isInteger(pid) || pid <= 0) fail(`pid 不合法：${pidRaw}`, 2);

  try {
    process.chdir(dirname(ntHelperPath));
  } catch (cause) {
    fail(`chdir 失败：${cause instanceof Error ? cause.message : String(cause)}`, 2);
  }

  // 动态 import：这条分支在 root 子进程里跑，不需要把整个 CLI 的模块图都拉起来。
  const { loadNative } = await import('../loader');
  let binding: RawNativeBinding;
  try {
    binding = loadNative({ dir: dirname(ntHelperPath) }).binding;
  } catch (cause) {
    fail(`加载原生组件失败：${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!binding.scanSessionMaterial) fail('原生组件缺少 scanSessionMaterial');

  try {
    const material = (await binding.scanSessionMaterial!(
      pid,
      uin || undefined,
      uid || undefined,
    )) as ScannedMaterial;
    process.stdout.write(`${JSON.stringify({ ok: true, material })}\n`);
    process.exit(0);
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
  }
}
