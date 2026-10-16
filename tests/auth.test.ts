/** R1 / R7 — lambda/auth.ts: JWT verification + tenant binding, offline. */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { accessToken, byId, idToken, installMocks } from './fixtures';

installMocks();
const { authenticate, AuthError } = await import('../lambda/auth');

const acme = byId('acme'), globex = byId('globex');
const acmeShared = byId('acme-shared'), globexShared = byId('globex-shared');

async function rejects(header: string | undefined, path: string, status: number, code: string) {
  await assert.rejects(authenticate(header, path), (e: unknown) => {
    assert.ok(e instanceof AuthError, `expected AuthError, got ${e}`);
    assert.equal(e.status, status);
    assert.equal(e.code, code);
    return true;
  });
}

describe('authenticate()', () => {
  it('accepts an own-tenant access token and returns its claims', async () => {
    const ctx = await authenticate(`Bearer ${accessToken(acme, { role: 'admin', module: 'module2' })}`, 'acme');
    assert.equal(ctx.tenantId, 'acme');
    assert.equal(ctx.role, 'admin');
    assert.equal(ctx.module, 'module2');
    assert.equal(ctx.clientId, acme.modules.module2.clientId);
  });

  it('401 missing_token without a Bearer header', () => rejects(undefined, 'acme', 401, 'missing_token'));
  it('401 malformed_token for a non-JWT', () => rejects('Bearer not-a-jwt', 'acme', 401, 'malformed_token'));

  it('401 unknown_issuer for a pool that is not in the registry', async () => {
    const t = accessToken(acme, { claims: { iss: 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_Evil' } });
    await rejects(`Bearer ${t}`, 'acme', 401, 'unknown_issuer');
  });

  it('401 invalid_token when the signature is tampered', async () => {
    const t = accessToken(acme);
    const bad = t.slice(0, -4) + (t.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    await rejects(`Bearer ${bad}`, 'acme', 401, 'invalid_token');
  });

  it('401 invalid_token when the payload is edited (tenant_id swapped)', async () => {
    const [h, , s] = accessToken(acme).split('.');
    const forged = Buffer.from(JSON.stringify({ iss: acme.issuer, tenant_id: 'globex' })).toString('base64url');
    await rejects(`Bearer ${h}.${forged}.${s}`, 'globex', 401, 'invalid_token');
  });

  it('401 invalid_token for an ID token used as a bearer token', () => rejects(`Bearer ${idToken(acme)}`, 'acme', 401, 'invalid_token'));

  it('401 invalid_token for an expired token', async () => {
    const t = accessToken(acme, { claims: { exp: Math.floor(Date.now() / 1000) - 60 } });
    await rejects(`Bearer ${t}`, 'acme', 401, 'invalid_token');
  });

  it('401 invalid_token for a client_id that is not registered to that pool', async () => {
    const t = accessToken(acme, { claims: { client_id: globex.modules.module1.clientId } });
    await rejects(`Bearer ${t}`, 'acme', 401, 'invalid_token');
  });

  it('403 no_tenant_claim when pre-token did not stamp tenant_id', async () => {
    await rejects(`Bearer ${accessToken(acme, { claims: { tenant_id: undefined } })}`, 'acme', 403, 'no_tenant_claim');
  });

  it('403 tenant_client_mismatch when tenant_id disagrees with the issuing client', async () => {
    await rejects(`Bearer ${accessToken(acme, { claims: { tenant_id: 'globex' } })}`, 'globex', 403, 'tenant_client_mismatch');
  });

  it('403 wrong_tenant: pool model, Acme token on Globex', () =>
    rejects(`Bearer ${accessToken(acme)}`, 'globex', 403, 'wrong_tenant'));

  it('403 wrong_tenant: shared pool, same issuer, other tenant', async () => {
    assert.equal(acmeShared.issuer, globexShared.issuer);
    await rejects(`Bearer ${accessToken(acmeShared)}`, 'globex-shared', 403, 'wrong_tenant');
  });

  it('403 tenant_client_mismatch: shared pool, Acme client claiming Globex', async () => {
    const t = accessToken(acmeShared, { claims: { tenant_id: 'globex-shared' } });
    await rejects(`Bearer ${t}`, 'globex-shared', 403, 'tenant_client_mismatch');
  });

  it('a token minted by a key that is not in the pool JWKS is rejected', async () => {
    const { generateKeyPairSync, sign } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const [h, p] = accessToken(acme).split('.');
    const sig = sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url');
    await rejects(`Bearer ${h}.${p}.${sig}`, 'acme', 401, 'invalid_token');
  });
});
