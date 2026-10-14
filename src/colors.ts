export interface ColorOption {
  name: string;
  value: string;
  border: string;
}

export const SQUARE_COLORS: ColorOption[] = [
  { name: 'Default Slate', value: '#1e293b', border: '#475569' },
  { name: 'Dark Charcoal', value: '#18181b', border: '#3f3f46' },
  { name: 'Ruby Red', value: '#991b1b', border: '#ef4444' },
  { name: 'Rose', value: '#881337', border: '#f43f5e' },
  { name: 'Rust Orange', value: '#9a3412', border: '#f97316' },
  { name: 'Amber Gold', value: '#92400e', border: '#f59e0b' },
  { name: 'Warm Yellow', value: '#713f12', border: '#eab308' },
  { name: 'Forest Green', value: '#166534', border: '#22c55e' },
  { name: 'Emerald', value: '#065f46', border: '#10b981' },
  { name: 'Deep Teal', value: '#115e59', border: '#14b8a6' },
  { name: 'Cyan Blue', value: '#155e75', border: '#06b6d4' },
  { name: 'Sapphire Blue', value: '#1e40af', border: '#3b82f6' },
  { name: 'Electric Indigo', value: '#3730a3', border: '#6366f1' },
  { name: 'Deep Violet', value: '#5b21b6', border: '#8b5cf6' },
  { name: 'Royal Purple', value: '#6b21a8', border: '#a855f7' },
  { name: 'Magenta Fuchsia', value: '#86198f', border: '#d946ef' },
];

/**
 * Given a hex color (e.g. #1e293b), returns a matching border color,
 * either from the predefined preset list or calculated by lightening/adjusting brightness.
 */
export function getSquareBorderColor(hex?: string): string {
  if (!hex) return '#475569';
  const found = SQUARE_COLORS.find(c => c.value.toLowerCase() === hex.toLowerCase());
  if (found) return found.border;

  // Otherwise calculate lighter border for arbitrary hex
  try {
    const clean = hex.replace('#', '');
    if (clean.length === 6) {
      const num = parseInt(clean, 16);
      const r = Math.min(255, ((num >> 16) & 255) + 50);
      const g = Math.min(255, ((num >> 8) & 255) + 50);
      const b = Math.min(255, (num & 255) + 50);
      return `rgb(${r}, ${g}, ${b})`;
    }
  } catch (e) {}

  return '#475569';
}

/** True for light tile colors, where overlays and text need to be dark to stay visible. */
export function isLightColor(hex?: string): boolean {
  if (!hex) return false;
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
  if (full.length !== 6) return false;
  const num = parseInt(full, 16);
  if (isNaN(num)) return false;
  const r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
  // Perceived brightness (ITU-R BT.601)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
}
