import type { PreAuthenticationTriggerEvent } from 'aws-lambda';
import { tenantByClientId } from './registry';

/**
 * Pre Authentication trigger — attached ONLY to the shared pool.
 * Rejects a username/password sign-in when the user's custom:tenant_id does not
 * match the tenant that owns the app client (i.e. Acme user on Globex's login page).
 * Note: Cognito does not invoke this trigger for federated (Entra/Google) sign-ins;
 * the pre-token trigger covers those.
 */
export const handler = async (event: PreAuthenticationTriggerEvent) => {
  const hit = await tenantByClientId(event.callerContext.clientId);
  if (!hit) throw new Error('This app client is not registered to any tenant.');
  const userTenant = event.request.userAttributes['custom:tenant_id'];
  if (userTenant !== hit.tenant.tenantId) {
    // Same generic message as a bad password, so tenants can't probe each other's users.
    throw new Error('Incorrect username or password.');
  }
  return event;
};
