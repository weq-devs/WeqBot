/**
 * QQ 空间表单写接口的回执解析（`frameElement.callback(...)` 外壳）。
 *
 * 来源：WeQ `packages/service/src/account/web/qzone_write_actions.ts`（2026-11-16）
 * 的 `responsePayload` / `post`。**刻意不搬 `@babel/parser` + `parse5` 两个依赖**：
 * 那边用完整 AST 是为了精确区分「真正执行的回调」与「字符串 / 注释里出现的伪回调」，
 * 这里用一个小型词法扫描做同一件事 —— 跳过字符串、模板字符串、注释与正则字面量，
 * 只在**代码 token** 上匹配回调名。实参随后交给 {@link parseJsLiteral} 当数据解析，
 * 永不执行。
 *
 * 与 WeQ 的行为对齐（`qzone_web_actions.test.ts` 的 13 条用例是回归口径）：
 *   - `<script>var text="frameElement.callback({code:0})"</script>` → 失败；
 *   - `// frameElement.callback({code:0})` 注释 → 失败；
 *   - 两个回调 / 零个回调 / 实参不是对象字面量 → 失败（结果未确认）；
 *   - 正常 HTML 回执只认 `frameElement.callback({...})` 这一种形状。
 */

import { WebAuthError } from './credential';
import { parseJsLiteral, parseQzoneCallback } from './qzone';

const CALLBACK_NAMES = [
  'frameElement.callback',
  'parent.frameElement.callback',
  'window.frameElement.callback',
];
/**
 * 登录票据失效的业务码。
 *
 * 写路径取 WeQ `assertQzoneWriteAccepted` 的 `[-3000, -4009, -10001, -10003]`，
 * 再并上 qzone 读路径的 `-10000`（同一含义、换票重试一次无副作用）。
 */
const AUTH_CODES = new Set([-3000, -4009, -10000, -10001, -10003]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 前一个非空白字符是否能让 `/` 只能是除号（用于区分正则字面量）。 */
function dividesAfter(prev: string | undefined): boolean {
  if (prev === undefined) return false;
  return /[A-Za-z0-9_$)\]}"']/.test(prev);
}

/**
 * 扫描一段脚本，返回所有**代码位置**上的 `frameElement.callback(<对象字面量>)` 实参。
 *
 * 不做完整语法分析：只需要知道某个回调名的出现是否落在字符串/注释/正则里。
 * 每个命中的实参必须是单个对象字面量，且后面紧跟 `)`（或 `,`? 不需要，回调只收一个参数）。
 */
export function findFormCallbacks(source: string): unknown[] {
  const found: unknown[] = [];
  let i = 0;
  const n = source.length;
  let prevMeaningful: string | undefined;

  const skipString = (quote: string): void => {
    i++;
    while (i < n) {
      const c = source[i]!;
      if (c === '\\') {
        i += 2;
        continue;
      }
      i++;
      if (c === quote) return;
    }
    throw new Error('空间表单回执包含未闭合字符串，结果未确认，请核对后刷新。');
  };

  while (i < n) {
    const c = source[i]!;

    // 注释
    if (c === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    // 字符串 / 模板字符串：内容一律跳过（模板里的 `${}` 不展开，反正我们不执行）
    if (c === '"' || c === "'" || c === '`') {
      skipString(c);
      prevMeaningful = c;
      continue;
    }
    // 正则字面量：只在明显不是除法的位置当正则
    if (c === '/' && !dividesAfter(prevMeaningful)) {
      i++;
      let inClass = false;
      while (i < n) {
        const ch = source[i]!;
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) {
          i++;
          break;
        } else if (ch === '\n') break;
        i++;
      }
      while (i < n && /[a-z]/.test(source[i]!)) i++;
      prevMeaningful = '/';
      continue;
    }

    if (!/[A-Za-z_$]/.test(c)) {
      if (!/\s/.test(c)) prevMeaningful = c;
      i++;
      continue;
    }

    // 标识符 / 成员表达式：取最长的一个「a.b.c」链
    let path = '';
    while (i < n && /[A-Za-z0-9_$.]/.test(source[i]!)) {
      path += source[i];
      i++;
    }
    prevMeaningful = 'a';

    if (!CALLBACK_NAMES.includes(path)) continue;

    // 必须是调用：`(` 之前只允许空白
    while (i < n && /\s/.test(source[i]!)) i++;
    if (source[i] !== '(') continue;
    i++;

    // 实参：单个对象字面量
    while (i < n && /\s/.test(source[i]!)) i++;
    if (source[i] !== '{') {
      throw new Error('空间表单回执无法解析，结果未确认，请核对后刷新。');
    }
    // `parseJsLiteral` 不返回消费长度，所以先做括号配平定位实参结尾，再解析那一段。
    let depth = 0;
    let inString: string | null = null;
    let end = -1;
    for (let j = i; j < n; j++) {
      const ch = source[j]!;
      if (inString) {
        if (ch === '\\') j++;
        else if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inString = ch;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) {
      throw new Error('空间表单回执无法解析，结果未确认，请核对后刷新。');
    }
    let value: unknown;
    try {
      value = parseJsLiteral(source.slice(i, end + 1));
    } catch {
      throw new Error('空间表单回执无法解析，结果未确认，请核对后刷新。');
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('空间表单回执无法解析，结果未确认，请核对后刷新。');
    }
    found.push(value);
    i = end + 1;
  }

  return found;
}

/**
 * 把空间写接口的回包（JSON / JSONP / HTML 表单回执）解析成业务对象。
 * 形状无法确定时抛错 —— **不把「看起来像登录页」当成成功**。
 */
export function parseQzoneFormReply(text: string): Record<string, unknown> {
  if (!text.trimStart().startsWith('<')) {
    const parsed = record(parseQzoneCallback<unknown>(text));
    if (!parsed) throw new Error('空间回执不是对象，结果未确认，请核对后刷新。');
    return parsed;
  }

  const scripts = extractScripts(text);
  const callbacks: unknown[] = [];
  for (const source of scripts) callbacks.push(...findFormCallbacks(source));

  if (callbacks.length !== 1) {
    throw new Error('空间响应缺少明确的操作回执，结果未确认，请核对后刷新。');
  }
  const parsed = record(callbacks[0]);
  if (!parsed) throw new Error('空间回执不是对象，结果未确认，请核对后刷新。');
  return parsed;
}

/** 取页面里**内联**脚本的内容（外链 `<script src>` 不取，避免联网执行远程内容）。 */
function extractScripts(html: string): string[] {
  const scripts: string[] = [];
  const opening = /<script\b([^>]*)>/gi;
  let match: RegExpExecArray | null = opening.exec(html);
  while (match) {
    const attrs = match[1] ?? '';
    const bodyStart = match.index + match[0].length;
    const close = html.toLowerCase().indexOf('</script', bodyStart);
    if (close === -1) break;
    // 带 src 的外链脚本一律忽略（与 WeQ 的 `attrs.some(src)` 判断等价）。
    if (!/(^|\s)src\s*=/i.test(attrs)) scripts.push(html.slice(bodyStart, close));
    opening.lastIndex = close + '</script'.length;
    match = opening.exec(html);
  }
  return scripts;
}

/**
 * 校验一次空间写操作的回执。成功返回原对象，失败按 WeQ 的同一套层次抛错：
 * `needVerify` / `verifyurl` → 需要人工验证；`-3000/-4009/-10001/-10003` → 换票；
 * 其它非零码 → 业务失败；三层都缺业务码 → 结果未确认。
 */
export function assertQzoneWriteAccepted(
  response: Record<string, unknown>,
  what: string,
): Record<string, unknown> {
  const result = record(response.result) ?? {};
  const data = record(response.data) ?? {};

  for (const layer of [response, result, data]) {
    if (
      (layer.needVerify !== undefined && layer.needVerify !== 0) ||
      layer.verifyurl ||
      layer.verifyUrl
    ) {
      throw new Error('QQ 空间要求验证，请在 QQ 空间完成验证后核对操作结果。');
    }
    for (const key of ['code', 'subcode', 'ret'] as const) {
      const value = layer[key];
      if (value !== undefined && value !== 0) {
        if (typeof value === 'number' && AUTH_CODES.has(value)) {
          throw new WebAuthError('空间登录票据已失效。', value);
        }
        const message = layer.msg ?? layer.message ?? value;
        throw new Error(`空间${what}未被受理：${String(message)}`);
      }
    }
  }

  // 与 WeQ 一致：只要任一层给出 code=0 就认为有明确回执；三层都拿不出业务码
  // （例如回包 `{}` 或登录页）说明结果没被确认，不能当成功。
  if (response.code !== 0 && response.ret !== 0 && result.code !== 0) {
    throw new Error('空间操作响应格式无效，未确认结果，请核对后刷新。');
  }
  return response;
}
