/**
 * Per-tenant MFA policy (stretch goal: TOTP).
 *   npm run mfa -- --tenant acme --mode required   # next sign-in shows branded authenticator-app setup
 *   npm run mfa -- --tenant acme --mode optional
 * With pool-per-tenant this is a per-tenant setting; in the shared pool it affects every tenant.
 */
import { SetUserPoolMfaConfigCommand } from '@aws-sdk/client-cognito-identity-provider';
import { arg, cognito, getTenant } from './lib/common';

const tenantId = arg('tenant');
const mode = arg('mode', 'required');
if (!tenantId || !['required', 'optional'].includes(mode!)) {
  console.error('Usage: npm run mfa -- --tenant <tenantId> --mode required|optional');
  process.exit(1);
}
const t = await getTenant(tenantId);
if (!t) throw new Error(`Unknown tenant ${tenantId}`);
if (t.model === 'shared') console.warn('⚠ Shared pool: this changes MFA for EVERY shared tenant.');
await cognito.send(
  new SetUserPoolMfaConfigCommand({
    UserPoolId: t.userPoolId,
    MfaConfiguration: mode === 'required' ? 'ON' : 'OPTIONAL',
    SoftwareTokenMfaConfiguration: { Enabled: true },
  }),
);
console.log(`✔ ${tenantId}: TOTP MFA ${mode}. Sign in again (prompt=login) to see the setup / code screen.`);
