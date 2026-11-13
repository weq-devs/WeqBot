/** 群号必须是正整数；多条群命令共用。 */
export function requireGroupId(groupId: number): number {
  if (!Number.isSafeInteger(groupId) || groupId <= 0) {
    throw new Error(`groupId 必须是正整数，收到 ${String(groupId)}`);
  }
  return groupId;
}
