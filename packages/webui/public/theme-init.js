// 首帧前决定主题（深 / 浅），避免先画白底再闪成深色。
// 存储键与 src/lib/theme.ts 保持一致；这里只读不写。
(() => {
  let preference = 'system';
  try {
    preference = localStorage.getItem('weqbot.theme') || 'system';
  } catch {
    // 隐私模式下 localStorage 可能不可用：按系统偏好走。
  }
  const dark =
    preference === 'dark' ||
    (preference !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
