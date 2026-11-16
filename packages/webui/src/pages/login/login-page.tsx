/**
 * 账号登录页：本机账号 / 扫码 + 上线进度。
 *
 * 环境检查已挪到「设置」页：登录只需要账号列表，安装路径和 wrapper 属于排障信息。
 *
 * 两条路径都在服务端（`ConsoleRuntime.startAccount` / `startQrLogin`）；页面只
 * 展示状态。扫码进度走 SSE（`console` 事件里的 `qr`），不轮询二维码 —— 那会
 * 每 500ms 拉一次 100KB 的 base64 图片。
 */

import {
  AlertTriangle,
  Check,
  CircleAlert,
  CircleUserRound,
  LoaderCircle,
  LogIn,
  QrCode,
  RefreshCw,
  ScanLine,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import type { ConsolePhase, LoginAccount, QrSnapshot } from '../../api/types';
import { Button } from '../../components/button';
import { Logo } from '../../components/logo';
import { enterPop, enterRise, enterStagger, screenExit } from '../../lib/motion';
import { formatRelative } from '../../lib/format';
import './login.css';

type Tab = 'accounts' | 'qr';

export function LoginPage({ phase, onLocked }: { phase: ConsolePhase; onLocked(): void }) {
  const [tab, setTab] = useState<Tab>('accounts');
  const [accounts, setAccounts] = useState<LoginAccount[]>();
  const [qr, setQr] = useState<QrSnapshot>();
  const [failure, setFailure] = useState<string>();
  const [starting, setStarting] = useState<string>();
  const qrRequested = useRef(false);

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

  // 切到扫码页时自动起一次；45 秒过期后由用户点「刷新」。
  useEffect(() => {
    if (tab !== 'qr' || qrRequested.current) return;
    qrRequested.current = true;
    void startQr();
    return () => {
      void api.login.cancelQr().catch(() => undefined);
    };
  }, [tab]);

  const login = useEffectEvent(async (uin: string) => {
    setFailure(undefined);
    setStarting(uin);
    try {
      await api.login.start(uin);
    } catch (cause) {
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
          用本机 QQ 的登录记录直接上线，或者用手机扫码。同一时刻只有一个账号在线。
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
                  ['accounts', '本机账号', CircleUserRound],
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
              {tab === 'accounts' ? (
                <motion.div
                  key="accounts"
                  className="login-panel"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.16 }}
                >
                  {accounts === undefined ? (
                    <AccountsSkeleton />
                  ) : accounts.length === 0 ? (
                    <EmptyAccounts onRescan={() => void loadAccounts()} />
                  ) : (
                    <ul className="login-accounts">
                      {accounts.map((account) => (
                        <li key={account.uin}>
                          <button
                            type="button"
                            className="login-account"
                            disabled={starting !== undefined}
                            onClick={() => void login(account.uin)}
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
                                {account.lastLoginAt
                                  ? ` · 上次登录 ${formatRelative(account.lastLoginAt)}`
                                  : ''}
                              </span>
                            </span>
                            {!account.hasA1 && (
                              <span className="login-badge" data-tone="warning">
                                无 a1
                              </span>
                            )}
                            <span className="login-account-action">
                              {starting === account.uin ? (
                                <LoaderCircle size={16} className="spin" aria-label="正在登录" />
                              ) : (
                                <LogIn size={16} aria-hidden="true" />
                              )}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </motion.div>
              ) : (
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
          : `剩余 ${remaining} 秒 · 也可以直接用「本机账号」登录`}
      </p>
    </>
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

function EmptyAccounts({ onRescan }: { onRescan(): void }) {
  return (
    <div className="login-empty">
      <AlertTriangle size={20} aria-hidden="true" />
      <strong>没有找到本机账号</strong>
      <p>这台机器上还没有 QQ 的登录记录，或者 login.db 读不出来。用手机扫码登录更直接。</p>
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
    return cause.message;
  }
  return cause instanceof Error ? cause.message : String(cause);
}
