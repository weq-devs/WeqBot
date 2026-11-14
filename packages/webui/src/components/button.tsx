import type { ButtonHTMLAttributes } from 'react';
import './button.css';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `primary` 一屏最多一个；其余用 `secondary` / `ghost`。 */
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'md' | 'lg';
  /** 撑满父容器宽度。 */
  block?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  block = false,
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={className ? `btn ${className}` : 'btn'}
      data-variant={variant}
      data-size={size}
      data-block={block || undefined}
    />
  );
}
