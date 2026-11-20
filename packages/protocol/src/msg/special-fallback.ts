export const SPECIAL_MESSAGE_KINDS = ['emojiBounce', 'flashPhoto', 'pokeEmoji'] as const;
export type SpecialMessageKind = (typeof SPECIAL_MESSAGE_KINDS)[number];

export const FLASH_PHOTO_FALLBACK_TEXT = '[闪照]请使用新版手机QQ查看闪照。';

/** 识别 QQ 生成的完整兼容文案，保留聊天中提及这些文案的普通文本。 */
export function specialFallbackKind(text: string): SpecialMessageKind | undefined {
  const content = text.trim();
  if (content === FLASH_PHOTO_FALLBACK_TEXT) return 'flashPhoto';
  if (/^\[表情弹射\]请使用最新版(?:本)?手机QQ体验新功能[。.]?$/.test(content)) return 'emojiBounce';
  if (/^\[戳一戳\]请使用最新版(?:本)?手机QQ体验新功能[。.]?$/.test(content)) return 'pokeEmoji';
}
