import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, type ReactNode } from 'react';
import './dialog.css';

/**
 * 通用模态框：遮罩 + 卡片 + 进出场动画 + Esc / 点遮罩关闭。
 *
 * 只有一处需要模态框（登录页的提权框），但它不是「一次性的弹窗」：网络页的抽屉
 * 之外，控制台迟早还要确认危险操作。所以这里只做**结构与交互**，内容全部由调用方
 * 给（`icon` / `title` / `description` / `children` / `footer`），样式走设计令牌。
 *
 * 三个细节是刻意的：
 *
 * - 打开时锁 `body` 滚动，关闭还原 —— 否则在长列表页上滚轮会带着背景一起动；
 * - 遮罩用 `<button>` 而不是带 onClick 的 div：既能键盘聚焦语义正确，也不触
 *   发 a11y 的「静态元素绑事件」规则；
 * - 面板用 `role="dialog"` + `aria-modal`，标题 id 由 `useId` 生成，页面里同时
 *   存在多个对话框也不会撞。
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  icon,
  children,
  footer,
  dismissible = true,
  width = 424,
}: {
  open: boolean;
  onClose(): void;
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** `false` 时 Esc / 点遮罩不关闭（进行中的请求不让人半路撤掉）。 */
  dismissible?: boolean;
  /** 面板宽度（px）；默认 424，足够放下说明 + 一个输入框。 */
  width?: number;
}) {
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && dismissible) {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, dismissible, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="dialog-layer"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
        >
          <button
            type="button"
            className="dialog-scrim"
            aria-label="关闭"
            tabIndex={-1}
            onClick={() => {
              if (dismissible) onClose();
            }}
          />
          <motion.div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            style={{ width: `min(${width}px, calc(100vw - 32px))` }}
            initial={{ opacity: 0, y: 10, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.985 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          >
            <header className="dialog-head">
              {icon && <span className="dialog-icon">{icon}</span>}
              <div className="dialog-heading">
                <h2 id={titleId}>{title}</h2>
                {description && <p>{description}</p>}
              </div>
            </header>
            {children}
            {footer && <footer className="dialog-foot">{footer}</footer>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
