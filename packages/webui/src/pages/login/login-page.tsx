/**
 * 账号登录页：已保存的凭据 / QQ 登录记录 / 扫码 + 上线进度。
 *
 * 环境检查已挪到「设置」页：登录只需要账号列表，安装路径和 wrapper 属于排障信息。
 *
 * **两个账号来源分成两个 tab**：vault 里的是「我们存的、用来上线的 a1」，`login.db`
 * 里的是「QQ 本体最后写进去的」。同一 uin 可能两边各有一条，语义不同、失效处理也不同
 * （a1 失效只清 vault 那条，见 `ConsoleRuntime.forgetExpiredCredential`），所以不合并。
 *
 * 三条路径都在服务端（`ConsoleRuntime.startAccount` / `startQrLogin`）；页面只展示
 * 状态。扫码进度走 SSE（`console` 事件里的 `qr`），不轮询二维码 —— 那会每 500ms
 * 拉一次 100KB 的 base64 图片。
 */

import {
  AlertTriangle,
  Check,
  CircleAlert,
  CircleUserRound,
  KeyRound,
  LoaderCircle,
  LogIn,
  QrCode,
  RefreshCw,
  ScanLine,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useEffectEvent, useState } from 'react';
import { api, ApiError } from '../../api';
import type { AccountSource, ConsolePhase, LoginAccount, QrSnapshot } from '../../api/types';
import { Button } from '../../components/button';
import { Logo } from '../../components/logo';
import { enterPop, enterRise, enterStagger, screenExit } from '../../lib/motion';
import { formatRelative } from '../../lib/format';
import type { LoginHint } from '../../app';
import './login.css';

/** 三个 tab：两个账号来源 + 扫码。 */
type Tab = 'saved' | 'local' | 'qr';

const ACCOUNT_SOURCE_OF: Record<'saved' | 'local', AccountSource> = {
  saved: 'vault',
  local: 'login-db',
};

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
  const [tab, setTab] = useState<Tab>('saved');
  const [accounts, setAccounts] = useState<LoginAccount[]>();
  const [qr, setQr] = useState<QrSnapshot>();
  const [failure, setFailure] = useState<string>();
  const [starting, setStarting] = useState<string>();

  const loadAccounts = useCallback(async () => {
    try {
      setAccounts(await api.login.accounts());
    } catch (cause) {
      setFailure(describe(cause));
    }
  }, []);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  // 扫码进度由服务端推过来；二维码图片也在这条流里，不轮询。
  useEffect(() => {
    if (tab !== 'qr') return;
    const off = api.events.subscribe({
      onConsole(event) {
        if (event.qr) setQr(event.qr);
        if (event.phase === 'online') setStarting(undefined);
      },
    });
    return off;
  }, [tab]);

  const startQr = useEffectEvent(async () => {
    setFailure(undefined);
    setQr(undefined);
    try {
      const snapshot = await api.login.startQr();
      setQr(snapshot);
    } catch (cause) {
      setFailure(describe(cause));
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
    setFailure(hint.notice);
    void loadAccounts();
    onHintConsumed?.();
  }, [hint, loadAccounts, onHintConsumed]);

  const login = useEffectEvent(async (uin: string, source: AccountSource) => {
    setFailure(undefined);
    setStarting(`${source}:${uin}`);
    try {
      await api.login.start(uin, { source });
    } catch (cause) {
      // a1 失效：服务端已删掉 vault 里那份，只剩扫码还能继续。
      if (cause instanceof ApiError && cause.code === 'A1_EXPIRED') {
        setTab('qr');
        await loadAccounts();
      }
      setFailure(describe(cause));
      setStarting(undefined);
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
          用已经保存的凭据或本机 QQ 的登录记录上线，也可以用手机扫码。同一时刻只有一个账号在线。
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
                  ['saved', '已保存', KeyRound],
                  ['local', 'QQ 记录', CircleUserRound],
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
                      accounts={accounts.filter((item) => item.source === ACCOUNT_SOURCE_OF[tab])}
                      tab={tab}
                      starting={starting}
                      onLogin={login}
                      onRescan={() => void loadAccounts()}
                    />
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {failure && (
                <motion.p
                  className="login-failure"
                  role="alert"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                >
                  <CircleAlert size={15} aria-hidden="true" />
                  {failure}
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
          : `剩余 ${remaining} 秒 · 也可以直接用「已保存」或「QQ 记录」登录`}
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
 */
function AccountList({
  accounts,
  tab,
  starting,
  onLogin,
  onRescan,
}: {
  accounts: LoginAccount[];
  tab: 'saved' | 'local';
  /** `${source}:${uin}`，与 `login()` 里设置的保持一致。 */
  starting?: string;
  onLogin(uin: string, source: AccountSource): void;
  onRescan(): void;
}) {
  if (accounts.length === 0) return <EmptyAccounts tab={tab} onRescan={onRescan} />;

  return (
    <ul className="login-accounts">
      {accounts.map((account) => {
        const key = `${account.source}:${account.uin}`;
        return (
          <li key={key}>
            <button
              type="button"
              className="login-account"
              disabled={starting !== undefined}
              onClick={() => onLogin(account.uin, account.source)}
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
                  uin {account.uin}
                  {account.lastLoginAt ? ` · 上次登录 ${formatRelative(account.lastLoginAt)}` : ''}
                </span>
              </span>
              <span className="login-account-action">
                {starting === key ? (
                  <LoaderCircle size={16} className="spin" aria-label="正在登录" />
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

function EmptyAccounts({ tab, onRescan }: { tab: 'saved' | 'local'; onRescan(): void }) {
  return (
    <div className="login-empty">
      <AlertTriangle size={20} aria-hidden="true" />
      <strong>{tab === 'saved' ? '还没有保存过凭据' : '没有可用的 QQ 登录记录'}</strong>
      <p>
        {tab === 'saved'
          ? 'WeqBot 保存的凭据用完之后会删掉（例如 a1 失效）。可以用 QQ 登录记录或扫码重新登录。'
          : '这台机器上的 login.db 读不出来，或者记录里没有可用的 a1。用手机扫码登录更直接。'}
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
      return '保存的 a1 已失效，凭据已清除 —— 请用「QQ 记录」或扫码重新登录。';
    }
    return cause.message;
  }
  return cause instanceof Error ? cause.message : String(cause);
}
