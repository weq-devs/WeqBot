/**
 * `@weqbot/node` —— 独立宿主，**唯一允许加载 `.node` 的包**。
 *
 * WeQ 嵌入时**不得**依赖本包：那样会把加载器和 `.node` 一起带进 desktop 的
 * 打包产物，正是我们要避免的「两份 native」。
 */

export {
  defaultNativeDir,
  loadNative,
  resolveNativeDir,
  resolveNativePath,
  type LoadNativeOptions,
  type LoadedNative,
} from './loader';
export { runSidecar, type SidecarHandle, type SidecarOptions } from './sidecar';
export {
  ConfigError,
  loadConfigFile,
  mergeConfig,
  type LoadedConfig,
} from './config';
