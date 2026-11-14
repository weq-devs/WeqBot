import { Check, Copy, RotateCcw } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { MOCK_TOKEN, mockControls } from '../api/mock';
import { Switch } from '../components/switch';
import './mock-panel.css';

/**
 * 开发期浮层（只在 `pnpm dev:webui` 里出现，生产构建不包含）：
 * 复制 mock 令牌、模拟 WeqBot 进程离线、清掉失败次数与锁定。
 */
export function MockPanel() {
  const offline = useSyncExternalStore(mockControls.subscribe, mockControls.isOffline);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copyToken() {
    try {
      await navigator.clipboard.writeText(MOCK_TOKEN);
      setCopied(true);
    } catch {
      // 复制被拒：令牌就显示在按钮上，手动选中也行。
    }
  }

  return (
    <aside className="mock-panel" aria-label="Mock 开发面板">
      <span className="mock-panel-badge">MOCK</span>
      <button
        type="button"
        className="mock-panel-token"
        onClick={copyToken}
        title="复制 mock 令牌（也可以整行粘贴，试试自动识别）"
      >
        <code>{MOCK_TOKEN}</code>
        {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      </button>
      <span className="mock-panel-switch">
        <Switch id="mock-offline" checked={offline} onChange={mockControls.setOffline} />
        <label htmlFor="mock-offline">模拟离线</label>
      </span>
      <button
        type="button"
        className="mock-panel-icon"
        onClick={mockControls.reset}
        title="清掉失败次数与锁定"
        aria-label="清掉失败次数与锁定"
      >
        <RotateCcw size={13} aria-hidden="true" />
      </button>
    </aside>
  );
}
