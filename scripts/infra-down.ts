/**
 * Removes what infra-up created: trigger Lambdas, their log groups, the execution role and the
 * registry table. Run `npm run teardown` first so no user pool still points at the triggers.
 *
 *   npm run infra:down
 */
import { CloudWatchLogsClient, DeleteLogGroupCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteRoleCommand, DeleteRolePolicyCommand, IAMClient } from '@aws-sdk/client-iam';
import { DeleteFunctionCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { rmSync } from 'node:fs';
import { assertAwsAccount, config, listTenants } from './lib/common';

const region = config.region;
const p = config.resourcePrefix;

await assertAwsAccount();
const left = await listTenants().catch(() => []);
if (left.length) {
  console.error(`✖ ${left.length} tenant(s) still registered (${left.map((t) => t.tenantId).join(', ')}). Run: npm run teardown`);
  process.exit(1);
}

const quiet = (what: string) => (e: unknown) => console.log(`  • ${what}: ${(e as Error).name}`);
const lambda = new LambdaClient({ region });
const logs = new CloudWatchLogsClient({ region });
for (const f of ['pre-token', 'pre-auth']) {
  await lambda.send(new DeleteFunctionCommand({ FunctionName: `${p}-${f}` })).then(() => console.log(`  • deleted Lambda ${p}-${f}`), quiet(`Lambda ${p}-${f}`));
  await logs.send(new DeleteLogGroupCommand({ logGroupName: `/aws/lambda/${p}-${f}` })).then(() => console.log(`  • deleted log group ${p}-${f}`), quiet(`log group ${p}-${f}`));
}
const iam = new IAMClient({ region });
await iam.send(new DeleteRolePolicyCommand({ RoleName: `${p}-trigger-role`, PolicyName: 'least-privilege' })).catch(quiet('role policy'));
await iam.send(new DeleteRoleCommand({ RoleName: `${p}-trigger-role` })).then(() => console.log(`  • deleted role ${p}-trigger-role`), quiet('role'));
await new DynamoDBClient({ region }).send(new DeleteTableCommand({ TableName: `${p}-tenants` })).then(() => console.log(`  • deleted table ${p}-tenants`), quiet('table'));
rmSync('.poc/outputs.json', { force: true });
console.log('\n✔ AWS resources removed');
