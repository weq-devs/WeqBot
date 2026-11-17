/**
 * 网络页：四类网络卡片 + 居中模态卡片编辑。
 *
 * 保存走 `PUT /api/onebot/config`：服务端会先停旧适配器再按新配置起，失败回滚。
 * 改动自动保存（防抖 550ms），不再有「保存并应用」按钮 —— 端口、路径、role
 * 都是少数几个值，下拉 + 输入框比「猜」可靠；用户不该为了一个开关去找保存按钮。
 */

import {
  AlertTriangle,
  Check,
  CirclePlus,
  Globe,
  LoaderCircle,
  Plug,
  PlugZap,
  Radio,
  Trash2,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import type {
  MessageFormat,
  NetworkConfig,
  NetworkSnapshot,
  OneBotConfig,
  WsRole,
} from '../../api/types';
import { Button } from '../../components/button';
import { Switch } from '../../components/switch';
import { useToast } from '../../components/toast';
import { usePolling } from '../../lib/hooks';
import { NETWORK_KIND_LABEL, NETWORK_STATE_LABEL } from '../../lib/format';
import type { PageProps } from '../../components/shell';
import './network.css';

type Kind = NetworkConfig['kind'];

const KINDS: { kind: Kind; label: string; Icon: typeof Globe; hint: string }[] = [
  { kind: 'httpServers', label: 'HTTP 服务端', Icon: Globe, hint: '客户端 POST /action 调进来' },
  { kind: 'httpClients', label: 'HTTP 上报', Icon: Radio, hint: '事件 POST 出去' },
  { kind: 'wsServers', label: '正向 WS', Icon: Plug, hint: '客户端连进来' },
  { kind: 'wsClients', label: '反向 WS', Icon: PlugZap, hint: '我们连出去' },
];

export function NetworkPage({ overview, phase }: PageProps) {
  const load = useCallback(() => api.network.get(), []);
  const { data: loaded, error, reload } = usePolling(load, 8000);
  const [draft, setDraft] = useState<OneBotConfig>();
  const [editing, setEditing] = useState<{ kind: Kind; index: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [savedAt, setSavedAt] = useState<number>();
  const toast = useToast();
  /** 最后一次成功落盘的序列化内容：防抖保存据此判断是否真的改了。 */
  const lastSaved = useRef<string | undefined>(undefined);
  /** 最新草稿：保存回来时只在草稿没被继续编辑的前提下回填。 */
  const draftRef = useRef<OneBotConfig | undefined>(undefined);
  draftRef.current = draft;

  // 首次拿到配置后建草稿；之后不再用服务端值覆盖用户正在编辑的内容。
  useEffect(() => {
    if (loaded && !draft) {
      lastSaved.current = JSON.stringify(loaded);
      setDraft(structuredClone(loaded));
    }
  }, [loaded, draft]);

  const dirty = Boolean(draft && loaded && JSON.stringify(draft) !== JSON.stringify(loaded));

  const persist = useCallback(
    async (config: OneBotConfig, serialized: string) => {
      setSaving(true);
      setFailure(undefined);
      try {
        const saved = await api.network.save(config);
        lastSaved.current = JSON.stringify(saved);
        // 服务端会把 accessToken 换成 `***`；回填草稿才能让「已保存」生效，
        // 但保存期间用户又改了东西时不能用旧响应盖掉新输入。
        if (JSON.stringify(draftRef.current) === serialized) setDraft(structuredClone(saved));
        setSavedAt(Date.now());
        reload();
      } catch (cause) {
        const message = describe(cause);
        setFailure(message);
        // 自动保存失败时用户可能已经在看别处（比如刚改完 accessToken 就往下滚），
        // 行内错误不一定在视野里 —— 再推一条 toast，用同一个 key 避免堆叠。
        toast.push({
          key: 'network-save',
          tone: 'error',
          title: '网络配置保存失败',
          detail: message,
        });
      } finally {
        setSaving(false);
      }
    },
    [reload, toast],
  );

  // 自动保存：改动停止 550ms 后提交。失败时保留草稿，用户改一下或点「重试」。
  useEffect(() => {
    if (!draft) return;
    const serialized = JSON.stringify(draft);
    if (serialized === lastSaved.current) return;
    const timer = setTimeout(() => void persist(draft, serialized), 550);
    return () => clearTimeout(timer);
  }, [draft, persist]);

  const update = useCallback((kind: Kind, index: number, patch: Partial<NetworkConfig>) => {
    setDraft((current) => {
      if (!current) return current;
      const list = current.networks[kind] as NetworkConfig[];
      const next = { ...current, networks: { ...current.networks } };
      (next.networks as Record<Kind, NetworkConfig[]>)[kind] = list.map((item, position) =>
        position === index ? ({ ...item, ...patch } as NetworkConfig) : item,
      );
      return next;
    });
  }, []);

  const remove = useCallback((kind: Kind, index: number) => {
    setDraft((current) => {
      if (!current) return current;
      const list = current.networks[kind] as NetworkConfig[];
      const next = { ...current, networks: { ...current.networks } };
      (next.networks as Record<Kind, NetworkConfig[]>)[kind] = list.filter(
        (_, position) => position !== index,
      );
      return next;
    });
    setEditing((current) =>
      current && current.kind === kind && current.index === index ? null : current,
    );
  }, []);

  const add = useCallback((kind: Kind) => {
    setDraft((current) => {
      if (!current) return current;
      const list = current.networks[kind] as NetworkConfig[];
      const next = { ...current, networks: { ...current.networks } };
      (next.networks as Record<Kind, NetworkConfig[]>)[kind] = [
        ...list,
        defaultNetwork(kind, list.length + 1),
      ];
      setEditing({ kind, index: list.length });
      return next;
    });
  }, []);

  const snapshots = overview?.networks ?? [];
  const findSnapshot = (network: NetworkConfig): NetworkSnapshot | undefined =>
    snapshots.find((item) => item.name === network.name && matchesKind(item.kind, network.kind));

  const editingNetwork =
    editing && draft
      ? ((draft.networks[editing.kind] as NetworkConfig[])[editing.index] as
          | NetworkConfig
          | undefined)
      : undefined;

  return (
    <div className="net">
      <div className="net-toolbar">
        {' '}
        <p className="net-hint">
          配置按当前账号保存（{overview?.account?.uin ?? '未上线'}）。改动会自动保存并热重启 OneBot
          适配器，会话与账号保持在线；账号不在线时先保存，上线后自动启动。
        </p>
        <span className="net-autosave" data-saving={saving || undefined} role="status">
          {saving ? (
            <>
              <LoaderCircle size={14} className="spin" aria-hidden="true" />
              保存中…
            </>
          ) : savedAt && !dirty ? (
            <>
              <Check size={14} aria-hidden="true" />
              已自动保存
            </>
          ) : dirty ? (
            <>
              <span className="net-autosave-dot" aria-hidden="true" />
              等待保存…
            </>
          ) : null}
        </span>
      </div>

      <AnimatePresence>
        {(failure ?? (error ? describe(error) : undefined)) && (
          <motion.p
            className="net-failure"
            role="alert"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
          >
            <AlertTriangle size={15} aria-hidden="true" />
            <span>{failure ?? describe(error)}</span>
            {failure && draft && (
              <Button
                variant="ghost"
                size="md"
                onClick={() => void persist(draft, JSON.stringify(draft))}
              >
                重试
              </Button>
            )}
          </motion.p>
        )}
      </AnimatePresence>

      <div className="net-groups">
        {KINDS.map(({ kind, label, Icon, hint }) => {
          const list = (draft?.networks[kind] ?? []) as NetworkConfig[];
          return (
            <section key={kind} className="card net-group">
              <header className="net-group-head">
                <h3>
                  <Icon size={16} aria-hidden="true" />
                  {label}
                  <span className="net-group-count">{list.length}</span>
                </h3>
                <span className="net-group-hint">{hint}</span>
              </header>

              {list.length === 0 ? (
                <p className="net-empty">没有配置。</p>
              ) : (
                <ul className="net-list">
                  {list.map((network, index) => {
                    const snapshot = findSnapshot(network);
                    return (
                      <li key={itemKey(network)} className="net-item">
                        <span
                          className="net-dot"
                          data-state={
                            snapshot?.state ??
                            (network.enabled === false ? 'stopped' : 'connecting')
                          }
                          aria-hidden="true"
                        />
                        <button
                          type="button"
                          className="net-item-main"
                          onClick={() => setEditing({ kind, index })}
                        >
                          <span className="net-item-name">{network.name}</span>
                          <span className="net-item-endpoint mono">{endpointOf(network)}</span>
                          <span
                            className="net-item-state"
                            title={
                              snapshot
                                ? (NETWORK_STATE_LABEL[snapshot.state] ?? snapshot.state)
                                : network.enabled === false
                                  ? '这条网络已关闭，不会被启动'
                                  : '配置已保存；账号上线后自动启动'
                            }
                          >
                            {snapshot
                              ? (NETWORK_STATE_LABEL[snapshot.state] ?? snapshot.state)
                              : network.enabled === false
                                ? '已关闭'
                                : phase === 'online'
                                  ? '启动中…'
                                  : '账号上线后启动'}
                            {snapshot && snapshot.clients > 0 && ` · ${snapshot.clients}`}
                          </span>
                        </button>
                        <Switch
                          checked={network.enabled !== false}
                          aria-label={`${network.name} 启用`}
                          onChange={(enabled) => update(kind, index, { enabled })}
                        />
                        <button
                          type="button"
                          className="net-item-remove"
                          aria-label={`删除 ${network.name}`}
                          onClick={() => remove(kind, index)}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              <button type="button" className="net-add" onClick={() => add(kind)}>
                <CirclePlus size={15} aria-hidden="true" />
                添加
              </button>
            </section>
          );
        })}
      </div>

      <AnimatePresence>
        {editingNetwork && editing && (
          <NetworkModal
            key={`${editing.kind}:${editing.index}`}
            kind={editing.kind}
            network={editingNetwork}
            saving={saving}
            onChange={(patch) => update(editing.kind, editing.index, patch)}
            onClose={() => setEditing(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ─────────────────────────── 模态卡片 ───────────────────────────

function NetworkModal({
  kind,
  network,
  saving,
  onChange,
  onClose,
}: {
  kind: Kind;
  network: NetworkConfig;
  saving: boolean;
  onChange(patch: Partial<NetworkConfig>): void;
  onClose(): void;
}) {
  const server = kind === 'httpServers' || kind === 'wsServers';
  const ws = kind === 'wsServers' || kind === 'wsClients';

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <motion.div
      className="net-modal-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
      onClick={onClose}
    >
      <motion.section
        className="net-modal card"
        role="dialog"
        aria-modal="true"
        aria-label="编辑网络"
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.98 }}
        transition={{ type: 'spring', bounce: 0, duration: 0.32 }}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="net-modal-head">
          <div>
            <h2>{NETWORK_KIND_LABEL[snapshotKindOf(kind)] ?? kind}</h2>
            <span className="net-modal-sub">改动自动保存</span>
          </div>
          <button type="button" className="net-modal-close" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </header>

        <div className="net-modal-body">
          <Field label="名称">
            <input
              className="net-input"
              value={network.name}
              onChange={(event) => onChange({ name: event.currentTarget.value })}
            />
          </Field>

          {server ? (
            <>
              <Field label="监听地址">
                <input
                  className="net-input mono"
                  value={(network as { host?: string }).host ?? '127.0.0.1'}
                  onChange={(event) => onChange({ host: event.currentTarget.value })}
                />
              </Field>
              <Field label="端口">
                <input
                  className="net-input mono"
                  type="number"
                  min={0}
                  max={65535}
                  value={(network as { port: number }).port}
                  onChange={(event) =>
                    onChange({ port: Number(event.currentTarget.value) } as Partial<NetworkConfig>)
                  }
                />
              </Field>
              <Field label="路径">
                <input
                  className="net-input mono"
                  value={(network as { path?: string }).path ?? '/'}
                  onChange={(event) => onChange({ path: event.currentTarget.value })}
                />
              </Field>
              {kind === 'httpServers' && (
                <div className="net-field net-field-row">
                  <span id="net-ws-shared">同时接受 WS 连接</span>
                  <Switch
                    checked={Boolean((network as { enableWebSocket?: boolean }).enableWebSocket)}
                    aria-labelledby="net-ws-shared"
                    onChange={(enableWebSocket) => onChange({ enableWebSocket })}
                  />
                </div>
              )}
            </>
          ) : (
            <Field label="目标地址">
              <input
                className="net-input mono"
                value={(network as { url: string }).url}
                onChange={(event) => onChange({ url: event.currentTarget.value })}
              />
            </Field>
          )}

          {ws && (
            <Field label="角色">
              <select
                className="net-input"
                value={(network as { role?: WsRole }).role ?? 'Universal'}
                onChange={(event) => onChange({ role: event.currentTarget.value as WsRole })}
              >
                <option value="Universal">Universal（收发都行）</option>
                <option value="Api">Api（只收 action）</option>
                <option value="Event">Event（只收事件）</option>
              </select>
            </Field>
          )}

          <Field label="消息格式">
            <select
              className="net-input"
              value={network.messageFormat}
              onChange={(event) =>
                onChange({ messageFormat: event.currentTarget.value as MessageFormat })
              }
            >
              <option value="array">array（消息段数组）</option>
              <option value="string">string（CQ 码）</option>
            </select>
          </Field>

          <div className="net-field net-field-row">
            <span id="net-report-self">
              上报自身消息
              <small>`message_sent` 事件是否推给客户端</small>
            </span>
            <Switch
              checked={network.reportSelfMessage}
              aria-labelledby="net-report-self"
              onChange={(reportSelfMessage) => onChange({ reportSelfMessage })}
            />
          </div>

          <Field label="访问令牌">
            <input
              className="net-input mono"
              type="password"
              placeholder="留空表示不鉴权"
              value={network.accessToken ?? ''}
              onChange={(event) => onChange({ accessToken: event.currentTarget.value })}
            />
            <small className="net-field-hint">
              显示 `***` 表示已有令牌，保持不动会自动沿用原值。
            </small>
          </Field>
        </div>

        <footer className="net-modal-foot">
          <span className="net-autosave" data-saving={saving || undefined}>
            {saving ? (
              <>
                <LoaderCircle size={14} className="spin" aria-hidden="true" />
                保存中…
              </>
            ) : (
              <>
                <Check size={14} aria-hidden="true" />
                已自动保存
              </>
            )}
          </span>
          <Button variant="secondary" size="md" onClick={onClose}>
            完成
          </Button>
        </footer>
      </motion.section>
    </motion.div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  // 用 `div` 而不是 `label`：`children` 可能是普通 input / select，也可能是一个
  // 自带 `aria-label` 的开关；由控件自己声明名字比隐式 `label` 更明确。
  return (
    <div className="net-field">
      <span className="net-field-label">{label}</span>
      {children}
    </div>
  );
}

// ─────────────────────────── 工具 ───────────────────────────

function matchesKind(snapshotKind: NetworkSnapshot['kind'], configKind: Kind): boolean {
  return snapshotKind === snapshotKindOf(configKind);
}

/** 配置里的复数键 → 观测快照的 kind（两套命名各自贴合自己的使用场景）。 */
function snapshotKindOf(kind: Kind): NetworkSnapshot['kind'] {
  switch (kind) {
    case 'httpServers':
      return 'http-server';
    case 'httpClients':
      return 'http-client';
    case 'wsServers':
      return 'ws-server';
    case 'wsClients':
      return 'ws-client';
  }
}

/** 稳定的条目 key：配置里名字可改、可重名，用名字 + 地址组合。 */
function itemKey(network: NetworkConfig): string {
  return 'url' in network ? `${network.kind}:${network.url}` : `${network.kind}:${network.port}`;
}

function endpointOf(network: NetworkConfig): string {
  if ('url' in network) return network.url;
  return `${network.host ?? '127.0.0.1'}:${network.port}${network.path ?? '/'}`;
}

function defaultNetwork(kind: Kind, index: number): NetworkConfig {
  const base = { messageFormat: 'array' as const, reportSelfMessage: false };
  switch (kind) {
    case 'httpServers':
      return {
        kind,
        name: `HTTP ${index}`,
        host: '127.0.0.1',
        port: 5700 + index,
        path: '/',
        ...base,
      };
    case 'httpClients':
      return { kind, name: `上报 ${index}`, url: 'http://127.0.0.1:8080/onebot/event', ...base };
    case 'wsServers':
      return {
        kind,
        name: `正向 WS ${index}`,
        host: '127.0.0.1',
        port: 6700 + index,
        path: '/',
        role: 'Universal',
        ...base,
      };
    case 'wsClients':
      return {
        kind,
        name: `反向 WS ${index}`,
        url: 'ws://127.0.0.1:8080/onebot/v11/ws',
        role: 'Universal',
        reconnectIntervalMs: 5000,
        ...base,
      };
  }
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.code === 'PORT_CONFLICT') return cause.message;
    if (cause.status === 0) return '控制台服务没有响应。';
    return cause.message;
  }
  return cause instanceof Error ? cause.message : String(cause);
}
