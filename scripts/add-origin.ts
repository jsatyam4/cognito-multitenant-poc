/**
 * Allow the app on a new address (e.g. its Vercel URL) to sign users in and out:
 * adds <origin>/callback and <origin>/t/<tenant> to every app client of every tenant.
 * Keeps all other client settings. Safe to re-run.
 *
 *   npm run add-origin -- --origin https://cognito-multitenant-poc.vercel.app
 *   npm run add-origin -- --origin https://… --remove
 *
 * New tenants get it automatically when the origin is listed in config/poc.config.json "publicOrigins".
 */
import { arg, assertAwsAccount, flag, listTenants } from './lib/common';
import { updateClient } from './lib/clients';

const origin = arg('origin')?.replace(/\/$/, '');
if (!origin || !/^https:\/\/[a-z0-9.-]+$/i.test(origin)) {
  console.error('Usage: npm run add-origin -- --origin https://<host> [--remove]');
  process.exit(1);
}
const remove = flag('remove');
await assertAwsAccount();

let n = 0;
for (const t of await listTenants()) {
  for (const [m, c] of Object.entries(t.modules)) {
    const cb = `${origin}/callback`;
    const lo = `${origin}/t/${t.tenantId}`;
    await updateClient(t.userPoolId, c.clientId, (cur) => {
      const keep = (list: string[] | undefined, v: string) => (remove ? (list ?? []).filter((x) => x !== v) : [...new Set([...(list ?? []), v])]);
      return { CallbackURLs: keep(cur.CallbackURLs, cb), LogoutURLs: keep(cur.LogoutURLs, lo) };
    });
    n++;
    process.stdout.write(`  • ${t.tenantId}/${m}\n`);
  }
}
console.log(`\n✔ ${remove ? 'Removed' : 'Added'} ${origin} on ${n} app clients`);
