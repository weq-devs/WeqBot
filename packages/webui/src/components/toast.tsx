/**
 * 统一通知（toast）：右下角堆叠、可手动关闭、自动倒计时。
 *
 * 参考 WeQ 的 `Toast.tsx`：语气图标 + 标题 + 可选详情 + 关闭按钮 + 底部倒计时条，
 * 悬停 / 聚焦时暂停计时。视觉全部走本项目的语义令牌（`tokens.css`），所以深浅
 * 两种模式各自取值，不在这里写第二套颜色。
 *
 * 用法：
 *
 * ```tsx
 * const toast = useToast();
 * toast.push({ tone: 'error', title: '令牌不正确', detail: '还可以再试 3 次。' });
 * ```
 *
 * `key` 相同会**原地替换**（比如连接断开 → 恢复，始终只有一条，不会越堆越多）。
 */

import { AlertTriangle, Check, CircleAlert, Info, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import './toast.css';

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export interface ToastInput {
  tone?: ToastTone;
  /** 一行主文案。 */
  title: ReactNode;
  /** 可选详情（第二行，允许换行）。 */
  detail?: ReactNode;
  /**
   * 自动关闭的毫秒数；`0` 表示常驻（需要用户手动关闭）。
   *
   * 省略时按语气取默认值：成功 / 信息 4.2 秒，警告 / 错误 8 秒（够读完一句
   * 排障说明，又不会一直挡着页面）。
   */
  ttl?: number;
  /** 同 key 的 toast 原地替换（不叠加、不重播进场）。 */
  key?: string;
}

interface ToastRecord {
  id: number;
  key?: string;
  tone: ToastTone;
  title: ReactNode;
  detail?: ReactNode;
  ttl: number;
  /** 每次替换都变：用它重置倒计时。 */
  enteredAt: number;
}

export interface ToastApi {
  push(input: ToastInput): void;
  dismiss(id: number): void;
  /** 关掉所有同 key 的 toast（问题已解决时用）。 */
  dismissKey(key: string): void;
}

/** 同时最多显示几条：再多就把最旧的挤掉，不让整块通知区盖住页面。 */
const MAX_TOASTS = 5;

/** 倒计时刷新间隔（进度条每 100ms 走一格，够顺滑也不费 CPU）。 */
const TICK_MS = 100;

const DEFAULT_TTL: Record<ToastTone, number> = {
  info: 4200,
  success: 4200,
  warning: 8000,
  error: 8000,
};

const TONE_ICON = {
  info: Info,
  success: Check,
  warning: AlertTriangle,
  error: CircleAlert,
} as const;

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const dismissKey = useCallback((key: string) => {
    setToasts((current) => current.filter((toast) => toast.key !== key));
  }, []);

  const push = useCallback((input: ToastInput) => {
    const tone = input.tone ?? 'info';
    setToasts((current) => {
      const record: ToastRecord = {
        id: 0,
        ...(input.key !== undefined ? { key: input.key } : {}),
        tone,
        title: input.title,
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        ttl: input.ttl ?? DEFAULT_TTL[tone],
        enteredAt: Date.now(),
      };
      if (input.key === undefined) {
        seq.current += 1;
        return [...current, { ...record, id: seq.current }].slice(-MAX_TOASTS);
      }
      const index = current.findIndex((toast) => toast.key === input.key);
      if (index === -1) {
        seq.current += 1;
        return [...current, { ...record, id: seq.current }].slice(-MAX_TOASTS);
      }
      // 同一个 key：保留 id（AnimatePresence 不重播进场），内容与倒计时换新。
      const next = [...current];
      next[index] = { ...record, id: current[index]!.id };
      return next;
    });
  }, []);

  const value = useMemo<ToastApi>(
    () => ({ push, dismiss, dismissKey }),
    [push, dismiss, dismissKey],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-host" aria-live="polite" aria-relevant="additions text">
        <AnimatePresence initial={false}>
          {toasts.map((toast) => (
            <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

/** 取通知入口。必须在 `<ToastProvider>` 内使用。 */
export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast() 必须在 <ToastProvider> 内使用');
  return value;
}

function ToastItem({ toast, onDismiss }: { toast: ToastRecord; onDismiss(id: number): void }) {
  const [left, setLeft] = useState(toast.ttl);
  const leftRef = useRef(toast.ttl);
  const [paused, setPaused] = useState(false);
  const Icon = TONE_ICON[toast.tone];

  // 内容被替换（同 key）时重新计时，即使时长恰好一样 —— `enteredAt` 是唯一的
  // “这次是新的”信号，linter 看不到 `leftRef`，只能显式声明。
  // biome-ignore lint/correctness/useExhaustiveDependencies: enteredAt 变化必须重置倒计时
  useEffect(() => {
    leftRef.current = toast.ttl;
    setLeft(toast.ttl);
  }, [toast.enteredAt, toast.ttl]);

  useEffect(() => {
    if (toast.ttl <= 0) return;
    const timer = window.setInterval(() => {
      if (paused) return;
      leftRef.current = Math.max(0, leftRef.current - TICK_MS);
      setLeft(leftRef.current);
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [paused, toast.ttl]);

  useEffect(() => {
    if (toast.ttl > 0 && left <= 0) onDismiss(toast.id);
  }, [left, onDismiss, toast.id, toast.ttl]);

  const progress = toast.ttl > 0 ? Math.max(0, Math.min(100, (left / toast.ttl) * 100)) : 100;

  return (
    <motion.div
      className="toast"
      data-tone={toast.tone}
      role={toast.tone === 'error' ? 'alert' : 'status'}
      initial={{ opacity: 0, y: 14, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 28, scale: 0.98 }}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false);
      }}
    >
      <span className="toast-icon" aria-hidden="true">
        <Icon size={15} strokeWidth={2.2} />
      </span>
      <div className="toast-text">
        <strong className="toast-title">{toast.title}</strong>
        {toast.detail !== undefined && <p className="toast-detail">{toast.detail}</p>}
      </div>
      <button
        type="button"
        className="toast-close"
        onClick={() => onDismiss(toast.id)}
        aria-label="关闭通知"
        title="关闭"
      >
        <X size={14} aria-hidden="true" />
      </button>
      {toast.ttl > 0 && (
        <span className="toast-progress-track" aria-hidden="true">
          <span
            className="toast-progress"
            data-paused={paused || undefined}
            style={{ width: `${progress}%` }}
          />
        </span>
      )}
    </motion.div>
  );
}
