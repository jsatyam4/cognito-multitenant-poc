/**
 * Onboard the 9 demo tenants: 3 per scenario.
 *   A · shared pool, hosted login page:      acme-shared, globex-shared, initech-shared
 *   B · own pool, hosted login page:         acme, globex, initech
 *   C · own pool, our own login page:        umbrella, hooli, stark   (loginMode "own" in tenants/*.json)
 * The 10th slot (limit in config) is left for onboarding "wayne" live in the demo.
 */
import { onboard } from './onboard';
import { getTenant, tenantIdFor, writeJson } from './lib/common';
import type { TenantModel } from '../shared/types';

const plan: Array<[string, TenantModel]> = [
  ['acme', 'shared'],
  ['globex', 'shared'],
  ['initech', 'shared'],
  ['acme', 'pool'],
  ['globex', 'pool'],
  ['initech', 'pool'],
  ['umbrella', 'pool'],
  ['hooli', 'pool'],
  ['stark', 'pool'],
];

const summary: Array<{ tenantId: string; model: TenantModel; seconds: number | string }> = [];
for (const [slug, model] of plan) {
  const id = tenantIdFor(slug, model);
  if (await getTenant(id)) {
    console.log(`• ${id} already onboarded — skipping`);
    summary.push({ tenantId: id, model, seconds: 'existing' });
    continue;
  }
  const r = await onboard(slug, model);
  summary.push({ tenantId: id, model, seconds: r.onboardingSeconds ?? 0 });
}
console.log('\nOnboarding summary');
console.table(summary);
writeJson('.poc/onboarding/summary.json', summary);
console.log('\nNext: npm run seed');
