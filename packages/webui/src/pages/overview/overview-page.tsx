/**
 * 总览：账号主卡 + 4 个指标块 + OneBot 连接 + 会话时间线。
 *
 * 图表纪律（`tokens.css` 头注释）：只有一条蓝色阶，不用彩虹色；量级用同一个蓝的
 * 明暗。这里的 sparkline 与 RTT 条都只用 `--accent`。
 */

import {
  Activity,
  CircleUserRound,
  Clock,
  Inbox,
  Radio,
  RefreshCw,
  Send,
  TerminalSquare,
  Wifi,
} from 'lucide-react';
import { motion } from 'motion/react';
import { type ReactNode, useCallback } from 'react';
import { api } from '../../api';
import type { LogStats, NetworkSnapshot } from '../../api/types';
import { useNow, usePolling } from '../../lib/hooks';
import {
  formatCompact,
  formatDateTime,
  formatDuration,
  formatMs,
  formatRelative,
  NETWORK_KIND_LABEL,
  NETWORK_STATE_LABEL,
} from '../../lib/format';
import type { PageProps } from '../../components/shell';
import './overview.css';

export function OverviewPage({ overview, phase, reloadOverview }: PageProps) {
  // 每秒刷新「在线时长」这类相对时间，避免只跟着 3 秒轮询跳。
  const now = useNow();

  const loadStats = useCallback(() => api.logs.stats(), []);
  const { data: stats } = usePolling(loadStats, 5000);

  if (!overview || phase !== 'online' || !overview.account) {
    return <OverviewIdle phase={phase} />;
  }

  const account = overview.account;
  // 掉线重连期间 `onlineSince` 可能缺失；缺失时显示「—」，不要显示成 0 秒。
  const online = account.onlineSince ? now - account.onlineSince : undefined;
  const actions = stats?.actions;

  return (
    <div className="overview">
      <section className="ov-account card">
        <div className="ov-account-avatar">
          <img src={account.avatarUrl} alt="" width={72} height={72} />
          <span className="ov-pulse" aria-hidden="true" />
        </div>
        <div className="ov-account-text">
          <h2>{account.nickname || account.uin}</h2>
          <p className="ov-account-meta">
            <span>uin {account.uin}</span>
            {account.uid && <span className="mono">uid {account.uid}</span>}
          </p>
          <p className="ov-account-facts">
            <span>
              <Clock size={14} aria-hidden="true" />
              已在线 {online === undefined ? '—' : formatDuration(online)}
            </span>
            {account.device && (
              <span>
                <Radio size={14} aria-hidden="true" />
                {account.device.os} · {account.device.clientVersion}
              </span>
            )}
            {account.sessionId !== undefined && (
              <span className="mono">session #{account.sessionId}</span>
            )}
          </p>
        </div>
        <button
          type="button"
          className="ov-refresh"
          onClick={reloadOverview}
          aria-label="刷新总览"
          title="刷新总览"
        >
          <RefreshCw size={15} aria-hidden="true" />
        </button>
      </section>

      <section className="ov-metrics" aria-label="运行指标">
        <Metric
          Icon={Inbox}
          label="收到消息"
          value={formatCompact(overview.messages.received)}
          hint="本进程累计"
        />
        <Metric
          Icon={Send}
          label="发出消息"
          value={formatCompact(overview.messages.sent)}
          hint="本进程累计"
        />
        <Metric
          Icon={TerminalSquare}
          label="Action 调用"
          value={actions ? formatCompact(actions.total) : String(overview.actions.registered)}
          hint={
            actions
              ? `${actions.ok} 成功 · ${actions.failed} 失败`
              : `${overview.actions.registered} 条已注册`
          }
          chart={actions?.latency ? <LatencyBars latency={actions.latency} /> : undefined}
        />
        <Metric
          Icon={Activity}
          label="心跳 RTT"
          value={
            overview.heartbeat.medianMs !== undefined ? formatMs(overview.heartbeat.medianMs) : '—'
          }
          hint={
            overview.heartbeat.samples.length > 0
              ? `中位数 · 最近 ${overview.heartbeat.samples.length} 次`
              : '还没有心跳样本'
          }
          chart={<Sparkline samples={overview.heartbeat.samples} />}
        />
      </section>

      <section className="ov-grid">
        <div className="card ov-networks">
          <header className="ov-card-head">
            <h3>
              <Wifi size={16} aria-hidden="true" />
              OneBot 连接
            </h3>
            {overview.onebotPort !== undefined && (
              <span className="ov-card-sub mono">端口 {overview.onebotPort}</span>
            )}
          </header>
          {overview.networks.length === 0 ? (
            <p className="ov-empty">没有启用任何网络。</p>
          ) : (
            <ul className="ov-network-list">
              {overview.networks.map((network) => (
                <NetworkRow key={`${network.kind}:${network.name}`} network={network} />
              ))}
            </ul>
          )}
        </div>

        <div className="card ov-timeline">
          <header className="ov-card-head">
            <h3>
              <Clock size={16} aria-hidden="true" />
              会话
            </h3>
          </header>
          <dl className="ov-facts">
            <div>
              <dt>本次启动</dt>
              <dd>{formatDateTime(account.startedAt)}</dd>
            </div>
            <div>
              <dt>上线时刻</dt>
              <dd>{account.onlineSince ? formatRelative(account.onlineSince, now) : '—'}</dd>
            </div>
            <div>
              <dt>重连次数</dt>
              <dd>{account.reconnects}</dd>
            </div>
            <div>
              <dt>SecToken 轮换</dt>
              <dd>
                {account.secTokenRotatesAt
                  ? formatRelative(account.secTokenRotatesAt, now).replace('前', '后')
                  : '未排期'}
              </dd>
            </div>
            <div>
              <dt>已注册 action</dt>
              <dd>
                {overview.actions.registered}
                {overview.actions.skipped > 0 && (
                  <span className="ov-muted"> · {overview.actions.skipped} 条未注册</span>
                )}
              </dd>
            </div>
            {actions && (
              <div>
                <dt>Action 分位</dt>
                <dd className="mono">
                  p50 {formatMs(actions.latency.p50)} · p95 {formatMs(actions.latency.p95)}
                </dd>
              </div>
            )}
          </dl>
        </div>
      </section>

      {actions && actions.byAction.length > 0 && (
        <section className="card ov-top-actions">
          <header className="ov-card-head">
            <h3>调用最多的 action</h3>
            <span className="ov-card-sub">最近 {actions.total} 次</span>
          </header>
          <TopActions stats={actions} />
        </section>
      )}
    </div>
  );
}

function Metric({
  Icon,
  label,
  value,
  hint,
  chart,
}: {
  Icon: typeof Inbox;
  label: string;
  value: string;
  hint: string;
  chart?: ReactNode;
}) {
  return (
    <motion.div
      className="card ov-metric"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
    >
      <header>
        <Icon size={15} aria-hidden="true" />
        {label}
      </header>
      <strong className="ov-metric-value">{value}</strong>
      <span className="ov-metric-hint">{hint}</span>
      {chart}
    </motion.div>
  );
}

/** 单色 sparkline：只画折线与末端点，无网格、无图例（单系列不需要）。 */
function Sparkline({ samples }: { samples: number[] }) {
  if (samples.length < 2) return <div className="ov-spark ov-spark-empty" />;
  const width = 100;
  const height = 28;
  const min = Math.min(...samples);
  const span = Math.max(1, Math.max(...samples) - min);
  const points = samples.map((value, index) => {
    const x = (index / (samples.length - 1)) * width;
    const y = height - ((value - min) / span) * (height - 4) - 2;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const last = points[points.length - 1]!.split(',');
  return (
    <svg
      className="ov-spark"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline points={points.join(' ')} fill="none" stroke="var(--accent)" strokeWidth="1.4" />
      <circle cx={last[0]} cy={last[1]} r="1.8" fill="var(--accent)" />
    </svg>
  );
}

/** 延迟分位：三根同色柱，靠标签区分（不是三个系列）。 */
function LatencyBars({ latency }: { latency: { p50: number; p95: number; max: number } }) {
  const max = Math.max(1, latency.max);
  const bars = [
    { label: 'p50', value: latency.p50 },
    { label: 'p95', value: latency.p95 },
    { label: 'max', value: latency.max },
  ];
  return (
    <div className="ov-bars" aria-hidden="true">
      {bars.map((bar) => (
        <span
          key={bar.label}
          className="ov-bar"
          style={{ height: `${Math.max(8, (bar.value / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

function NetworkRow({ network }: { network: NetworkSnapshot }) {
  return (
    <li className="ov-network">
      <span className="ov-network-dot" data-state={network.state} aria-hidden="true" />
      <span className="ov-network-kind">{NETWORK_KIND_LABEL[network.kind] ?? network.kind}</span>
      <span className="ov-network-name">{network.name}</span>
      <span className="ov-network-endpoint mono">{network.endpoint}</span>
      <span className="ov-network-state" data-state={network.state}>
        {NETWORK_STATE_LABEL[network.state] ?? network.state}
        {network.clients > 0 && ` · ${network.clients} 个客户端`}
      </span>
    </li>
  );
}

function TopActions({ stats }: { stats: LogStats['actions'] }) {
  const max = Math.max(1, ...stats.byAction.map((item) => item.count));
  return (
    <ul className="ov-top-list">
      {stats.byAction.map((item) => (
        <li key={item.action}>
          <span className="ov-top-name mono">{item.action}</span>
          <span className="ov-top-track" aria-hidden="true">
            <span
              className="ov-top-fill"
              style={{ width: `${(item.count / max) * 100}%` }}
              data-failed={item.failed > 0 || undefined}
            />
          </span>
          <span className="ov-top-count">
            {item.count}
            {item.failed > 0 && <em> · {item.failed} 失败</em>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function OverviewIdle({ phase }: { phase: string }) {
  return (
    <div className="ov-idle">
      <CircleUserRound size={28} strokeWidth={1.4} aria-hidden="true" />
      <p>{phase === 'starting' ? '账号正在上线…' : '账号不在线'}</p>
    </div>
  );
}
