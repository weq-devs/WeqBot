/**
 * OIDB / trpc 业务 spec。
 *
 * 这里最终应该是 `WeQ/packages/protocol/src/oidb/**` 的镜像。搬运清单元数据见
 * `TODO.md` 的「搬运清单」，顺序建议：
 *
 *   1. `shared.ts` / `invoke.ts`（已在）；
 *   2. `media-schemas.ts` + `ntv2.ts`（图片/文件下载的公共底座）；
 *   3. `misc/`（rkey / clientKey / pskey / Ark —— 消息收发的前置）；
 *   4. `profile/`、`interaction/`（戳一戳 / 表情回应，OneBot 常用）；
 *   5. `group-admin/`、`group-file/`、`group-album/`、`request/`、`custom-face/`、`group-todo/`；
 *   6. `flashtransfer/` + `highway/`（媒体上传）。
 *
 * 每个目录的 `index.ts` 显式 re-export，方便 `export * from './oidb/xxx'` 逐块接上。
 */

export {
  invokeOidb,
  invokeTrpc,
  type OidbSpec,
  type TrpcSpec,
} from './invoke';
export { bytesToHex, ensureRetCodeZero, toInt } from './shared';
