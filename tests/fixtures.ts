/**
 * Offline fixtures: an in-memory tenant registry and locally signed Cognito-style JWTs.
 * Nothing here talks to AWS — DynamoDB is stubbed and the JWKS is cached into
 * aws-jwt-verify, so the real lambda/*.ts code runs unchanged.
 */
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { faviconSvg, logoSvg } from '../scripts/lib/branding';
import { clientKey, poolKey, type ModuleId, type TenantModel, type TenantRecord } from '../shared/types';

export const REGION = 'ap-south-1';
const KID = 'local-test-key';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const JWKS = { keys: [{ ...(publicKey.export({ format: 'jwk' }) as object), kid: KID, alg: 'RS256', use: 'sig' }] };

const issuerFor = (poolId: string) => `https://cognito-idp.${REGION}.amazonaws.com/${poolId}`;

function tenant(slug: string, model: TenantModel, poolId: string, host: string): TenantRecord {
  const def = JSON.parse(readFileSync(`tenants/${slug}.json`, 'utf8'));
  const tenantId = model === 'shared' ? `${slug}-shared` : slug;
  const client = (m: ModuleId) => `${tenantId.replace(/-/g, '')}${m}client`.padEnd(26, 'x');
  return {
    tenantId,
    slug,
    displayName: def.displayName,
    appName: def.appName,
    tagline: def.tagline,
    model,
    loginMode: 'hosted',
    // initech allows no federated sign-in at all (tests the default-deny path)
    allowedEmailDomains: slug === 'initech' ? [] : [`${slug}.com`],
    region: REGION,
    userPoolId: poolId,
    issuer: issuerFor(poolId),
    loginDomain: `https://${host}.auth.${REGION}.amazoncognito.com`,
    modules: {
      module1: { clientId: client('module1'), idps: ['COGNITO'] },
      module2: { clientId: client('module2'), idps: ['COGNITO'], missing: ['microsoft'] },
      module3: { clientId: client('module3'), idps: ['COGNITO'], missing: ['google'] },
    },
    branding: { ...def.branding, logoSvg: logoSvg(def.appName, def.branding), faviconSvg: faviconSvg(def.appName, def.branding) },
    status: 'active',
    createdAt: '2026-10-15T00:00:00.000Z',
    onboardingSeconds: model === 'pool' ? 21.4 : 6.2,
  };
}

const SHARED_POOL = `${REGION}_SharedPool1`;
export const TENANTS: TenantRecord[] = [
  tenant('acme', 'pool', `${REGION}_AcmePool1`, 'cpoc-acme-local'),
  tenant('globex', 'pool', `${REGION}_GlobexPool1`, 'cpoc-globex-local'),
  tenant('initech', 'pool', `${REGION}_InitechPool1`, 'cpoc-initech-local'),
  tenant('acme', 'shared', SHARED_POOL, 'cpoc-shared-local'),
  tenant('globex', 'shared', SHARED_POOL, 'cpoc-shared-local'),
  tenant('initech', 'shared', SHARED_POOL, 'cpoc-shared-local'),
];
export const byId = (id: string) => TENANTS.find((t) => t.tenantId === id)!;

/** The registry table as onboarding writes it: tenant rows + client# and pool# lookup rows. */
export function registryRows(records: TenantRecord[] = TENANTS): Array<Record<string, any>> {
  const rows: Array<Record<string, any>> = structuredClone(records);
  const pools = new Map<string, string[]>();
  for (const t of records) {
    for (const [module, c] of Object.entries(t.modules)) rows.push({ tenantId: clientKey(c.clientId), kind: 'client', ref: t.tenantId, module });
    pools.set(t.userPoolId, [...(pools.get(t.userPoolId) ?? []), t.tenantId]);
  }
  for (const [pool, refs] of pools) rows.push({ tenantId: poolKey(pool), kind: 'pool', refs: new Set(refs) });
  return rows;
}

let installed = false;
/** Stub DynamoDB (Get by key / Scan over registryRows) and pre-load our JWKS into every verifier. */
export function installMocks(records: TenantRecord[] = TENANTS) {
  if (installed) return;
  installed = true;
  const rows = registryRows(records);
  (DynamoDBDocumentClient.prototype as any).send = async (cmd: any) => {
    const name = cmd.constructor.name;
    if (name === 'GetCommand') return { Item: structuredClone(rows.find((r) => r.tenantId === cmd.input.Key.tenantId)) };
    if (name === 'ScanCommand') return { Items: structuredClone(rows) };
    if (name === 'UpdateCommand' && cmd.input.UpdateExpression === 'SET theme = :t, branding = :b') {
      const row = rows.find((r) => r.tenantId === cmd.input.Key.tenantId);
      if (!row) throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
      Object.assign(row, { theme: cmd.input.ExpressionAttributeValues[':t'], branding: cmd.input.ExpressionAttributeValues[':b'] });
      return {};
    }
    throw new Error(`fixtures: unexpected DynamoDB command ${name}`);
  };
  const create = CognitoJwtVerifier.create.bind(CognitoJwtVerifier);
  (CognitoJwtVerifier as any).create = (props: any) => {
    const v = create(props);
    v.cacheJwks(JWKS as any);
    return v;
  };
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** Sign a JWT the way Cognito would (RS256, kid in header). */
export function signJwt(payload: Record<string, unknown>): string {
  const head = b64({ alg: 'RS256', kid: KID, typ: 'JWT' });
  const body = b64(payload);
  const sig = cryptoSign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

/** An access token as the pre-token V2 trigger would leave it. Override any claim. */
export function accessToken(t: TenantRecord, opts: { module?: ModuleId; role?: string; claims?: Record<string, unknown> } = {}) {
  const module = opts.module ?? 'module1';
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    sub: `sub-${t.tenantId}-${opts.role ?? 'user'}`,
    iss: t.issuer,
    client_id: t.modules[module].clientId,
    token_use: 'access',
    scope: 'openid email profile',
    username: `${opts.role ?? 'user'}@${t.slug}.example.com`,
    'cognito:groups': [opts.role ?? 'user'],
    tenant_id: t.tenantId,
    tenant_model: t.model,
    role: opts.role ?? 'user',
    module,
    iat: now,
    exp: now + 3600,
    ...opts.claims,
  });
}

export const idToken = (t: TenantRecord) =>
  accessToken(t, { claims: { token_use: 'id', aud: t.modules.module1.clientId, client_id: undefined } });
