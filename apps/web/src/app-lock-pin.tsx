import { useId, useState, type RefObject } from 'react';
import { appLockPasswordValid } from '@lifeos/core';

export function PinField({ value, onChange, onComplete, label, autoFocus = false, disabled = false, invalid = false, inputRef }: {
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  label: string;
  autoFocus?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const [error, setError] = useState('');
  const id = useId();
  const change = (next: string) => {
    if (disabled || next.length > 4 || /[^0-9]/.test(next)) return;
    setError('');
    onChange(next);
    if (appLockPasswordValid(next) && next !== value) onComplete?.(next);
  };
  return <div className="app-lock-pin-field">
    <div className={`app-lock-pin${disabled ? ' is-disabled' : ''}${invalid || error ? ' is-invalid' : ''}`}>
      <div className="app-lock-pin-slots" aria-hidden="true">{[0, 1, 2, 3].map(i => <span key={i} className={`app-lock-pin-slot${i < value.length ? ' is-filled' : ''}${i === value.length ? ' is-current' : ''}`}>{i < value.length ? '●' : ''}</span>)}</div>
      <input ref={inputRef} autoFocus={autoFocus} aria-label={label} aria-invalid={invalid || !!error} aria-describedby={error ? id : undefined} autoComplete="off" autoCapitalize="off" spellCheck={false} type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} value={value} disabled={disabled}
        onChange={e => change(e.target.value)}
        onPaste={e => { e.preventDefault(); if (disabled) return; const text = e.clipboardData.getData('text'); if (!appLockPasswordValid(text)) { setError('请粘贴完整的4位数字'); return; } change(text); }}
        onDrop={e => e.preventDefault()} />
    </div>
    {error ? <span id={id} className="app-lock-pin-error" role="alert">{error}</span> : null}
  </div>;
}
