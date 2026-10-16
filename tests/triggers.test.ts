/** R1 / R6 — lambda/pre-token.ts and lambda/pre-auth.ts, offline. */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { PreAuthenticationTriggerEvent, PreTokenGenerationV2TriggerEvent } from 'aws-lambda';
import { byId, installMocks } from './fixtures';
import type { ModuleId, TenantRecord } from '../shared/types';

installMocks();
const preToken = (await import('../lambda/pre-token')).handler;
const preAuth = (await import('../lambda/pre-auth')).handler;

function tokenEvent(t: TenantRecord, opts: { module?: ModuleId; groups?: string[]; attrs?: Record<string, string>; poolId?: string } = {}) {
  return {
    userPoolId: opts.poolId ?? t.userPoolId,
    callerContext: { clientId: t.modules[opts.module ?? 'module1'].clientId },
    request: { userAttributes: opts.attrs ?? {}, groupConfiguration: { groupsToOverride: opts.groups ?? [] } },
    response: {},
  } as unknown as PreTokenGenerationV2TriggerEvent;
}

const authEvent = (t: TenantRecord, userTenant?: string) =>
  ({
    callerContext: { clientId: t.modules.module1.clientId },
    request: { userAttributes: userTenant ? { 'custom:tenant_id': userTenant } : {} },
  }) as unknown as PreAuthenticationTriggerEvent;

describe('pre-token V2 trigger', () => {
  it('stamps tenant_id, tenant_model, role and module into BOTH tokens', async () => {
    const out = await preToken(tokenEvent(byId('acme'), { module: 'module2', groups: ['admin'] }));
    const d = out.response.claimsAndScopeOverrideDetails!;
    const expected = { tenant_id: 'acme', tenant_model: 'pool', role: 'admin', module: 'module2' };
    assert.deepEqual(d.idTokenGeneration!.claimsToAddOrOverride, expected);
    assert.deepEqual(d.accessTokenGeneration!.claimsToAddOrOverride, expected);
  });

  it('role defaults to user without the admin group', async () => {
    const out = await preToken(tokenEvent(byId('globex'), { groups: ['user'] }));
    assert.equal(out.response.claimsAndScopeOverrideDetails!.accessTokenGeneration!.claimsToAddOrOverride!.role, 'user');
  });

  it('rejects a client that is not registered to any tenant', async () => {
    const ev = tokenEvent(byId('acme'));
    (ev.callerContext as any).clientId = 'unknownclientxxxxxxxxxxxxx';
    await assert.rejects(preToken(ev), /not registered/);
  });

  it('rejects a registered client presented by a different pool', async () => {
    await assert.rejects(preToken(tokenEvent(byId('acme'), { poolId: byId('globex').userPoolId })), /not registered/);
  });

  it('shared pool: blocks a user whose custom:tenant_id belongs to another tenant', async () => {
    const ev = tokenEvent(byId('globex-shared'), { attrs: { 'custom:tenant_id': 'acme-shared' } });
    await assert.rejects(preToken(ev), /does not belong/);
  });

  it('shared pool: blocks a password user with no tenant assigned', async () => {
    await assert.rejects(preToken(tokenEvent(byId('acme-shared'))), /no tenant/);
  });

  it('shared pool: allows the own-tenant user', async () => {
    const out = await preToken(tokenEvent(byId('acme-shared'), { attrs: { 'custom:tenant_id': 'acme-shared' } }));
    assert.equal(out.response.claimsAndScopeOverrideDetails!.idTokenGeneration!.claimsToAddOrOverride!.tenant_id, 'acme-shared');
  });

  const fed = (email: string) => ({ identities: '[{"providerName":"Microsoft"}]', email });

  it('federated user from an allowed email domain gets the tenant claim', async () => {
    const out = await preToken(tokenEvent(byId('acme'), { module: 'module2', attrs: fed('ana@acme.com') }));
    const c = out.response.claimsAndScopeOverrideDetails!.accessTokenGeneration!.claimsToAddOrOverride!;
    assert.equal(c.tenant_id, 'acme');
    assert.equal(c.role, 'user');
  });

  it('federated user from another company is refused (pool model)', async () => {
    await assert.rejects(preToken(tokenEvent(byId('acme'), { module: 'module2', attrs: fed('bob@globex.com') })), /not allowed/);
  });

  it('federated user from another company is refused (shared pool)', async () => {
    await assert.rejects(preToken(tokenEvent(byId('globex-shared'), { attrs: fed('ana@acme.com') })), /not allowed/);
  });

  it('federated sign-in is refused when the tenant lists no allowed domains', async () => {
    assert.deepEqual(byId('initech').allowedEmailDomains, []);
    await assert.rejects(preToken(tokenEvent(byId('initech'), { attrs: fed('ana@initech.com') })), /not allowed/);
  });
});

describe('pre-auth trigger (shared pool)', () => {
  it('lets the own-tenant user through', async () => {
    const ev = authEvent(byId('acme-shared'), 'acme-shared');
    assert.equal(await preAuth(ev), ev);
  });

  it('rejects another tenant with the same message as a bad password', async () => {
    await assert.rejects(preAuth(authEvent(byId('globex-shared'), 'acme-shared')), { message: 'Incorrect username or password.' });
  });

  it('rejects an unregistered client', async () => {
    const ev = authEvent(byId('acme-shared'), 'acme-shared');
    (ev.callerContext as any).clientId = 'unknownclientxxxxxxxxxxxxx';
    await assert.rejects(preAuth(ev), /not registered/);
  });
});
