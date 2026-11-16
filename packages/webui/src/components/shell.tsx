/**
 * 应用壳：左侧导航 + 顶栏 + 内容区。
 *
 * 导航项只在**账号在线**时出现；「退出登录」与「退出控制台」是两个不同的动作
 * （前者让 QQ 账号下线并发 UnRegister，后者只清浏览器会话），所以放在账号菜单里
 * 分开列，不合并成一个「退出」。
 */

import {
  Activity,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  CircleUserRound,
  Gauge,
  LogOut,
  Network,
  ScrollText,
  ShieldOff,
  TerminalSquare,
  type LucideIcon,
  MoreVertical,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { ConsolePhase, Overview } from '../api/types';
import { usePolling } from '../lib/hooks';
import { EASE_OUT, enterRise, enterStagger, screenExit } from '../lib/motion';
import { formatDuration, PHASE_LABEL } from '../lib/format';
import { Logo } from './logo';
import { ThemeToggle } from './theme-toggle';
import './shell.css';
import { DebugPage } from '../pages/debug/debug-page';
import { LogsPage } from '../pages/logs/logs-page';
import { NetworkPage } from '../pages/network/network-page';
import { OverviewPage } from '../pages/overview/overview-page';

export type PageKey = 'overview' | 'network' | 'logs' | 'debug';

export interface PageProps {
  overview: Overview | undefined;
  phase: ConsolePhase;
  reloadOverview(): void;
}

interface NavItem {
  key: PageKey;
  label: string;
  Icon: LucideIcon;
}

const NAV: NavItem[] = [
  { key: 'overview', label: '总览', Icon: Gauge },
  { key: 'network', label: '网络', Icon: Network },
  { key: 'logs', label: '日志', Icon: ScrollText },
  { key: 'debug', label: '调试', Icon: TerminalSquare },
];

export function Shell({
  phase,
  onLocked,
  onLoggedOut,
}: {
  phase: ConsolePhase;
  onLocked(): void;
  onLoggedOut(): void;
}) {
  const [page, setPage] = useState<PageKey>('overview');
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState<'logout' | 'lock' | null>(null);

  const loadOverview = useCallback(() => api.overview.get(), []);
  // 总览数据 3 秒一轮：心跳 / 网络客户端数这类值是实时的，但没必要上 SSE。
  const { data: overview, reload } = usePolling(loadOverview, 3000);

  // 侧栏折叠状态记在本地：这是纯外观偏好，不属于控制台配置。
  useEffect(() => {
    setCollapsed(localStorage.getItem('weqbot.nav.collapsed') === '1');
  }, []);
  const toggleCollapsed = useCallback(() => {
    setCollapsed((value) => {
      const next = !value;
      localStorage.setItem('weqbot.nav.collapsed', next ? '1' : '0');
      return next;
    });
  }, []);

  const account = overview?.account;
  const onlineLabel = useMemo(() => {
    if (phase !== 'online' || !account?.onlineSince) return PHASE_LABEL[phase] ?? phase;
    return `在线 ${formatDuration(Date.now() - account.onlineSince)}`;
  }, [phase, account?.onlineSince]);

  const logout = useCallback(
    async (forgetCredential: boolean) => {
      setBusy('logout');
      setMenuOpen(false);
      try {
        await api.account.logout({ forgetCredential });
        onLoggedOut();
      } finally {
        setBusy(null);
      }
    },
    [onLoggedOut],
  );

  const lock = useCallback(async () => {
    setBusy('lock');
    setMenuOpen(false);
    try {
      await api.auth.deleteSession();
      onLocked();
    } finally {
      setBusy(null);
    }
  }, [onLocked]);

  const PageComponent =
    page === 'overview'
      ? OverviewPage
      : page === 'network'
        ? NetworkPage
        : page === 'logs'
          ? LogsPage
          : DebugPage;

  return (
    <motion.div
      className="shell"
      data-collapsed={collapsed || undefined}
      initial="hidden"
      animate="shown"
      exit={screenExit}
      variants={enterStagger}
    >
      <aside className="shell-nav" aria-label="主导航">
        <div className="shell-brand">
          <Logo size={26} />
          {!collapsed && <span className="shell-brand-name">WeqBot</span>}
        </div>

        <nav className="shell-nav-list">
          {NAV.map(({ key, label, Icon }) => {
            const active = page === key;
            return (
              <button
                key={key}
                type="button"
                className="shell-nav-item"
                aria-current={active ? 'page' : undefined}
                title={collapsed ? label : undefined}
                onClick={() => setPage(key)}
              >
                {/* 选中条用共享 layoutId 滑动，不分页重挂载。 */}
                {active && (
                  <motion.span
                    layoutId="shell-nav-active"
                    className="shell-nav-active"
                    transition={{ type: 'spring', bounce: 0.16, duration: 0.42 }}
                  />
                )}
                <Icon size={17} strokeWidth={1.9} aria-hidden="true" />
                {!collapsed && <span>{label}</span>}
              </button>
            );
          })}
        </nav>

        <div className="shell-nav-footer">
          <a
            className="shell-nav-item shell-nav-link"
            href="/docs/"
            target="_blank"
            rel="noreferrer noopener"
            title={collapsed ? '文档' : undefined}
          >
            <BookOpen size={17} strokeWidth={1.9} aria-hidden="true" />
            {!collapsed && <span>文档</span>}
          </a>
          <button
            type="button"
            className="shell-collapse"
            onClick={toggleCollapsed}
            aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
            title={collapsed ? '展开侧栏' : '收起侧栏'}
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </div>
      </aside>

      <div className="shell-main">
        <header className="shell-top">
          <div className="shell-heading">
            <h1>{NAV.find((item) => item.key === page)?.label}</h1>
            {page === 'overview' && account && (
              <span className="shell-heading-sub">{account.nickname || account.uin}</span>
            )}
          </div>
          <div className="shell-top-actions">
            <span className="shell-status" data-phase={phase}>
              <span className="shell-status-dot" aria-hidden="true" />
              {onlineLabel}
            </span>
            <ThemeToggle />
            <div className="shell-menu-anchor">
              <button
                type="button"
                className="shell-icon-button"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label="账号菜单"
                onClick={() => setMenuOpen((value) => !value)}
              >
                <MoreVertical size={17} aria-hidden="true" />
              </button>
              <AnimatePresence>
                {menuOpen && (
                  <motion.div
                    className="shell-menu"
                    role="menu"
                    initial={{ opacity: 0, y: -6, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -6, scale: 0.98 }}
                    transition={{ duration: 0.16, ease: EASE_OUT }}
                  >
                    <div className="shell-menu-head">
                      {account?.avatarUrl ? (
                        <img
                          className="shell-avatar"
                          src={account.avatarUrl}
                          alt=""
                          width={34}
                          height={34}
                        />
                      ) : (
                        <CircleUserRound size={34} strokeWidth={1.4} aria-hidden="true" />
                      )}
                      <div>
                        <strong>{account?.nickname || account?.uin || '未登录'}</strong>
                        <span>{account ? `uin ${account.uin}` : '账号不在线'}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      role="menuitem"
                      className="shell-menu-item"
                      disabled={busy !== null}
                      onClick={() => void logout(false)}
                    >
                      <LogOut size={15} aria-hidden="true" />
                      退出登录
                      <span className="shell-menu-hint">账号下线</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="shell-menu-item"
                      disabled={busy !== null}
                      onClick={() => void logout(true)}
                    >
                      <ShieldOff size={15} aria-hidden="true" />
                      退出并删除凭据
                      <span className="shell-menu-hint">下次重新登录</span>
                    </button>
                    <hr className="shell-menu-sep" />
                    <button
                      type="button"
                      role="menuitem"
                      className="shell-menu-item"
                      disabled={busy !== null}
                      onClick={() => void lock()}
                    >
                      <Activity size={15} aria-hidden="true" />
                      退出控制台
                      <span className="shell-menu-hint">账号不下线</span>
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </header>

        <motion.main className="shell-content" variants={enterRise}>
          <PageComponent overview={overview} phase={phase} reloadOverview={reload} />
        </motion.main>
      </div>
    </motion.div>
  );
}
