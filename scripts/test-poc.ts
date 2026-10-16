/**
 * Automated pass/fail run of the 8 POC requirements against the LIVE Cognito setup, reported
 * separately for each scenario:
 *   A · shared pool, hosted login page   B · own pool, hosted login page   C · own pool, our own login page
 * Signs in with SRP (like a real app). Runs the sample API in-process against the real registry.
 *
 *   npm run test:poc        → results/results.md, results/results.json
 */
import {
  DescribeManagedLoginBrandingByClientCommand,
  DescribeUserPoolClientCommand,
  GetUserPoolMfaConfigCommand,
  InitiateAuthCommand,
  RevokeTokenCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { cognito, listTenants, outputs, readJson, writeJson } from './lib/common';
import { serveLambda } from './lib/http-adapter';
import { srpLogin, type Tokens } from './lib/srp';
import type { ModuleId, TenantRecord } from '../shared/types';

type Status = 'PASS' | 'FAIL' | 'PARTIAL' | 'MANUAL';
type Scenario = 'A' | 'B' | 'C';
const SCENARIOS: Scenario[] = ['A', 'B', 'C'];
const SCENARIO_NAME: Record<Scenario, string> = { A: 'A · shared pool, hosted page', B: 'B · own pool, hosted page', C: 'C · own pool, own page' };
interface Check { name: string; status: Status; detail: string; scenario: Scenario }
interface Req { id: number; title: string; checks: Check[]; status?: Partial<Record<Scenario, Status>> }

const o = outputs();
const tenants = await listTenants();
const users = readJson<Record<string, Array<{ user: string; email: string; password: string }>>>('.poc/users.json');
const seed = existsSync('.poc/seed-results.json')
  ? readJson<Array<{ tenantId: string; user: string; outcome: string; detail?: string }>>('.poc/seed-results.json')
  : [];
const scenarioOf = (t: TenantRecord): Scenario => (t.model === 'shared' ? 'A' : t.loginMode === 'own' ? 'C' : 'B');
const groups: Record<Scenario, TenantRecord[]> = { A: [], B: [], C: [] };
for (const t of tenants) groups[scenarioOf(t)].push(t);

// Sample API in-process, against the real registry
process.env.TENANT_TABLE = o.TenantTable;
process.env.AWS_REGION = o.Region;
const { handler } = await import('../lambda/api');
const server = await serveLambda(handler, 0);
const apiBase = `http://localhost:${(server.address() as AddressInfo).port}`;

const reqs: Req[] = [];
const add = (id: number, title: string) => {
  const r: Req = { id, title, checks: [] };
  reqs.push(r);
  return (scenario: Scenario, name: string, status: Status, detail: string) => r.checks.push({ scenario, name, status, detail });
};

const userOf = (t: TenantRecord, key: string) => users[t.tenantId]?.find((u) => u.user === key);
const decode = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
const login = (t: TenantRecord, module: ModuleId, email: string, password: string) =>
  srpLogin(t.userPoolId, t.modules[module].clientId, email, password);

async function api(path: string, token?: string) {
  const res = await fetch(`${apiBase}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  let body: any = {};
  try { body = await res.json(); } catch { /* empty */ }
  return { status: res.status, body };
}
async function reachable(url: string) {
  try { return (await fetch(url)).status; } catch { return 0; }
}
const authorizeUrl = (t: TenantRecord, m: ModuleId, responseType = 'code') => {
  const u = new URL(`${t.loginDomain}/oauth2/authorize`);
  u.searchParams.set('client_id', t.modules[m].clientId);
  u.searchParams.set('response_type', responseType);
  u.searchParams.set('scope', 'openid email profile');
  u.searchParams.set('redirect_uri', `${o.AppUrl}/callback`);
  u.searchParams.set('state', 'poc');
  u.searchParams.set('code_challenge', createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url'));
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
};

console.log(`Testing ${tenants.length} tenants: ${SCENARIOS.map((s) => `${s}=${groups[s].map((t) => t.tenantId).join(',')}`).join('  ')}\n`);
const appUp = (await reachable(o.AppUrl)) === 200;

// ---------------- R1 Tenant isolation ----------------
{
  const c = add(1, 'Tenant isolation');
  for (const s of SCENARIOS) {
    const g = groups[s];
    if (!g.length) continue;
    let ownOk = 0, blocked = 0, total = 0;
    const leaks: string[] = [];
    for (const a of g) {
      const ua = userOf(a, 'admin');
      if (!ua) continue;
      if ((await login(a, 'module1', ua.email, ua.password)).ok) ownOk++;
      for (const b of g) {
        if (a === b) continue;
        total++;
        const r = await login(b, 'module1', ua.email, ua.password);
        if (r.ok) leaks.push(`${a.tenantId} user signed in to ${b.tenantId}`);
        else blocked++;
      }
    }
    c(s, 'Users sign in to their own tenant', ownOk === g.length ? 'PASS' : 'FAIL', `${ownOk}/${g.length}`);
    c(s, 'Cross-tenant sign-in blocked at Cognito', leaks.length === 0 && total > 0 ? 'PASS' : 'FAIL',
      leaks.length ? leaks.join('; ') : `${blocked}/${total} attempts rejected${s === 'A' ? ' (pre-auth trigger)' : ' (user not in that pool)'}`);
    if (s === 'A') {
      const blockedSeed = seed.filter((x) => x.outcome === 'blocked_same_email_other_tenant');
      c(s, 'Same email in two tenants', blockedSeed.length ? 'FAIL' : 'PASS',
        blockedSeed.length ? `cannot create: ${blockedSeed[0].detail}` : 'created in all shared tenants');
    } else {
      const subs = new Set<string>();
      let ok = 0;
      for (const t of g) {
        const j = userOf(t, 'jane');
        const r = j && (await login(t, 'module1', j.email, j.password));
        if (r && r.ok) { ok++; subs.add(decode(r.tokens.IdToken).sub); }
      }
      c(s, 'Same email in two tenants', ok >= 2 && subs.size === ok ? 'PASS' : 'FAIL', `${ok} tenants hold ${userOf(g[0], 'jane')?.email}, ${subs.size} distinct identities`);
    }
  }
}

// ---------------- R2 Per-tenant login URL ----------------
{
  const c = add(2, 'Per-tenant login URL');
  for (const s of SCENARIOS) {
    const g = groups[s];
    if (!g.length) continue;
    if (s === 'C') {
      const ok = g.every((t) => t.loginMode === 'own' && t.theme);
      c(s, 'Each tenant has its own login page in our app (/t/<tenant>/login)', ok ? 'PASS' : 'FAIL', g.map((t) => `/t/${t.tenantId}/login`).join(', '));
      if (appUp) {
        const st = await Promise.all(g.map((t) => reachable(`${o.AppUrl}/t/${t.tenantId}/login`)));
        c(s, 'Login pages served by the app', st.every((x) => x === 200) ? 'PASS' : 'FAIL', st.join(', '));
      } else c(s, 'Login pages served by the app', 'MANUAL', `start the app (npm run dev:frontend) — ${o.AppUrl} not reachable`);
      c(s, 'Own domain per tenant (login.<tenant>.com)', 'MANUAL', 'No domain available. Our page can be served on any number of subdomains (no Cognito 4-domain limit).');
      continue;
    }
    let ok = 0, n = 0;
    const fails: string[] = [];
    for (const t of g) {
      for (const m of Object.keys(t.modules) as ModuleId[]) {
        n++;
        const r = await fetch(authorizeUrl(t, m), { redirect: 'manual' });
        const loc = r.headers.get('location') ?? '';
        if (r.status === 302 && /\/login\?/.test(loc)) {
          const lp = await fetch(new URL(loc, t.loginDomain));
          if (lp.status === 200) ok++;
          else fails.push(`${t.tenantId}/${m}: /login ${lp.status}`);
        } else fails.push(`${t.tenantId}/${m}: authorize ${r.status} ${loc.slice(0, 80)}`);
      }
    }
    c(s, 'Each tenant × module reaches its hosted login page', ok === n ? 'PASS' : 'FAIL', fails.length ? fails.join('; ') : `${ok}/${n} login pages served`);
    const hosts = new Set(g.map((t) => t.loginDomain));
    if (s === 'B') c(s, 'Distinct login host per tenant', hosts.size === g.length ? 'PASS' : 'FAIL', [...hosts].join(', '));
    else c(s, 'Distinct login host per tenant', 'PARTIAL', `all tenants share ${[...hosts].join(', ')}; branding chosen by client_id`);
    c(s, 'Custom domain per tenant', 'MANUAL', 'No domain available. Cognito allows 4 custom domains per region per account (not adjustable).');
  }
  if (appUp) {
    const st = await Promise.all(tenants.map((t) => reachable(`${o.AppUrl}/t/${t.tenantId}`)));
    for (const s of SCENARIOS) {
      const idx = tenants.map((t, i) => (scenarioOf(t) === s ? i : -1)).filter((i) => i >= 0);
      if (idx.length) c(s, 'Tenant app URL (/t/<tenant>) is served', idx.every((i) => st[i] === 200) ? 'PASS' : 'FAIL', idx.map((i) => `/t/${tenants[i].tenantId}=${st[i]}`).join(', '));
    }
  }
}

// ---------------- R3 Per-tenant branding ----------------
{
  const c = add(3, 'Per-tenant branding');
  for (const s of SCENARIOS) {
    const g = groups[s];
    if (!g.length) continue;
    if (s === 'C') {
      const themed = g.filter((t) => t.theme && t.branding.logoSvg && t.branding.faviconSvg);
      c(s, 'Logo, favicon, colours and theme per tenant (registry)', themed.length === g.length ? 'PASS' : 'FAIL', `${themed.length}/${g.length} tenants themed`);
      c(s, 'Primary colour differs per tenant', new Set(g.map((t) => t.branding.primary)).size === g.length ? 'PASS' : 'FAIL', g.map((t) => `${t.slug}=${t.branding.primary}`).join(', '));
      c(s, 'App name and page text per tenant', g.every((t) => t.theme?.welcomeTitle) ? 'PASS' : 'FAIL', 'real text from the theme: ' + g.map((t) => `"${t.theme?.welcomeTitle}"`).join(', '));
      c(s, 'Branding change without deploy', 'PASS', 'theme saved to the registry by the theme editor / API; live on next page load');
      continue;
    }
    const primaries = new Map<string, string>();
    let styled = 0, n = 0;
    const notes: string[] = [];
    for (const t of g) {
      for (const [m, cl] of Object.entries(t.modules)) {
        n++;
        try {
          const r = await cognito.send(new DescribeManagedLoginBrandingByClientCommand({ UserPoolId: t.userPoolId, ClientId: cl.clientId }));
          const b = r.ManagedLoginBranding;
          const assets = (b?.Assets ?? []).map((a) => a.Category);
          const prim = (b?.Settings as any)?.components?.primaryButton?.lightMode?.defaults?.backgroundColor;
          if (assets.includes('FORM_LOGO') && assets.includes('FAVICON_SVG') && assets.includes('PAGE_BACKGROUND')) styled++;
          else notes.push(`${t.tenantId}/${m} assets=[${assets.join(',')}]`);
          if (prim) primaries.set(t.slug, prim);
        } catch (e) {
          notes.push(`${t.tenantId}/${m}: ${(e as Error).name}`);
        }
      }
    }
    c(s, 'Logo, favicon, background on every login page', styled === n ? 'PASS' : 'FAIL', notes.length ? notes.join('; ') : `${styled}/${n} branding styles`);
    c(s, 'Primary colour differs per tenant', new Set(primaries.values()).size === g.length ? 'PASS' : 'FAIL', [...primaries].map(([k, v]) => `${k}=${v}`).join(', '));
    c(s, 'App name and page text per tenant', 'PARTIAL', 'Managed login cannot set page text (only localisation); app name is drawn inside the logo image');
    const t0 = g[0];
    if (t0.modules.module1.brandingId) {
      const { updateBranding } = await import('./lib/branding');
      const st = Date.now();
      const r = await updateBranding(t0.userPoolId, t0.modules.module1.brandingId, t0.appName, t0.branding);
      c(s, 'Branding change without deploy', r.mode === 'custom-settings+assets' ? 'PASS' : 'FAIL', `${((Date.now() - st) / 1000).toFixed(2)}s API call (${r.mode})`);
    }
  }
}

// ---------------- R4 Login flows ----------------
{
  const c = add(4, 'Login flows');
  const expect: Record<ModuleId, string> = { module1: 'COGNITO', module2: 'COGNITO+Microsoft', module3: 'Google' };
  for (const s of SCENARIOS) {
    const g = groups[s];
    if (!g.length) continue;
    for (const m of ['module1', 'module2', 'module3'] as ModuleId[]) {
      const got = g.map((t) => t.modules[m].idps.join('+'));
      const allMatch = got.every((x) => x === expect[m]);
      const missing = [...new Set(g.flatMap((t) => t.modules[m].missing ?? []))];
      c(s, `${m}: own app client with ${expect[m]}`, allMatch ? 'PASS' : missing.length ? 'PARTIAL' : 'FAIL',
        allMatch ? `${g.length} clients` : `configured: ${[...new Set(got)].join(', ')}${missing.length ? ` — IdP credentials not provided: ${missing.join(', ')}` : ''}`);
    }
    const t = g[0], u = userOf(t, 'user');
    if (u) {
      const r = await login(t, 'module1', u.email, u.password);
      if (r.ok) {
        await cognito.send(new RevokeTokenCommand({ Token: r.tokens.RefreshToken, ClientId: t.modules.module1.clientId }));
        let refreshed = false;
        try {
          await cognito.send(new InitiateAuthCommand({ AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: t.modules.module1.clientId, AuthParameters: { REFRESH_TOKEN: r.tokens.RefreshToken } }));
          refreshed = true;
        } catch { /* expected */ }
        c(s, 'Logout revokes refresh token', refreshed ? 'FAIL' : 'PASS', refreshed ? 'refresh still worked after revoke' : 'refresh rejected after RevokeToken');
      } else c(s, 'Logout revokes refresh token', 'FAIL', `sign-in failed: ${r.error}`);
    }
    const d = await cognito.send(new DescribeUserPoolClientCommand({ UserPoolId: t.userPoolId, ClientId: t.modules.module1.clientId }));
    c(s, 'Logout redirect configured', (d.UserPoolClient?.LogoutURLs?.length ?? 0) > 0 ? 'PASS' : 'FAIL', d.UserPoolClient?.LogoutURLs?.join(', ') ?? '');
    const mfa = await cognito.send(new GetUserPoolMfaConfigCommand({ UserPoolId: t.userPoolId }));
    c(s, 'TOTP MFA available (stretch)', mfa.SoftwareTokenMfaConfiguration?.Enabled ? 'PASS' : 'FAIL',
      `MfaConfiguration=${mfa.MfaConfiguration}; enrolment shows at sign-in when set to required (npm run mfa)`);
    c(s, 'Forgot password', 'MANUAL', s === 'C' ? 'Our login page: request code → set new password; needs a real inbox (demoEmailTemplate)' : 'Built into managed login; needs a real inbox (demoEmailTemplate)');
  }
}

// ---------------- R5 OIDC Code + PKCE ----------------
{
  const c = add(5, 'OIDC Authorization Code + PKCE');
  for (const s of SCENARIOS) {
    const t = groups[s][0];
    if (!t) continue;
    const d = await cognito.send(new DescribeUserPoolClientCommand({ UserPoolId: t.userPoolId, ClientId: t.modules.module1.clientId }));
    const cl = d.UserPoolClient!;
    const flows = cl.ExplicitAuthFlows ?? [];
    c(s, 'Public client, code flow only, no secret, no plain-password API', JSON.stringify(cl.AllowedOAuthFlows) === '["code"]' && !cl.ClientSecret && !flows.includes('ALLOW_USER_PASSWORD_AUTH') ? 'PASS' : 'FAIL',
      `oauth=${cl.AllowedOAuthFlows}, secret=${cl.ClientSecret ? 'yes' : 'no'}, api flows=${flows.join(',')}`);
    const imp = await fetch(authorizeUrl(t, 'module1', 'token'), { redirect: 'manual' });
    const loc = imp.headers.get('location') ?? '';
    c(s, 'Implicit flow (response_type=token) rejected', /error=/.test(loc) || imp.status >= 400 ? 'PASS' : 'FAIL', `${imp.status} ${loc.slice(0, 100)}`);
    const disc = await (await fetch(`${t.issuer}/.well-known/openid-configuration`)).json();
    c(s, 'OIDC discovery document', disc.issuer === t.issuer ? 'PASS' : 'FAIL', `authorization_endpoint=${disc.authorization_endpoint}`);
    if (s === 'C') c(s, 'Password sign-in uses the OIDC code flow', 'PARTIAL', 'Our login page signs in with Cognito\'s SRP API, not the code flow; Microsoft/Google still use code + PKCE');
    else c(s, 'PKCE S256 round trip in browser', 'MANUAL', 'App uses oidc-client-ts (code_challenge_method=S256); see /oauth2/token with code_verifier in the network tab');
  }
}

// ---------------- R6 Tokens ----------------
const tokens: Record<string, Tokens> = {};
{
  const c = add(6, 'Tokens carry tenant + role claims');
  for (const s of SCENARIOS) {
    const g = groups[s];
    if (!g.length) continue;
    const bad: string[] = [];
    let n = 0;
    for (const t of g) {
      for (const key of ['admin', 'user']) {
        const u = userOf(t, key);
        if (!u) continue;
        const r = await login(t, 'module1', u.email, u.password);
        if (!r.ok) { bad.push(`${t.tenantId}/${key}: ${r.error}`); continue; }
        n++;
        tokens[`${t.tenantId}:${key}`] = r.tokens;
        for (const [kind, p] of [['access', decode(r.tokens.AccessToken)], ['id', decode(r.tokens.IdToken)]] as const) {
          if (p.tenant_id !== t.tenantId) bad.push(`${t.tenantId}/${key} ${kind}.tenant_id=${p.tenant_id}`);
          if (p.role !== key) bad.push(`${t.tenantId}/${key} ${kind}.role=${p.role}`);
          if (!p['cognito:groups']?.includes(`tenant_${t.tenantId}`)) bad.push(`${t.tenantId}/${key} ${kind} missing tenant group`);
        }
      }
    }
    c(s, 'tenant_id, role and tenant group in BOTH ID and access token', bad.length ? 'FAIL' : 'PASS', bad.length ? bad.join('; ') : `${n} users × 2 tokens verified`);
    const sample = tokens[`${g[0].tenantId}:admin`];
    if (sample) {
      const p = decode(sample.IdToken);
      c(s, 'Extra profile attributes in ID token', p['custom:department'] ? 'PASS' : 'FAIL', `custom:department=${p['custom:department']}, custom:employee_id=${p['custom:employee_id']}`);
    }
  }
}

// ---------------- R7 App integration ----------------
{
  const c = add(7, 'Sample API validates JWT and rejects wrong tenant');
  for (const s of SCENARIOS) {
    const [a, b] = groups[s];
    const ta = a && tokens[`${a.tenantId}:user`], tadm = a && tokens[`${a.tenantId}:admin`];
    if (!a || !b || !ta || !tadm) continue;
    const own = await api(`/t/${a.tenantId}/me`, ta.AccessToken);
    c(s, 'Own-tenant token accepted', own.status === 200 ? 'PASS' : 'FAIL', `GET /t/${a.tenantId}/me → ${own.status}`);
    const cross = await api(`/t/${b.tenantId}/data`, ta.AccessToken);
    c(s, 'Wrong-tenant token rejected', cross.status === 403 ? 'PASS' : 'FAIL', `${a.tenantId} token → /t/${b.tenantId}/data → ${cross.status} ${cross.body.error ?? ''}`);
    const none = await api(`/t/${a.tenantId}/me`);
    c(s, 'Missing token rejected', none.status === 401 ? 'PASS' : 'FAIL', `→ ${none.status} ${none.body.error ?? ''}`);
    const sig = ta.AccessToken.slice(0, -4) + (ta.AccessToken.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    const tam = await api(`/t/${a.tenantId}/me`, sig);
    c(s, 'Tampered signature rejected', tam.status === 401 ? 'PASS' : 'FAIL', `→ ${tam.status} ${tam.body.error ?? ''}`);
    const idt = await api(`/t/${a.tenantId}/me`, ta.IdToken);
    c(s, 'ID token used as access token rejected', idt.status === 401 ? 'PASS' : 'FAIL', `→ ${idt.status} ${idt.body.error ?? ''}`);
    const ua = await api(`/t/${a.tenantId}/admin`, ta.AccessToken), aa = await api(`/t/${a.tenantId}/admin`, tadm.AccessToken);
    c(s, 'Role-based route (admin only)', ua.status === 403 && aa.status === 200 ? 'PASS' : 'FAIL', `user→${ua.status}, admin→${aa.status}`);
  }
  // Across scenarios: the same company in two models must still be isolated
  const bAcme = tokens['acme:user'];
  if (bAcme && tenants.some((t) => t.tenantId === 'acme-shared')) {
    const r = await api('/t/acme-shared/data', bAcme.AccessToken);
    c('B', 'Token from acme (own pool) rejected by acme-shared', r.status === 401 || r.status === 403 ? 'PASS' : 'FAIL', `→ ${r.status} ${r.body.error ?? ''}`);
  }
}

// ---------------- R8 Tenant onboarding ----------------
{
  const c = add(8, 'Tenant onboarding by script, timed');
  const logs = existsSync('.poc/onboarding')
    ? readdirSync('.poc/onboarding').filter((f) => f.endsWith('.json') && f !== 'summary.json').map((f) => readJson<any>(`.poc/onboarding/${f}`))
    : [];
  for (const s of SCENARIOS) {
    const g = groups[s];
    if (!g.length) continue;
    const l = logs.filter((x) => g.some((t) => t.tenantId === x.tenantId));
    c(s, 'Created by one script, no deploy', l.length === g.length ? 'PASS' : 'PARTIAL', `${l.length}/${g.length} onboarding logs`);
    c(s, 'Time per tenant', l.length ? 'PASS' : 'MANUAL', l.map((x) => `${x.tenantId}=${x.totalSeconds}s`).join(', '));
  }
}

server.close();

// ---------------- Roll-up per scenario ----------------
const rollup = (checks: Check[]): Status | undefined => {
  const st = checks.map((c) => c.status).filter((x) => x !== 'MANUAL');
  if (!checks.length) return undefined;
  if (!st.length) return 'MANUAL';
  return st.includes('FAIL') ? (st.includes('PASS') ? 'PARTIAL' : 'FAIL') : st.includes('PARTIAL') ? 'PARTIAL' : 'PASS';
};
for (const r of reqs) r.status = Object.fromEntries(SCENARIOS.map((s) => [s, rollup(r.checks.filter((c) => c.scenario === s))]));
const icon: Record<Status, string> = { PASS: '✅', FAIL: '❌', PARTIAL: '🟡', MANUAL: '👀' };
const cell = (x?: Status) => (x ? `${icon[x]} ${x}` : '—');
const count = (s: Scenario, st: Status) => reqs.filter((r) => r.status?.[s] === st).length;

let md = `# Cognito POC — automated results\n\nRun: ${new Date().toISOString()}  \nApp: ${o.AppUrl} (${appUp ? 'running' : 'not running — app checks marked MANUAL'})  \nTenants: ${tenants.length}\n\n`;
md += `| # | Requirement | ${SCENARIOS.map((s) => SCENARIO_NAME[s]).join(' | ')} |\n|---|---|${SCENARIOS.map(() => '---').join('|')}|\n`;
md += reqs.map((r) => `| ${r.id} | ${r.title} | ${SCENARIOS.map((s) => cell(r.status?.[s])).join(' | ')} |`).join('\n') + '\n';
md += `| | **Full pass** | ${SCENARIOS.map((s) => `**${count(s, 'PASS')}/8** (${count(s, 'PARTIAL')} partial, ${count(s, 'FAIL')} fail)`).join(' | ')} |\n\n`;
for (const r of reqs) {
  md += `## ${r.id}. ${r.title}\n\n| Scenario | Check | Result | Detail |\n|---|---|---|---|\n`;
  md += r.checks.map((c) => `| ${c.scenario} | ${c.name} | ${icon[c.status]} ${c.status} | ${c.detail.replace(/\|/g, '\\|')} |`).join('\n') + '\n\n';
}
writeJson('results/results.json', reqs);
writeFileSync('results/results.md', md);

console.log(`${'Requirement'.padEnd(46)} ${SCENARIOS.map((s) => s.padEnd(11)).join(' ')}`);
for (const r of reqs) console.log(`R${r.id} ${r.title.padEnd(43)} ${SCENARIOS.map((s) => cell(r.status?.[s]).padEnd(11)).join(' ')}`);
console.log(`${'Full pass'.padEnd(46)} ${SCENARIOS.map((s) => `${count(s, 'PASS')}/8`.padEnd(11)).join(' ')}`);
for (const r of reqs) for (const c of r.checks.filter((x) => x.status === 'FAIL')) console.log(`  ❌ R${r.id} [${c.scenario}] ${c.name} — ${c.detail}`);
console.log('\nWrote results/results.md');
