/** 从空间网页中读取明确的表单回执，把回调实参当作数据。 */
import { parse } from '@babel/parser';
import { parse as parseHtml, type DefaultTreeAdapterMap } from 'parse5';
import { WebAuthError } from './credential';
import { parseQzoneCallback } from './qzone';

// -10000 也用于业务限流。写操作只对明确的登录拒绝换票。
const AUTH_CODES = new Set([-3000, -4009, -10001, -10003]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function object(value: unknown): Record<string, unknown> {
  return record(value) ?? {};
}

function parseReplyObject(text: string): Record<string, unknown> {
  try {
    const payload = record(parseQzoneCallback<unknown>(text));
    if (payload) return payload;
  } catch {
    // 回包内容包含用户输入，向调用方只报告确认状态。
  }
  throw new Error('空间表单回执无法解析，结果未确认，请核对后刷新。');
}

function callbackPath(value: unknown): string {
  const node = object(value);
  if (node.type === 'Identifier' && typeof node.name === 'string') return node.name;
  if (node.type !== 'MemberExpression') return '';
  const property = object(node.property);
  const name = node.computed
    ? property.type === 'StringLiteral'
      ? property.value
      : ''
    : property.type === 'Identifier'
      ? property.name
      : '';
  return typeof name === 'string' ? `${callbackPath(node.object)}.${name}` : '';
}

/** fs 是 HTML 表单回执；只提取已知回调的对象实参，不执行页面脚本。 */
export function parseQzoneFormReply(text: string): Record<string, unknown> {
  if (!text.trimStart().startsWith('<')) return parseReplyObject(text);
  const scripts: string[] = [];
  const collect = (node: DefaultTreeAdapterMap['node'], depth: number): void => {
    if (depth > 128) return;
    if ('tagName' in node && node.tagName === 'script') {
      if (!node.attrs.some((attr) => attr.name === 'src'))
        scripts.push(
          node.childNodes.map((child) => ('value' in child ? child.value : '')).join(''),
        );
      return;
    }
    if ('childNodes' in node) for (const child of node.childNodes) collect(child, depth + 1);
  };
  collect(parseHtml(text), 0);
  const callbacks: string[] = [];
  for (const source of scripts) {
    let ast: unknown;
    try {
      ast = parse(source, { sourceType: 'script' });
    } catch {
      continue;
    }
    const visit = (value: unknown, depth: number): void => {
      if (depth > 128) return;
      if (Array.isArray(value)) {
        for (const child of value) visit(child, depth + 1);
        return;
      }
      const node = object(value);
      if (
        node.type === 'CallExpression' &&
        [
          'frameElement.callback',
          'parent.frameElement.callback',
          'window.frameElement.callback',
        ].includes(callbackPath(node.callee))
      ) {
        const args = Array.isArray(node.arguments) ? node.arguments : [];
        const argument = object(args[0]);
        if (
          args.length !== 1 ||
          argument.type !== 'ObjectExpression' ||
          typeof argument.start !== 'number' ||
          typeof argument.end !== 'number'
        )
          throw new Error('空间表单回执无法解析，结果未确认，请核对后刷新。');
        callbacks.push(source.slice(argument.start, argument.end));
        return;
      }
      for (const child of Object.values(node))
        if (child !== null && typeof child === 'object') visit(child, depth + 1);
    };
    visit(ast, 0);
  }
  if (callbacks.length !== 1)
    throw new Error('空间响应缺少明确的操作回执，结果未确认，请核对后刷新。');
  return parseReplyObject(callbacks[0]!);
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

  // 以外层或 result 的显式成功码确认受理。
  if (response.code !== 0 && response.ret !== 0 && result.code !== 0) {
    throw new Error('空间操作响应格式无效，未确认结果，请核对后刷新。');
  }
  return response;
}
