import { User, UserManager, WebStorageStateStore } from 'oidc-client-ts';
import type { ModuleId, PublicTenantConfig } from '../../shared/types';

export type { ModuleId, PublicTenantConfig };
export { MODULES } from '../../shared/types';

// ---------- runtime config & API ----------
let apiUrl: string | undefined;
export async function getApiUrl(): Promise<string> {
  if (apiUrl) return apiUrl;
  const r = await fetch('/runtime-config.json', { cache: 'no-store' });
  if (!r.ok) throw new Error('runtime-config.json not found — deploy the stack first');
  apiUrl = ((await r.json()) as { apiUrl: string }).apiUrl.replace(/\/$/, '');
  return apiUrl;
}

const tenantCache = new Map<string, PublicTenantConfig>();
export async function fetchTenant(id: string): Promise<PublicTenantConfig | null> {
  if (tenantCache.has(id)) return tenantCache.get(id)!;
  const r = await fetch(`${await getApiUrl()}/public/tenants/${encodeURIComponent(id)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Tenant config ${r.status}`);
  const t = (await r.json()) as PublicTenantConfig;
  tenantCache.set(id, t);
  return t;
}
/** Forget a cached tenant config (after the theme editor saves) */
export const forgetTenant = (id: string) => tenantCache.delete(id);

export async function fetchTenants(): Promise<PublicTenantConfig[]> {
  const r = await fetch(`${await getApiUrl()}/public/tenants`);
  if (!r.ok) throw new Error(`Tenant list ${r.status}`);
  return r.json();
}

export interface ApiResult {
  label: string;
  method: string;
  path: string;
  status: number;
  body: unknown;
  ms: number;
  expect?: number;
}
export async function callApi(label: string, path: string, token?: string, expect?: number): Promise<ApiResult> {
  const t0 = performance.now();
  const res = await fetch(`${await getApiUrl()}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = await res.text().catch(() => null);
  }
  return { label, method: 'GET', path, status: res.status, body, ms: Math.round(performance.now() - t0), expect };
}

// ---------- OIDC (Authorization Code + PKCE via oidc-client-ts) ----------
const managers = new Map<string, UserManager>();

/** One OIDC client per tenant × module — each module has its own Cognito app client & login page. */
export function managerFor(t: PublicTenantConfig, module: ModuleId): UserManager {
  const key = `${t.tenantId}:${module}`;
  if (managers.has(key)) return managers.get(key)!;
  const origin = window.location.origin;
  const m = new UserManager({
    authority: t.issuer,
    client_id: t.modules[module].clientId,
    redirect_uri: `${origin}/callback`,
    post_logout_redirect_uri: `${origin}/t/${t.tenantId}`,
    response_type: 'code', // PKCE (S256) is applied automatically by oidc-client-ts
    scope: 'openid email profile',
    loadUserInfo: false,
    automaticSilentRenew: false,
    // Explicit metadata: Cognito's hosted endpoints live on the pool's login domain
    metadata: {
      issuer: t.issuer,
      authorization_endpoint: `${t.loginDomain}/oauth2/authorize`,
      token_endpoint: `${t.loginDomain}/oauth2/token`,
      userinfo_endpoint: `${t.loginDomain}/oauth2/userInfo`,
      revocation_endpoint: `${t.loginDomain}/oauth2/revoke`,
      end_session_endpoint: `${t.loginDomain}/logout`,
      jwks_uri: `${t.issuer}/.well-known/jwks.json`,
    },
    userStore: new WebStorageStateStore({ store: window.sessionStorage, prefix: `poc.user.${key}.` }),
    stateStore: new WebStorageStateStore({ store: window.sessionStorage, prefix: 'poc.state.' }),
  });
  managers.set(key, m);
  return m;
}

const PENDING = 'poc.pending';
export async function signIn(t: PublicTenantConfig, module: ModuleId, forceLoginPage: boolean) {
  // Scenario C: our own login page instead of Cognito's hosted page
  if (t.loginMode === 'own') return navigate(`/t/${t.tenantId}/login?module=${module}`);
  sessionStorage.setItem(PENDING, JSON.stringify({ tenantId: t.tenantId, module }));
  await managerFor(t, module).signinRedirect({
    // Cognito keeps one session cookie per login domain. Without prompt=login, signing into
    // Module 2 after Module 1 (same pool) skips Module 2's page entirely (SSO).
    prompt: forceLoginPage ? 'login' : undefined,
  });
}

/** "Continue with Microsoft/Google": straight to the identity provider, skipping Cognito's page */
export async function federatedSignIn(t: PublicTenantConfig, module: ModuleId, idp: string) {
  sessionStorage.setItem(PENDING, JSON.stringify({ tenantId: t.tenantId, module }));
  await managerFor(t, module).signinRedirect({ extraQueryParams: { identity_provider: idp } });
}

/** Our own login page signed in through Cognito's API: store the tokens like a hosted sign-in */
export async function storeOwnSession(t: PublicTenantConfig, module: ModuleId, tok: { idToken: string; accessToken: string; refreshToken: string }) {
  const exp = Number(decodeJwt(tok.accessToken).exp);
  const user = new User({
    id_token: tok.idToken,
    access_token: tok.accessToken,
    refresh_token: tok.refreshToken,
    token_type: 'Bearer',
    scope: 'openid email profile',
    profile: decodeJwt(tok.idToken) as never,
    expires_at: exp,
  });
  await managerFor(t, module).storeUser(user);
}

export async function completeSignIn(): Promise<{ tenantId: string; module: ModuleId; user: User }> {
  const raw = sessionStorage.getItem(PENDING);
  if (!raw) throw new Error('No sign-in in progress (pending state missing).');
  const { tenantId, module } = JSON.parse(raw) as { tenantId: string; module: ModuleId };
  const t = await fetchTenant(tenantId);
  if (!t) throw new Error(`Unknown tenant ${tenantId}`);
  const user = await managerFor(t, module).signinRedirectCallback();
  sessionStorage.removeItem(PENDING);
  return { tenantId, module, user };
}

export async function getUser(t: PublicTenantConfig, module: ModuleId): Promise<User | null> {
  const u = await managerFor(t, module).getUser();
  return u && !u.expired ? u : null;
}

/** Cognito logout: revoke refresh token, clear local session, then hit /logout to clear the hosted-login cookie. */
export async function signOut(t: PublicTenantConfig, module: ModuleId) {
  const m = managerFor(t, module);
  try {
    await m.revokeTokens(['refresh_token']);
  } catch {
    /* best effort */
  }
  await m.removeUser();
  // Own login page: no hosted-login session cookie to clear
  if (t.loginMode === 'own') return navigate(`/t/${t.tenantId}/login?module=${module}`);
  const u = new URL(`${t.loginDomain}/logout`);
  u.searchParams.set('client_id', t.modules[module].clientId);
  u.searchParams.set('logout_uri', `${window.location.origin}/t/${t.tenantId}`);
  window.location.assign(u.toString());
}

export function decodeJwt(token: string): Record<string, unknown> {
  try {
    const p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(p), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {};
  }
}

// ---------- tenant theming ----------
export const svgDataUrl = (svg?: string) => (svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : undefined);

export function applyTheme(t: PublicTenantConfig | null) {
  const root = document.documentElement.style;
  const icon = document.getElementById('favicon') as HTMLLinkElement | null;
  if (!t) {
    for (const k of ['--brand', '--brand-text', '--tenant-bg', '--accent']) root.removeProperty(k);
    document.title = 'Multi-tenant Login POC';
    return;
  }
  root.setProperty('--brand', t.branding.primary);
  root.setProperty('--brand-text', t.branding.primaryText);
  root.setProperty('--tenant-bg', t.branding.pageBackground);
  root.setProperty('--accent', t.branding.accent);
  document.title = t.appName;
  const fav = svgDataUrl(t.branding.faviconSvg);
  if (icon && fav) icon.href = fav;
}

/** Scenario label shown in the UI */
export const scenarioOf = (t: PublicTenantConfig): 'A' | 'B' | 'C' => (t.model === 'shared' ? 'A' : t.loginMode === 'own' ? 'C' : 'B');
export const SCENARIO_LABEL = {
  A: 'A · Shared pool · hosted login',
  B: 'B · Own pool · hosted login',
  C: 'C · Own pool · own login page',
} as const;

// ---------- tiny router ----------
export function navigate(path: string) {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
