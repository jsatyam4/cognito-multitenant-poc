/**
 * Turn on Microsoft (or Google) sign-in for an EXISTING tenant, with no teardown and no deploy.
 *
 *   npm run enable-idp -- --tenant acme --idp microsoft --allow-domain example.com
 *
 * 1. Creates the identity provider in the tenant's user pool (credentials from config/idp.local.json)
 * 2. Adds it to the module's app client (Microsoft → Module 2, Google → Module 3), keeping every
 *    other client setting: UpdateUserPoolClient resets anything not sent, so we send it all back
 * 3. Updates the registry: the module's IdPs, and the email domains allowed to sign in this way
 * The pre-token trigger refuses federated users whose email domain isn't allowed for the tenant.
 */
import {
  CreateIdentityProviderCommand,
  DescribeUserPoolClientCommand,
  UpdateUserPoolClientCommand,
  type UpdateUserPoolClientCommandInput,
} from '@aws-sdk/client-cognito-identity-provider';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { arg, cognito, ddb, getTenant, idpCreds, outputs } from './lib/common';
import { IDP_GOOGLE, IDP_MICROSOFT } from './lib/provision';
import type { ModuleId } from '../shared/types';

const tenantId = arg('tenant');
const which = (arg('idp', 'microsoft') ?? 'microsoft').toLowerCase();
const allowDomain = arg('allow-domain')?.toLowerCase();
if (!tenantId || !['microsoft', 'google'].includes(which)) {
  console.error('Usage: npm run enable-idp -- --tenant <id> --idp microsoft|google [--allow-domain example.com]');
  process.exit(1);
}

const t = await getTenant(tenantId);
if (!t) throw new Error(`Unknown tenant ${tenantId}`);
const creds = idpCreds();
const module: ModuleId = which === 'microsoft' ? 'module2' : 'module3';
const providerName = which === 'microsoft' ? IDP_MICROSOFT : IDP_GOOGLE;
console.log(`▶ Enabling ${providerName} for ${t.displayName} (${t.tenantId}), ${module}`);

// 1. Identity provider in the pool
if (which === 'microsoft') {
  const m = creds.microsoft;
  if (!m) throw new Error('config/idp.local.json has no valid "microsoft" block (clientId, clientSecret, entraTenantId)');
  await cognito
    .send(
      new CreateIdentityProviderCommand({
        UserPoolId: t.userPoolId,
        ProviderName: IDP_MICROSOFT,
        ProviderType: 'OIDC',
        ProviderDetails: {
          client_id: m.clientId,
          client_secret: m.clientSecret,
          attributes_request_method: 'GET',
          oidc_issuer: `https://login.microsoftonline.com/${m.entraTenantId}/v2.0`,
          authorize_scopes: 'openid email profile',
        },
        // Entra's `email` claim is optional; preferred_username (UPN) is always present for work accounts
        AttributeMapping: { email: 'preferred_username', name: 'name', username: 'sub' },
      }),
    )
    .then(() => console.log('  • Identity provider "Microsoft" created'))
    .catch((e) => {
      if ((e as Error).name !== 'DuplicateProviderException') throw e;
      console.log('  • Identity provider "Microsoft" already exists');
    });
} else {
  const g = creds.google;
  if (!g) throw new Error('config/idp.local.json has no valid "google" block');
  await cognito
    .send(
      new CreateIdentityProviderCommand({
        UserPoolId: t.userPoolId,
        ProviderName: IDP_GOOGLE,
        ProviderType: 'Google',
        ProviderDetails: { client_id: g.clientId, client_secret: g.clientSecret, authorize_scopes: 'openid email profile' },
        AttributeMapping: { email: 'email', name: 'name', username: 'sub' },
      }),
    )
    .then(() => console.log('  • Identity provider "Google" created'))
    .catch((e) => {
      if ((e as Error).name !== 'DuplicateProviderException') throw e;
      console.log('  • Identity provider "Google" already exists');
    });
}

// 2. App client: same settings, plus the provider (Module 2 keeps password sign-in; Module 3 is Google only)
const client = t.modules[module];
const c = (await cognito.send(new DescribeUserPoolClientCommand({ UserPoolId: t.userPoolId, ClientId: client.clientId }))).UserPoolClient!;
const idps = which === 'microsoft' ? ['COGNITO', IDP_MICROSOFT] : [IDP_GOOGLE];
const update: UpdateUserPoolClientCommandInput = {
  UserPoolId: c.UserPoolId,
  ClientId: c.ClientId,
  ClientName: c.ClientName,
  RefreshTokenValidity: c.RefreshTokenValidity,
  AccessTokenValidity: c.AccessTokenValidity,
  IdTokenValidity: c.IdTokenValidity,
  TokenValidityUnits: c.TokenValidityUnits,
  ReadAttributes: c.ReadAttributes,
  WriteAttributes: c.WriteAttributes,
  ExplicitAuthFlows: c.ExplicitAuthFlows,
  SupportedIdentityProviders: idps,
  CallbackURLs: c.CallbackURLs,
  LogoutURLs: c.LogoutURLs,
  DefaultRedirectURI: c.DefaultRedirectURI,
  AllowedOAuthFlows: c.AllowedOAuthFlows,
  AllowedOAuthScopes: c.AllowedOAuthScopes,
  AllowedOAuthFlowsUserPoolClient: c.AllowedOAuthFlowsUserPoolClient,
  AnalyticsConfiguration: c.AnalyticsConfiguration,
  PreventUserExistenceErrors: c.PreventUserExistenceErrors,
  EnableTokenRevocation: c.EnableTokenRevocation,
  EnablePropagateAdditionalUserContextData: c.EnablePropagateAdditionalUserContextData,
  AuthSessionValidity: c.AuthSessionValidity,
  RefreshTokenRotation: c.RefreshTokenRotation,
};
await cognito.send(new UpdateUserPoolClientCommand(update));
console.log(`  • ${module} app client now offers: ${idps.join(' + ')}`);

// 3. Registry: module IdPs, cleared "credentials pending" flag, allowed email domains
const domains = [...new Set([...(t.allowedEmailDomains ?? []), ...(allowDomain ? [allowDomain] : [])])];
await ddb.send(
  new UpdateCommand({
    TableName: outputs().TenantTable,
    Key: { tenantId: t.tenantId },
    UpdateExpression: 'SET modules.#m.idps = :i, modules.#m.missing = :none, allowedEmailDomains = :d',
    ExpressionAttributeNames: { '#m': module },
    ExpressionAttributeValues: { ':i': idps, ':none': [], ':d': domains },
  }),
);
console.log(`  • Registry updated; federated sign-in allowed for: ${domains.join(', ') || '(none — every federated user will be refused)'}`);
console.log(`\n✔ Done. The triggers and API pick this up within 30 s.`);
console.log(`  Redirect URI that must be registered in the IdP app: ${t.loginDomain}/oauth2/idpresponse`);
