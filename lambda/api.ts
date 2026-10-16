import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { authenticate, AuthError } from './auth';
import { allTenants, saveTheme, tenantById } from './registry';
import { faviconSvg, logoSvg } from '../shared/branding-assets';
import { validateThemeUpdate, type ThemeUpdate } from '../shared/theme';
import type { PublicTenantConfig, TenantRecord } from '../shared/types';

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body, null, 2),
});

const toPublic = ({ status: _s, allowedEmailDomains: _d, ...rest }: TenantRecord): PublicTenantConfig => rest;

/** Deterministic fake per-tenant business data so each tenant visibly sees only its own rows. */
function tenantData(t: TenantRecord) {
  let seed = [...t.tenantId].reduce((a, c) => a + c.charCodeAt(0), 0);
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  return Array.from({ length: 4 }, (_, i) => ({
    id: `${t.slug.toUpperCase()}-${1000 + i}`,
    tenant_id: t.tenantId,
    item: ['Invoice', 'Shipment', 'Contract', 'Ticket'][i],
    amount: Math.round(rnd() * 90000 + 1000),
  }));
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const path = event.rawPath.replace(/\/+$/, '') || '/';
  const parts = path.split('/').filter(Boolean);

  try {
    // ---- Theme editor save: PUT /t/{tenantId}/theme (tenant admin only) ----
    if (method === 'PUT' && parts[0] === 't' && parts.length === 3 && parts[2] === 'theme') {
      const tenant = await tenantById(parts[1]);
      if (!tenant) return json(404, { error: 'tenant_not_found' });
      const auth = await authenticate(event.headers.authorization, tenant.tenantId);
      if (auth.role !== 'admin') return json(403, { error: 'insufficient_role', required: 'admin' });
      let body: unknown;
      try {
        body = JSON.parse(event.body ?? '');
      } catch {
        return json(400, { error: 'invalid_json' });
      }
      const errors = validateThemeUpdate(body);
      if (errors.length) return json(400, { error: 'invalid_theme', errors });
      const u = body as ThemeUpdate;
      const branding = { ...tenant.branding, primary: u.primary, primaryText: u.primaryText, pageBackground: u.pageBackground };
      branding.logoSvg = logoSvg(tenant.appName, branding);
      branding.faviconSvg = faviconSvg(tenant.appName, branding);
      await saveTheme(tenant.tenantId, u.theme, branding);
      return json(200, { ok: true, tenant: tenant.tenantId, savedBy: auth.username });
    }

    if (method !== 'GET') return json(405, { error: 'method_not_allowed' });

    // ---- Public (no auth): tenant directory and branding/config for the SPA ----
    if (parts[0] === 'public' && parts[1] === 'tenants') {
      if (parts.length === 2) {
        const list = (await allTenants()).map(toPublic).sort((a, b) => a.tenantId.localeCompare(b.tenantId));
        return json(200, list);
      }
      const t = await tenantById(parts[2]);
      return t ? json(200, toPublic(t)) : json(404, { error: 'tenant_not_found' });
    }

    // ---- Protected: /t/{tenantId}/{me|data|admin} ----
    if (parts[0] === 't' && parts.length === 3) {
      const [, tenantId, resource] = parts;
      const tenant = await tenantById(tenantId);
      if (!tenant) return json(404, { error: 'tenant_not_found' });
      const auth = await authenticate(event.headers.authorization, tenantId);

      if (resource === 'me') {
        return json(200, { ok: true, tenant: tenant.displayName, user: auth, verifiedBy: 'aws-jwt-verify (JWKS)' });
      }
      if (resource === 'data') {
        return json(200, { ok: true, tenant: tenant.tenantId, rows: tenantData(tenant) });
      }
      if (resource === 'admin') {
        if (auth.role !== 'admin') {
          return json(403, { error: 'insufficient_role', message: `role "${auth.role}" cannot access admin`, required: 'admin' });
        }
        return json(200, { ok: true, message: `Welcome, ${tenant.displayName} admin`, tenant: tenant.tenantId });
      }
    }
    return json(404, { error: 'not_found', path });
  } catch (e) {
    if (e instanceof AuthError) return json(e.status, { error: e.code, message: e.message });
    console.error(e);
    return json(500, { error: 'internal_error' });
  }
};
