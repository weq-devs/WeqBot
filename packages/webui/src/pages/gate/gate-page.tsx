import {
  ArrowRight,
  Check,
  CircleAlert,
  LoaderCircle,
  LockKeyhole,
  type LucideIcon,
  Timer,
  Unplug,
} from 'lucide-react';
import { AnimatePresence, motion, useAnimate } from 'motion/react';
import { type FormEvent, useEffect, useEffectEvent, useRef, useState } from 'react';
import { api } from '../../api';
import { Button } from '../../components/button';
import { Logo } from '../../components/logo';
import { EASE_OUT, enterPop, enterRise, enterStagger, screenExit } from '../../lib/motion';
import { isWellFormedToken } from '../../lib/token';
import { TerminalHint } from './terminal-hint';
import { TokenField } from './token-field';
import './gate.css';

type Phase = 'idle' | 'verifying' | 'success';

type Problem =
  | { kind: 'malformed' }
  | { kind: 'invalid'; remainingAttempts: number }
  | { kind: 'locked'; until: number }
  | { kind: 'unreachable' };

interface GatePageProps {
  /** 一键链接带来的令牌（`#token=…`）：进场后自动填入并提交一次。 */
  linkToken: string | null;
  onLinkTokenUsed(): void;
  onAuthenticated(): void;
}

/** 卡片抖动：幅度递减，像被轻轻推了一下。 */
const SHAKE = [0, -10, 9, -6, 4, -2, 0];

const FIELD_ID = 'gate-token';
const PROBLEM_ID = 'gate-problem';

/**
 * 访问令牌页：WebUI 的第一道门。
 *
 * 令牌在启动 WeqBot 的终端里（每次启动重新生成）；验证通过后服务端写 HttpOnly cookie，
 * 前端不保存令牌本身。
 */
export function GatePage({ linkToken, onLinkTokenUsed, onAuthenticated }: GatePageProps) {
  const [token, setToken] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  // 终端提示默认展开（新用户需要知道令牌在哪）；用户点了标题栏就收起来，让输入框成主体。
  const [terminalOpen, setTerminalOpen] = useState(true);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [cardRef, animateCard] = useAnimate<HTMLDivElement>();
  const inputRef = useRef<HTMLInputElement>(null);
  const linkTokenHandled = useRef(false);

  const lockRemainingMs = problem?.kind === 'locked' ? Math.max(0, problem.until - now) : 0;
  const locked = lockRemainingMs > 0;
  const busy = phase !== 'idle';

  // 锁定倒计时：到点自动解锁，焦点还给输入框。
  useEffect(() => {
    if (problem?.kind !== 'locked') return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= problem.until) setProblem(null);
    }, 250);
    return () => window.clearInterval(timer);
  }, [problem]);

  // 出错后把整串选中，方便直接重新粘贴覆盖。
  useEffect(() => {
    if (!problem || problem.kind === 'locked') return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [problem]);

  // 验证成功：留一点时间给笑眼和按钮形变，再切到下一屏。
  useEffect(() => {
    if (phase !== 'success') return;
    const timer = window.setTimeout(onAuthenticated, 900);
    return () => window.clearTimeout(timer);
  }, [phase, onAuthenticated]);

  // 指针聚光：卡片边框跟着指针亮起。只写 CSS 变量，不触发 React 渲染。
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    let frame = 0;
    const move = (event: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = card.getBoundingClientRect();
        card.style.setProperty('--spot-x', `${event.clientX - rect.left}px`);
        card.style.setProperty('--spot-y', `${event.clientY - rect.top}px`);
        card.dataset.spot = '';
      });
    };
    const leave = () => {
      cancelAnimationFrame(frame);
      delete card.dataset.spot;
    };
    window.addEventListener('pointermove', move, { passive: true });
    document.documentElement.addEventListener('pointerleave', leave);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      document.documentElement.removeEventListener('pointerleave', leave);
    };
  }, [cardRef]);

  function shake() {
    const card = cardRef.current;
    if (card) void animateCard(card, { x: SHAKE }, { duration: 0.46, ease: 'easeInOut' });
  }

  async function verify(candidate: string) {
    if (busy || locked) return;
    const value = candidate.trim();
    if (!isWellFormedToken(value)) {
      setProblem({ kind: 'malformed' });
      shake();
      return;
    }

    setProblem(null);
    setPhase('verifying');
    const result = await api.auth.createSession(value);
    if (result.ok) {
      setPhase('success');
      return;
    }

    setPhase('idle');
    if (result.reason === 'invalid') {
      setProblem({ kind: 'invalid', remainingAttempts: result.remainingAttempts });
    } else if (result.reason === 'locked') {
      const current = Date.now();
      setNow(current);
      setProblem({ kind: 'locked', until: current + result.retryAfterMs });
    } else {
      setProblem({ kind: 'unreachable' });
    }
    shake();
  }

  const submitLinkToken = useEffectEvent((value: string) => {
    onLinkTokenUsed();
    void verify(value);
  });

  // 一键链接：先把令牌填进去，等进场动画走完再提交，用户能看到「填入 → 验证」的过程。
  useEffect(() => {
    if (!linkToken || linkTokenHandled.current) return;
    setToken(linkToken);
    const timer = window.setTimeout(() => {
      linkTokenHandled.current = true;
      submitLinkToken(linkToken);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [linkToken]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void verify(token);
  }

  function handleTokenChange(value: string) {
    setToken(value);
    if (problem?.kind === 'malformed' || problem?.kind === 'invalid') setProblem(null);
  }

  const fieldInvalid = problem?.kind === 'malformed' || problem?.kind === 'invalid';

  return (
    <motion.main
      className="gate"
      initial="hidden"
      animate="shown"
      exit={screenExit}
      variants={enterStagger}
    >
      <div className="gate-brand">
        <motion.div className="gate-logo" variants={enterPop}>
          <span className="gate-logo-halo" aria-hidden="true" />
          <Logo size={54} mood={phase === 'success' ? 'happy' : 'idle'} />
        </motion.div>
        <motion.h1 className="gate-title" variants={enterRise}>
          WeqBot 控制台
        </motion.h1>
        <motion.p className="gate-subtitle" variants={enterRise}>
          输入启动 WeqBot 时终端里打印的访问令牌
        </motion.p>
      </div>

      <motion.div variants={enterRise}>
        <div ref={cardRef} className="gate-card" data-phase={phase}>
          <TerminalHint open={terminalOpen} onToggle={() => setTerminalOpen((v) => !v)} />
          <form className="gate-form" onSubmit={handleSubmit} noValidate>
            <div>
              <TokenField
                id={FIELD_ID}
                value={token}
                onChange={handleTokenChange}
                inputRef={inputRef}
                invalid={fieldInvalid}
                readOnly={busy}
                disabled={locked}
                describedBy={problem ? PROBLEM_ID : undefined}
              />
              <AnimatePresence initial={false}>
                {problem && <ProblemNote key={problem.kind} problem={problem} />}
              </AnimatePresence>
            </div>

            <Button
              type="submit"
              variant="primary"
              size="lg"
              block
              disabled={locked}
              aria-busy={phase === 'verifying'}
            >
              <SubmitLabel phase={phase} lockRemainingMs={lockRemainingMs} />
            </Button>
          </form>
        </div>
      </motion.div>

      <motion.footer className="gate-foot" variants={enterRise}>
        <LockKeyhole size={13} aria-hidden="true" />
        <span>仅限本机访问 · {window.location.host}</span>
        <span className="gate-foot-sep" aria-hidden="true" />
        <span>令牌随进程重启刷新</span>
      </motion.footer>
    </motion.main>
  );
}

function describeProblem(problem: Problem): {
  Icon: LucideIcon;
  tone: 'critical' | 'neutral';
  text: string;
} {
  switch (problem.kind) {
    case 'malformed':
      return {
        Icon: CircleAlert,
        tone: 'critical',
        text: '格式不对：令牌以 wqb_ 开头，后面是 24 位字母或数字。',
      };
    case 'invalid':
      return {
        Icon: CircleAlert,
        tone: 'critical',
        text:
          problem.remainingAttempts > 1
            ? `令牌不正确，还可以再试 ${problem.remainingAttempts} 次。`
            : '令牌不正确。再错一次会锁定 30 秒。',
      };
    case 'locked':
      // 倒计时只放在按钮上：这条提示是 role="alert"，每秒变一次会被读屏反复播报。
      return { Icon: Timer, tone: 'critical', text: '尝试次数过多，已暂时锁定。' };
    case 'unreachable':
      return {
        Icon: Unplug,
        tone: 'neutral',
        text: '连不上 WeqBot 进程。确认它还在运行，然后再试一次。',
      };
  }
}

function ProblemNote({ problem }: { problem: Problem }) {
  const { Icon, tone, text } = describeProblem(problem);
  return (
    <motion.div
      className="gate-problem-wrap"
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.28, ease: EASE_OUT }}
    >
      <p id={PROBLEM_ID} className="gate-problem" data-tone={tone} role="alert">
        <Icon size={15} aria-hidden="true" />
        <span>{text}</span>
      </p>
    </motion.div>
  );
}

function SubmitLabel({ phase, lockRemainingMs }: { phase: Phase; lockRemainingMs: number }) {
  const locked = lockRemainingMs > 0;
  const state = locked ? 'locked' : phase;

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={state}
        className="gate-submit-label"
        initial={{ opacity: 0, y: 6, filter: 'blur(3px)' }}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        exit={{ opacity: 0, y: -6, filter: 'blur(3px)' }}
        transition={{ duration: 0.16, ease: EASE_OUT }}
      >
        {state === 'locked' && (
          <>
            <Timer size={16} aria-hidden="true" />
            {Math.ceil(lockRemainingMs / 1000)} 秒后可重试
          </>
        )}
        {state === 'verifying' && (
          <>
            <LoaderCircle className="gate-spin" size={16} aria-hidden="true" />
            正在验证
          </>
        )}
        {state === 'success' && (
          <>
            <Check size={16} strokeWidth={2.6} aria-hidden="true" />
            验证通过
          </>
        )}
        {state === 'idle' && (
          <>
            进入控制台
            <ArrowRight className="gate-submit-arrow" size={16} aria-hidden="true" />
          </>
        )}
      </motion.span>
    </AnimatePresence>
  );
}
