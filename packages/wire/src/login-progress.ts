/**
 * native 的 `QuickLoginEvent` → {@link LoginProgressEvent} 归一。
 *
 * 为什么放在 wire 而不是 bot：**形状是 native 的**。napi 把事件声明成
 * `{ kind, state?, message?, unusualDeviceCheckSig?, qrImage?, ... }`，其中
 * `unusualDeviceCheckSig` 是认证物料、`qrImage` 是几十 KB 的 PNG —— 上层
 * 一个都不需要，只需要「现在到哪一步、该对用户说什么」。让三个调用方
 * （WebUI 登录页、WeQ 宿主、测试）各写一份 `kind` 解析，就是把 native 的
 * 形状漂移成本抄三遍。
 *
 * 只认**已知**的 `kind`：不认识的一律返回 `undefined`（调用方忽略），
 * 不把它包装成 `info` 硬塞给用户 —— 多一条看不懂的提示比少一条更糟。
 */

import type { LoginProgressEvent } from './types';

/** 兜底文案：native 没给 `message` 时的阶段说明。 */
const STATE_MESSAGES: Record<string, string> = {
  'key-exchange': '正在与登录服务器协商会话密钥',
  'easy-login': '正在用本地 a1 换取登录票据',
  'unusual-device-wait': '当前设备被判定为异常设备，请在手机 QQ 上点击「确认登录」',
  'easy-login-unusual': '已确认，正在换取登录票据',
};

/**
 * 异常设备：native 的 `unusual-device` 事件有时只带签名物料、不带 `message`。
 *
 * 这句话必须**一定**有值 —— 手机确认最长要等 45 秒（native 的 `FLOW_TIMEOUT`），
 * 期间页面没有别的反馈，一句话都没有就只剩一个转圈。
 */
const UNUSUAL_DEVICE_MESSAGE =
  '当前设备被判定为异常设备，请在手机 QQ 上点击「确认登录」；确认后会自动继续。';

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 把一条 native 事件归一成进度事件；不是进度事件（缺 `kind` / 未知 `kind`）
 * 时返回 `undefined`。
 *
 * `qr-code` 被**丢弃**：它带的是二维码字节，属于扫码登录的展示逻辑，
 * 由 `qrLogin` 的调用方自己处理。
 */
export function parseLoginProgress(event: unknown): LoginProgressEvent | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const record = event as Record<string, unknown>;
  const kind = textOf(record.kind);
  const state = textOf(record.state);
  const message = textOf(record.message);

  switch (kind) {
    case 'unusual-device':
      return {
        kind: 'unusual-device',
        ...(state ? { state } : {}),
        message: message || UNUSUAL_DEVICE_MESSAGE,
      };
    case 'state': {
      // 异常设备确认的信号只在这条流里出现一次，且它的阶段名就是
      // `unusual-device-wait`；保持 `state` 语义不变，文案照 native 的来。
      const text = message || STATE_MESSAGES[state];
      if (!text) return undefined;
      return { kind: 'state', ...(state ? { state } : {}), message: text };
    }
    case 'qr-state': {
      if (!state) return undefined;
      return { kind: 'qr-state', state, message: message || state };
    }
    case 'info': {
      if (!message) return undefined;
      return { kind: 'info', message };
    }
    default:
      return undefined;
  }
}

/** 这条进度是否意味着「手机确认中」（页面要拉长等待提示、不能当作卡死）。 */
export function isAwaitingPhoneConfirmation(event: LoginProgressEvent): boolean {
  if (event.kind === 'unusual-device') return true;
  if (event.kind === 'state') {
    return event.state === 'unusual-device-wait' || event.state === 'easy-login-unusual';
  }
  return event.kind === 'qr-state' && event.state === 'waiting-confirm';
}
