/**
 * Requirement 8 — create a new tenant with branding by script. No code deploy.
 *
 *   npm run onboard -- --tenant acme                  # B: pool per tenant, Cognito hosted login page
 *   npm run onboard -- --tenant acme --model shared   # A: tenant inside the shared pool
 *   npm run onboard -- --tenant umbrella              # C: tenants/umbrella.json says loginMode "own"
 *
 * Reads tenants/<slug>.json, provisions Cognito (+ branding for hosted pages), registers the
 * tenant in the registry, and writes a timed step log to .poc/onboarding/<tenantId>.json.
 * If any step fails, everything created so far is rolled back, so a re-run starts clean.
 */
import {
  DeleteManagedLoginBrandingCommand,
  DeleteUserPoolClientCommand,
  DeleteUserPoolCommand,
  DeleteUserPoolDomainCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { applyBranding, faviconSvg, logoSvg } from './lib/branding';
import {
  arg,
  assertAwsAccount,
  cognito,
  config,
  domainPrefix,
  getTenant,
  issuerFor,
  listTenants,
  loadTenantFile,
  loginDomainUrl,
  outputs,
  StepTimer,
  tenantIdFor,
  writeJson,
} from './lib/common';
import { createDomain, createGroups, createIdps, createModuleClient, createPool, findPoolByName, ROLE_GROUPS, tenantGroup } from './lib/provision';
import { putTenant } from './lib/registry';
import { MODULES, type LoginMode, type ModuleId, type TenantModel, type TenantModuleClient, type TenantRecord } from '../shared/types';

export async function onboard(slug: string, model: TenantModel): Promise<TenantRecord> {
  await assertAwsAccount();
  const o = outputs();
  const def = loadTenantFile(slug);
  const loginMode: LoginMode = def.loginMode ?? 'hosted';
  const tenantId = tenantIdFor(slug, model);
  if (loginMode === 'own' && model === 'shared') throw new Error('Own-login-page tenants use their own pool (scenario C); --model shared is not supported.');
  if (await getTenant(tenantId)) {
    throw new Error(`Tenant "${tenantId}" already exists. Run: npm run offboard -- --tenant ${tenantId}`);
  }
  const existing = await listTenants();
  if (existing.length >= config.limits.maxTenants) {
    throw new Error(`Free-tier guardrail: ${existing.length} tenants already (limit ${config.limits.maxTenants} in config/poc.config.json).`);
  }

  const scenario = model === 'shared' ? 'A · shared pool' : loginMode === 'own' ? 'C · own pool, own login page' : 'B · own pool, hosted login page';
  console.log(`\n▶ Onboarding ${def.displayName} as "${tenantId}" (${scenario})`);
  const t = new StepTimer();
  const tags = { poc: config.resourcePrefix, tenant: tenantId, model };

  // Everything created in this run, so a failure can undo it (newest first)
  const undo: Array<{ what: string; run: () => Promise<unknown> }> = [];

  try {
    let userPoolId: string;
    let loginDomain: string;
    let idps: string[];

    if (model === 'pool') {
      userPoolId = await t.step('Create user pool (Essentials tier, TOTP optional, pre-token trigger)', () =>
        createPool(`${config.resourcePrefix}-${tenantId}`, 'pool', tags), (id) => id);
      undo.push({ what: `user pool ${userPoolId}`, run: () => cognito.send(new DeleteUserPoolCommand({ UserPoolId: userPoolId })) });
      const prefix = domainPrefix(slug, o.AccountId);
      loginDomain = await t.step('Create managed-login domain', () => createDomain(userPoolId, prefix), (d) => d);
      undo.push({ what: `domain ${prefix}`, run: () => cognito.send(new DeleteUserPoolDomainCommand({ UserPoolId: userPoolId, Domain: prefix })) });
      await t.step('Create groups (admin, user, tenant)', () => createGroups(userPoolId, [...ROLE_GROUPS, tenantGroup(tenantId)]));
      idps = await t.step('Create federated IdPs', () => createIdps(userPoolId), (x) => (x.length ? x.join(', ') : 'none configured'));
    } else {
      // One shared pool for every "shared" tenant; created on first use (and kept on rollback if it already existed).
      const poolName = `${config.resourcePrefix}-shared-pool`;
      const prefix = domainPrefix('shared', o.AccountId);
      const found = await findPoolByName(poolName);
      if (found) {
        userPoolId = found;
        loginDomain = loginDomainUrl(prefix);
        console.log(`  • Reusing shared pool ${userPoolId}`);
      } else {
        userPoolId = await t.step('Create SHARED user pool (custom:tenant_id, pre-auth + pre-token triggers)', () =>
          createPool(poolName, 'shared', { poc: config.resourcePrefix, model: 'shared' }), (id) => id);
        undo.push({ what: `shared pool ${userPoolId}`, run: () => cognito.send(new DeleteUserPoolCommand({ UserPoolId: userPoolId })) });
        loginDomain = await t.step('Create shared managed-login domain', () => createDomain(userPoolId, prefix), (d) => d);
        undo.push({ what: `domain ${prefix}`, run: () => cognito.send(new DeleteUserPoolDomainCommand({ UserPoolId: userPoolId, Domain: prefix })) });
      }
      await t.step('Create groups (admin, user, tenant)', () => createGroups(userPoolId, [...ROLE_GROUPS, tenantGroup(tenantId)]));
      idps = await t.step('Ensure federated IdPs', () => createIdps(userPoolId), (x) => (x.length ? x.join(', ') : 'none configured'));
    }

    const modules = {} as Record<ModuleId, TenantModuleClient>;
    for (const m of MODULES) {
      modules[m.id] = await t.step(`Create app client for ${m.name}`, () =>
        createModuleClient(userPoolId, tenantId, m.id, model, idps),
        (c) => `${c.clientId} [${c.idps.join('+')}]${c.missing?.length ? ` missing: ${c.missing.join(',')}` : ''}`);
      const clientId = modules[m.id].clientId;
      undo.push({ what: `app client ${clientId}`, run: () => cognito.send(new DeleteUserPoolClientCommand({ UserPoolId: userPoolId, ClientId: clientId })) });
    }

    if (loginMode === 'hosted') {
      for (const m of MODULES) {
        const r = await t.step(`Apply managed-login branding to ${m.id}`, () =>
          applyBranding(userPoolId, modules[m.id].clientId, def.appName, def.branding),
          (b) => `${b.mode}${b.error ? ` — ${b.error}` : ''}`);
        modules[m.id].brandingId = r.brandingId;
        undo.push({ what: `branding ${r.brandingId}`, run: () => cognito.send(new DeleteManagedLoginBrandingCommand({ UserPoolId: userPoolId, ManagedLoginBrandingId: r.brandingId })) });
      }
    } else {
      console.log('  • No managed-login branding: this tenant signs in on our own login page (theme from the registry)');
    }

    const record: TenantRecord = {
      tenantId,
      slug,
      displayName: def.displayName,
      appName: def.appName,
      tagline: def.tagline,
      model,
      loginMode,
      region: config.region,
      userPoolId,
      issuer: issuerFor(userPoolId),
      loginDomain,
      modules,
      branding: {
        ...def.branding,
        logoSvg: logoSvg(def.appName, def.branding),
        faviconSvg: faviconSvg(def.appName, def.branding),
      },
      ...(def.theme ? { theme: def.theme } : {}),
      allowedEmailDomains: def.allowedEmailDomains ?? [],
      status: 'active',
      createdAt: new Date().toISOString(),
    };
    await t.step('Register tenant in the registry (app, API and triggers pick it up, no deploy)', () => putTenant(record));
    record.onboardingSeconds = t.totalSeconds;
    await putTenant(record);

    writeJson(`.poc/onboarding/${tenantId}.json`, {
      tenantId,
      model,
      loginMode,
      scenario,
      totalSeconds: record.onboardingSeconds,
      steps: t.steps,
      at: record.createdAt,
    });

    mkdirSync('.poc', { recursive: true });
    const uriFile = '.poc/idp-redirect-uris.txt';
    const uri = `${loginDomain}/oauth2/idpresponse`;
    if (!(existsSync(uriFile) && readFileSync(uriFile, 'utf8').includes(uri))) appendFileSync(uriFile, `${uri}\n`);

    console.log(`\n✔ ${tenantId} ready in ${record.onboardingSeconds}s`);
    console.log(`  App:    ${o.AppUrl}/t/${tenantId}`);
    console.log(`  Login:  ${loginMode === 'own' ? `${o.AppUrl}/t/${tenantId}/login (our page)` : `${loginDomain}  (pool ${userPoolId})`}`);
    if (idps.length) {
      console.log(`  ⚠ Add this redirect URI to your Entra / Google app registrations if not already there:`);
      console.log(`    ${uri}`);
    }
    return record;
  } catch (e) {
    console.error(`\n✖ ${(e as Error).name}: ${(e as Error).message}\n  Rolling back ${undo.length} created resource(s)…`);
    for (const u of undo.reverse()) {
      try {
        await u.run();
        console.error(`    removed ${u.what}`);
      } catch (err) {
        console.error(`    could not remove ${u.what}: ${(err as Error).message}`);
      }
    }
    throw e;
  }
}

const isMain = process.argv[1]?.includes('onboard.ts');
if (isMain) {
  const slug = arg('tenant');
  const model = (arg('model', 'pool') as TenantModel) ?? 'pool';
  if (!slug || !['pool', 'shared'].includes(model)) {
    console.error('Usage: npm run onboard -- --tenant <slug> [--model pool|shared]');
    process.exit(1);
  }
  onboard(slug, model).catch(() => process.exit(1));
}
