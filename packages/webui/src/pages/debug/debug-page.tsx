/**
 * 调试页：左 action 列表 / 中参数 JSON / 右响应。
 *
 * 写操作（`write: true`）必须二次确认 —— 这类调用会真的改 QQ 侧状态，
 * 而调试页又是最容易手滑的地方。参数模板来自 action 名（`get_*` 给空对象，
 * `send_*` 给最小可用骨架），不是 schema：schema 还没有（TODO W8）。
 */

import {
  AlertTriangle,
  Check,
  CircleAlert,
  Copy,
  LoaderCircle,
  Play,
  Search,
  TerminalSquare,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../api';
import type { ActionInfo, ActionRunResult, ActionsSnapshot } from '../../api/types';
import { Button } from '../../components/button';
import { ACTION_GROUP_LABEL, formatMs } from '../../lib/format';
import './debug.css';

const NICHE_EMPTY = '{}';

export function DebugPage() {
  const [snapshot, setSnapshot] = useState<ActionsSnapshot>();
  const [selected, setSelected] = useState<string>();
  const [filter, setFilter] = useState('');
  const [params, setParams] = useState('');
  const [result, setResult] = useState<ActionRunResult>();
  const [failure, setFailure] = useState<string>();
  const [running, setRunning] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    api.debug
      .actions()
      .then((value) => {
        if (!active) return;
        setSnapshot(value);
        if (value.actions[0] && !selected) setSelected(value.actions[0].name);
      })
      .catch((cause) => {
        if (active) setFailure(describe(cause));
      });
    return () => {
      active = false;
    };
  }, [selected]);

  // 选中新 action 时换模板；用户已经改过参数就不动（避免手误丢掉输入）。
  useEffect(() => {
    if (!selected) return;
    setParams(templateOf(selected));
    setResult(undefined);
    setFailure(undefined);
  }, [selected]);

  const groups = useMemo(() => groupActions(snapshot?.actions ?? [], filter), [snapshot, filter]);
  const current = snapshot?.actions.find((action) => action.name === selected);
  const parsed = useMemo(() => parseParams(params), [params]);

  const run = useCallback(async () => {
    if (!selected) return;
    if (!parsed.ok) {
      setFailure(parsed.error);
      return;
    }
    setRunning(true);
    setFailure(undefined);
    setResult(undefined);
    try {
      const response = await api.debug.run(selected, parsed.value);
      setResult(response);
    } catch (cause) {
      setFailure(describe(cause));
    } finally {
      setRunning(false);
      setConfirming(false);
    }
  }, [selected, parsed]);

  const copyResponse = useCallback(async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // 忽略：不影响查看
    }
  }, [result]);

  return (
    <div className="dbg">
      <aside className="dbg-actions card" aria-label="Action 列表">
        <label className="dbg-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            placeholder="过滤 action…"
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
          />
        </label>
        <div className="dbg-action-list">
          {snapshot === undefined ? (
            <p className="dbg-empty">正在读取…</p>
          ) : snapshot.actions.length === 0 ? (
            <p className="dbg-empty">{emptyReasonOf(snapshot)}</p>
          ) : groups.length === 0 ? (
            <p className="dbg-empty">没有匹配的 action。</p>
          ) : (
            groups.map((group) => (
              <section key={group.key} className="dbg-group">
                <h3>
                  {ACTION_GROUP_LABEL[group.key] ?? group.key}
                  <span>{group.items.length}</span>
                </h3>
                <ul>
                  {group.items.map((action) => (
                    <li key={action.name}>
                      <button
                        type="button"
                        className="dbg-action"
                        aria-current={action.name === selected ? 'true' : undefined}
                        onClick={() => setSelected(action.name)}
                        title={action.summary}
                      >
                        <span className="mono">{action.name}</span>
                        {action.write && <em>写</em>}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </aside>

      <section className="dbg-editor card" aria-label="参数">
        <header className="dbg-head">
          <h2 className="mono">{selected ?? '选择一个 action'}</h2>
          {current && (
            <span className="dbg-summary">
              {current.summary || '—'}
              <span className="dbg-badge">{current.group}</span>
              {current.write && (
                <span className="dbg-badge" data-tone="accent">
                  写操作
                </span>
              )}
            </span>
          )}
        </header>

        <label className="dbg-params">
          <span className="sr-only">参数 JSON</span>
          <textarea
            className="mono"
            spellCheck={false}
            value={params}
            onChange={(event) => setParams(event.currentTarget.value)}
            rows={16}
          />
        </label>
        {!parsed.ok && params.trim() !== NICHE_EMPTY && (
          <p className="dbg-parse-error">
            <CircleAlert size={14} aria-hidden="true" />
            {parsed.error}
          </p>
        )}

        <footer className="dbg-footer">
          {current?.write ? (
            confirming ? (
              <div className="dbg-confirm" role="alert">
                <AlertTriangle size={15} aria-hidden="true" />
                <span>这是写操作，会真的改变 QQ 侧状态。</span>
                <Button variant="primary" size="md" onClick={() => void run()}>
                  确认执行
                </Button>
                <Button variant="ghost" size="md" onClick={() => setConfirming(false)}>
                  取消
                </Button>
              </div>
            ) : (
              <Button
                variant="primary"
                size="md"
                disabled={running}
                onClick={() => setConfirming(true)}
              >
                <Play size={15} aria-hidden="true" />
                执行（需确认）
              </Button>
            )
          ) : (
            <Button
              variant="primary"
              size="md"
              disabled={running || !selected || !parsed.ok}
              onClick={() => void run()}
            >
              {running ? (
                <LoaderCircle size={15} className="spin" aria-hidden="true" />
              ) : (
                <Play size={15} aria-hidden="true" />
              )}
              {running ? '执行中…' : '执行'}
            </Button>
          )}
        </footer>
      </section>

      <section className="dbg-result card" aria-label="响应">
        <header className="dbg-head">
          <h2>响应</h2>
          {result && (
            <span className="dbg-result-meta">
              <span className="dbg-status" data-ok={result.status === 'ok'}>
                {result.status === 'ok' ? (
                  <Check size={13} aria-hidden="true" />
                ) : (
                  <AlertTriangle size={13} aria-hidden="true" />
                )}
                {result.status} · {result.retcode}
              </span>
              <span className="mono">{formatMs(result.latencyMs)}</span>
              <button
                type="button"
                className="dbg-copy"
                onClick={() => void copyResponse()}
                aria-label="复制响应"
              >
                <Copy size={14} />
                {copied ? '已复制' : ''}
              </button>
            </span>
          )}
        </header>
        <AnimatePresence mode="wait">
          {failure ? (
            <motion.p
              key="failure"
              className="dbg-failure"
              role="alert"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <CircleAlert size={15} aria-hidden="true" />
              {failure}
            </motion.p>
          ) : result ? (
            <motion.pre
              key="result"
              className="mono dbg-json"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              {JSON.stringify(result.data, null, 2)}
              {result.wording && `\n// ${result.wording}`}
            </motion.pre>
          ) : (
            <motion.div
              key="idle"
              className="dbg-idle"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <TerminalSquare size={20} aria-hidden="true" />
              <p>执行后结果显示在这里</p>
            </motion.div>
          )}
        </AnimatePresence>
      </section>
    </div>
  );
}

/** 空列表要说清楚是哪一种，否则用户会被「账号不在线」引到错误方向。 */
function emptyReasonOf(snapshot: ActionsSnapshot): string {
  if (snapshot.phase === 'starting') return '账号正在上线，action 还没有注册。';
  if (snapshot.phase === 'no-account' || snapshot.phase === 'offline') {
    return '账号不在线，没有可执行的 action。';
  }
  if (snapshot.onebot === false) {
    return '账号在线，但 OneBot 网络未启用。请到「网络」页添加一个网络并保存。';
  }
  if (snapshot.phase === 'online' && snapshot.onebot === true) {
    return 'OneBot 已启动，但没有注册 action。';
  }
  return '没有可执行的 action（账号不在线，或 OneBot 未启用）。';
}

function groupActions(
  actions: ActionInfo[],
  filter: string,
): Array<{ key: string; items: ActionInfo[] }> {
  const needle = filter.trim().toLowerCase();
  const matched = needle
    ? actions.filter(
        (action) =>
          action.name.toLowerCase().includes(needle) ||
          action.summary.toLowerCase().includes(needle),
      )
    : actions;
  const groups = new Map<string, ActionInfo[]>();
  for (const action of matched) {
    const list = groups.get(action.group) ?? [];
    list.push(action);
    groups.set(action.group, list);
  }
  return [...groups.entries()]
    .map(([key, items]) => ({ key, items: items.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => b.items.length - a.items.length || a.key.localeCompare(b.key));
}

function parseParams(
  text: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true, value: {} };
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, error: '参数必须是 JSON 对象' };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : '不是合法 JSON' };
  }
}

/** 按 action 名给一个最小骨架；不猜测业务字段（猜错比空对象更糟）。 */
function templateOf(name: string): string {
  if (name.startsWith('send_group_msg')) {
    return JSON.stringify(
      { group_id: 0, message: [{ type: 'text', data: { text: '' } }] },
      null,
      2,
    );
  }
  if (name.startsWith('send_private_msg')) {
    return JSON.stringify({ user_id: 0, message: [{ type: 'text', data: { text: '' } }] }, null, 2);
  }
  if (name.startsWith('get_group_member_list') || name.startsWith('get_group_info')) {
    return JSON.stringify({ group_id: 0 }, null, 2);
  }
  if (name.includes('group')) return JSON.stringify({ group_id: 0 }, null, 2);
  if (name.includes('friend') || name.includes('stranger')) {
    return JSON.stringify({ user_id: 0 }, null, 2);
  }
  return NICHE_EMPTY;
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 0) return '控制台服务没有响应。';
    return cause.message;
  }
  return cause instanceof Error ? cause.message : String(cause);
}
