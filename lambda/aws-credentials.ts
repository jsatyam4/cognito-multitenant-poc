/**
 * AWS credentials for the API when it runs on Vercel, with no AWS keys stored there.
 *
 * Vercel sends each function request a short-lived OIDC token (header `x-vercel-oidc-token`).
 * We exchange it with AWS STS (AssumeRoleWithWebIdentity) for temporary credentials of the role
 * in AWS_ROLE_ARN, which can only read/write the tenant registry table. Credentials are cached
 * until shortly before they expire.
 *
 * Everywhere else (Lambda triggers, local API, scripts) AWS_ROLE_ARN is unset, this returns
 * undefined, and the AWS SDK uses its normal credential chain.
 */
import { AssumeRoleWithWebIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@aws-sdk/types';

let oidcToken: string | undefined;
/** Called by the Vercel entry point with each request's OIDC token. */
export const setOidcToken = (token: string | undefined) => {
  if (token) oidcToken = token;
};

export const awsRegion = () => process.env.APP_AWS_REGION ?? process.env.AWS_REGION;

export function awsCredentials(): AwsCredentialIdentityProvider | undefined {
  const roleArn = process.env.AWS_ROLE_ARN;
  if (!roleArn) return undefined;
  let cached: AwsCredentialIdentity | undefined;
  return async () => {
    if (cached?.expiration && cached.expiration.getTime() - Date.now() > 60_000) return cached;
    if (!oidcToken) throw new Error('No Vercel OIDC token on this request (is OIDC enabled for the project?)');
    const sts = new STSClient({ region: awsRegion() });
    const r = await sts.send(
      new AssumeRoleWithWebIdentityCommand({ RoleArn: roleArn, RoleSessionName: 'vercel-api', WebIdentityToken: oidcToken, DurationSeconds: 3600 }),
    );
    const c = r.Credentials!;
    cached = { accessKeyId: c.AccessKeyId!, secretAccessKey: c.SecretAccessKey!, sessionToken: c.SessionToken, expiration: c.Expiration };
    return cached;
  };
}
