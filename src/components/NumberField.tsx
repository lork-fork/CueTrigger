import { useState } from 'react';

interface NumberFieldProps {
  value: number;
  onChange: (value: number) => void;
  // Used when the field is left empty or invalid
  fallback: number;
  min?: number;
  step?: number;
  className?: string;
}

// A number input you can clear while typing: an empty field only becomes the fallback
// when you leave it, and clicking or tabbing in selects the whole number to type over it.
export default function NumberField({ value, onChange, fallback, min, step, className }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);

  const clamp = (n: number) => (min !== undefined ? Math.max(min, n) : n);

  return (
    <input
      type="number"
      min={min}
      step={step}
      value={draft ?? String(value)}
      onFocus={(e) => {
        setDraft(String(value));
        e.currentTarget.select();
      }}
      // Keep the selection made on focus when the click lands
      onMouseUp={(e) => e.preventDefault()}
      onChange={(e) => {
        setDraft(e.target.value);
        const parsed = parseFloat(e.target.value);
        if (!isNaN(parsed)) onChange(clamp(parsed));
      }}
      onBlur={() => {
        const parsed = parseFloat(draft ?? '');
        onChange(isNaN(parsed) ? fallback : clamp(parsed));
        setDraft(null);
      }}
      className={className}
    />
  );
}
