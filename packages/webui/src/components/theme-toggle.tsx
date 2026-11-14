import { type LucideIcon, Monitor, Moon, Sun } from 'lucide-react';
import { motion } from 'motion/react';
import { setThemePreference, type ThemePreference, useThemePreference } from '../lib/theme';
import './theme-toggle.css';

const OPTIONS: { value: ThemePreference; label: string; Icon: LucideIcon }[] = [
  { value: 'light', label: '浅色', Icon: Sun },
  { value: 'system', label: '跟随系统', Icon: Monitor },
  { value: 'dark', label: '深色', Icon: Moon },
];

/** 三段式外观切换（浅 / 跟随系统 / 深），选中块用共享布局动画滑动。 */
export function ThemeToggle() {
  const current = useThemePreference();

  return (
    <fieldset className="theme-toggle">
      <legend className="sr-only">外观</legend>
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = value === current;
        return (
          <button
            key={value}
            type="button"
            className="theme-toggle-option"
            aria-pressed={active}
            aria-label={label}
            title={label}
            onClick={(event) => {
              // 键盘触发时没有指针坐标（detail === 0），改从按钮中心扩散。
              const rect = event.currentTarget.getBoundingClientRect();
              const origin =
                event.detail === 0
                  ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
                  : { x: event.clientX, y: event.clientY };
              setThemePreference(value, origin);
            }}
          >
            {active && (
              <motion.span
                layoutId="theme-toggle-pill"
                className="theme-toggle-pill"
                transition={{ type: 'spring', bounce: 0.2, duration: 0.45 }}
              />
            )}
            <Icon className="theme-toggle-icon" size={15} strokeWidth={2} aria-hidden="true" />
          </button>
        );
      })}
    </fieldset>
  );
}
