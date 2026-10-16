import { useEffect, useState } from 'react';
import { getUser, MODULES, navigate, signIn, type ModuleId } from '../lib';
import { TenantShell, TenantState, useTenant } from '../components/TenantShell';

const IDP_LABEL: Record<string, string> = { COGNITO: 'Username & password', Microsoft: 'Microsoft Entra ID', Google: 'Google' };

export function TenantHome({ tenantId }: { tenantId: string }) {
  const { tenant, error } = useTenant(tenantId);
  const [signedIn, setSignedIn] = useState<Record<string, string | undefined>>({});
  const [force, setForce] = useState(true);

  useEffect(() => {
    if (!tenant) return;
    Promise.all(MODULES.map(async (m) => [m.id, (await getUser(tenant, m.id))?.profile.email as string | undefined] as const)).then(
      (rows) => setSignedIn(Object.fromEntries(rows)),
    );
  }, [tenant]);

  if (!tenant) return <TenantState tenantId={tenantId} tenant={tenant} error={error} />;

  return (
    <TenantShell tenant={tenant}>
      <section className="hero">
        <h1>{tenant.appName}</h1>
        <p className="tagline">{tenant.tagline}</p>
      </section>

      <section className="module-grid">
        {MODULES.map((m) => {
          const client = tenant.modules[m.id as ModuleId];
          const who = signedIn[m.id];
          return (
            <article key={m.id} className="module-card">
              <div className="module-top">
                <h3>{m.name}</h3>
                <p className="muted">{m.description}</p>
              </div>
              <ul className="chips">
                {client.idps.map((i) => (
                  <li key={i} className="chip">{IDP_LABEL[i] ?? i}</li>
                ))}
                {client.missing?.map((i) => (
                  <li key={i} className="chip warn" title="Add IdP credentials in config/idp.local.json and re-onboard">
                    {i === 'microsoft' ? 'Microsoft' : 'Google'}: credentials pending
                  </li>
                ))}
              </ul>
              <p className="mono small">client_id {client.clientId}</p>
              {who ? (
                <div className="module-actions">
                  <span className="signed">Signed in as {who}</span>
                  <button className="btn" onClick={() => navigate(`/t/${tenant.tenantId}/m/${m.id}`)}>Open module</button>
                </div>
              ) : (
                <button className="btn" onClick={() => signIn(tenant, m.id as ModuleId, force)}>Sign in to {m.name.split(' · ')[1]}</button>
              )}
            </article>
          );
        })}
      </section>

      <section className="card info">
        <h4>How this page works</h4>
        <dl>
          <dt>Login page</dt>
          <dd className="mono">{tenant.loginMode === 'own' ? `${window.location.host}/t/${tenant.tenantId}/login (ours, themed per tenant)` : new URL(tenant.loginDomain).hostname}</dd>
          <dt>Issuer</dt>
          <dd className="mono">{tenant.issuer}</dd>
          <dt>Flow</dt>
          <dd>{tenant.loginMode === 'own'
            ? 'Password: Cognito SRP from our page (the password never leaves the browser). Microsoft/Google: Authorization Code + PKCE.'
            : 'OIDC Authorization Code + PKCE (S256), public client, no secret in the browser'}</dd>
        </dl>
        {tenant.loginMode === 'own' && (
          <p><button className="btn outline" onClick={() => navigate(`/t/${tenant.tenantId}/admin/branding`)}>Edit login theme (admins)</button></p>
        )}
        {tenant.loginMode !== 'own' && <label className="toggle">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
          <span>
            Always show the module's login page (<code>prompt=login</code>). If you turn this off, Cognito's session
            cookie on the login domain signs you into other modules of the same pool without showing their page.
          </span>
        </label>}
      </section>
    </TenantShell>
  );
}
