import { AnimatePresence, MotionConfig } from 'motion/react';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { Backdrop } from './components/backdrop';
import { ThemeToggle } from './components/theme-toggle';
import { takeLinkToken } from './lib/token';
import { GatePage } from './pages/gate/gate-page';
import { NextStep } from './pages/next-step';

/** 开发面板按需加载：生产构建里 `import.meta.env.DEV` 恒为 false，这段整个被摇掉。 */
const MockPanel = import.meta.env.DEV
  ? lazy(() => import('./dev/mock-panel').then((module) => ({ default: module.MockPanel })))
  : null;

/** 一键链接 `#token=…`：模块加载时读掉，并立刻从地址栏抹去。 */
const initialLinkToken = takeLinkToken();

type Screen = 'boot' | 'gate' | 'next';

export function App() {
  const [screen, setScreen] = useState<Screen>('boot');
  const [linkToken, setLinkToken] = useState(initialLinkToken);

  // 刷新页面时会话可能还有效（cookie 还在）：有效就跳过令牌页。
  useEffect(() => {
    let cancelled = false;
    api.auth.getSession().then(
      ({ authenticated }) => {
        if (!cancelled) setScreen(authenticated ? 'next' : 'gate');
      },
      () => {
        if (!cancelled) setScreen('gate');
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const showGate = useCallback(() => setScreen('gate'), []);
  const showNext = useCallback(() => setScreen('next'), []);
  const clearLinkToken = useCallback(() => setLinkToken(null), []);

  return (
    <MotionConfig reducedMotion="user">
      <Backdrop />
      <div className="corner-bar">
        <ThemeToggle />
      </div>
      <AnimatePresence mode="wait">
        {screen === 'gate' && (
          <GatePage
            key="gate"
            linkToken={linkToken}
            onLinkTokenUsed={clearLinkToken}
            onAuthenticated={showNext}
          />
        )}
        {screen === 'next' && <NextStep key="next" onLocked={showGate} />}
      </AnimatePresence>
      {MockPanel && (
        <Suspense fallback={null}>
          <MockPanel />
        </Suspense>
      )}
    </MotionConfig>
  );
}
