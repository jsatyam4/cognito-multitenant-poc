/** Prints the (deterministic) Cognito redirect URIs to register in Entra / Google BEFORE onboarding. */
import { readdirSync } from 'node:fs';
import { domainPrefix, loginDomainUrl, outputs } from './lib/common';

const acct = outputs().AccountId;
const slugs = readdirSync('tenants').filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
const hosts = [...slugs.map((s) => loginDomainUrl(domainPrefix(s, acct))), loginDomainUrl(domainPrefix('shared', acct))];

console.log('Redirect URIs (Entra: Authentication → Web redirect URIs; Google: Authorized redirect URIs):\n');
for (const h of hosts) console.log(`  ${h}/oauth2/idpresponse`);
console.log('\nGoogle → Authorized JavaScript origins:\n');
for (const h of hosts) console.log(`  ${h}`);
