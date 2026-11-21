import {
  AlertTriangle,
  ArrowLeft,
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
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import type {
  AccountGroup,
  ConsolePhase,
  ConsoleStateEvent,
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

const ACCOUNT_TABS = [
  ['self', 'WeqBot 自主维护', CircleUserRound],
  ['local', '借用 QQ 缓存凭据', KeyRound],
  ['attach', '借用在线实例', Plug],
] as const;

type Tab = (typeof ACCOUNT_TABS)[number][0];

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
  const [tab, setTab] = useState<Tab>('self');
  const [qrAttempt, setQrAttempt] = useState<number | null>(hint ? 0 : null);
  const qrOpen = qrAttempt !== null;
  const toast = useToast();
  // 轮询账号列表以更新本机 QQ 的在线状态。
  const {
    data: accounts,
    error: accountsError,
    reload: reloadAccounts,
  } = usePolling(api.login.accounts, 4000);
  const [qr, setQr] = useState<QrSnapshot>();
  const qrRequest = useRef(Promise.resolve());
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

  function selectTab(next: Tab) {
    if (next === tab) return;
    setQrAttempt(null);
    setTab(next);
  }

  const onConsole = useEffectEvent((event: ConsoleStateEvent) => {
    if (event.progress) setProgress(event.progress);
    if (qrOpen && event.qr) setQr(event.qr);
    if (event.phase === 'online' || event.phase === 'offline') {
      setStarting(undefined);
      setProgress(undefined);
    }
  });
  useEffect(() => api.events.subscribe({ onConsole: (event) => onConsole(event) }), []);

  useEffect(() => {
    if (qrAttempt === null) {
      setQr(undefined);
      return;
    }

    let active = true;
    let requested = false;
    setQr(undefined);
    // 先完成上一次取消请求，避免快速切换时取消了新打开的二维码。
    qrRequest.current = qrRequest.current.then(async () => {
      if (!active) return;
      requested = true;
      try {
        const snapshot = await api.login.startQr();
        if (active) setQr((latest) => latest ?? snapshot);
      } catch (cause) {
        if (active) {
          setQr({ state: 'invalid', expiresAt: 0, error: describe(cause) });
        }
      }
    });
    return () => {
      active = false;
      qrRequest.current = qrRequest.current.then(async () => {
        if (requested) await api.login.cancelQr().catch(() => undefined);
      });
    };
  }, [qrAttempt]);

  // 失效的凭据已被服务端清除，进入自主维护组的扫码面板并重拉账号。
  useEffect(() => {
    if (!hint) return;
    setTab('self');
    setQrAttempt((attempt) => attempt ?? 0);
    toast.push({ key: 'login', tone: 'error', title: '需要重新扫码登录', detail: hint.notice });
    reloadAccounts();
    onHintConsumed?.();
  }, [hint, reloadAccounts, onHintConsumed, toast]);

  async function login(uin: string, group: AccountGroup) {
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
      if (cause instanceof ApiError && cause.code === 'A1_EXPIRED') {
        setTab('self');
        setQrAttempt((attempt) => attempt ?? 0);
        reloadAccounts();
      }
      toast.push({ key: 'login', tone: 'error', title: '登录失败', detail: describe(cause) });
      setStarting(undefined);
      setProgress(undefined);
    }
  }

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
          </motion.div>
        ) : (
          <motion.div
            key="form"
            className="login-card"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.32 }}
          >
            <div className="login-tabs" role="tablist" aria-label="账号类型">
              {ACCOUNT_TABS.map(([key, label, Icon], index) => (
                <button
                  key={key}
                  id={`login-tab-${key}`}
                  type="button"
                  role="tab"
                  aria-controls={`login-panel-${key}`}
                  aria-selected={tab === key}
                  tabIndex={tab === key ? 0 : -1}
                  className="login-tab"
                  onClick={() => selectTab(key)}
                  onKeyDown={(event) => {
                    const last = ACCOUNT_TABS.length - 1;
                    let nextIndex: number;
                    switch (event.key) {
                      case 'ArrowLeft':
                        nextIndex = index === 0 ? last : index - 1;
                        break;
                      case 'ArrowRight':
                        nextIndex = index === last ? 0 : index + 1;
                        break;
                      case 'Home':
                        nextIndex = 0;
                        break;
                      case 'End':
                        nextIndex = last;
                        break;
                      default:
                        return;
                    }
                    event.preventDefault();
                    const [next] = ACCOUNT_TABS[nextIndex]!;
                    selectTab(next);
                    document.getElementById(`login-tab-${next}`)?.focus();
                  }}
                >
                  {tab === key && (
                    <motion.span
                      layoutId="login-tab-pill"
                      className="login-tab-pill"
                      transition={{ type: 'spring', bounce: 0.18, duration: 0.4 }}
                    />
                  )}
                  <Icon size={15} aria-hidden="true" />
                  <span>{label}</span>
                </button>
              ))}
            </div>

            {ACCOUNT_TABS.map(([key]) => (
              <div
                key={key}
                id={`login-panel-${key}`}
                role="tabpanel"
                aria-labelledby={`login-tab-${key}`}
                className="login-panel"
                hidden={tab !== key}
              >
                {tab === key && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.16 }}
                  >
                    {key === 'self' && (
                      <div className="login-panel-head">
                        <h2>{qrOpen ? '扫码登录' : '已保存账号'}</h2>
                        <Button
                          variant="secondary"
                          disabled={starting !== undefined}
                          onClick={() => setQrAttempt(qrOpen ? null : 0)}
                        >
                          {qrOpen ? (
                            <ArrowLeft size={15} aria-hidden="true" />
                          ) : (
                            <QrCode size={15} aria-hidden="true" />
                          )}
                          {qrOpen ? '返回账号' : '扫码登录'}
                        </Button>
                      </div>
                    )}
                    {key === 'attach' ? (
                      <AttachPanel />
                    ) : key === 'self' && qrOpen ? (
                      <QrPanel
                        qr={qr}
                        onRefresh={() => setQrAttempt((attempt) => (attempt ?? 0) + 1)}
                      />
                    ) : accounts === undefined ? (
                      <AccountsSkeleton />
                    ) : (
                      <AccountList
                        accounts={accounts.filter((item) => item.group === key)}
                        group={key}
                        starting={starting}
                        progress={progress}
                        onLogin={login}
                        onRescan={reloadAccounts}
                      />
                    )}
                  </motion.div>
                )}
              </div>
            ))}

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

function QrPanel({ qr, onRefresh }: { qr: QrSnapshot | undefined; onRefresh(): void }) {
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

  const expired = qr?.state === 'expired' || qr?.state === 'invalid' || qr?.state === 'canceled';
  const stateLabel =
    qr?.state === 'waiting-confirm'
      ? '已扫描，请在手机上确认'
      : qr?.state === 'confirmed'
        ? '已确认，正在上线'
        : expired
          ? (qr.error ?? (qr.state === 'expired' ? '二维码已过期' : '扫码未完成'))
          : qr?.image
            ? '用手机 QQ 扫码'
            : '正在获取二维码…';

  return (
    <div className="login-qr">
      <div className="login-qr-frame" data-dim={expired || undefined}>
        {qr?.image ? (
          <img
            src={`data:image/png;base64,${qr.image}`}
            alt="登录二维码"
            width={196}
            height={196}
          />
        ) : !expired ? (
          <div className="login-qr-placeholder">
            <LoaderCircle size={24} className="spin" aria-hidden="true" />
          </div>
        ) : null}
        {!expired && qr?.image && qr.state !== 'confirmed' && (
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
      <p className="login-qr-state" role="status">
        {qr?.state === 'waiting-confirm' && <ScanLine size={15} aria-hidden="true" />}
        {stateLabel}
      </p>
      {!expired && qr?.image && qr.state !== 'confirmed' && (
        <p className="login-qr-hint">剩余 {remaining} 秒</p>
      )}
    </div>
  );
}

// ─────────────────────────── 账号列表 ───────────────────────────

/**
 * 同一 uin 可能有两种凭据，登录时必须传入对应的组。
 * `qqOnline` 表示本机 QQ 正在用该账号，登录会结束对应的 QQ 进程。
 */
function AccountList({
  accounts,
  group,
  starting,
  progress,
  onLogin,
  onRescan,
}: {
  accounts: LoginAccount[];
  group: AccountGroup;
  /** `${group}:${uin}`，与 `login()` 里设置的保持一致。 */
  starting?: string;
  progress?: LoginProgressEvent;
  onLogin(uin: string, group: AccountGroup): void;
  onRescan(): void;
}) {
  if (accounts.length === 0) {
    return (
      <div className="login-empty">
        <p>{group === 'self' ? '暂无已保存账号' : '暂无可用的 QQ 缓存凭据'}</p>
        {group === 'local' && (
          <Button variant="secondary" onClick={onRescan}>
            <RefreshCw size={15} aria-hidden="true" />
            重新检测
          </Button>
        )}
      </div>
    );
  }

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
                  {account.uin}
                  {account.lastLoginAt && ` · 上次登录 ${formatRelative(account.lastLoginAt)}`}
                </span>
                {account.qqOnline && (
                  <span className="login-qq-online">
                    <AlertTriangle size={11} aria-hidden="true" />
                    QQ 在线 · 登录将关闭本机 QQ
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

function AccountsSkeleton() {
  return (
    <ul className="login-accounts" aria-busy="true" aria-label="正在读取账号">
      {[0, 1].map((index) => (
        <li key={index} className="login-account skeleton-row" />
      ))}
    </ul>
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
      return '凭据已失效并清除，请重新扫码登录。';
    }
    // 消息可能缺失（老后端 / 非 JSON 响应），此时 `ApiError` 的 message 退化成了
    // code。裸 code（`INTERNAL` / `BAD_JSON`）对用户没有任何意义，换成人话。
    const message = cause.message?.trim();
    if (message && message !== cause.code) return message;
    return '登录失败：控制台没有给出原因，详见控制台日志。';
  }
  return cause instanceof Error ? cause.message : String(cause);
}
