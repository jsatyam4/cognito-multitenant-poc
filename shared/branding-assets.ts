/**
 * Generated branding assets (pure functions, no AWS): used by onboarding (Cognito managed-login
 * styles), the API (regenerating a logo when a theme changes) and the theme editor preview.
 */
import type { TenantBranding } from './types';

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

/**
 * Managed login cannot show tenant-specific TEXT (only localisation), so the app name
 * is rendered INTO the logo image. Generated, so onboarding needs no designer assets.
 */
export function logoSvg(appName: string, b: TenantBranding): string {
  const initial = esc(appName.trim()[0]?.toUpperCase() ?? '?');
  const mark =
    b.pattern === 'grid'
      ? `<rect x="6" y="14" width="52" height="52" rx="10" fill="${b.primary}"/>`
      : b.pattern === 'diagonal'
        ? `<path d="M32 10 L58 40 L32 70 L6 40 Z" fill="${b.primary}"/>`
        : `<circle cx="32" cy="40" r="27" fill="${b.primary}"/>`;
  const w = Math.max(260, 90 + appName.length * 19);
  // Cognito rejects logos outside a 1:1–4:1 width:height ratio, so long names get a taller canvas
  const h = Math.max(80, Math.ceil(w / LOGO_MAX_RATIO));
  const dy = (h - 80) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><g transform="translate(0 ${dy})">${mark}<text x="32" y="50" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="30" font-weight="700" fill="${b.primaryText}">${initial}</text><text x="74" y="51" font-family="Helvetica, Arial, sans-serif" font-size="30" font-weight="700" fill="${b.accent}">${esc(appName)}</text></g></svg>`;
}

/** Managed login accepts logos between 1:1 and 4:1 (width:height); stay just under the limit. */
export const LOGO_MAX_RATIO = 3.9;

export function faviconSvg(appName: string, b: TenantBranding): string {
  const initial = esc(appName.trim()[0]?.toUpperCase() ?? '?');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${b.primary}"/><text x="32" y="44" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="36" font-weight="700" fill="${b.primaryText}">${initial}</text></svg>`;
}

export function backgroundSvg(b: TenantBranding): string {
  const c = b.primary;
  const pattern =
    b.pattern === 'grid'
      ? `<pattern id="p" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="${c}" stroke-opacity="0.12" stroke-width="1.5"/></pattern>`
      : b.pattern === 'diagonal'
        ? `<pattern id="p" width="28" height="28" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="10" height="28" fill="${c}" fill-opacity="0.07"/></pattern>`
        : `<pattern id="p" width="32" height="32" patternUnits="userSpaceOnUse"><circle cx="4" cy="4" r="2.4" fill="${c}" fill-opacity="0.18"/></pattern>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000"><defs>${pattern}<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${b.pageBackground}"/><stop offset="1" stop-color="${c}" stop-opacity="0.18"/></linearGradient></defs><rect width="1600" height="1000" fill="url(#g)"/><rect width="1600" height="1000" fill="url(#p)"/></svg>`;
}
