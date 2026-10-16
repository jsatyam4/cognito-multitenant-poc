import { useEffect, useState } from 'react';
import { applyTheme, fetchTenants, navigate, scenarioOf, SCENARIO_LABEL, svgDataUrl, type PublicTenantConfig } from '../lib';

export function Directory() {
  const [tenants, setTenants] = useState<PublicTenantConfig[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    applyTheme(null);
    fetchTenants().then(setTenants).catch((e: Error) => setError(e.message));
  }, []);

  const groups: Array<[string, string, PublicTenantConfig[]]> = (['A', 'B', 'C'] as const).map((s) => [
    s,
    `${SCENARIO_LABEL[s]} — ${{ A: 'one user pool for every tenant, tenant tag on each user', B: 'one user pool per tenant, Cognito-hosted branded login page', C: 'one user pool per tenant, our own themed login page (no Cognito branding or domain limits)' }[s]}`,
    tenants?.filter((t) => scenarioOf(t) === s) ?? [],
  ]);

  return (
    <div className="platform">
      <header className="platform-head">
        <div>
          <p className="eyebrow">Amazon Cognito · Multi-tenant login POC</p>
          <h1>Tenant directory</h1>
          <p className="muted">
            One codebase serves every tenant. Each tenant opens its own URL and gets its own branded login page for
            each of the 3 modules: Cognito's hosted page in scenarios A and B, our own themed page in scenario C.
            Tenants come from the registry at runtime, so a new tenant appears here after <code>npm run onboard</code>{' '}
            with no deploy.
          </p>
        </div>
      </header>

      {error && <div className="card error">Could not load tenants: {error}</div>}
      {!tenants && !error && <div className="spinner" />}

      {tenants &&
        groups.map(([key, title, list]) => (
          <section key={key} className="platform-section">
            <h2>{title}</h2>
            {list.length === 0 && <p className="muted">No tenants yet.</p>}
            <div className="tenant-grid">
              {list.map((t) => (
                <button
                  key={t.tenantId}
                  className="tenant-tile"
                  style={{ ['--tile' as string]: t.branding.primary, ['--tile-bg' as string]: t.branding.pageBackground }}
                  onClick={() => navigate(`/t/${t.tenantId}`)}
                >
                  <img src={svgDataUrl(t.branding.logoSvg)} alt="" className="tile-logo" />
                  <span className="tile-name">{t.displayName}</span>
                  <span className="tile-url mono">/t/{t.tenantId}</span>
                  <span className="tile-meta mono">{t.loginMode === 'own' ? `login: /t/${t.tenantId}/login` : new URL(t.loginDomain).hostname}</span>
                  {t.onboardingSeconds !== undefined && <span className="tile-meta">onboarded in {t.onboardingSeconds}s</span>}
                </button>
              ))}
            </div>
          </section>
        ))}
    </div>
  );
}
