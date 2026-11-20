/**
 * 账号登录页：本机账号 / 自主账号 / 有头模式 / 扫码 + 上线进度。
 *
 * 环境检查已挪到「设置」页：登录只需要账号列表，安装路径和 wrapper 属于排障信息。
 *
 * **两个账号组分成两个 tab**，因为它们连设备身份都不同（服务端看来是两合设备）：
 *
 * - **本机**：`login.db` 里 QQ 本体写的 a1，uid / guid 复用本机的；上线后轮换的
 *   a1 会写回 `login.db`；
 * - **自主**：扫码产生的凭据，guid 是首次扫码时随机生成并持久化的那个。
 *
 * 同一 uin 可能在两组里各有一条 —— 这正是要分开的原因（拿错 guid 就会被服务端
 * 当成换设备）。有头模式不落凭据，仍用本机 guid。
 *
 * 三条路径都在服务端（`ConsoleRuntime.startAccount` / `startQrLogin` / `attachAccount`）；
 * 页面只展示状态。扫码进度走 SSE（`console` 事件里的 `qr`），不轮询二维码 ——
 * 那会每 500ms 拉一次 100KB 的 base64 图片。
 */

import {
  AlertTriangle,
  Check,
  CircleUserRound,
  KeyRound,
  LoaderCircle,
  LogIn,
  Plug,
  QrCode,
  RefreshCw,
  ScanLine,
  Smartphone,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import type {
  AccountGroup,
  ConsolePhase,
  LoginAccount,
  LoginProgressEvent,
  QrSnapshot,
} from '../../api/types';
import { Button } from '../../components/button';
import { Logo } from '../../components/logo';
import { useToast } from '../../components/toast';
import { usePolling } from '../../lib/hooks';
import { enterPop, enterRise, enterStagger, screenExit } from '../../lib/motion';
import { formatRelative } from '../../lib/format';
import type { LoginHint } from '../../app';
import { AttachPanel } from './attach-panel';
import './login.css';

/** 四个 tab：两个账号组 + 有头接入 + 扫码。 */
type Tab = 'local' | 'self' | 'attach' | 'qr';

export function LoginPage({
  phase,
  hint,
  onHintConsumed,
  onLocked,
}: {
  phase: ConsolePhase;
  hint?: LoginHint | null;
  onHintConsumed?(): void;
  onLocked(): void;
}) {
  const [tab, setTab] = useState<Tab>('local');
  const toast = useToast();
  /**
   * 账号列表每 4 秒重拉一次：`qqOnline` 是实时状态（用户可能在扫码期间打开 /
   * 退出了 QQ），轮询才能让它自己变 —— 不需要用户手动「重新检测」。
   *
   * 服务端只做一次 `existsSync` + 一次文件锁探针，4 秒的代价可以忽略。
   */
  const loadAccounts = useCallback(() => api.login.accounts(), []);
  const {
    data: accounts,
    error: accountsError,
    reload: reloadAccounts,
  } = usePolling(loadAccounts, 4000);
  const [qr, setQr] = useState<QrSnapshot>();
  const [starting, setStarting] = useState<string>();
  /**
   * 上线进度（当前正在上线的账号的实时说明）。
   *
   * 重点是异常设备确认：native 会等手机确认最长 45 秒，这段没有任何其它信号，
   * 页面必须把「请在手机上确认」显示出来，否则用户只能看着转圈。
   */
  const [progress, setProgress] = useState<LoginProgressEvent>();

  /**
   * 拉账号失败 = 控制台进程可能已经退了。常驻一条 toast，恢复后原地替换成
   * 成功提示（同一个 key，不会堆一屏）。
   */
  const unreachable = useRef(false);
  useEffect(() => {
    if (accountsError) {
      unreachable.current = true;
      toast.push({
        key: 'login-health',
        tone: 'error',
        title: '连不上控制台',
        detail: describe(accountsError),
        ttl: 0,
      });
    } else if (unreachable.current) {
      unreachable.current = false;
      toast.push({ key: 'login-health', tone: 'success', title: '控制台已恢复连接', ttl: 3000 });
    }
  }, [accountsError, toast]);
  // 登录成功后登录页会被卸掉：这条常驻提示不能留在控制台上。
  useEffect(() => () => toast.dismissKey('login-health'), [toast]);

  /**
   * 进度事件：**无论停在哪个 tab 都要听**。
   *
   * 异常设备确认会在「本机账号」/「自主账号」tab 里发生 —— 只订阅 `qr` tab 的话，
   * 从账号列表点上线时页面收不到任何进度，用户看到的就是转圈。
   */
  useEffect(() => {
    return api.events.subscribe({
      onConsole(event) {
        if (event.progress) setProgress(event.progress);
        if (event.qr && tab === 'qr') setQr(event.qr);
        // 上线结束（成功或失败）都要收起进度：失败时后端会另发 failure。
        if (event.phase === 'online' || event.phase === 'offline') {
          setStarting(undefined);
          setProgress(undefined);
        }
      },
    });
  }, [tab]);

  const startQr = useEffectEvent(async () => {
    setQr(undefined);
    try {
      const snapshot = await api.login.startQr();
      setQr(snapshot);
    } catch (cause) {
      toast.push({
        key: 'login-qr',
        tone: 'error',
        title: '获取二维码失败',
        detail: describe(cause),
      });
    }
  });

  // 每次切到扫码页都重新起一次：上一次的二维码可能已经过期，留着只会让人扫到死码。
  useEffect(() => {
    if (tab !== 'qr') return;
    void startQr();
    return () => {
      void api.login.cancelQr().catch(() => undefined);
    };
  }, [tab]);

  // 服务端推来的「a1 失效」：切到扫码页 + 提示，并重拉列表（失效那条已被清掉）。
  useEffect(() => {
    if (!hint) return;
    setTab('qr');
    toast.push({ key: 'login', tone: 'error', title: '需要重新扫码登录', detail: hint.notice });
    reloadAccounts();
    onHintConsumed?.();
  }, [hint, reloadAccounts, onHintConsumed, toast]);

  const login = useEffectEvent(async (uin: string, group: AccountGroup) => {
    setProgress(undefined);
    setStarting(`${group}:${uin}`);
    try {
      const result = await api.login.start(uin, { group });
      // QQ 本体正用着这个账号时，后端会先结束它再上线（页面上的徽标已经警告过）。
      if (result.endedQq > 0) {
        toast.push({
          tone: 'info',
          title: '已结束本机 QQ 进程',
          detail: `为了接管这个账号，登录前结束了 ${result.endedQq} 个 QQ 进程。`,
          ttl: 5000,
        });
      }
    } catch (cause) {
      // a1 失效：服务端已删掉 vault 里那份，只剩扫码还能继续。
      if (cause instanceof ApiError && cause.code === 'A1_EXPIRED') {
        setTab('qr');
        reloadAccounts();
      }
      toast.push({ key: 'login', tone: 'error', title: '登录失败', detail: describe(cause) });
      setStarting(undefined);
      setProgress(undefined);
    }
  });

  const qrState = qr?.state;
  const qrExpired = qrState === 'expired' || qrState === 'invalid' || qrState === 'canceled';
  const online = phase === 'online';

  return (
    <motion.main
      className="login"
      initial="hidden"
      animate="shown"
      exit={screenExit}
      variants={enterStagger}
    >
      <header className="login-brand">
        <motion.div variants={enterPop}>
          <Logo size={40} />
        </motion.div>
        <motion.h1 variants={enterRise}>登录 QQ 账号</motion.h1>
        <motion.p variants={enterRise}>
          「本机账号」复用本机 QQ 的 uid 与设备身份，「自主账号」是扫码产生的独立设备身份；
          两者严格分开，不会串用 guid。也可以接上正在运行的 QQ（有头模式）。
          同一时刻只有一个账号在线；本机 QQ 的在线状态每 4 秒自动检查一次。
        </motion.p>
      </header>

      <AnimatePresence mode="wait">
        {online ? (
          <motion.div
            key="online"
            className="login-card login-online"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.32 }}
          >
            <Check size={20} className="login-online-icon" aria-hidden="true" />
            <strong>账号已上线</strong>
            <p>控制台正在加载。</p>
          </motion.div>
        ) : (
          <motion.div
            key="form"
            className="login-card"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.32 }}
          >
            <div className="login-tabs" role="tablist" aria-label="登录方式">
              {(
                [
                  ['local', '本机账号', CircleUserRound],
                  ['self', '自主账号', KeyRound],
                  ['attach', '有头模式', Plug],
                  ['qr', '扫码登录', QrCode],
                ] as const
              ).map(([key, label, Icon]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  className="login-tab"
                  onClick={() => setTab(key)}
                >
                  {tab === key && (
                    <motion.span
                      layoutId="login-tab-pill"
                      className="login-tab-pill"
                      transition={{ type: 'spring', bounce: 0.18, duration: 0.4 }}
                    />
                  )}
                  <Icon size={15} aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>

            <AnimatePresence mode="wait">
              {tab === 'qr' ? (
                <motion.div
                  key="qr"
                  className="login-panel login-qr"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.16 }}
                >
                  <QrPanel qr={qr} expired={qrExpired} onRefresh={() => void startQr()} />
                </motion.div>
              ) : tab === 'attach' ? (
                <motion.div
                  key="attach"
                  className="login-panel"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.16 }}
                >
                  <AttachPanel />
                </motion.div>
              ) : (
                <motion.div
                  key={tab}
                  className="login-panel"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.16 }}
                >
                  {accounts === undefined ? (
                    <AccountsSkeleton />
                  ) : (
                    <AccountList
                      accounts={accounts.filter((item) => item.group === tab)}
                      tab={tab}
                      starting={starting}
                      progress={progress}
                      onLogin={login}
                      onRescan={reloadAccounts}
                    />
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {progress && starting && (
                <motion.p
                  className="login-progress"
                  data-await={
                    progress.kind === 'unusual-device' || progress.state === 'unusual-device-wait'
                      ? ''
                      : undefined
                  }
                  role="status"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                >
                  {progress.kind === 'unusual-device' ? (
                    <Smartphone size={15} aria-hidden="true" />
                  ) : (
                    <LoaderCircle size={15} className="spin" aria-hidden="true" />
                  )}
                  {progress.message}
                </motion.p>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

      <button type="button" className="login-lock" onClick={onLocked}>
        退出控制台
      </button>
    </motion.main>
  );
}

// ─────────────────────────── 扫码面板 ───────────────────────────

function QrPanel({
  qr,
  expired,
  onRefresh,
}: {
  qr: QrSnapshot | undefined;
  expired: boolean;
  onRefresh(): void;
}) {
  const [remaining, setRemaining] = useState(45);
  useEffect(() => {
    if (!qr?.expiresAt) return;
    const tick = (): void => {
      setRemaining(Math.max(0, Math.round((qr.expiresAt - Date.now()) / 1000)));
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [qr?.expiresAt]);

  const stateLabel =
    qr?.state === 'waiting-confirm'
      ? '已扫描，请在手机上确认'
      : qr?.state === 'confirmed'
        ? '已确认，正在上线'
        : qr?.state === 'expired'
          ? '二维码已过期'
          : qr?.state === 'invalid' || qr?.state === 'canceled'
            ? '登录未完成'
            : '用手机 QQ 扫描二维码';

  return (
    <>
      <div className="login-qr-frame" data-dim={expired || undefined}>
        {qr?.image ? (
          <img
            src={`data:image/png;base64,${qr.image}`}
            alt="登录二维码"
            width={196}
            height={196}
          />
        ) : (
          <div className="login-qr-placeholder">
            <LoaderCircle size={24} className="spin" aria-label="正在获取二维码" />
          </div>
        )}
        {!expired && qr?.state !== 'confirmed' && (
          <motion.span
            className="login-qr-scanline"
            aria-hidden="true"
            initial={{ top: '4%' }}
            animate={{ top: '94%' }}
            transition={{
              duration: 2.2,
              repeat: Infinity,
              repeatType: 'reverse',
              ease: 'easeInOut',
            }}
          />
        )}
        {expired && (
          <button type="button" className="login-qr-refresh" onClick={onRefresh}>
            <RefreshCw size={15} aria-hidden="true" />
            刷新二维码
          </button>
        )}
      </div>
      <p className="login-qr-state">
        {qr?.state === 'waiting-confirm' && <ScanLine size={15} aria-hidden="true" />}
        {stateLabel}
      </p>
      <p className="login-qr-hint">
        {expired
          ? (qr?.error ?? '二维码已失效')
          : `剩余 ${remaining} 秒 · 也可以用「本机账号」或「自主账号」登录`}
      </p>
    </>
  );
}

// ─────────────────────────── 账号列表 ───────────────────────────

/**
 * 一个来源的账号列表。
 *
 * 两个来源分成两个 tab 之后，`key` 仍然按 `source:uin` 拼 —— 同一 uin 在两个 tab
 * 里各有一条，不能只按 uin 做 key（切 tab 时 React 会复用错节点）。
 *
 * `qqOnline` 是**本机 QQ 本体**的在线状态（不是 bot）：为真时行内给出警告
 * 徽标 —— 点下去会接管账号，登录前先结束那个 QQ 进程。
 */
function AccountList({
  accounts,
  tab,
  starting,
  progress,
  onLogin,
  onRescan,
}: {
  accounts: LoginAccount[];
  tab: 'local' | 'self';
  /** `${group}:${uin}`，与 `login()` 里设置的保持一致。 */
  starting?: string;
  /** 正在上线那条的进度说明（异常设备确认时是「请在手机上确认」）。 */
  progress?: LoginProgressEvent;
  onLogin(uin: string, group: AccountGroup): void;
  onRescan(): void;
}) {
  if (accounts.length === 0) return <EmptyAccounts tab={tab} onRescan={onRescan} />;

  return (
    <ul className="login-accounts">
      {accounts.map((account) => {
        const key = `${account.group}:${account.uin}`;
        return (
          <li key={key}>
            <button
              type="button"
              className="login-account"
              disabled={starting !== undefined}
              onClick={() => onLogin(account.uin, account.group)}
            >
              {account.avatarUrl ? (
                <img
                  className="login-avatar"
                  src={account.avatarUrl}
                  alt=""
                  width={38}
                  height={38}
                />
              ) : (
                <CircleUserRound
                  size={38}
                  strokeWidth={1.3}
                  className="login-avatar"
                  aria-hidden="true"
                />
              )}
              <span className="login-account-text">
                <strong>{account.nickname || account.uin}</strong>
                <span>
                  {starting === key && progress
                    ? progress.message
                    : `uin ${account.uin}${
                        account.lastLoginAt
                          ? ` · 上次登录 ${formatRelative(account.lastLoginAt)}`
                          : ''
                      }`}
                </span>
                {account.qqOnline && (
                  <span
                    className="login-qq-online"
                    title="QQ 本体正在使用这个账号；登录 WeqBot 会先结束那个 QQ 进程，避免同一账号双端在线"
                  >
                    <AlertTriangle size={11} aria-hidden="true" />
                    QQ 本体在线 · 登录会先结束它
                  </span>
                )}
              </span>
              <span className="login-account-action">
                {starting === key ? (
                  progress?.kind === 'unusual-device' ? (
                    <Smartphone size={16} aria-label="等待手机确认" />
                  ) : (
                    <LoaderCircle size={16} className="spin" aria-label="正在登录" />
                  )
                ) : (
                  <LogIn size={16} aria-hidden="true" />
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ─────────────────────────── 空态与骨架 ───────────────────────────

function AccountsSkeleton() {
  return (
    <ul className="login-accounts" aria-busy="true" aria-label="正在读取账号">
      {[0, 1].map((index) => (
        <li key={index} className="login-account skeleton-row" />
      ))}
    </ul>
  );
}

function EmptyAccounts({ tab, onRescan }: { tab: 'local' | 'self'; onRescan(): void }) {
  return (
    <div className="login-empty">
      <AlertTriangle size={20} aria-hidden="true" />
      <strong>{tab === 'local' ? '没有可用的本机 QQ 登录记录' : '还没有自主账号'}</strong>
      <p>
        {tab === 'local'
          ? '这台机器上的 login.db 读不出来，或者记录里没有可用的 a1。也可以用手机扫码登录（那样会建一个自主账号，设备身份与本机 QQ 无关）。'
          : '扫码登录成功后会存一份自主凭据：guid 在首次扫码时生成，之后一直复用它。a1 失效时只删这一份，不影响本机账号。'}
      </p>
      <Button variant="secondary" onClick={onRescan}>
        <RefreshCw size={15} aria-hidden="true" />
        重新检测
      </Button>
    </div>
  );
}

// ─────────────────────────── 工具 ───────────────────────────

function describe(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 0) return '控制台服务没有响应 —— 检查 weqbot 进程是否还在运行。';
    // 项目策略拒绝与凭据无关：显式说出来，否则用户会以为要重新登录 / 重新扫码。
    if (cause.code === 'ACCESS_DENIED') {
      return '当前构建的项目策略限制了登录 —— 这不是 QQ 凭据或扫码的问题，重新登录也不会改变结果。';
    }
    // a1 失效：后端已经删掉 vault 里那份，这里要说清楚「为什么列表少了一条」。
    if (cause.code === 'A1_EXPIRED') {
      return '保存的 a1 已失效，这一组的凭据已清除 —— 请用扫码登录，或换另一组账号。';
    }
    // 消息可能缺失（老后端 / 非 JSON 响应），此时 `ApiError` 的 message 退化成了
    // code。裸 code（`INTERNAL` / `BAD_JSON`）对用户没有任何意义，换成人话。
    const message = cause.message?.trim();
    if (message && message !== cause.code) return message;
    return '登录失败：控制台没有给出原因，详见控制台日志。';
  }
  return cause instanceof Error ? cause.message : String(cause);
}
