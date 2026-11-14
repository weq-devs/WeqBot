import './logo.css';

export type LogoMood = 'idle' | 'happy';

interface LogoProps {
  /** 显示宽度（px）；高度按原图比例（590 × 600）。 */
  size?: number;
  /** `happy`：验证 / 上线成功时弹一下并亮起光环。 */
  mood?: LogoMood;
  className?: string;
}

/** 原图是 590 × 600，宽高比固定，代码里只给宽度。 */
const ASPECT = 600 / 590;

/**
 * WeqBot 标志：沿用 WeQ 的品牌图（`docs/images/logo.png` 的同源副本，
 * 见 `public/brand/README.md`）。透明底，深浅色都能直接用。
 */
export function Logo({ size = 40, mood = 'idle', className }: LogoProps) {
  return (
    <span
      className={className ? `logo ${className}` : 'logo'}
      data-mood={mood}
      style={{ width: size, height: Math.round(size * ASPECT) }}
    >
      <img
        className="logo-image"
        src="/brand/logo-2x.png"
        srcSet="/brand/logo-2x.png 2x, /brand/logo-3x.png 3x"
        alt=""
        width={590}
        height={600}
        draggable={false}
        decoding="async"
      />
      <span className="logo-flash" aria-hidden="true" />
    </span>
  );
}
