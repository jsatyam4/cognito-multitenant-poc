import {
  CreateGroupCommand,
  CreateIdentityProviderCommand,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  CreateUserPoolDomainCommand,
  DescribeUserPoolDomainCommand,
  ListUserPoolsCommand,
  SetUserPoolMfaConfigCommand,
  type CreateUserPoolCommandInput,
} from '@aws-sdk/client-cognito-identity-provider';
import { cognito, config, idpCreds, loginDomainUrl, outputs, sleep } from './common';
import type { ModuleId, TenantModel, TenantModuleClient } from '../../shared/types';

export const IDP_MICROSOFT = 'Microsoft';
export const IDP_GOOGLE = 'Google';

export async function findPoolByName(name: string): Promise<string | undefined> {
  let NextToken: string | undefined;
  do {
    const r = await cognito.send(new ListUserPoolsCommand({ MaxResults: 60, NextToken }));
    const hit = r.UserPools?.find((p) => p.Name === name);
    if (hit) return hit.Id;
    NextToken = r.NextToken;
  } while (NextToken);
  return undefined;
}

export async function createPool(name: string, model: TenantModel, tags: Record<string, string>): Promise<string> {
  const o = outputs();
  const input: CreateUserPoolCommandInput = {
    PoolName: name,
    UserPoolTier: 'ESSENTIALS', // managed login branding editor + access-token customisation
    UsernameAttributes: ['email'],
    UsernameConfiguration: { CaseSensitive: false },
    AutoVerifiedAttributes: ['email'],
    AdminCreateUserConfig: { AllowAdminCreateUserOnly: true }, // B2B: tenant admins invite users
    AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'verified_email', Priority: 1 }] },
    Policies: {
      PasswordPolicy: {
        MinimumLength: 10,
        RequireLowercase: true,
        RequireUppercase: true,
        RequireNumbers: true,
        RequireSymbols: true,
        TemporaryPasswordValidityDays: 7,
      },
    },
    DeletionProtection: 'INACTIVE',
    Schema: [
      // "Capturing additional user profile info" — custom attributes (max 50 per pool, can't be removed later)
      { Name: 'department', AttributeDataType: 'String', Mutable: true, StringAttributeConstraints: { MaxLength: '64' } },
      { Name: 'employee_id', AttributeDataType: 'String', Mutable: true, StringAttributeConstraints: { MaxLength: '32' } },
      ...(model === 'shared'
        ? [{ Name: 'tenant_id', AttributeDataType: 'String' as const, Mutable: false, StringAttributeConstraints: { MaxLength: '64' } }]
        : []),
    ],
    LambdaConfig: {
      PreTokenGeneration: o.PreTokenFnArn,
      PreTokenGenerationConfig: { LambdaArn: o.PreTokenFnArn, LambdaVersion: 'V2_0' },
      ...(model === 'shared' ? { PreAuthentication: o.PreAuthFnArn } : {}),
    },
    UserPoolTags: tags,
  };
  const r = await cognito.send(new CreateUserPoolCommand(input));
  const id = r.UserPool!.Id!;
  // TOTP MFA (stretch goal): optional, users enrol from managed login
  await cognito.send(
    new SetUserPoolMfaConfigCommand({
      UserPoolId: id,
      MfaConfiguration: 'OPTIONAL',
      SoftwareTokenMfaConfiguration: { Enabled: true },
    }),
  );
  return id;
}

export async function createDomain(userPoolId: string, prefix: string): Promise<string> {
  await cognito.send(
    new CreateUserPoolDomainCommand({ UserPoolId: userPoolId, Domain: prefix, ManagedLoginVersion: 2 }),
  );
  for (let i = 0; i < 60; i++) {
    const d = await cognito.send(new DescribeUserPoolDomainCommand({ Domain: prefix }));
    if (d.DomainDescription?.Status === 'ACTIVE') break;
    await sleep(2000);
  }
  return loginDomainUrl(prefix);
}

export async function createGroups(userPoolId: string, groups: Array<[string, string, number]>) {
  for (const [GroupName, Description, Precedence] of groups) {
    try {
      await cognito.send(new CreateGroupCommand({ UserPoolId: userPoolId, GroupName, Description, Precedence }));
    } catch (e) {
      if ((e as Error).name !== 'GroupExistsException') throw e;
    }
  }
}

/** Role groups (appear in tokens as cognito:groups) */
export const ROLE_GROUPS: Array<[string, string, number]> = [
  ['admin', 'Tenant administrators', 1],
  ['user', 'Standard users', 10],
];
/** Tenant group: puts the tenant in cognito:groups too, so tenant membership survives even if a trigger is off */
export const tenantGroup = (tenantId: string): [string, string, number] => [`tenant_${tenantId}`, `Members of tenant ${tenantId}`, 100];

/** Returns IdP names that were created in this pool. Missing creds → skipped (reported). */
export async function createIdps(userPoolId: string): Promise<string[]> {
  const creds = idpCreds();
  const made: string[] = [];
  const create = async (fn: () => Promise<unknown>, name: string) => {
    try {
      await fn();
      made.push(name);
    } catch (e) {
      if ((e as Error).name === 'DuplicateProviderException') made.push(name);
      else throw e;
    }
  };
  if (creds.microsoft) {
    const m = creds.microsoft;
    await create(
      () =>
        cognito.send(
          new CreateIdentityProviderCommand({
            UserPoolId: userPoolId,
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
        ),
      IDP_MICROSOFT,
    );
  }
  if (creds.google) {
    const g = creds.google;
    await create(
      () =>
        cognito.send(
          new CreateIdentityProviderCommand({
            UserPoolId: userPoolId,
            ProviderName: IDP_GOOGLE,
            ProviderType: 'Google',
            ProviderDetails: { client_id: g.clientId, client_secret: g.clientSecret, authorize_scopes: 'openid email profile' },
            // Every mapped attribute must be in the app client's WriteAttributes
            AttributeMapping: { email: 'email', name: 'name', username: 'sub' },
          }),
        ),
      IDP_GOOGLE,
    );
  }
  return made;
}

/** Module → which IdPs its app client exposes on its login page. */
function idpsForModule(module: ModuleId, available: string[]): { idps: string[]; missing: string[] } {
  const has = (n: string) => available.includes(n);
  if (module === 'module1') return { idps: ['COGNITO'], missing: [] };
  if (module === 'module2')
    return has(IDP_MICROSOFT) ? { idps: ['COGNITO', IDP_MICROSOFT], missing: [] } : { idps: ['COGNITO'], missing: ['microsoft'] };
  // module3: Google login; fall back to password so the page still works without Google creds
  return has(IDP_GOOGLE) ? { idps: [IDP_GOOGLE], missing: [] } : { idps: ['COGNITO'], missing: ['google'] };
}

export async function createModuleClient(
  userPoolId: string,
  tenantId: string,
  module: ModuleId,
  model: TenantModel,
  availableIdps: string[],
): Promise<TenantModuleClient> {
  const o = outputs();
  const { idps, missing } = idpsForModule(module, availableIdps);
  const origins = [...new Set([o.AppUrl, config.localDevOrigin])];
  const readAttrs = ['email', 'email_verified', 'name', 'custom:department', 'custom:employee_id'];
  if (model === 'shared') readAttrs.push('custom:tenant_id');

  const r = await cognito.send(
    new CreateUserPoolClientCommand({
      UserPoolId: userPoolId,
      ClientName: `${tenantId}-${module}`,
      GenerateSecret: false, // public SPA client → Authorization Code + PKCE
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthFlows: ['code'],
      AllowedOAuthScopes: ['openid', 'email', 'profile'],
      CallbackURLs: origins.map((x) => `${x}/callback`),
      LogoutURLs: origins.map((x) => `${x}/t/${tenantId}`),
      SupportedIdentityProviders: idps,
      // SRP only: the password never travels in plain text. Used by our own login page (scenario C)
      // and the test harness; the hosted login page (A/B) uses the code flow above.
      ExplicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH', 'ALLOW_USER_SRP_AUTH'],
      PreventUserExistenceErrors: 'ENABLED',
      EnableTokenRevocation: true,
      AccessTokenValidity: 60,
      IdTokenValidity: 60,
      RefreshTokenValidity: 1,
      TokenValidityUnits: { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'days' },
      ReadAttributes: readAttrs,
      WriteAttributes: ['email', 'name', 'custom:department'],
    }),
  );
  return { clientId: r.UserPoolClient!.ClientId!, idps, missing };
}
