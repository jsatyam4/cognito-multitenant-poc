/** R2 / R3 / R7 end to end over HTTP: real API handler, in-memory registry, local tokens. */
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { accessToken, byId, idToken, TENANTS } from './fixtures';
import { startLocalApi } from '../scripts/local-api';

let base = '';
let close: () => void;
before(async () => {
  const server = await startLocalApi(0);
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

async function get(path: string, token?: string) {
  const r = await fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.status, body: (await r.json()) as any };
}

describe('public tenant config (what the SPA loads)', () => {
  it('lists every tenant without the internal status field', async () => {
    const { status, body } = await get('/public/tenants');
    assert.equal(status, 200);
    assert.equal(body.length, TENANTS.length);
    assert.ok(body.every((t: any) => !('status' in t)));
  });

  it('serves per-tenant branding, issuer and one client per module', async () => {
    const { status, body } = await get('/public/tenants/acme');
    assert.equal(status, 200);
    assert.equal(body.branding.primary, '#E4572E');
    assert.match(body.branding.logoSvg, /Acme Workspace/);
    assert.deepEqual(Object.keys(body.modules).sort(), ['module1', 'module2', 'module3']);
  });

  it('branding differs per tenant (colour + login host)', async () => {
    const [a, g] = await Promise.all([get('/public/tenants/acme'), get('/public/tenants/globex')]);
    assert.notEqual(a.body.branding.primary, g.body.branding.primary);
    assert.notEqual(a.body.loginDomain, g.body.loginDomain);
  });

  it('404 tenant_not_found for an unknown tenant', async () => {
    assert.deepEqual(await get('/public/tenants/nope'), { status: 404, body: { error: 'tenant_not_found' } });
  });
});

describe('protected routes', () => {
  const acme = byId('acme'), globex = byId('globex');

  it('200 own tenant /me and /data, rows scoped to the tenant', async () => {
    const me = await get('/t/acme/me', accessToken(acme));
    assert.equal(me.status, 200);
    assert.equal(me.body.user.tenantId, 'acme');
    const data = await get('/t/acme/data', accessToken(acme));
    assert.ok(data.body.rows.every((r: any) => r.tenant_id === 'acme'));
  });

  it('403 wrong_tenant: Acme token on Globex data', async () => {
    const r = await get('/t/globex/data', accessToken(acme));
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'wrong_tenant');
  });

  it('401 with no token, and with an ID token as bearer', async () => {
    assert.equal((await get('/t/acme/data')).status, 401);
    assert.equal((await get('/t/acme/data', idToken(acme))).status, 401);
  });

  it('admin route: user 403 insufficient_role, admin 200', async () => {
    const u = await get('/t/globex/admin', accessToken(globex));
    assert.equal(u.status, 403);
    assert.equal(u.body.error, 'insufficient_role');
    assert.equal((await get('/t/globex/admin', accessToken(globex, { role: 'admin' }))).status, 200);
  });

  it('every cross-tenant pair is rejected (both models)', async () => {
    for (const a of TENANTS) {
      for (const b of TENANTS) {
        if (a === b) continue;
        const r = await get(`/t/${b.tenantId}/data`, accessToken(a));
        assert.equal(r.status, 403, `${a.tenantId} → ${b.tenantId} returned ${r.status}`);
      }
    }
  });
});
