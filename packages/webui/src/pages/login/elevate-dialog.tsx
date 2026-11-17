/**
 * 提权框：有头模式第一次读 QQ 内存时，向用户要一次管理员授权。
 *
 * 它不是「确认对话框」，而是一次**认证**，所以文案必须回答三个问题（顺序也按
 * 用户真正会问的来）：
 *
 * 1. 你要干什么 —— 只读 QQ 内存里的会话密钥，不改任何数据；
 * 2. 为什么非 root 不可 —— ptrace 附加受内核门禁保护；
 * 3. 密码去哪了 —— 直接交给 `sudo -S`，WeqBot 不保存、不写日志、不进配置。
 *
 * 密码只活在这个组件的 state 里，提交后立刻清空；父组件拿到它只做一次请求。
 * `elevation.cached` 为真时（sudo 时间戳还在）不显示输入框 —— 让人白输一遍
 * 是最没必要的摩擦。
 */

import { Clock, Eye, EyeOff, KeyRound, Lock, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ElevationState } from '../../api/types';
import { Button } from '../../components/button';
import { Dialog } from '../../components/dialog';

export function ElevateDialog({
  open,
  elevation,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  open: boolean;
  elevation: ElevationState | undefined;
  /** 请求进行中：不自造 spinner，按钮内联 loading。 */
  busy: boolean;
  /** 上一次尝试的失败原因（密码错 / sudo 取消）。 */
  error?: string;
  onSubmit(password: string): void;
  onClose(): void;
}) {
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);

  // 每次打开都从空白开始：上一次的密码绝不留在输入框里。
  useEffect(() => {
    if (open) {
      setPassword('');
      setReveal(false);
    }
  }, [open]);

  const needsPassword = elevation?.mechanism === 'sudo' && !elevation.cached;
  const canSubmit = !busy && (!needsPassword || password.length > 0);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      icon={<ShieldAlert size={18} aria-hidden="true" />}
      title="需要管理员授权"
      description={
        needsPassword
          ? '读取运行中 QQ 的登录态需要一次系统级权限，就像 WeQ 读取在线能力时那样。'
          : '系统里已有可用的管理员授权，直接继续即可。'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={!canSubmit}
            onClick={() => {
              const value = password;
              setPassword('');
              onSubmit(value);
            }}
          >
            {busy ? '正在读取…' : '授权并接入'}
          </Button>
        </>
      }
    >
      <ul className="elevate-facts">
        <li>
          <Lock size={14} aria-hidden="true" />
          <span>只读取 QQ 内存里的会话密钥（a2 / d2 / d2key），不修改任何数据。</span>
        </li>
        <li>
          <Clock size={14} aria-hidden="true" />
          <span>一次 QQ 登录只需要授权一次，之后复用内存里的会话。</span>
        </li>
        <li>
          <ShieldCheck size={14} aria-hidden="true" />
          <span>密码直接交给系统的 sudo，WeqBot 不保存、不写日志、不进配置。</span>
        </li>
      </ul>

      {needsPassword ? (
        <form
          className="elevate-field"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmit) return;
            const value = password;
            setPassword('');
            onSubmit(value);
          }}
        >
          <label htmlFor="elevate-password">管理员密码</label>
          <div className="elevate-input">
            <KeyRound size={15} aria-hidden="true" />
            <input
              id="elevate-password"
              type={reveal ? 'text' : 'password'}
              value={password}
              autoComplete="current-password"
              autoFocus
              spellCheck={false}
              placeholder="系统登录密码（sudo）"
              disabled={busy}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button
              type="button"
              className="elevate-reveal"
              aria-label={reveal ? '隐藏密码' : '显示密码'}
              onClick={() => setReveal((value) => !value)}
            >
              {reveal ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          <p className="elevate-hint">{elevation?.hint ?? '密码只用于这一次读取。'}</p>
        </form>
      ) : (
        <p className="elevate-hint">
          {elevation?.mechanism === 'uac'
            ? 'Windows 下需要以管理员身份运行 weqbot：关闭当前进程，右键「以管理员身份运行」后重新打开控制台。'
            : (elevation?.hint ?? '不需要额外授权。')}
        </p>
      )}

      {error && (
        <p className="elevate-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
