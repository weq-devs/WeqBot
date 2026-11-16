/**
 * 日志页：三条流（运行日志 / action 调用 / 推送事件）+ 统计头。
 *
 * 缓冲有界（服务端 2000 / 1000），页面只保留最近 500 条渲染 —— 再多就是
 * 虚拟列表的问题，而控制台的日志页只需要「最近发生了什么」。
 */

import {
  Bot,
  CircleAlert,
  Copy,
  History,
  Pause,
  Play,
  Radio,
  Search,
  TerminalSquare,
  Trash2,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import type {
  ActionCallEntry,
  ActionStats,
  LogEntry,
  LogStats,
  PushEventEntry,
  StreamName,
} from '../../api/types';
import { usePolling } from '../../lib/hooks';
import { formatClock, formatCompact, formatMs, LEVEL_LABEL } from '../../lib/format';
import './logs.css';

const MAX_ROWS = 500;

const STREAMS: { key: StreamName; label: string; Icon: typeof Bot }[] = [
  { key: 'logs', label: '运行日志', Icon: TerminalSquare },
  { key: 'actions', label: 'Action 调用', Icon: Bot },
  { key: 'events', label: '推送事件', Icon: Radio },
];

type AnyEntry = LogEntry | ActionCallEntry | PushEventEntry;

export function LogsPage() {
  const [stream, setStream] = useState<StreamName>('logs');
  const [paused, setPaused] = useState(false);
  const [entries, setEntries] = useState<Record<StreamName, AnyEntry[]>>({
    logs: [],
    actions: [],
    events: [],
  });
  const [filter, setFilter] = useState('');
  const [detail, setDetail] = useState<AnyEntry | null>(null);

  const loadStats = useCallback(() => api.logs.stats(), []);
  const { data: stats } = usePolling(loadStats, 4000);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // 三条流同时在后台订阅：切标签时不需要重新建立连接，统计头也不会滞后。
  useEffect(() => {
    const offs = STREAMS.map(({ key }) =>
      api.logs.stream(key, {
        onEntry(entry) {
          if (pausedRef.current) return;
          setEntries((current) => {
            const list = current[key];
            const next = [...list, entry as AnyEntry];
            return { ...current, [key]: next.length > MAX_ROWS ? next.slice(-MAX_ROWS) : next };
          });
        },
      }),
    );
    return () => {
      for (const off of offs) off();
    };
  }, []);

  const visible = useMemo(() => {
    const list = entries[stream];
    const needle = filter.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((entry) => JSON.stringify(entry).toLowerCase().includes(needle));
  }, [entries, stream, filter]);

  return (
    <div className="logs">
      <header className="logs-stats" aria-label="统计">
        <StatTile label="Action 调用" value={stats ? formatCompact(stats.actions.total) : '—'} />
        <StatTile
          label="成功率"
          value={
            stats && stats.actions.total > 0
              ? `${((stats.actions.ok / stats.actions.total) * 100).toFixed(1)}%`
              : '—'
          }
        />
        <StatTile
          label="p50 / p95"
          value={
            stats
              ? `${formatMs(stats.actions.latency.p50)} / ${formatMs(stats.actions.latency.p95)}`
              : '—'
          }
        />
        <StatTile
          label="错误码"
          value={
            stats && stats.actions.byRetcode.length > 0
              ? stats.actions.byRetcode
                  .slice(0, 2)
                  .map((item) => `${item.retcode}×${item.count}`)
                  .join(' ')
              : '无'
          }
        />
        <StatTile label="推送事件" value={stats ? formatCompact(stats.events.total) : '—'} />
      </header>

      <div className="logs-toolbar">
        <div className="logs-tabs" role="tablist" aria-label="日志流">
          {STREAMS.map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={stream === key}
              className="logs-tab"
              onClick={() => setStream(key)}
            >
              {stream === key && (
                <motion.span
                  layoutId="logs-tab-pill"
                  className="logs-tab-pill"
                  transition={{ type: 'spring', bounce: 0.16, duration: 0.4 }}
                />
              )}
              <Icon size={14} aria-hidden="true" />
              {label}
              <span className="logs-tab-count">{entries[key].length}</span>
            </button>
          ))}
        </div>

        <label className="logs-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            placeholder="搜索…"
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
          />
        </label>

        <div className="logs-actions">
          <button
            type="button"
            className="logs-icon-button"
            aria-pressed={paused}
            aria-label={paused ? '继续接收' : '暂停接收'}
            title={paused ? '继续接收' : '暂停接收'}
            onClick={() => setPaused((value) => !value)}
          >
            {paused ? <Play size={15} /> : <Pause size={15} />}
          </button>
          <button
            type="button"
            className="logs-icon-button"
            aria-label="清空本页"
            title="清空本页"
            onClick={() => setEntries((current) => ({ ...current, [stream]: [] }))}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      {paused && (
        <p className="logs-paused" role="status">
          <Pause size={13} aria-hidden="true" />
          已暂停接收，新日志不会进入列表
        </p>
      )}

      <div className="logs-table-wrap">
        {visible.length === 0 ? (
          <div className="logs-empty">
            <History size={18} aria-hidden="true" />
            <p>{filter ? '没有匹配的记录' : '还没有记录'}</p>
          </div>
        ) : (
          <table className="logs-table">
            <thead>
              <tr>
                <th scope="col" className="logs-col-time">
                  时间
                </th>
                {stream === 'logs' && <th scope="col">级别</th>}
                {stream === 'actions' && <th scope="col">Action</th>}
                {stream === 'events' && <th scope="col">类型</th>}
                <th scope="col">{headerFor(stream)}</th>
                <th scope="col" className="logs-col-right">
                  {stream === 'actions' ? '耗时' : '详情'}
                </th>
              </tr>
            </thead>
            <tbody>
              {visible
                .slice()
                .reverse()
                .map((entry, index) => (
                  <Row
                    key={`${entry.ts}-${index}`}
                    stream={stream}
                    entry={entry}
                    onOpen={() => setDetail(entry)}
                  />
                ))}
            </tbody>
          </table>
        )}
      </div>

      <AnimatePresence>
        {detail && <DetailDrawer entry={detail} onClose={() => setDetail(null)} />}
      </AnimatePresence>

      {stats && stats.actions.byAction.length > 0 && <ActionBreakdown stats={stats.actions} />}
    </div>
  );
}

function headerFor(stream: StreamName): string {
  return stream === 'logs' ? '内容' : stream === 'actions' ? '参数' : '摘要';
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="logs-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Row({ stream, entry, onOpen }: { stream: StreamName; entry: AnyEntry; onOpen(): void }) {
  const time = formatClock(entry.ts);
  if (stream === 'logs') {
    const log = entry as LogEntry;
    return (
      <tr onClick={onOpen} className="logs-row" data-level={log.level}>
        <td className="mono logs-col-time">{time}</td>
        <td>
          <span className="logs-level" data-level={log.level}>
            {LEVEL_LABEL[log.level] ?? log.level}
          </span>
        </td>
        <td>
          <span className="logs-scope mono">{log.scope}</span>
          <span className="logs-msg">{log.msg}</span>
        </td>
        <td className="logs-col-right">{log.fields ? <ChevronHint /> : null}</td>
      </tr>
    );
  }

  if (stream === 'actions') {
    const call = entry as ActionCallEntry;
    return (
      <tr
        onClick={onOpen}
        className="logs-row"
        data-level={call.status === 'ok' ? 'info' : 'error'}
      >
        <td className="mono logs-col-time">{time}</td>
        <td>
          <span className="logs-action mono">{call.action}</span>
          {call.status === 'failed' && <span className="logs-retcode">{call.retcode}</span>}
        </td>
        <td className="logs-params mono">{preview(call.params)}</td>
        <td className="logs-col-right mono">
          <span className="logs-latency">{formatMs(call.latencyMs)}</span>
          <span className="logs-transport">{call.transport}</span>
        </td>
      </tr>
    );
  }

  const event = entry as PushEventEntry;
  return (
    <tr onClick={onOpen} className="logs-row" data-level="info">
      <td className="mono logs-col-time">{time}</td>
      <td>
        <span className="logs-type">{event.type}</span>
        <span className="logs-kind mono">{event.kind}</span>
      </td>
      <td className="logs-summary">{event.summary}</td>
      <td className="logs-col-right">{event.peer ? <ChevronHint /> : null}</td>
    </tr>
  );
}

function ChevronHint() {
  return (
    <span className="logs-chevron" aria-hidden="true">
      ›
    </span>
  );
}

function DetailDrawer({ entry, onClose }: { entry: AnyEntry; onClose(): void }) {
  const [copied, setCopied] = useState(false);
  const text = JSON.stringify(entry, null, 2);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // 剪贴板权限被拒：不影响查看。
    }
  }, [text]);

  return (
    <motion.aside
      className="logs-detail"
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={{ type: 'spring', bounce: 0, duration: 0.36 }}
      aria-label="记录详情"
    >
      <header>
        <h2>{formatClock(entry.ts)}</h2>
        <div>
          <button
            type="button"
            className="logs-icon-button"
            onClick={() => void copy()}
            aria-label="复制 JSON"
          >
            <Copy size={15} />
          </button>
          <button type="button" className="logs-icon-button" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
      </header>
      {copied && <p className="logs-copied">已复制</p>}
      <pre className="logs-json mono">{text}</pre>
    </motion.aside>
  );
}

/** 按 action 的调用量：单色柱，靠标签区分（不是多系列）。 */
function ActionBreakdown({ stats }: { stats: ActionStats }) {
  const max = Math.max(1, ...stats.byAction.map((item) => item.count));
  return (
    <section className="card logs-breakdown">
      <header>
        <h3>调用分布</h3>
        <span>
          {stats.byAction.length} 个 action · 失败 {stats.failed}
        </span>
      </header>
      <ul>
        {stats.byAction.slice(0, 10).map((item) => (
          <li key={item.action}>
            <span className="logs-breakdown-name mono">{item.action}</span>
            <span className="logs-breakdown-track" aria-hidden="true">
              <span
                className="logs-breakdown-fill"
                style={{ width: `${(item.count / max) * 100}%` }}
                data-failed={item.failed > 0 || undefined}
              />
            </span>
            <span className="logs-breakdown-count">{item.count}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function preview(value: Record<string, unknown>): string {
  const text = JSON.stringify(value);
  return text === '{}' ? '—' : text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

/** 统计里的错误码为空时给一个明确的「无」，而不是空白（空白会被当成加载中）。 */
export function EmptyStats() {
  return (
    <div className="logs-empty">
      <CircleAlert size={18} aria-hidden="true" />
      <p>还没有统计数据</p>
    </div>
  );
}
