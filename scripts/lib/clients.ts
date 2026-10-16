/**
 * Safe edits to an existing Cognito app client. UpdateUserPoolClient resets every setting that
 * isn't sent, so we read the client first and send all of it back with only the change applied.
 */
import {
  DescribeUserPoolClientCommand,
  UpdateUserPoolClientCommand,
  type UpdateUserPoolClientCommandInput,
  type UserPoolClientType,
} from '@aws-sdk/client-cognito-identity-provider';
import { cognito } from './common';

export async function updateClient(userPoolId: string, clientId: string, change: (c: UserPoolClientType) => Partial<UpdateUserPoolClientCommandInput>) {
  const c = (await cognito.send(new DescribeUserPoolClientCommand({ UserPoolId: userPoolId, ClientId: clientId }))).UserPoolClient!;
  const input: UpdateUserPoolClientCommandInput = {
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
    SupportedIdentityProviders: c.SupportedIdentityProviders,
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
    ...change(c),
  };
  await cognito.send(new UpdateUserPoolClientCommand(input));
}
