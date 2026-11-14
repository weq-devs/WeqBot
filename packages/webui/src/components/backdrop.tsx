import './backdrop.css';

/**
 * 全屏氛围背景：顶部品牌光晕 + 点阵 + 两团缓慢漂移的光 + 颗粒噪点（压掉渐变色带）。
 *
 * 纯装饰，所有屏幕共用一份 —— 切换页面时背景不跟着淡出，只有前景在动。
 */
export function Backdrop() {
  return (
    <div className="backdrop" aria-hidden="true">
      <div className="backdrop-glow" />
      <div className="backdrop-orb backdrop-orb-a" />
      <div className="backdrop-orb backdrop-orb-b" />
      <div className="backdrop-grid" />
      <div className="backdrop-noise" />
    </div>
  );
}
