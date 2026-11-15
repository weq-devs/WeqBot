/** 控制台通用的格式化：时间 / 时长 / 数字 / 状态文案。 */

export function formatClock(ts: number): string {
  const date = new Date(ts);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

export function formatDateTime(ts: number): string {
  const date = new Date(ts);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day} ${formatClock(ts)}`;
}

/** `47 分 12 秒` 这种口语化时长；超过一天只说「N 天」。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  if (days > 0) return `${days} 天 ${Math.floor((total % 86400) / 3600)} 小时`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

/** 相对时刻：`刚刚` / `3 分钟前` / 具体日期。 */
export function formatRelative(ts: number, now = Date.now()): string {
  const delta = now - ts;
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`;
  return formatDateTime(ts).slice(0, 10);
}

export function formatNumber(value: number): string {
  return value.toLocaleString('zh-CN');
}

/** 计数紧凑写法（图表轴、指标块用）。 */
export function formatCompact(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export const PHASE_LABEL: Record<string, string> = {
  'no-account': '未登录',
  starting: '启动中',
  online: '在线',
  offline: '离线',
};

export const NETWORK_STATE_LABEL: Record<string, string> = {
  listening: '监听中',
  connected: '已连接',
  connecting: '连接中',
  stopped: '已停止',
  error: '错误',
};

export const NETWORK_KIND_LABEL: Record<string, string> = {
  'http-server': 'HTTP 服务端',
  'http-client': 'HTTP 上报',
  'ws-server': '正向 WS',
  'ws-client': '反向 WS',
};

export const LEVEL_LABEL: Record<string, string> = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
};

/** action 的能力域 → 中文展示名（调试页分组标题用）。 */
export const ACTION_GROUP_LABEL: Record<string, string> = {
  message: '消息',
  contact: '联系人',
  'group-admin': '群管理',
  interaction: '互动',
  'group-file': '群文件',
  extended: '扩展',
  'flash-transfer': '闪传',
  'l2-extra': '扩展（第二批）',
  account: '账号',
  'group-web': '群 Web',
  'account-web': '账号 Web',
  collection: '收藏',
  qzone: 'QQ 空间',
};
