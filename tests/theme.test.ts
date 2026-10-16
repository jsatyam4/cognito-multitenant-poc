/** Scenario C — theme editor save route (PUT /t/{tenant}/theme) and shared validation. */
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { accessToken, byId } from './fixtures';
import { startLocalApi } from '../scripts/local-api';
import { contrastRatio, validateThemeUpdate } from '../shared/theme';

const good = {
  primary: '#2563EB',
  primaryText: '#FFFFFF',
  pageBackground: '#EFF5FF',
  theme: { layout: 'split', font: 'rounded', radius: 16, welcomeTitle: 'Hello Acme', welcomeText: 'Sign in to continue.', buttonLabel: 'Continue', footerText: 'Acme IT' },
};

let base = '';
let close: () => void;
before(async () => {
  const server = await startLocalApi(0);
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

const put = (tenant: string, body: unknown, token?: string) =>
  fetch(`${base}/t/${tenant}/theme`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

describe('validateThemeUpdate', () => {
  it('accepts a valid theme', () => assert.deepEqual(validateThemeUpdate(good), []));
  it('rejects HTML in text', () => {
    assert.match(validateThemeUpdate({ ...good, theme: { ...good.theme, welcomeTitle: '<script>x</script>' } }).join(), /must not contain/);
  });
  it('rejects unreadable button colours', () => {
    assert.match(validateThemeUpdate({ ...good, primary: '#FFFF00', primaryText: '#FFFFFF' }).join(), /hard to read/);
  });
  it('rejects bad colour formats and lengths', () => {
    const e = validateThemeUpdate({ ...good, primary: 'blue', theme: { ...good.theme, buttonLabel: 'x'.repeat(40) } }).join();
    assert.match(e, /primary must be/);
    assert.match(e, /at most 24/);
  });
  it('contrast ratio matches WCAG reference values', () => {
    assert.equal(Math.round(contrastRatio('#000000', '#FFFFFF')), 21);
    assert.equal(contrastRatio('#777777', '#777777'), 1);
  });
});

describe('PUT /t/{tenant}/theme', () => {
  const acme = byId('acme');

  it('401 without a token', async () => assert.equal((await put('acme', good)).status, 401));
  it('403 for a non-admin', async () => assert.equal((await put('acme', good, accessToken(acme))).body.error, 'insufficient_role'));
  it('403 for another tenant\'s admin', async () => {
    assert.equal((await put('acme', good, accessToken(byId('globex'), { role: 'admin' }))).body.error, 'wrong_tenant');
  });
  it('400 with the validation errors', async () => {
    const r = await put('acme', { ...good, primary: 'red' }, accessToken(acme, { role: 'admin' }));
    assert.equal(r.status, 400);
    assert.match(r.body.errors.join(), /primary/);
  });
  it('admin save is served on the next read, with a regenerated logo', async () => {
    assert.equal((await put('acme', good, accessToken(acme, { role: 'admin' }))).status, 200);
    const cfg = (await (await fetch(`${base}/public/tenants/acme`)).json()) as any;
    assert.equal(cfg.theme.welcomeTitle, 'Hello Acme');
    assert.equal(cfg.branding.primary, '#2563EB');
    assert.match(cfg.branding.logoSvg, /#2563EB/);
  });
});
