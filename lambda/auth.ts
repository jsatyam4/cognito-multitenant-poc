import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { tenantByClientId, tenantsByIssuer } from './registry';

export interface AuthContext {
  sub: string;
  username: string;
  tenantId: string;
  role: string;
  module: string;
  clientId: string;
  issuer: string;
  claims: Record<string, unknown>;
}

export class AuthError extends Error {
  constructor(
    public status: 401 | 403,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type Verifier = ReturnType<typeof CognitoJwtVerifier.create>;
const verifiers = new Map<string, Verifier>();

function verifierFor(userPoolId: string, clientIds: string[]): Verifier {
  const key = `${userPoolId}|${[...clientIds].sort().join(',')}`;
  let v = verifiers.get(key);
  if (!v) {
    v = CognitoJwtVerifier.create({ userPoolId, tokenUse: 'access', clientId: clientIds });
    verifiers.set(key, v);
  }
  return v;
}

function unsafeDecode(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError(401, 'malformed_token', 'Token is not a JWT');
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new AuthError(401, 'malformed_token', 'Token payload is not JSON');
  }
}

/**
 * Validates a Cognito ACCESS token and enforces tenant isolation.
 *
 * Why not the API Gateway HTTP API native JWT authorizer? It accepts one issuer per
 * authorizer. With pool-per-tenant every tenant is a new issuer, so each new tenant
 * would need an infrastructure deploy — which breaks the "no deploy" requirement.
 * Instead the trusted issuer list comes from the tenant registry at runtime.
 */
export async function authenticate(authHeader: string | undefined, pathTenantId: string): Promise<AuthContext> {
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AuthError(401, 'missing_token', 'Authorization: Bearer <access token> header required');
  }
  const token = authHeader.slice(7).trim();
  const unverified = unsafeDecode(token);
  const iss = String(unverified.iss ?? '');

  // 1. Issuer must be one of OUR user pools (from registry, not hard-coded)
  const poolTenants = await tenantsByIssuer(iss);
  if (poolTenants.length === 0) {
    throw new AuthError(401, 'unknown_issuer', `Issuer ${iss || '(none)'} is not a registered tenant pool`);
  }
  const userPoolId = poolTenants[0].userPoolId;
  const clientIds = poolTenants.flatMap((t) => Object.values(t.modules).map((m) => m.clientId));

  // 2. Cryptographic verification: signature (JWKS), exp, iss, token_use=access, client_id
  let payload: Record<string, unknown>;
  try {
    payload = (await verifierFor(userPoolId, clientIds).verify(token)) as unknown as Record<string, unknown>;
  } catch (e) {
    throw new AuthError(401, 'invalid_token', `JWT verification failed: ${(e as Error).message}`);
  }

  // 3. Tenant binding: claim, owning app client and requested tenant must all agree
  const tokenTenant = String(payload.tenant_id ?? '');
  const owner = await tenantByClientId(String(payload.client_id));
  if (!tokenTenant) throw new AuthError(403, 'no_tenant_claim', 'Token has no tenant_id claim');
  if (!owner || owner.tenant.tenantId !== tokenTenant) {
    throw new AuthError(403, 'tenant_client_mismatch', 'tenant_id claim does not match the app client that issued it');
  }
  if (tokenTenant !== pathTenantId) {
    throw new AuthError(
      403,
      'wrong_tenant',
      `Token belongs to tenant "${tokenTenant}" but the request is for tenant "${pathTenantId}"`,
    );
  }

  return {
    sub: String(payload.sub),
    username: String(payload.username ?? payload.sub),
    tenantId: tokenTenant,
    role: String(payload.role ?? 'user'),
    module: String(payload.module ?? ''),
    clientId: String(payload.client_id),
    issuer: iss,
    claims: payload,
  };
}
