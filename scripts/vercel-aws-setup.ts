/**
 * Lets the API on Vercel read the tenant registry without any AWS keys stored on Vercel.
 * Idempotent. Creates in AWS (IAM is free):
 *   • an OIDC identity provider that trusts Vercel's tokens for your Vercel team
 *   • role <prefix>-vercel-api: assumable only by that Vercel project, allowed only to read/write
 *     the registry table
 * Prints the role ARN to set as AWS_ROLE_ARN in the Vercel project.
 *
 *   npm run vercel:aws        # uses VERCEL_TEAM_SLUG and VERCEL_PROJECT from .env
 */
import {
  CreateOpenIDConnectProviderCommand,
  CreateRoleCommand,
  GetRoleCommand,
  IAMClient,
  PutRolePolicyCommand,
  UpdateAssumeRolePolicyCommand,
} from '@aws-sdk/client-iam';
import { assertAwsAccount, config, outputs, readJson, writeJson } from './lib/common';

const team = process.env.VERCEL_TEAM_SLUG;
const project = process.env.VERCEL_PROJECT;
if (!team || !project) throw new Error('Set VERCEL_TEAM_SLUG and VERCEL_PROJECT in .env (see .env.example).');

const account = await assertAwsAccount();
const o = outputs();
const iam = new IAMClient({ region: config.region });
const host = `oidc.vercel.com/${team}`;
const audience = `https://vercel.com/${team}`;
const providerArn = `arn:aws:iam::${account}:oidc-provider/${host}`;
const roleName = `${config.resourcePrefix}-vercel-api`;
const tableArn = `arn:aws:dynamodb:${config.region}:${account}:table/${o.TenantTable}`;

await iam
  .send(new CreateOpenIDConnectProviderCommand({ Url: `https://${host}`, ClientIDList: [audience], Tags: [{ Key: 'poc', Value: config.resourcePrefix }] }))
  .then(() => console.log(`  • OIDC provider created: ${host}`))
  .catch((e) => {
    if ((e as Error).name !== 'EntityAlreadyExistsException') throw e;
    console.log(`  • OIDC provider exists: ${host}`);
  });

const trust = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { Federated: providerArn },
      Action: 'sts:AssumeRoleWithWebIdentity',
      Condition: {
        StringEquals: { [`${host}:aud`]: audience },
        // Only this Vercel project (production and preview deployments)
        StringLike: { [`${host}:sub`]: `owner:${team}:project:${project}:environment:*` },
      },
    },
  ],
});

let roleArn: string;
try {
  roleArn = (await iam.send(new GetRoleCommand({ RoleName: roleName }))).Role!.Arn!;
  await iam.send(new UpdateAssumeRolePolicyCommand({ RoleName: roleName, PolicyDocument: trust }));
  console.log(`  • Role exists, trust policy refreshed: ${roleName}`);
} catch (e) {
  if ((e as Error).name !== 'NoSuchEntityException') throw e;
  roleArn = (
    await iam.send(
      new CreateRoleCommand({
        RoleName: roleName,
        Description: `Vercel project ${team}/${project}: tenant registry access for the sample API`,
        AssumeRolePolicyDocument: trust,
        MaxSessionDuration: 3600,
        Tags: [{ Key: 'poc', Value: config.resourcePrefix }],
      }),
    )
  ).Role!.Arn!;
  console.log(`  • Role created: ${roleName}`);
}
await iam.send(
  new PutRolePolicyCommand({
    RoleName: roleName,
    PolicyName: 'registry-only',
    PolicyDocument: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:Scan', 'dynamodb:UpdateItem'], Resource: tableArn }],
    }),
  }),
);

const all = readJson<Record<string, Record<string, string>>>('.poc/outputs.json');
all.CognitoPocPlatform.VercelRoleArn = roleArn;
writeJson('.poc/outputs.json', all);
console.log(`\n✔ Set these in the Vercel project (Production and Preview):`);
console.log(`    AWS_ROLE_ARN   = ${roleArn}`);
console.log(`    APP_AWS_REGION = ${config.region}`);
console.log(`    TENANT_TABLE   = ${o.TenantTable}`);
