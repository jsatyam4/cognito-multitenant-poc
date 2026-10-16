import {
  CreateManagedLoginBrandingCommand,
  DeleteManagedLoginBrandingCommand,
  DescribeManagedLoginBrandingByClientCommand,
  DescribeManagedLoginBrandingCommand,
  UpdateManagedLoginBrandingCommand,
  type AssetType,
} from '@aws-sdk/client-cognito-identity-provider';
import { cognito } from './common';
import type { TenantBranding } from '../../shared/types';
import { backgroundSvg, faviconSvg, logoSvg } from '../../shared/branding-assets';

export { backgroundSvg, faviconSvg, logoSvg, LOGO_MAX_RATIO } from '../../shared/branding-assets';

/** Cognito branding colours are 8-char lowercase RRGGBBAA without '#'. */
export const cognitoColor = (hex: string) => `${hex.replace('#', '').toLowerCase().padEnd(6, '0').slice(0, 6)}ff`;

function assetsFor(appName: string, b: TenantBranding): AssetType[] {
  const svg = (s: string) => new TextEncoder().encode(s);
  return [
    { Category: 'FORM_LOGO', ColorMode: 'LIGHT', Extension: 'SVG', Bytes: svg(logoSvg(appName, b)) },
    { Category: 'FAVICON_SVG', ColorMode: 'LIGHT', Extension: 'SVG', Bytes: svg(faviconSvg(appName, b)) },
    { Category: 'PAGE_BACKGROUND', ColorMode: 'LIGHT', Extension: 'SVG', Bytes: svg(backgroundSvg(b)) },
  ];
}

type Json = Record<string, any>;

function getPath(o: Json, path: string[]): any {
  return path.reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), o as any);
}
function setIfObject(o: Json, path: string[], key: string, value: unknown, log: string[]) {
  const parent = getPath(o, path);
  if (parent && typeof parent === 'object') {
    parent[key] = value;
    log.push(`${[...path, key].join('.')}`);
  }
}
function replaceDeep(o: any, from: string, to: string, log: string[], trail = ''): any {
  if (typeof o === 'string') {
    if (o.toLowerCase() === from) {
      log.push(trail);
      return to;
    }
    return o;
  }
  if (Array.isArray(o)) return o.map((v, i) => replaceDeep(v, from, to, log, `${trail}[${i}]`));
  if (o && typeof o === 'object') {
    for (const k of Object.keys(o)) o[k] = replaceDeep(o[k], from, to, log, trail ? `${trail}.${k}` : k);
  }
  return o;
}

/**
 * The managed-login settings document is large and versioned by AWS. Rather than
 * hand-writing it, we let Cognito create its defaults, read them back merged, and
 * patch only the colour / image switches we care about. This keeps the POC working
 * if AWS adds fields.
 */
export function patchSettings(defaults: Json, b: TenantBranding): { settings: Json; patched: string[] } {
  const s: Json = structuredClone(defaults);
  const patched: string[] = [];
  const defaultPrimary = String(
    getPath(s, ['components', 'primaryButton', 'lightMode', 'defaults', 'backgroundColor']) ?? '',
  ).toLowerCase();
  if (defaultPrimary) replaceDeep(s, defaultPrimary, cognitoColor(b.primary), patched);

  setIfObject(s, ['components', 'pageBackground', 'lightMode'], 'color', cognitoColor(b.pageBackground), patched);
  setIfObject(s, ['components', 'pageBackground', 'image'], 'enabled', true, patched);
  setIfObject(s, ['components', 'form', 'logo'], 'enabled', true, patched);
  setIfObject(s, ['components', 'form'], 'borderRadius', 12, patched);
  setIfObject(s, ['categories', 'global'], 'colorSchemeMode', 'LIGHT', patched);
  setIfObject(s, ['components', 'favicon'], 'enabledTypes', ['SVG'], patched);
  return { settings: s, patched };
}

export interface BrandingResult {
  brandingId: string;
  mode: 'custom-settings+assets' | 'default-settings+assets' | 'defaults-only';
  patchedPaths: number;
  error?: string;
}

/** Create (or replace) the branding style for one app client. */
export async function applyBranding(
  userPoolId: string,
  clientId: string,
  appName: string,
  b: TenantBranding,
): Promise<BrandingResult> {
  // A client can only have one style and it can't be re-assigned → delete + create.
  try {
    const ex = await cognito.send(new DescribeManagedLoginBrandingByClientCommand({ UserPoolId: userPoolId, ClientId: clientId }));
    const id = ex.ManagedLoginBranding?.ManagedLoginBrandingId;
    if (id) await cognito.send(new DeleteManagedLoginBrandingCommand({ UserPoolId: userPoolId, ManagedLoginBrandingId: id }));
  } catch (e) {
    if ((e as Error).name !== 'ResourceNotFoundException') throw e;
  }

  const created = await cognito.send(
    new CreateManagedLoginBrandingCommand({ UserPoolId: userPoolId, ClientId: clientId, UseCognitoProvidedValues: true }),
  );
  const brandingId = created.ManagedLoginBranding!.ManagedLoginBrandingId!;
  return updateBranding(userPoolId, brandingId, appName, b);
}

/** Re-brand in place — no deploy, takes effect on next page load of the login page. */
export async function updateBranding(
  userPoolId: string,
  brandingId: string,
  appName: string,
  b: TenantBranding,
): Promise<BrandingResult> {
  const merged = await cognito.send(
    new DescribeManagedLoginBrandingCommand({ UserPoolId: userPoolId, ManagedLoginBrandingId: brandingId, ReturnMergedResources: true }),
  );
  const defaults = (merged.ManagedLoginBranding?.Settings ?? {}) as Json;
  const assets = assetsFor(appName, b);
  const { settings, patched } = patchSettings(defaults, b);

  try {
    await cognito.send(
      new UpdateManagedLoginBrandingCommand({
        UserPoolId: userPoolId,
        ManagedLoginBrandingId: brandingId,
        UseCognitoProvidedValues: false,
        Settings: settings as any,
        Assets: assets,
      }),
    );
    return { brandingId, mode: 'custom-settings+assets', patchedPaths: patched.length };
  } catch (e1) {
    // An asset problem (size, ratio) would fail the retry too, so report it instead of retrying
    if (/Invalid assets/.test((e1 as Error).message)) {
      return { brandingId, mode: 'defaults-only', patchedPaths: 0, error: (e1 as Error).message };
    }
    console.warn(`\n    ! patched settings rejected (${(e1 as Error).message}); retrying with default settings + assets`);
    try {
      await cognito.send(
        new UpdateManagedLoginBrandingCommand({
          UserPoolId: userPoolId,
          ManagedLoginBrandingId: brandingId,
          UseCognitoProvidedValues: false,
          Settings: defaults as any,
          Assets: assets,
        }),
      );
      return { brandingId, mode: 'default-settings+assets', patchedPaths: 0, error: (e1 as Error).message };
    } catch (e2) {
      return { brandingId, mode: 'defaults-only', patchedPaths: 0, error: (e2 as Error).message };
    }
  }
}
