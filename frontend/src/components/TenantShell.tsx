import { useEffect, useState, type ReactNode } from 'react';
import { applyTheme, fetchTenant, navigate, scenarioOf, SCENARIO_LABEL, svgDataUrl, type PublicTenantConfig } from '../lib';

export function useTenant(tenantId: string) {
  const [tenant, setTenant] = useState<PublicTenantConfig | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchTenant(tenantId)
      .then((t) => {
        setTenant(t);
        applyTheme(t);
      })
      .catch((e: Error) => setError(e.message));
  }, [tenantId]);
  return { tenant, error };
}

export function TenantShell({ tenant, children, right }: { tenant: PublicTenantConfig; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="tenant-page">
      <header className="tenant-head">
        <button className="logo-btn" onClick={() => navigate(`/t/${tenant.tenantId}`)} aria-label={`${tenant.appName} home`}>
          <img src={svgDataUrl(tenant.branding.logoSvg)} alt={tenant.appName} className="tenant-logo" />
        </button>
        <div className="head-right">
          <span className={`model-badge ${tenant.model}`}>{SCENARIO_LABEL[scenarioOf(tenant)]}</span>
          {right}
        </div>
      </header>
      <main className="tenant-main">{children}</main>
      <footer className="tenant-foot">
        <span>{tenant.displayName}</span>
        <span className="mono">tenant_id: {tenant.tenantId}</span>
        <button className="link" onClick={() => navigate('/')}>All tenants</button>
      </footer>
    </div>
  );
}

export function TenantState({ tenantId, tenant, error }: { tenantId: string; tenant: PublicTenantConfig | null | undefined; error: string | null }) {
  if (error) return <main className="center-screen"><div className="card error">{error}</div></main>;
  if (tenant === undefined) return <main className="center-screen"><div className="spinner" /></main>;
  return (
    <main className="center-screen">
      <div className="card narrow">
        <h2>Unknown tenant</h2>
        <p className="muted">No tenant <code>{tenantId}</code> is registered.</p>
        <button className="btn" onClick={() => navigate('/')}>All tenants</button>
      </div>
    </main>
  );
}
