/**
 * mode2 的 `SecToken` 生成。
 *
 * ⚠️ **这是全项目唯一一处「我们不确定服务端怎么校验」的逻辑**，所以单独成文件、
 * 单独写 TODO，不让它藏在签名代码里。
 *
 * 背景：mode1 的 `sec_token` 来自 QQ 进程里的会话物料（`scanSessionMaterial`），
 * mode2 没有 QQ 会话，必须本地造一个。用户口径是「本地随机生成，不是服务端下发」，
 * 但**是否完全随机**（长度 / 字符集 / 是否与 guid、uin、时间有关）尚未逆向确认。
 *
 * 现状：按 mode1 观测到的形态（12 字符 base64）生成。如果抓包证明服务端只做
 * 长度/字符集校验，这里就是最终实现；如果它参与 `sec_sign` 的校验链，改这一个文件。
 */

import { randomBytes } from 'node:crypto';

/** mode1 抓包里 `SecToken` 的形态：12 个 base64 字符（= 9 字节）。 */
const SEC_TOKEN_BYTES = 9;

export function generateSecToken(random: (size: number) => Uint8Array = randomBytes): string {
  return Buffer.from(random(SEC_TOKEN_BYTES)).toString('base64');
}
