/**
 * 设置页：环境检查 + 日志设置 + 运行信息。
 *
 * 环境检查原来在登录页，但登录页只需要「能登录的账号」；安装路径、wrapper、
 * QQ 本体在线状态这些是排障信息，放这里才不会把登录流程挤满。
 */

import {
  AlertTriangle,
  Check,
  CircleAlert,
  FileText,
  Globe2,
  HardDrive,
  LoaderCircle,
  RefreshCw,
  ScrollText,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../api';
import type { LogLevel, SettingsSnapshot } from '../../api/types';
import { Button } from '../../components/button';
import { Switch } from '../../components/switch';
import { formatBytes, formatDuration } from '../../lib/format';
import './settings.css';

const LOG_LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'];

const LEVEL_LABEL: Record<LogLevel, string> = {
  trace: 'trace（含收发包，极啰嗦）',
  debug: 'debug（排查用）',
  info: 'info（默认）',
  warn: 'warn（只看警告）',
  error: 'error（只看错误）',
};

export function SettingsPage() {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>();
  const [failure, setFailure] = useState<string>();
  const [logDir, setLogDir] = useState('');
  const [dirBusy, setDirBusy] = useState(false);
  const [levelBusy, setLevelBusy] = useState(false);
  const [qzoneBusy, setQzoneBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number>();

  const load = useCallback(async () => {
    try {
      const value = await api.settings.get();
      setSnapshot(value);
      setLogDir(value.logging.dir ?? '');
      setFailure(undefined);
    } catch (cause) {
      setFailure(describe(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const applyLogDir = useCallback(async () => {
    setDirBusy(true);
    setFailure(undefined);
    try {
      const value = await api.settings.update({ logDir });
      setSnapshot(value);
      setLogDir(value.logging.dir ?? '');
      setSavedAt(Date.now());
    } catch (cause) {
      setFailure(describe(cause));
    } finally {
      setDirBusy(false);
    }
  }, [logDir]);

  const applyQzone = useCallback(async (qzone: boolean) => {
    setQzoneBusy(true);
    setFailure(undefined);
    try {
      const value = await api.settings.update({ qzone });
      setSnapshot(value);
      setSavedAt(Date.now());
    } catch (cause) {
      setFailure(describe(cause));
    } finally {
      setQzoneBusy(false);
    }
  }, []);

  const applyLevel = useCallback(async (level: LogLevel) => {
    setLevelBusy(true);
    setFailure(undefined);
    try {
      const value = await api.settings.update({ level });
      setSnapshot(value);
      setSavedAt(Date.now());
    } catch (cause) {
      setFailure(describe(cause));
    } finally {
      setLevelBusy(false);
    }
  }, []);

  if (!snapshot) {
    return (
      <div className="settings">
        {failure ? (
          <p className="set-failure" role="alert">
            <CircleAlert size={15} aria-hidden="true" />
            {failure}
          </p>
        ) : (
          <p className="set-loading">
            <LoaderCircle size={16} className="spin" aria-hidden="true" />
            正在读取设置…
          </p>
        )}
      </div>
    );
  }

  const environment = snapshot.environment;
  const logging = snapshot.logging;
  const runtime = snapshot.runtime;

  return (
    <div className="settings">
      <header className="card set-hero">
        <div>
          <h2>本机与运行设置</h2>
          <p>环境检查、日志落盘与运行信息都在这里；登录页只负责账号。</p>
        </div>
        <button
          type="button"
          className="set-refresh"
          onClick={() => void load()}
          aria-label="重新检查"
          title="重新检查"
        >
          <RefreshCw size={15} aria-hidden="true" />
        </button>
      </header>

      <AnimatePresence>
        {failure && (
          <motion.p
            className="set-failure"
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

      <section className="card set-section" aria-label="环境检查">
        <header className="set-section-head">
          <h3>
            <ShieldCheck size={16} aria-hidden="true" />
            环境检查
          </h3>
          <span className="set-section-sub">{environment.platform}</span>
        </header>
        <ul className="set-checks">
          <CheckRow
            label="QQ 安装"
            tone={environment.qqExe ? 'good' : 'critical'}
            detail={environment.installRoot ?? '未找到 QQ 安装目录'}
          />
          <CheckRow
            label="wrapper"
            tone={environment.wrapperNode ? 'good' : 'critical'}
            detail={environment.wrapperNode ?? '缺失，mode2 无法签名上线'}
            mono
          />
          <CheckRow
            label="客户端身份"
            tone={environment.client ? 'good' : 'critical'}
            detail={
              environment.client
                ? [
                    `appid ${environment.client.appid}`,
                    environment.client.version ?? '',
                    environment.client.qua ?? '',
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : '读不到 major.node'
            }
          />
          <CheckRow
            label="数据目录"
            tone={environment.dataRoot ? 'good' : 'critical'}
            detail={environment.dataRoot ?? '未找到'}
            mono
          />
          <CheckRow
            label="login.db"
            tone={environment.loginDbs.length > 0 ? 'good' : 'muted'}
            detail={
              environment.loginDbs.length > 0
                ? `${environment.loginDbs.length} 份`
                : '未找到（扫码登录仍然可用）'
            }
            title={environment.loginDbs.join('\n')}
          />
          <CheckRow
            label="QQ 本体在线检查"
            tone={
              environment.qqRunning === undefined
                ? 'muted'
                : environment.qqRunning
                  ? 'warning'
                  : 'good'
            }
            detail={
              environment.qqRunning === undefined
                ? '未配置 qq.dbPath，无法检查。这不影响上线；只是不能提前发现 QQ 本体在线、可能互相顶号。'
                : environment.qqRunning
                  ? 'QQ 本体正在运行 —— mode2 与 QQ 同时在线会互相顶号，请先退出 QQ。'
                  : 'QQ 本体已退出，可以安全自建上线。'
            }
          />
        </ul>
        <p className="set-note">
          `qq.dbPath` 是应用配置里的一个字段（`nt_msg.db` 的路径），由启动参数 `--qq-db` 或环境变量
          `WEQBOT_QQ_DB` 提供；设置页暂不直接修改它。
        </p>
      </section>

      <section className="card set-section" aria-label="日志">
        <header className="set-section-head">
          <h3>
            <ScrollText size={16} aria-hidden="true" />
            日志
          </h3>
          <span className="set-section-sub">
            {logging.dir ? `落盘 ${logging.fileLevel}` : '当前关闭落盘'}
          </span>
        </header>

        <div className="set-field">
          <label htmlFor="set-log-dir">日志目录</label>
          <div className="set-inline">
            <input
              id="set-log-dir"
              className="set-input mono"
              value={logDir}
              placeholder="例如 /var/log/weqbot；留空关闭落盘"
              onChange={(event) => setLogDir(event.currentTarget.value)}
            />
            <Button
              variant="primary"
              size="md"
              disabled={dirBusy}
              onClick={() => void applyLogDir()}
            >
              {dirBusy ? (
                <LoaderCircle size={15} className="spin" aria-hidden="true" />
              ) : (
                <Check size={15} aria-hidden="true" />
              )}
              {dirBusy ? '应用中…' : '应用'}
            </Button>
          </div>
          <small className="set-hint">
            立即切换本进程的落盘目录；下次启动仍以 `--config` / `WEQBOT_LOG_DIR` 为准。 native 的
            `native.log` 目录需要重启后才会跟着变。
          </small>
        </div>

        <div className="set-field">
          <label htmlFor="set-log-level">终端日志级别</label>
          <div className="set-inline">
            <select
              id="set-log-level"
              className="set-input"
              value={logging.level}
              disabled={levelBusy}
              onChange={(event) => void applyLevel(event.currentTarget.value as LogLevel)}
            >
              {LOG_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {LEVEL_LABEL[level]}
                </option>
              ))}
            </select>
            {levelBusy && <LoaderCircle size={15} className="spin" aria-hidden="true" />}
          </div>
          <small className="set-hint">
            只影响终端输出。文件仍按 `fileLevel`（当前 {logging.fileLevel}）记录；trace 不落盘。
          </small>
        </div>

        <div className="set-subsection">
          <h4>
            <HardDrive size={14} aria-hidden="true" />
            落盘文件
          </h4>
          {logging.files.length === 0 ? (
            <p className="set-empty">
              <FileText size={14} aria-hidden="true" />
              {logging.dir ? '目录里还没有日志文件。' : '日志落盘已关闭。'}
            </p>
          ) : (
            <ul className="set-files">
              {logging.files.map((file) => (
                <li key={file.name}>
                  <span className="mono">{file.name}</span>
                  <span>{formatBytes(file.size)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {savedAt && (
          <p className="set-saved" role="status">
            <Check size={13} aria-hidden="true" />
            已应用到当前进程
          </p>
        )}
      </section>

      <section className="card set-section" aria-label="QQ 空间">
        <header className="set-section-head">
          <h3>
            <Globe2 size={16} aria-hidden="true" />
            QQ 空间
          </h3>
          <span className="set-section-sub">
            {snapshot.account ? `账号 ${snapshot.account.uin}` : '未登录账号'}
          </span>
        </header>
        <div className="set-row">
          <div>
            <strong>允许 qzone 能力</strong>
            <small>
              关闭后不换取空间凭据，所有 qzone action
              不注册。空间是主动写能力，暴露给不可信客户端时应关闭。
            </small>
          </div>
          <Switch
            checked={snapshot.onebot?.qzone ?? true}
            disabled={!snapshot.account || qzoneBusy}
            aria-label="允许 QQ 空间能力"
            onChange={(qzone) => void applyQzone(qzone)}
          />
        </div>
        <small className="set-hint">
          配置按当前账号保存。改动会重启 OneBot 适配器，现有客户端会短暂断开后自动重连。
        </small>
      </section>

      <section className="card set-section" aria-label="运行信息">
        <header className="set-section-head">
          <h3>
            <Server size={16} aria-hidden="true" />
            运行信息
          </h3>
        </header>
        <dl className="set-facts">
          <div>
            <dt>平台</dt>
            <dd className="mono">
              {runtime.platform} · {runtime.arch}
            </dd>
          </div>
          <div>
            <dt>Node</dt>
            <dd className="mono">{runtime.node}</dd>
          </div>
          <div>
            <dt>进程</dt>
            <dd className="mono">pid {runtime.pid}</dd>
          </div>
          <div>
            <dt>已运行</dt>
            <dd>{formatDuration(runtime.uptimeSec * 1000)}</dd>
          </div>
          <div>
            <dt>配置文件</dt>
            <dd className="mono">{runtime.configPath ?? '未使用 --config'}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

type Tone = 'good' | 'warning' | 'critical' | 'muted';

function CheckRow({
  label,
  detail,
  tone,
  mono,
  title,
}: {
  label: string;
  detail: string;
  tone: Tone;
  mono?: boolean;
  title?: string;
}) {
  const Icon = tone === 'good' ? Check : tone === 'muted' ? CircleAlert : AlertTriangle;
  return (
    <li className="set-check" data-tone={tone} title={title}>
      <Icon size={14} aria-hidden="true" />
      <span className="set-check-label">{label}</span>
      <span className={mono ? 'set-check-detail mono' : 'set-check-detail'}>{detail}</span>
    </li>
  );
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 0) return '控制台服务没有响应。';
    return cause.message;
  }
  return cause instanceof Error ? cause.message : String(cause);
}
