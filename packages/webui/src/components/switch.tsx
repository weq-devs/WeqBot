import './switch.css';

interface SwitchProps {
  checked: boolean;
  onChange(next: boolean): void;
  id?: string;
  disabled?: boolean;
  'aria-label'?: string;
  'aria-describedby'?: string;
}

/** 开关：原生 checkbox 承担语义与键盘操作，外观全部画在旁边的 track 上。 */
export function Switch({ checked, onChange, id, disabled, ...aria }: SwitchProps) {
  return (
    <span className="switch">
      <input
        {...aria}
        id={id}
        type="checkbox"
        role="switch"
        aria-checked={checked}
        className="switch-input"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
    </span>
  );
}
