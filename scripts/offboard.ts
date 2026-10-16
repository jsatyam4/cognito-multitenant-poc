/**
 *   npm run offboard -- --tenant acme
 * pool model: deletes the domain + whole user pool. shared model: deletes the tenant's
 * app clients (+ branding) and its seeded users, leaving the shared pool in place.
 */
import {
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  DeleteGroupCommand,
  DeleteUserPoolClientCommand,
  DeleteUserPoolCommand,
  DeleteUserPoolDomainCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { arg, assertAwsAccount, cognito, demoEmail, getTenant } from './lib/common';
import { removeTenant } from './lib/registry';

export async function offboard(tenantId: string) {
  await assertAwsAccount();
  const t = await getTenant(tenantId);
  if (!t) {
    console.log(`• ${tenantId} not found`);
    return;
  }
  if (t.model === 'pool') {
    const prefix = new URL(t.loginDomain).hostname.split('.')[0];
    try {
      await cognito.send(new DeleteUserPoolDomainCommand({ UserPoolId: t.userPoolId, Domain: prefix }));
    } catch (e) {
      console.warn(`  domain: ${(e as Error).message}`);
    }
    await cognito.send(new DeleteUserPoolCommand({ UserPoolId: t.userPoolId }));
  } else {
    for (const c of Object.values(t.modules)) {
      await cognito.send(new DeleteUserPoolClientCommand({ UserPoolId: t.userPoolId, ClientId: c.clientId }));
    }
    for (const email of [demoEmail(t.slug, 'admin'), demoEmail(t.slug, 'user'), demoEmail('shared', 'jane')]) {
      try {
        const u = await cognito.send(new AdminGetUserCommand({ UserPoolId: t.userPoolId, Username: email.toLowerCase() }));
        if (u.UserAttributes?.find((a) => a.Name === 'custom:tenant_id')?.Value === tenantId) {
          await cognito.send(new AdminDeleteUserCommand({ UserPoolId: t.userPoolId, Username: email.toLowerCase() }));
        }
      } catch {
        /* not present */
      }
    }
    try {
      await cognito.send(new DeleteGroupCommand({ UserPoolId: t.userPoolId, GroupName: `tenant_${tenantId}` }));
    } catch {
      /* not present */
    }
  }
  await removeTenant(t);
  console.log(`✔ Offboarded ${tenantId}`);
}

if (process.argv[1]?.includes('offboard.ts')) {
  const id = arg('tenant');
  if (!id) {
    console.error('Usage: npm run offboard -- --tenant <tenantId>');
    process.exit(1);
  }
  await offboard(id);
}
