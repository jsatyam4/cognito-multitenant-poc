/** Removes every tenant and the shared pool. Then run `npm run infra:down`. */
import { DeleteUserPoolCommand, DeleteUserPoolDomainCommand } from '@aws-sdk/client-cognito-identity-provider';
import { assertAwsAccount, cognito, config, domainPrefix, listTenants, outputs } from './lib/common';
import { findPoolByName } from './lib/provision';
import { offboard } from './offboard';

await assertAwsAccount();
for (const t of await listTenants()) await offboard(t.tenantId);

const shared = await findPoolByName(`${config.resourcePrefix}-shared-pool`);
if (shared) {
  try {
    await cognito.send(new DeleteUserPoolDomainCommand({ UserPoolId: shared, Domain: domainPrefix('shared', outputs().AccountId) }));
  } catch (e) {
    console.warn(`  shared domain: ${(e as Error).message}`);
  }
  await cognito.send(new DeleteUserPoolCommand({ UserPoolId: shared }));
  console.log('✔ Deleted shared pool');
}
console.log('\nNow run: npm run infra:down   (removes the trigger Lambdas, role and registry table)');
