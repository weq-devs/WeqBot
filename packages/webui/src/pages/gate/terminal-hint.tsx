import { ChevronUp } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { EASE_OUT } from '../../lib/motion';

const COMMAND = 'weqbot';
/** 打字开始前留给卡片进场的时间。 */
const TYPE_DELAY_MS = 950;
const TYPE_STEP_MS = 75;

const lineEnter = {
  initial: { opacity: 0, x: -4 },
  animate: { opacity: 1, x: 0 },
  transition: { duration: 0.3, ease: EASE_OUT },
};

interface TerminalHintProps {
  open: boolean;
  onToggle(): void;
}

/**
 * 迷你终端：告诉用户令牌在哪 —— 就在启动 WeqBot 的那个终端里。
 *
 * 点标题栏可以整块向上收起（只留一条标题栏），把位置让给输入框。
 * 地址栏是页面自己的 origin；令牌永远打码，页面不知道、也不该知道它。
 */
export function TerminalHint({ open, onToggle }: TerminalHintProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const [typed, setTyped] = useState(0);
  const [outputLines, setOutputLines] = useState(0);

  useEffect(() => {
    if (reduceMotion) return;
    const timers: number[] = [];
    for (let count = 1; count <= COMMAND.length; count += 1) {
      timers.push(window.setTimeout(() => setTyped(count), TYPE_DELAY_MS + count * TYPE_STEP_MS));
    }
    const typedAt = TYPE_DELAY_MS + COMMAND.length * TYPE_STEP_MS;
    timers.push(window.setTimeout(() => setOutputLines(1), typedAt + 280));
    timers.push(window.setTimeout(() => setOutputLines(2), typedAt + 540));
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [reduceMotion]);

  const shownTyped = reduceMotion ? COMMAND.length : typed;
  const shownLines = reduceMotion ? 2 : outputLines;

  return (
    <figure className="terminal" data-open={open || undefined}>
      <button
        type="button"
        className="terminal-bar"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={open ? '收起终端提示' : '展开终端提示'}
        title={open ? '收起' : '展开'}
      >
        <span className="terminal-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <ChevronUp className="terminal-chevron" size={14} aria-hidden="true" />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            className="terminal-collapse"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.34, ease: EASE_OUT }}
          >
            <div className="terminal-body" aria-hidden="true">
              <div className="terminal-line">
                <span className="terminal-prompt">$</span>
                <span className="terminal-command">
                  {COMMAND.slice(0, shownTyped)}
                  {shownLines === 0 && <span className="terminal-caret" />}
                </span>
              </div>
              {shownLines >= 1 && (
                <motion.div className="terminal-line" {...(reduceMotion ? {} : lineEnter)}>
                  <span className="terminal-key">WebUI</span>
                  <span className="terminal-value">{window.location.origin}</span>
                </motion.div>
              )}
              {shownLines >= 2 && (
                <motion.div className="terminal-line" {...(reduceMotion ? {} : lineEnter)}>
                  <span className="terminal-key">访问令牌</span>
                  <span className="terminal-value terminal-token">{`wqb_${'•'.repeat(24)}`}</span>
                </motion.div>
              )}
              {shownLines >= 2 && (
                <div className="terminal-line">
                  <span className="terminal-prompt">$</span>
                  <span className="terminal-caret" />
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <figcaption className="sr-only">
        访问令牌打印在启动 WeqBot 的终端里，以 wqb_ 开头。
      </figcaption>
    </figure>
  );
}
