/** R3 — generated branding assets must pass Cognito's managed-login validation. */
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { logoSvg } from '../scripts/lib/branding';

const tenants = readdirSync('tenants').map((f) => JSON.parse(readFileSync(`tenants/${f}`, 'utf8')));
const size = (svg: string) => {
  const m = /width="(\d+)" height="(\d+)"/.exec(svg)!;
  return { w: Number(m[1]), h: Number(m[2]) };
};

describe('logo asset', () => {
  for (const t of tenants) {
    it(`${t.slug}: "${t.appName}" logo is within Cognito's 1:1–4:1 ratio`, () => {
      const { w, h } = size(logoSvg(t.appName, t.branding));
      assert.ok(w / h >= 1 && w / h <= 4, `${w}x${h} = ${(w / h).toFixed(2)}:1`);
    });
  }

  it('a very long app name still fits the ratio', () => {
    const { w, h } = size(logoSvg('Extraordinarily Long Enterprise Workspace Name', tenants[0].branding));
    assert.ok(w / h <= 4);
  });
});
