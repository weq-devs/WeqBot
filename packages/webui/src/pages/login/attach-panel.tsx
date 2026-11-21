/**
 * 有头模式：接运行中的 QQ，而不是把 QQ 踢下线自己登录。
 *
 * 与两个账号组（本机 / 自主）的根本差别是**不碰凭据**：a2 / d2 / d2key 从
 * QQ 进程的内存里读（必要时提权），QQ 继续在线，WeqBot 只是搭同一条 SSO 通道
 * 发协议包。所以列表是「进程」而不是「账号」—— 一个 QQ 多开就有多条。
 *
 * 实例列表每 4 秒轮询一次：用户很可能开着 QQ 再回来点「有头」，或者在接入前
 * 退了 QQ —— 静态列表会让这两种情况都表现为「点了没反应」。
 */

import {
  AlertTriangle,
  CircleUserRound,
  LoaderCircle,
  Plug,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import { useEffectEvent, useState } from 'react';
import { api, ApiError } from '../../api';
import type { QqInstance } from '../../api/types';
import { Button } from '../../components/button';
import { useToast } from '../../components/toast';
import { usePolling } from '../../lib/hooks';
import { ElevateDialog } from './elevate-dialog';
import './attach.css';

export function AttachPanel() {
  const toast = useToast();
  const { data, error, reload } = usePolling(() => api.login.attach.instances(), 4000);
  /** 正在接入的 uin（按钮换成 spinner）。 */
  const [busy, setBusy] = useState<string>();
  /** 正在等授权的实例；非空即弹提权框。 */
  const [pending, setPending] = useState<{ uin: string; pid: number } | null>(null);
  const [elevateError, setElevateError] = useState<string>();

  const attach = useEffectEvent(async (uin: string, pid: number, password?: string) => {
    setBusy(uin);
    try {
      await api.login.attach.start(uin, { pid, ...(password !== undefined ? { password } : {}) });
      // 成功后阶段事件会把页面切到控制台，这里不再自己跳。
      setPending(null);
      setElevateError(undefined);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'ELEVATION_REQUIRED') {
        setElevateError(undefined);
        setPending({ uin, pid });
        return;
      }
      const detail = describe(cause);
      // 提权流程里失败（密码错 / sudo 取消）必须**留在对话框里**报错：关掉框
      // 再弹 toast 会让用户不知道该重新点哪个账号。
      if (password !== undefined) {
        setElevateError(detail);
        return;
      }
      setPending(null);
      toast.push({ key: 'attach', tone: 'error', title: '接入失败', detail });
    } finally {
      setBusy(undefined);
    }
  });
  const elevation = data?.elevation;
  const instances = data?.instances ?? [];
  const needsElevation =
    elevation?.mechanism === 'sudo' && !elevation.cached && !elevation.elevated;

  return (
    <>
      {data === undefined ? (
        <div className="attach-empty">
          {error ? (
            <>
              <strong>无法读取在线实例</strong>
              <p>{describe(error)}</p>
              <Button variant="secondary" onClick={reload}>
                重试
              </Button>
            </>
          ) : (
            <LoaderCircle size={20} className="spin" role="status" aria-label="正在检测在线实例" />
          )}
        </div>
      ) : instances.length === 0 ? (
        <div className="attach-empty">
          <p>暂无运行中的 QQ</p>
          <Button variant="secondary" onClick={reload}>
            <RefreshCw size={15} aria-hidden="true" />
            重新检测
          </Button>
        </div>
      ) : (
        <>
          <div className="attach-head">
            <span className="attach-title">运行中的 QQ</span>
            {needsElevation && (
              <span className="attach-badge">
                <ShieldAlert size={11} aria-hidden="true" />
                需管理员授权
              </span>
            )}
            <button
              type="button"
              className="attach-refresh"
              aria-label="重新检测运行中的 QQ"
              onClick={reload}
            >
              <RefreshCw size={14} aria-hidden="true" />
            </button>
          </div>
          <ul className="login-accounts">
            {instances.map((instance) => (
              <AttachRow
                key={instance.pid}
                instance={instance}
                busy={busy !== undefined && busy === instance.uin}
                disabled={busy !== undefined || !instance.attachable}
                onAttach={() => {
                  if (!instance.uin) return;
                  void attach(instance.uin, instance.pid);
                }}
              />
            ))}
          </ul>
        </>
      )}

      <ElevateDialog
        open={pending !== null}
        elevation={elevation}
        busy={busy !== undefined}
        {...(elevateError ? { error: elevateError } : {})}
        onClose={() => {
          setPending(null);
          setElevateError(undefined);
        }}
        onSubmit={(password) => {
          if (pending) void attach(pending.uin, pending.pid, password);
        }}
      />
    </>
  );
}

function AttachRow({
  instance,
  busy,
  disabled,
  onAttach,
}: {
  instance: QqInstance;
  busy: boolean;
  disabled: boolean;
  onAttach(): void;
}) {
  return (
    <li>
      <button
        type="button"
        className="login-account attach-item"
        disabled={disabled}
        title={instance.note ?? '接入这个 QQ 的会话'}
        onClick={onAttach}
      >
        {instance.avatarUrl ? (
          <img className="login-avatar" src={instance.avatarUrl} alt="" width={38} height={38} />
        ) : (
          <CircleUserRound
            size={38}
            strokeWidth={1.3}
            className="login-avatar"
            aria-hidden="true"
          />
        )}
        <span className="login-account-text">
          <strong>{instance.nickname || instance.uin || `pid ${instance.pid}`}</strong>
          <span>
            {instance.uin
              ? `uin ${instance.uin} · pid ${instance.pid}${
                  instance.qqVersion ? ` · QQ ${instance.qqVersion}` : ''
                }`
              : `pid ${instance.pid}`}
          </span>
          {!instance.attachable && instance.note && (
            <span className="attach-warn">
              <AlertTriangle size={11} aria-hidden="true" />
              {instance.note}
            </span>
          )}
        </span>
        <span className="login-account-action">
          {busy ? (
            <LoaderCircle size={16} className="spin" aria-label="正在接入" />
          ) : (
            <Plug size={16} aria-hidden="true" />
          )}
        </span>
      </button>
    </li>
  );
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 0) return '控制台服务没有响应 —— 检查 weqbot 进程是否还在运行。';
    if (cause.code === 'QQ_OFFLINE')
      return '这个账号的 QQ 已经退出了，刷新列表看看还有没有别的实例。';
    if (cause.code === 'NO_SESSION_MATERIAL') {
      return '没有读到完整的会话物料：QQ 可能还没登录完成，稍等一下再试。';
    }
    if (cause.code === 'ELEVATION_FAILED') return cause.message || '管理员认证失败或被取消。';
    const message = cause.message?.trim();
    if (message && message !== cause.code) return message;
    return '接入失败：控制台没有给出原因，详见控制台日志。';
  }
  return cause instanceof Error ? cause.message : String(cause);
}
