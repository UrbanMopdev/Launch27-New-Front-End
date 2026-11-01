// Small form controls shared by the support settings screens.
import { useEffect, useState, type ReactNode } from 'react';

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="switch" title={label}>
      <input type="checkbox" disabled={disabled} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="sr-only">{label}</span>
      <span className="switch-ui" aria-hidden="true" />
    </label>
  );
}

// Type a word or phrase and press Enter; each one becomes a removable chip.
export function TagInput({ values, onChange, placeholder, disabled, label }: { values: string[]; onChange: (v: string[]) => void; placeholder?: string; disabled?: boolean; label: string }) {
  const [text, setText] = useState('');
  const add = (raw: string) => {
    const parts = raw.split('\n').map((s) => s.trim()).filter(Boolean).filter((s) => !values.some((v) => v.toLowerCase() === s.toLowerCase()));
    if (parts.length) onChange([...values, ...parts]);
    setText('');
  };
  return (
    <div className={disabled ? 'tag-input disabled' : 'tag-input'}>
      {values.map((v, i) => (
        <span key={`${v}-${i}`} className="tag">
          {v}
          {!disabled && (
            <button type="button" className="tag-x" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((_, j) => j !== i))}>
              ×
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          aria-label={label}
          value={text}
          placeholder={values.length ? 'Add another…' : placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === 'Tab') && text.trim()) {
              e.preventDefault();
              add(text);
            } else if (e.key === 'Backspace' && !text && values.length) onChange(values.slice(0, -1));
          }}
          onPaste={(e) => {
            const t = e.clipboardData.getData('text');
            if (t.includes('\n')) {
              e.preventDefault();
              add(t);
            }
          }}
          onBlur={() => text.trim() && add(text)}
        />
      )}
    </div>
  );
}

// Pick any number of options as toggle pills.
export function PillPicker({ options, values, onChange, disabled }: { options: { value: string; label: string }[]; values: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  return (
    <div className="chips">
      {options.map((o) => {
        const on = values.includes(o.value);
        return (
          <button key={o.value} type="button" disabled={disabled} aria-pressed={on} className={on ? 'pillbtn on' : 'pillbtn'} onClick={() => onChange(on ? values.filter((v) => v !== o.value) : [...values, o.value])}>
            {on && <span aria-hidden="true">✓ </span>}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const UNITS = [
  { value: 1, label: 'minutes' },
  { value: 60, label: 'hours' },
  { value: 1440, label: 'days' },
];
const bestUnit = (m: number | null) => (m && m % 1440 === 0 ? 1440 : m && m % 60 === 0 ? 60 : 1);

// A length of time as "number + unit" instead of raw minutes.
export function DurationInput({ minutes, onChange, disabled, label, allowEmpty, placeholder }: { minutes: number | null; onChange: (m: number | null) => void; disabled?: boolean; label: string; allowEmpty?: boolean; placeholder?: string }) {
  const [unit, setUnit] = useState(() => bestUnit(minutes));
  const [text, setText] = useState(minutes === null ? '' : String(minutes / bestUnit(minutes)));
  useEffect(() => {
    // Follow outside changes (e.g. Discard) without fighting the user's typing.
    const current = text === '' ? null : Math.round(Number(text) * unit);
    if (current !== minutes) {
      const u = bestUnit(minutes);
      setUnit(u);
      setText(minutes === null ? '' : String(minutes / u));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minutes]);
  const emit = (t: string, u: number) => {
    if (t === '') return onChange(allowEmpty ? null : minutes);
    const n = Number(t);
    if (Number.isFinite(n) && n >= 0) onChange(Math.round(n * u));
  };
  return (
    <span className="duration">
      <input className="cap-input" type="number" min={0} step="any" aria-label={label} placeholder={placeholder} disabled={disabled} value={text} onChange={(e) => { setText(e.target.value); emit(e.target.value, unit); }} />
      <select aria-label={`${label} unit`} disabled={disabled} value={unit} onChange={(e) => { const u = Number(e.target.value); setUnit(u); emit(text, u); }}>
        {UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
      </select>
    </span>
  );
}

// Sticky bar shown while there are unsaved changes.
export function SaveBar({ show, saving, onSave, onDiscard, error, blocked, children }: { show: boolean; saving?: boolean; onSave: () => void; onDiscard: () => void; error?: string | null; blocked?: string | null; children?: ReactNode }) {
  if (!show && !error) return null;
  return (
    <div className="save-bar" role="region" aria-label="Unsaved changes">
      <div className="grow">
        {error ? <span className="error small">{error}</span> : blocked ? <span className="warn small">{blocked}</span> : <span className="strong">You have unsaved changes</span>}
        {children}
      </div>
      <button type="button" className="secondary" onClick={onDiscard} disabled={saving}>Discard</button>
      <button type="button" onClick={onSave} disabled={saving || !!blocked}>{saving ? 'Saving…' : 'Save changes'}</button>
    </div>
  );
}

// Warn before closing the tab with unsaved changes.
export function useLeaveWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);
}
