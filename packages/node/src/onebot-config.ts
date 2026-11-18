/**
 * OneBot 配置的校验与打码 —— WebUI 与宿主控制通道共用。
 *
 * 为什么要单独成文件：这条逻辑原来埋在 `webui/routes.ts` 里，只服务 HTTP 页面。
 * WeQ 接管之后，配置由**宿主**编辑、通过控制通道下发，同一份校验必须两边一致，
 * 否则「页面能保存、宿主下发时报错」这类漂移迟早出现。
 *
 * 两条约定：
 *
 *   1. **打码即「没改」**：`accessToken` 以 `'***'` 出现在读接口里；写回来时按
 *      同名（退回同下标）接回原令牌。页面在用户只改端口时不会把令牌清空。
 *   2. **端口唯一**：同一台机器上两个监听抢同一个端口是最常见的配置错误，
 *      在写入口就拒掉。`enabled === false` 的不参与（它根本不会 listen）。
 */

import type { BotOneBotConfig } from '@weqbot/bot';

/** 校验失败。`code` 直接进 HTTP / 控制通道的错误码。 */
export class OneBotConfigError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OneBotConfigError';
  }
}

/** 未配置 OneBot 时网络页使用的空骨架（`networks` 四类都要在）。 */
export const EMPTY_ONEBOT_CONFIG: BotOneBotConfig = {
  networks: { httpServers: [], httpClients: [], wsServers: [], wsClients: [] },
};

/** 读接口用的打码：`accessToken` 一律变成 `'***'`。 */
export function maskOneBotConfig(config: BotOneBotConfig | undefined): BotOneBotConfig | undefined {
  if (!config) return undefined;
  const mask = <T extends { accessToken?: string }>(item: T): T =>
    item.accessToken ? { ...item, accessToken: '***' } : item;
  return {
    ...config,
    networks: {
      httpServers: config.networks.httpServers.map(mask),
      httpClients: config.networks.httpClients.map(mask),
      wsServers: config.networks.wsServers.map(mask),
      wsClients: config.networks.wsClients.map(mask),
    },
  };
}

/**
 * 校验一份 OneBot 配置。
 *
 * 不信任调用方的任何字段：逐类检查数组与必填项。`previous` 用来接回打码的令牌。
 *
 * 注意这里**刻意保留未知字段**（返回原对象展开后的副本）：配置里将来可能加字段，
 * 过早剥掉会让宿主的配置在保存后静默丢数据。真正生效前由 kernel 的类型兜底。
 */
export function validateOneBotConfig(value: unknown, previous?: BotOneBotConfig): BotOneBotConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OneBotConfigError('BAD_CONFIG', 'config 必须是对象');
  }
  const record = value as Record<string, unknown>;
  const networks = record.networks as Record<string, unknown> | undefined;
  if (!networks || typeof networks !== 'object' || Array.isArray(networks)) {
    throw new OneBotConfigError('BAD_CONFIG', '缺少 networks');
  }
  const normalized = {
    httpServers: normalizeNetworks(
      networks.httpServers,
      'httpServers',
      previous?.networks.httpServers,
    ),
    httpClients: normalizeNetworks(
      networks.httpClients,
      'httpClients',
      previous?.networks.httpClients,
    ),
    wsServers: normalizeNetworks(networks.wsServers, 'wsServers', previous?.networks.wsServers),
    wsClients: normalizeNetworks(networks.wsClients, 'wsClients', previous?.networks.wsClients),
  } as BotOneBotConfig['networks'];

  // 端口唯一性：同一台机器上两个监听抢同一个端口是最常见的配置错误。
  const ports = new Set<number>();
  for (const server of [...normalized.httpServers, ...normalized.wsServers]) {
    if (server.enabled === false) continue;
    if (ports.has(server.port)) {
      throw new OneBotConfigError('PORT_CONFLICT', `端口 ${server.port} 被重复占用`);
    }
    ports.add(server.port);
  }

  return {
    networks: normalized,
    ...(record.qzone === false ? { qzone: false } : {}),
    ...(typeof record.qzoneDomain === 'string' ? { qzoneDomain: record.qzoneDomain } : {}),
  };
}

function normalizeNetworks<T extends { name?: string; accessToken?: string }>(
  value: unknown,
  label: string,
  previous?: T[],
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new OneBotConfigError('BAD_CONFIG', `${label} 必须是数组`);
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new OneBotConfigError('BAD_CONFIG', `${label}[${index}] 必须是对象`);
    }
    const record = { ...(item as Record<string, unknown>) };
    if (record.accessToken === '***') {
      // 打码值代表「没改」：按同名（退回同下标）条目把原令牌接回去。删掉会让
      // 自动保存 在用户只改端口 / 开关 / 名称时把已有令牌清空。
      const existing =
        previous?.find((candidate) => candidate.name === record.name) ?? previous?.[index];
      if (existing?.accessToken) record.accessToken = existing.accessToken;
      else delete record.accessToken;
    }
    if (typeof record.name !== 'string' || !record.name.trim()) {
      throw new OneBotConfigError('BAD_CONFIG', `${label}[${index}] 缺少 name`);
    }
    if (record.port !== undefined && (typeof record.port !== 'number' || record.port < 0)) {
      throw new OneBotConfigError('BAD_CONFIG', `${label}[${index}].port 必须是非负整数`);
    }
    if (record.messageFormat !== 'array' && record.messageFormat !== 'string') {
      record.messageFormat = 'array';
    }
    if (typeof record.reportSelfMessage !== 'boolean') record.reportSelfMessage = true;
    return record as T;
  });
}
