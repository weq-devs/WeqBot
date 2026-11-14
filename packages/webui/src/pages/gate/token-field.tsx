import { Check, ClipboardPaste, Eye, EyeOff, KeyRound } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ClipboardEvent, type RefObject, useEffect, useState } from 'react';
import { extractToken, isWellFormedToken } from '../../lib/token';

type Hint = 'default' | 'extracted' | 'clipboard-denied' | 'clipboard-empty';

const PASTE_KEYS = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘V' : 'Ctrl+V';

const HINTS: Record<Hint, string> = {
  default: `从终端复制，${PASTE_KEYS} 粘贴`,
  extracted: '已从粘贴内容里识别出令牌',
  'clipboard-denied': `浏览器不允许读剪贴板，请按 ${PASTE_KEYS}`,
  'clipboard-empty': '剪贴板里没有内容',
};

interface TokenFieldProps {
  id: string;
  value: string;
  onChange(value: string): void;
  inputRef: RefObject<HTMLInputElement | null>;
  invalid: boolean;
  /** 验证中：保持焦点但不许改。 */
  readOnly: boolean;
  /** 锁定中：整个输入不可用。 */
  disabled: boolean;
  describedBy?: string | undefined;
}

/**
 * 令牌输入框：等宽字体、默认打码、可切换显示；粘贴整行终端输出时只留令牌。
 *
 * 用 `type="text"` + CSS 打码而不是 `type="password"`：令牌每次启动都会变，
 * 不该让浏览器弹「保存密码」。
 */
export function TokenField({
  id,
  value,
  onChange,
  inputRef,
  invalid,
  readOnly,
  disabled,
  describedBy,
}: TokenFieldProps) {
  const [revealed, setRevealed] = useState(false);
  const [hint, setHint] = useState<Hint>('default');

  // 提示停留几秒后回到默认文案。
  useEffect(() => {
    if (hint === 'default') return;
    const timer = window.setTimeout(() => setHint('default'), 2800);
    return () => window.clearTimeout(timer);
  }, [hint]);

  // 进场动画差不多走完时把焦点放进来（不用 autoFocus：它会抢在动画之前）。
  useEffect(() => {
    const timer = window.setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 650);
    return () => window.clearTimeout(timer);
  }, [inputRef]);

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData('text');
    const token = extractToken(text);
    if (!token || token === text.trim()) return;
    // 粘进来的是整行（或几行）终端输出：只留令牌。
    event.preventDefault();
    onChange(token);
    setHint('extracted');
  }

  async function pasteFromClipboard() {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      const token = extractToken(text);
      if (token) {
        onChange(token);
        if (token !== text) setHint('extracted');
      } else if (text) {
        onChange(text);
      } else {
        setHint('clipboard-empty');
      }
    } catch {
      setHint('clipboard-denied');
    }
    inputRef.current?.focus();
  }

  const wellFormed = isWellFormedToken(value.trim());
  const masked = !revealed && value.length > 0;

  return (
    <div className="token-field">
      <div className="token-field-head">
        <label htmlFor={id} className="token-field-label">
          访问令牌
        </label>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={hint}
            className="token-field-hint"
            data-hint={hint}
            initial={{ opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -3 }}
            transition={{ duration: 0.15 }}
          >
            {HINTS[hint]}
          </motion.span>
        </AnimatePresence>
      </div>

      <div
        className="token-field-control"
        data-invalid={invalid || undefined}
        data-disabled={disabled || undefined}
      >
        <KeyRound className="token-field-icon" size={16} aria-hidden="true" />
        <input
          ref={inputRef}
          id={id}
          className="token-field-input"
          data-masked={masked || undefined}
          type="text"
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          onPaste={handlePaste}
          placeholder="粘贴以 wqb_ 开头的令牌"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          maxLength={512}
          readOnly={readOnly}
          disabled={disabled}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          data-1p-ignore
          data-lpignore="true"
        />
        <AnimatePresence initial={false}>
          {wellFormed && !invalid && (
            <motion.span
              key="well-formed"
              className="token-field-ok"
              title="格式正确"
              initial={{ opacity: 0, scale: 0.4 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.4 }}
              transition={{ type: 'spring', bounce: 0.45, duration: 0.4 }}
            >
              <Check size={12} strokeWidth={3.2} aria-hidden="true" />
              <span className="sr-only">格式正确</span>
            </motion.span>
          )}
        </AnimatePresence>
        <button
          type="button"
          className="token-field-action"
          onClick={pasteFromClipboard}
          disabled={disabled || readOnly}
          aria-label="从剪贴板粘贴"
          title="从剪贴板粘贴"
        >
          <ClipboardPaste size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="token-field-action"
          onClick={() => setRevealed((current) => !current)}
          disabled={disabled}
          aria-pressed={revealed}
          aria-label={revealed ? '隐藏令牌' : '显示令牌'}
          title={revealed ? '隐藏令牌' : '显示令牌'}
        >
          {revealed ? (
            <EyeOff size={16} aria-hidden="true" />
          ) : (
            <Eye size={16} aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
}
