/**
 * Seeds demo users into every registered tenant:
 *   admin  — group admin
 *   user   — group user
 *   jane   — SAME email in every tenant (requirement 1: "same email can exist in two tenants")
 * Writes .poc/users.json (gitignored) and .poc/seed-results.json for the test harness.
 */
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  type AttributeType,
} from '@aws-sdk/client-cognito-identity-provider';
import { assertAwsAccount, cognito, config, demoEmail, demoPassword, listTenants, writeJson } from './lib/common';
import type { TenantRecord } from '../shared/types';

interface SeedUser {
  key: 'admin' | 'user' | 'jane';
  group: 'admin' | 'user';
  name: (t: TenantRecord) => string;
  email: (t: TenantRecord) => string;
}

const USERS: SeedUser[] = [
  { key: 'admin', group: 'admin', name: (t) => `${t.displayName} Admin`, email: (t) => demoEmail(t.slug, 'admin') },
  { key: 'user', group: 'user', name: (t) => `${t.displayName} User`, email: (t) => demoEmail(t.slug, 'user') },
  // Deliberately identical across tenants
  { key: 'jane', group: 'user', name: () => 'Jane Doe', email: () => demoEmail('shared', 'jane') },
];

type Outcome = 'created' | 'exists' | 'blocked_same_email_other_tenant' | 'error';
const results: Array<{ tenantId: string; model: string; user: string; email: string; outcome: Outcome; detail?: string }> = [];
const creds: Record<string, Array<{ user: string; email: string; password: string; group: string }>> = {};

await assertAwsAccount();
if (USERS.length > config.limits.maxUsersPerTenant) throw new Error('Free-tier guardrail: too many seed users per tenant');
for (const t of await listTenants()) {
  creds[t.tenantId] = [];
  for (const u of USERS) {
    const email = u.email(t).toLowerCase();
    const attrs: AttributeType[] = [
      { Name: 'email', Value: email },
      { Name: 'email_verified', Value: 'true' },
      { Name: 'name', Value: u.name(t) },
      { Name: 'custom:department', Value: u.group === 'admin' ? 'IT' : 'Operations' },
      { Name: 'custom:employee_id', Value: `${t.slug.slice(0, 3).toUpperCase()}-${u.key === 'admin' ? '001' : u.key === 'user' ? '042' : '777'}` },
    ];
    if (t.model === 'shared') attrs.push({ Name: 'custom:tenant_id', Value: t.tenantId });

    let outcome: Outcome = 'created';
    let detail: string | undefined;
    try {
      await cognito.send(
        new AdminCreateUserCommand({ UserPoolId: t.userPoolId, Username: email, UserAttributes: attrs, MessageAction: 'SUPPRESS' }),
      );
    } catch (e) {
      if ((e as Error).name !== 'UsernameExistsException') {
        outcome = 'error';
        detail = (e as Error).message;
      } else {
        outcome = 'exists';
        if (t.model === 'shared') {
          const got = await cognito.send(new AdminGetUserCommand({ UserPoolId: t.userPoolId, Username: email }));
          const owner = got.UserAttributes?.find((a) => a.Name === 'custom:tenant_id')?.Value;
          if (owner !== t.tenantId) {
            outcome = 'blocked_same_email_other_tenant';
            detail = `email already registered to tenant "${owner}" in the shared pool (usernames are unique per pool)`;
          }
        }
      }
    }
    if (outcome === 'created' || outcome === 'exists') {
      await cognito.send(
        new AdminSetUserPasswordCommand({ UserPoolId: t.userPoolId, Username: email, Password: demoPassword(), Permanent: true }),
      );
      for (const GroupName of [u.group, `tenant_${t.tenantId}`]) {
        await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: t.userPoolId, Username: email, GroupName }));
      }
      creds[t.tenantId].push({ user: u.key, email, password: demoPassword(), group: u.group });
    }
    results.push({ tenantId: t.tenantId, model: t.model, user: u.key, email, outcome, detail });
  }
}

writeJson('.poc/users.json', creds);
writeJson('.poc/seed-results.json', results);
console.table(results.map(({ detail: _d, ...r }) => r));
const blocked = results.filter((r) => r.outcome === 'blocked_same_email_other_tenant');
if (blocked.length) {
  console.log(`\n⚠ Expected finding: ${blocked.length} "same email" users could not be created in the shared pool:`);
  for (const b of blocked) console.log(`  ${b.tenantId}: ${b.detail}`);
}
console.log('\nDemo password for all users: DEMO_PASSWORD in .env   (credentials in .poc/users.json)');
