import { useEffect, useState } from 'react';
import type { User } from 'oidc-client-ts';
import {
  callApi,
  decodeJwt,
  fetchTenants,
  getUser,
  MODULES,
  navigate,
  signIn,
  signOut,
  type ApiResult,
  type ModuleId,
  type PublicTenantConfig,
} from '../lib';
import { TenantShell, TenantState, useTenant } from '../components/TenantShell';

const HIGHLIGHT = new Set(['tenant_id', 'role', 'module', 'tenant_model', 'cognito:groups', 'custom:tenant_id', 'client_id', 'aud', 'iss', 'token_use']);

function Claims({ title, token }: { title: string; token: string }) {
  const claims = decodeJwt(token);
  return (
    <div className="claims">
      <h4>{title}</h4>
      <table>
        <tbody>
          {Object.entries(claims).map(([k, v]) => (
            <tr key={k} className={HIGHLIGHT.has(k) ? 'hl' : ''}>
              <th className="mono">{k}</th>
              <td className="mono wrap">
                {k === 'exp' || k === 'iat' || k === 'auth_time' ? `${v} (${new Date(Number(v) * 1000).toLocaleTimeString()})` : JSON.stringify(v)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Result({ r }: { r: ApiResult }) {
  const ok = r.status >= 200 && r.status < 300;
  const asExpected = r.expect === undefined || r.expect === r.status;
  return (
    <details className={`result ${ok ? 'ok' : 'bad'}`} open>
      <summary>
        <span className={`status s${String(r.status)[0]}`}>{r.status}</span>
        <span className="mono">{r.method} {r.path}</span>
        <span className="label">{r.label}</span>
        {r.expect !== undefined && <span className={`expect ${asExpected ? 'yes' : 'no'}`}>{asExpected ? 'as expected' : `expected ${r.expect}`}</span>}
        <span className="ms">{r.ms} ms</span>
      </summary>
      <pre>{JSON.stringify(r.body, null, 2)}</pre>
    </details>
  );
}

export function ModulePage({ tenantId, module }: { tenantId: string; module: ModuleId }) {
  const { tenant, error } = useTenant(tenantId);
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [others, setOthers] = useState<PublicTenantConfig[]>([]);
  const [target, setTarget] = useState('');
  const [results, setResults] = useState<ApiResult[]>([]);
  const [busy, setBusy] = useState(false);
  const def = MODULES.find((m) => m.id === module)!;

  useEffect(() => {
    if (!tenant) return;
    getUser(tenant, module).then(setUser);
    fetchTenants().then((all) => {
      const o = all.filter((t) => t.tenantId !== tenant.tenantId);
      setOthers(o);
      setTarget(o.find((t) => t.model === tenant.model)?.tenantId ?? o[0]?.tenantId ?? '');
    });
  }, [tenant, module]);

  if (!tenant) return <TenantState tenantId={tenantId} tenant={tenant} error={error} />;

  if (user === null) {
    return (
      <TenantShell tenant={tenant}>
        <div className="card narrow">
          <h2>{def.name}</h2>
          <p className="muted">You are not signed in to this module.</p>
          <button className="btn" onClick={() => signIn(tenant, module, true)}>Sign in</button>
        </div>
      </TenantShell>
    );
  }
  if (!user) return <main className="center-screen"><div className="spinner" /></main>;

  const at = user.access_token;
  const run = async (fn: () => Promise<ApiResult>) => {
    setBusy(true);
    try {
      const r = await fn();
      setResults((x) => [r, ...x].slice(0, 12));
    } finally {
      setBusy(false);
    }
  };
  const tampered = at.slice(0, -6) + (at.endsWith('AAAAAA') ? 'BBBBBB' : 'AAAAAA');
  const role = String(decodeJwt(at).role ?? 'user');

  return (
    <TenantShell
      tenant={tenant}
      right={
        <>
          <span className="who">{String(user.profile.email ?? user.profile.sub)}</span>
          <button className="btn ghost" onClick={() => signOut(tenant, module)}>Log out</button>
        </>
      }
    >
      <section className="module-head">
        <div>
          <p className="eyebrow">{tenant.appName}</p>
          <h1>{def.name}</h1>
          <p className="muted">Signed in through this module's own app client and login page.</p>
        </div>
        <nav className="module-nav">
          {MODULES.map((m) => (
            <button key={m.id} className={`tab ${m.id === module ? 'on' : ''}`} onClick={() => navigate(`/t/${tenant.tenantId}/m/${m.id}`)}>
              {m.name.split(' · ')[1]}
            </button>
          ))}
        </nav>
      </section>

      <section className="two-col">
        <div className="card">
          <h3>Sample API</h3>
          <p className="muted small">
            The API checks the access token's signature against the issuing pool's JWKS, then checks that
            <code> tenant_id</code>, the issuing app client, and the tenant in the URL all match.
          </p>
          <div className="api-buttons">
            <button disabled={busy} className="btn" onClick={() => run(() => callApi('My profile', `/t/${tenant.tenantId}/me`, at, 200))}>
              GET my tenant · /me
            </button>
            <button disabled={busy} className="btn" onClick={() => run(() => callApi('My tenant data', `/t/${tenant.tenantId}/data`, at, 200))}>
              GET my tenant · /data
            </button>
            <button disabled={busy} className="btn outline" onClick={() => run(() => callApi(`Admin route as "${role}"`, `/t/${tenant.tenantId}/admin`, at, role === 'admin' ? 200 : 403))}>
              GET /admin (role: {role})
            </button>
          </div>
          <div className="attack">
            <h4>Isolation tests</h4>
            <div className="attack-row">
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                {others.map((o) => (
                  <option key={o.tenantId} value={o.tenantId}>{o.displayName} ({o.model})</option>
                ))}
              </select>
              <button disabled={busy || !target} className="btn danger" onClick={() => run(() => callApi('Cross-tenant: my token, other tenant', `/t/${target}/data`, at, 403))}>
                Use my token on this tenant
              </button>
            </div>
            <div className="api-buttons">
              <button disabled={busy} className="btn danger outline" onClick={() => run(() => callApi('No token', `/t/${tenant.tenantId}/data`, undefined, 401))}>No token</button>
              <button disabled={busy} className="btn danger outline" onClick={() => run(() => callApi('Tampered signature', `/t/${tenant.tenantId}/data`, tampered, 401))}>Tampered token</button>
              <button disabled={busy} className="btn danger outline" onClick={() => run(() => callApi('ID token instead of access token', `/t/${tenant.tenantId}/data`, user.id_token, 401))}>ID token as bearer</button>
            </div>
          </div>
          <div className="results">
            {results.length === 0 && <p className="muted small">Results appear here.</p>}
            {results.map((r, i) => <Result key={`${r.path}-${i}-${r.ms}`} r={r} />)}
          </div>
        </div>

        <div className="card">
          <h3>Tokens</h3>
          <p className="muted small">The Pre-Token-Generation V2 Lambda adds the highlighted claims to both tokens.</p>
          <Claims title="Access token (sent to API)" token={at} />
          {user.id_token && <Claims title="ID token" token={user.id_token} />}
        </div>
      </section>
    </TenantShell>
  );
}
