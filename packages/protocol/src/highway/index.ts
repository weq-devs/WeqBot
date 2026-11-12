/**
 * highway（NTV2 媒体上传）协议 schema。
 *
 * 只搬 schema：上传编排（`ntv2-upload.ts` / `media-upload.ts`）要等 `MediaNative`
 * 在 `@weqbot/wire` 里定型之后再搬，否则会先引入一份不完整的原生契约。
 */

export * from './ntv2-schemas';
