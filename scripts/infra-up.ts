/**
 * Creates the AWS pieces besides Cognito, without CloudFormation (idempotent — safe to re-run):
 *   • DynamoDB table  <prefix>-tenants   — tenant registry, provisioned 1 RCU / 1 WCU (always-free tier)
 *   • CloudWatch log groups for the triggers, 1-day retention
 *   • IAM role        <prefix>-trigger-role — read registry rows + write its own logs, nothing else
 *   • Lambda          <prefix>-pre-token, <prefix>-pre-auth (Node 22, arm64), invokable by Cognito in this account
 * Then writes .poc/outputs.json, which onboarding and the local API read.
 * The app and API run locally: AppUrl http://localhost:5173, ApiUrl http://localhost:8787.
 *
 *   npm run infra:up
 */
import { CloudWatchLogsClient, CreateLogGroupCommand, PutRetentionPolicyCommand } from '@aws-sdk/client-cloudwatch-logs';
import { CreateTableCommand, DescribeTableCommand, DynamoDBClient, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { CreateRoleCommand, GetRoleCommand, IAMClient, PutRolePolicyCommand } from '@aws-sdk/client-iam';
import {
  AddPermissionCommand,
  CreateFunctionCommand,
  GetFunctionCommand,
  LambdaClient,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  waitUntilFunctionActiveV2,
  waitUntilFunctionUpdatedV2,
} from '@aws-sdk/client-lambda';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { assertAwsAccount, config, sleep, writeJson } from './lib/common';

const region = config.region;
const p = config.resourcePrefix;
const TABLE = `${p}-tenants`;
const ROLE = `${p}-trigger-role`;
const FUNCTIONS = ['pre-token', 'pre-auth'] as const;
const tags = { poc: p };

const dynamo = new DynamoDBClient({ region });
const iam = new IAMClient({ region });
const lambda = new LambdaClient({ region });
const logs = new CloudWatchLogsClient({ region });

const ignore = (...names: string[]) => (e: unknown) => {
  if (!names.includes((e as Error).name)) throw e;
};

const account = await assertAwsAccount();
console.log(`▶ Account ${account}, region ${region}\n`);

// ---------- Registry table ----------
process.stdout.write(`  • DynamoDB table ${TABLE} … `);
await dynamo
  .send(
    new CreateTableCommand({
      TableName: TABLE,
      AttributeDefinitions: [{ AttributeName: 'tenantId', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'tenantId', KeyType: 'HASH' }],
      // Provisioned 1/1 stays inside DynamoDB's always-free 25 RCU / 25 WCU; on-demand has no free requests
      BillingMode: 'PROVISIONED',
      ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
      Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
    }),
  )
  .catch(ignore('ResourceInUseException'));
await waitUntilTableExists({ client: dynamo, maxWaitTime: 120 }, { TableName: TABLE });
const tableArn = (await dynamo.send(new DescribeTableCommand({ TableName: TABLE }))).Table!.TableArn!;
console.log('ready');

// ---------- Log groups (pre-created so retention is 1 day; the role can't create groups) ----------
for (const f of FUNCTIONS) {
  const logGroupName = `/aws/lambda/${p}-${f}`;
  await logs.send(new CreateLogGroupCommand({ logGroupName, tags })).catch(ignore('ResourceAlreadyExistsException'));
  await logs.send(new PutRetentionPolicyCommand({ logGroupName, retentionInDays: 1 }));
}
console.log('  • Log groups: 1-day retention');

// ---------- Execution role ----------
process.stdout.write(`  • IAM role ${ROLE} … `);
let roleArn: string;
try {
  roleArn = (await iam.send(new GetRoleCommand({ RoleName: ROLE }))).Role!.Arn!;
} catch (e) {
  ignore('NoSuchEntityException')(e);
  roleArn = (
    await iam.send(
      new CreateRoleCommand({
        RoleName: ROLE,
        Description: 'Cognito POC trigger Lambdas: read tenant registry, write own logs',
        AssumeRolePolicyDocument: JSON.stringify({
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }],
        }),
        Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
      }),
    )
  ).Role!.Arn!;
}
await iam.send(
  new PutRolePolicyCommand({
    RoleName: ROLE,
    PolicyName: 'least-privilege',
    PolicyDocument: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Sid: 'ReadRegistryRows', Effect: 'Allow', Action: ['dynamodb:GetItem'], Resource: tableArn },
        {
          Sid: 'WriteOwnLogs',
          Effect: 'Allow',
          Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
          Resource: FUNCTIONS.map((f) => `arn:aws:logs:${region}:${account}:log-group:/aws/lambda/${p}-${f}:*`),
        },
      ],
    }),
  }),
);
console.log('ready');

// ---------- Trigger functions ----------
const arns: Record<string, string> = {};
for (const f of FUNCTIONS) {
  const name = `${p}-${f}`;
  process.stdout.write(`  • Lambda ${name} … `);
  const dir = `.poc/build/${f}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await build({
    entryPoints: [`lambda/${f}.ts`],
    outfile: `${dir}/index.js`,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    minify: true,
    logLevel: 'error',
  });
  execFileSync('zip', ['-j', '-q', `${dir}.zip`, `${dir}/index.js`]);
  const ZipFile = readFileSync(`${dir}.zip`);
  rmSync(`${dir}.zip`);
  const env = { Variables: { TENANT_TABLE: TABLE } };

  let exists = true;
  await lambda.send(new GetFunctionCommand({ FunctionName: name })).catch((e) => {
    ignore('ResourceNotFoundException')(e);
    exists = false;
  });
  if (exists) {
    await lambda.send(new UpdateFunctionCodeCommand({ FunctionName: name, ZipFile }));
    await waitUntilFunctionUpdatedV2({ client: lambda, maxWaitTime: 120 }, { FunctionName: name });
    await lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: name, Environment: env, Role: roleArn }));
    await waitUntilFunctionUpdatedV2({ client: lambda, maxWaitTime: 120 }, { FunctionName: name });
  } else {
    // A new role takes a few seconds to become assumable by Lambda; retry until it is
    for (let attempt = 1; ; attempt++) {
      try {
        await lambda.send(
          new CreateFunctionCommand({
            FunctionName: name,
            Runtime: 'nodejs22.x',
            Architectures: ['arm64'],
            Handler: 'index.handler',
            Role: roleArn,
            Code: { ZipFile },
            MemorySize: 256,
            Timeout: 5, // Cognito waits ~5 s for a trigger
            Environment: env,
            Description: `Cognito POC ${f} trigger`,
            Tags: tags,
          }),
        );
        break;
      } catch (e) {
        if ((e as Error).name !== 'InvalidParameterValueException' || attempt >= 10) throw e;
        await sleep(3000);
      }
    }
  }
  await waitUntilFunctionActiveV2({ client: lambda, maxWaitTime: 120 }, { FunctionName: name });
  // One account-scoped permission instead of one per pool (avoids the 20 KB resource-policy limit)
  await lambda
    .send(
      new AddPermissionCommand({
        FunctionName: name,
        StatementId: 'CognitoInvoke',
        Action: 'lambda:InvokeFunction',
        Principal: 'cognito-idp.amazonaws.com',
        SourceAccount: account,
      }),
    )
    .catch(ignore('ResourceConflictException'));
  arns[f] = `arn:aws:lambda:${region}:${account}:function:${name}`;
  console.log('ready');
}

writeJson('.poc/outputs.json', {
  CognitoPocPlatform: {
    AppUrl: config.localDevOrigin,
    ApiUrl: 'http://localhost:8787',
    TenantTable: TABLE,
    PreTokenFnArn: arns['pre-token'],
    PreAuthFnArn: arns['pre-auth'],
    Region: region,
    AccountId: account,
  },
});
console.log('\n✔ Wrote .poc/outputs.json\nNext: npm run onboard:all && npm run seed && npm run api');
