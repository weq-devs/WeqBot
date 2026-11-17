import { AnimatePresence, MotionConfig } from 'motion/react';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { api, usingMock } from './api';
import { Shell } from './components/shell';
import { takeLinkToken } from './lib/token';
import { GatePage } from './pages/gate/gate-page';
import { LoginPage } from './pages/login/login-page';
import type { ConsolePhase } from './api/types';

/** 开发面板按需加载：生产构建里 `import.meta.env.DEV` 恒为 false，这段整个被摇掉。 */
const MockPanel =
  import.meta.env.DEV && usingMock
    ? lazy(() => import('./dev/mock-panel').then((module) => ({ default: module.MockPanel })))
    : null;

/** 一键链接 `#token=…`：模块加载时读掉，并立刻从地址栏抹去。 */
const initialLinkToken = takeLinkToken();

type Screen = 'boot' | 'gate' | 'login' | 'console';

/** 由 SSE 的 `notice` 翻译来的一次性提示；见 `LoginPage` 的 `hint` prop。 */
export interface LoginHint {
  /** 递增标识，让同样内容的提示也能重新触发。 */
  id: number;
  /** 希望页面切到的 tab。 */
  tab: 'qr';
  notice: string;
}

export function App() {
  const [screen, setScreen] = useState<Screen>('boot');
  const [linkToken, setLinkToken] = useState(initialLinkToken);
  const [phase, setPhase] = useState<ConsolePhase>('no-account');
  /**
   * 给登录页的一次性提示。`id` 递增：同一个 `kind` 连续触发两次（比如两个账号
   * 先后失效）也要能让 `useEffect` 重新跑一遍。
   */
  const [loginHint, setLoginHint] = useState<LoginHint | null>(null);

  /** 根路由：已通过令牌 → 账号在线看控制台，否则看登录页。 */
  const route = useCallback(async () => {
    try {
      const { authenticated } = await api.auth.getSession();
      if (!authenticated) {
        setScreen('gate');
        return;
      }
      const overview = await api.overview.get();
      setPhase(overview.phase);
      setScreen(overview.phase === 'online' ? 'console' : 'login');
    } catch {
      setScreen('gate');
    }
  }, []);

  useEffect(() => {
    void route();
  }, [route]);

  // 控制台阶段变化（上线 / 下线 / 掉线）由 SSE 推过来：决定停在登录页还是控制台。
  useEffect(() => {
    if (screen === 'boot' || screen === 'gate') return;
    const off = api.events.subscribe({
      onConsole(event) {
        // notice 要先处理：它可能和 phase 一起到达，而下面 `!event.phase` 的提前
        // return 会把只有 notice 的事件吞掉。
        if (event.notice?.kind === 'a1-expired') {
          setLoginHint({
            id: Date.now(),
            tab: 'qr',
            notice: '本机保存的 a1 已失效，已清除凭据 —— 请用扫码重新登录。',
          });
        }
        if (!event.phase) return;
        setPhase(event.phase);
        if (event.phase === 'online') setScreen('console');
        else if (event.phase === 'no-account' || event.phase === 'offline') setScreen('login');
      },
    });
    return off;
  }, [screen]);

  const consumeLoginHint = useCallback(() => setLoginHint(null), []);

  const handledGate = useCallback(() => {
    setScreen('login');
  }, []);
  /** 只清会话（「退出控制台」）→ 回令牌页；账号下线 → 回登录页（会话仍然有效）。 */
  const backToGate = useCallback(() => setScreen('gate'), []);
  const backToLogin = useCallback(() => setScreen('login'), []);

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence mode="wait">
        {screen === 'boot' && <BootScreen key="boot" />}
        {screen === 'gate' && (
          <GatePage
            key="gate"
            linkToken={linkToken}
            onLinkTokenUsed={() => setLinkToken(null)}
            onAuthenticated={handledGate}
          />
        )}
        {screen === 'login' && (
          <LoginPage
            key="login"
            phase={phase}
            hint={loginHint}
            onHintConsumed={consumeLoginHint}
            onLocked={backToGate}
          />
        )}
        {screen === 'console' && (
          <Shell key="console" phase={phase} onLocked={backToGate} onLoggedOut={backToLogin} />
        )}
      </AnimatePresence>
      {MockPanel && (
        <Suspense fallback={null}>
          <MockPanel />
        </Suspense>
      )}
    </MotionConfig>
  );
}

/** 首屏：只做一次很短的品牌动效，避免刷新时白屏闪一下。 */
function BootScreen() {
  return (
    <main className="boot-screen">
      <div className="boot-mark" role="status" aria-label="WeqBot 控制台正在加载" />
    </main>
  );
}
