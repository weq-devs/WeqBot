/** QQ 收藏（只读）。 */

import { defineAction, ParamError } from '../action-registry';
import type { JsonObject } from '../types';

function optionalNonNegativeInt(raw: JsonObject, key: string): number | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ParamError(`${key} 必须是非负整数`);
  }
  return parsed;
}

export const COLLECTION_ACTIONS = [
  defineAction(
    {
      name: 'get_collection_list',
      summary: '获取收藏列表',
      parse: (raw) => {
        const category = optionalNonNegativeInt(raw, 'category') ?? 0;
        const count = optionalNonNegativeInt(raw, 'count') ?? 50;
        if (count < 1 || count > 500) throw new ParamError('count 必须在 1..500 之间');
        return { category, count };
      },
      run: async ({ category, count }, ctx) => ctx.backend.collection!.list(category, count),
    },
    { available: (backend) => typeof backend.collection?.list === 'function' },
  ),
];
