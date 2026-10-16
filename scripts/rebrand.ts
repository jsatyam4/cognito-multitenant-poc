/**
 * Requirement 3 — change a tenant's branding WITHOUT a deploy.
 *   npm run rebrand -- --tenant acme --primary "#7B2FF7" [--background "#F5EEFF"] [--app-name "Acme Next"]
 * Updates the managed-login style of all 3 module clients + the registry (app shell).
 */
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { faviconSvg, logoSvg, updateBranding } from './lib/branding';
import { arg, ddb, getTenant, outputs, StepTimer } from './lib/common';

const tenantId = arg('tenant');
if (!tenantId) {
  console.error('Usage: npm run rebrand -- --tenant <tenantId> --primary "#RRGGBB" [--background "#RRGGBB"] [--app-name "..."]');
  process.exit(1);
}
const t = await getTenant(tenantId);
if (!t) throw new Error(`Unknown tenant ${tenantId}`);

const appName = arg('app-name', t.appName)!;
const branding = {
  ...t.branding,
  primary: arg('primary', t.branding.primary)!,
  pageBackground: arg('background', t.branding.pageBackground)!,
};
branding.logoSvg = logoSvg(appName, branding);
branding.faviconSvg = faviconSvg(appName, branding);

console.log(`▶ Re-branding ${tenantId}: primary ${t.branding.primary} → ${branding.primary}`);
const timer = new StepTimer();
for (const [m, c] of Object.entries(t.modules)) {
  if (!c.brandingId) continue;
  await timer.step(`UpdateManagedLoginBranding ${m}`, () => updateBranding(t.userPoolId, c.brandingId!, appName, branding), (r) => r.mode);
}
await timer.step('Update registry (app shell branding)', () =>
  ddb.send(
    new UpdateCommand({
      TableName: outputs().TenantTable,
      Key: { tenantId },
      UpdateExpression: 'SET branding = :b, appName = :n',
      ExpressionAttributeValues: { ':b': branding, ':n': appName },
    }),
  ));
console.log(`\n✔ Done in ${timer.totalSeconds}s — no deploy. Reload the login page (app shell picks it up within ~30s cache).`);
