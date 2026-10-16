import type { PreTokenGenerationV2TriggerEvent } from 'aws-lambda';
import { tenantByClientId } from './registry';

/**
 * Pre Token Generation V2 trigger, shared by every user pool in the POC.
 * Adds tenant_id / role / module claims to BOTH the ID token and the access token
 * (access-token customisation requires the Essentials or Plus feature plan).
 *
 * Tenant is resolved from the app client the user signed in through, so the same
 * function works for pool-per-tenant and shared-pool tenants.
 */
export const handler = async (event: PreTokenGenerationV2TriggerEvent) => {
  const clientId = event.callerContext.clientId;
  const hit = await tenantByClientId(clientId);
  if (!hit || hit.tenant.userPoolId !== event.userPoolId) {
    throw new Error('This app client is not registered to any tenant.');
  }
  const { tenant, module } = hit;
  const attrs = event.request.userAttributes ?? {};
  const userTenant = attrs['custom:tenant_id'];
  const federated = Boolean(attrs['identities']);

  if (tenant.model === 'shared') {
    // Shared pool: the user record carries its tenant. Block sign-in through another tenant's client.
    if (userTenant && userTenant !== tenant.tenantId) {
      throw new Error(`This account does not belong to ${tenant.displayName}.`);
    }
    if (!userTenant && !federated) {
      throw new Error('Account has no tenant assigned.');
    }
  }

  if (federated) {
    // Microsoft/Google users are created by Cognito at first sign-in, so nothing tied them to a tenant.
    // Only email domains the tenant allows may enter; none configured = federated sign-in refused.
    const allowed = (tenant.allowedEmailDomains ?? []).map((d) => d.toLowerCase());
    const domain = String(attrs.email ?? '').toLowerCase().split('@')[1] ?? '';
    if (!allowed.includes('*') && !allowed.includes(domain)) {
      throw new Error(`Sign-in with this account is not allowed for ${tenant.displayName}.`);
    }
  }

  const groups = event.request.groupConfiguration?.groupsToOverride ?? [];
  const role = groups.includes('admin') ? 'admin' : 'user';

  const claims: Record<string, string> = {
    tenant_id: tenant.tenantId,
    tenant_model: tenant.model,
    role,
    module,
  };

  event.response = {
    claimsAndScopeOverrideDetails: {
      idTokenGeneration: { claimsToAddOrOverride: claims },
      accessTokenGeneration: { claimsToAddOrOverride: claims },
    },
  };
  return event;
};
