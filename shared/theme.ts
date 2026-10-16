/**
 * Theme rules shared by the theme editor (browser) and the API (server), so both reject the
 * same bad input. Text is stored as plain text and rendered as text, never as HTML.
 */
import type { TenantTheme } from './types';

export interface ThemeUpdate {
  theme: TenantTheme;
  primary: string;
  primaryText: string;
  pageBackground: string;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const LIMITS = { welcomeTitle: 60, welcomeText: 160, buttonLabel: 24, footerText: 120 } as const;

/** WCAG relative luminance contrast ratio between two #rrggbb colours (1 – 21). */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Returns a list of problems; empty means the update is valid. */
export function validateThemeUpdate(u: unknown): string[] {
  const errors: string[] = [];
  if (!u || typeof u !== 'object') return ['body must be a JSON object'];
  const x = u as Partial<ThemeUpdate>;
  for (const k of ['primary', 'primaryText', 'pageBackground'] as const) {
    if (typeof x[k] !== 'string' || !HEX.test(x[k]!)) errors.push(`${k} must be a #rrggbb colour`);
  }
  const t = x.theme as Partial<TenantTheme> | undefined;
  if (!t || typeof t !== 'object') return [...errors, 'theme is required'];
  if (!['centered', 'split'].includes(t.layout as string)) errors.push('layout must be centered or split');
  if (!['system', 'serif', 'rounded'].includes(t.font as string)) errors.push('font must be system, serif or rounded');
  if (typeof t.radius !== 'number' || t.radius < 0 || t.radius > 24) errors.push('radius must be 0–24');
  for (const [k, max] of Object.entries(LIMITS)) {
    const v = (t as Record<string, unknown>)[k];
    if (typeof v !== 'string' || !v.trim()) errors.push(`${k} is required`);
    else if (v.length > max) errors.push(`${k} must be at most ${max} characters`);
    else if (/[<>]/.test(v)) errors.push(`${k} must not contain < or >`);
  }
  // Readability: button text on the primary colour, and body text on the page background
  if (!errors.length) {
    if (contrastRatio(x.primary!, x.primaryText!) < 3) errors.push('button text is hard to read on the primary colour (contrast below 3:1)');
    if (contrastRatio(x.pageBackground!, '#15171c') < 4.5) errors.push('page background is too dark for body text (contrast below 4.5:1)');
  }
  return errors;
}
