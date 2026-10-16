import { useEffect, useMemo, useState } from 'react';
import { applyTheme, decodeJwt, fetchTenant, forgetTenant, getApiUrl, getUser, MODULES, navigate, type PublicTenantConfig } from '../lib';
import { TenantShell, TenantState, useTenant } from '../components/TenantShell';
import { DEFAULT_THEME, LoginFrame } from './OwnLogin';
import { contrastRatio, validateThemeUpdate, type ThemeUpdate } from '../../../shared/theme';
import { faviconSvg, logoSvg } from '../../../shared/branding-assets';
import type { TenantTheme } from '../../../shared/types';

/** Tenant admins edit their own login page's look. Saved to the registry through the API: no deploy. */
export function ThemeEditor({ tenantId }: { tenantId: string }) {
  const { tenant, error } = useTenant(tenantId);
  const [token, setToken] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!tenant) return;
    // Any module session whose access token says role=admin may edit
    Promise.all(MODULES.map((m) => getUser(tenant, m.id))).then((users) => {
      const admin = users.find((u) => u && decodeJwt(u.access_token).role === 'admin');
      setToken(admin?.access_token ?? null);
    });
  }, [tenant]);

  if (!tenant) return <TenantState tenantId={tenantId} tenant={tenant} error={error} />;
  if (tenant.loginMode !== 'own') {
    return (
      <TenantShell tenant={tenant}>
        <div className="card narrow">
          <h2>Login theme</h2>
          <p className="muted">{tenant.displayName} uses Cognito's hosted login page. Its branding changes with <code>npm run rebrand</code> (one Cognito API call per module, no deploy).</p>
        </div>
      </TenantShell>
    );
  }
  if (token === undefined) return <main className="center-screen"><div className="spinner" /></main>;
  if (token === null) {
    return (
      <TenantShell tenant={tenant}>
        <div className="card narrow">
          <h2>Sign in as an admin</h2>
          <p className="muted">Only {tenant.displayName} admins can edit the login theme.</p>
          <button className="btn" onClick={() => navigate(`/t/${tenant.tenantId}/login?module=module1`)}>Sign in</button>
        </div>
      </TenantShell>
    );
  }
  return <Editor tenant={tenant} token={token} />;
}

function Editor({ tenant, token }: { tenant: PublicTenantConfig; token: string }) {
  const [draft, setDraft] = useState<ThemeUpdate>({
    theme: tenant.theme ?? DEFAULT_THEME,
    primary: tenant.branding.primary,
    primaryText: tenant.branding.primaryText,
    pageBackground: tenant.branding.pageBackground,
  });
  const [saved, setSaved] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const errors = validateThemeUpdate(draft);
  const branding = useMemo(() => {
    const b = { ...tenant.branding, primary: draft.primary, primaryText: draft.primaryText, pageBackground: draft.pageBackground };
    return { ...b, logoSvg: logoSvg(tenant.appName, b), faviconSvg: faviconSvg(tenant.appName, b) };
  }, [tenant, draft.primary, draft.primaryText, draft.pageBackground]);

  const setTheme = <K extends keyof TenantTheme>(k: K, v: TenantTheme[K]) => setDraft((d) => ({ ...d, theme: { ...d.theme, [k]: v } }));
  const setColour = (k: 'primary' | 'primaryText' | 'pageBackground', v: string) => setDraft((d) => ({ ...d, [k]: v.toUpperCase() }));

  const save = async () => {
    setBusy(true);
    setSaved(null);
    setServerErrors([]);
    const res = await fetch(`${await getApiUrl()}/t/${tenant.tenantId}/theme`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(draft),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setServerErrors(body.errors ?? [body.message ?? body.error ?? `HTTP ${res.status}`]);
    forgetTenant(tenant.tenantId);
    const fresh = await fetchTenant(tenant.tenantId);
    applyTheme(fresh);
    setSaved(`Saved at ${new Date().toLocaleTimeString()}. Live on the next load of the login page — no deploy.`);
  };

  const text = (k: 'welcomeTitle' | 'welcomeText' | 'buttonLabel' | 'footerText', label: string, max: number, area = false) => (
    <label>
      {label} <span className="muted small">{draft.theme[k].length}/{max}</span>
      {area ? (
        <textarea rows={2} maxLength={max} value={draft.theme[k]} onChange={(e) => setTheme(k, e.target.value)} />
      ) : (
        <input maxLength={max} value={draft.theme[k]} onChange={(e) => setTheme(k, e.target.value)} />
      )}
    </label>
  );
  const colour = (k: 'primary' | 'primaryText' | 'pageBackground', label: string) => (
    <label className="te-colour">
      {label}
      <span>
        <input type="color" value={draft[k]} onChange={(e) => setColour(k, e.target.value)} />
        <input className="mono" value={draft[k]} maxLength={7} onChange={(e) => setColour(k, e.target.value)} />
      </span>
    </label>
  );

  return (
    <TenantShell tenant={tenant}>
      <section className="module-head">
        <div>
          <p className="eyebrow">Login theme · {tenant.displayName}</p>
          <h1>Edit your login page</h1>
          <p className="muted">Changes preview instantly and go live on save. The same rules are checked again by the API.</p>
        </div>
        <button className="btn outline" onClick={() => navigate(`/t/${tenant.tenantId}/login`)}>Open login page</button>
      </section>

      <section className="te-grid">
        <div className="card te-form">
          <h3>Layout</h3>
          <div className="te-row">
            <label>Layout
              <select value={draft.theme.layout} onChange={(e) => setTheme('layout', e.target.value as TenantTheme['layout'])}>
                <option value="centered">Centred card</option>
                <option value="split">Split, brand panel</option>
              </select>
            </label>
            <label>Font
              <select value={draft.theme.font} onChange={(e) => setTheme('font', e.target.value as TenantTheme['font'])}>
                <option value="system">System</option>
                <option value="serif">Serif</option>
                <option value="rounded">Rounded</option>
              </select>
            </label>
            <label>Corner radius <span className="muted small">{draft.theme.radius}px</span>
              <input type="range" min={0} max={24} value={draft.theme.radius} onChange={(e) => setTheme('radius', Number(e.target.value))} />
            </label>
          </div>
          <h3>Colours</h3>
          <div className="te-row">
            {colour('primary', 'Primary')}
            {colour('primaryText', 'Button text')}
            {colour('pageBackground', 'Page background')}
          </div>
          <p className="small muted">Button contrast {contrastRatio(draft.primary, draft.primaryText).toFixed(1)}:1 (min 3:1)</p>
          <h3>Text</h3>
          {text('welcomeTitle', 'Welcome title', 60)}
          {text('welcomeText', 'Welcome text', 160, true)}
          {text('buttonLabel', 'Sign-in button', 24)}
          {text('footerText', 'Footer', 120, true)}

          {(errors.length > 0 || serverErrors.length > 0) && (
            <ul className="te-errors">{[...errors, ...serverErrors].map((e) => <li key={e}>{e}</li>)}</ul>
          )}
          {saved && <p className="signed">{saved}</p>}
          <button className="btn" disabled={busy || errors.length > 0} onClick={save}>{busy ? 'Saving…' : 'Save theme'}</button>
        </div>

        <div className="te-preview">
          <p className="eyebrow">Live preview</p>
          <LoginFrame tenant={tenant} theme={draft.theme} branding={branding} preview>
            <div className="ol-form">
              <label>Email<input disabled placeholder="name@company.com" /></label>
              <label>Password<input disabled type="password" placeholder="••••••••••" /></label>
              <button className="btn ol-submit" type="button">{draft.theme.buttonLabel}</button>
            </div>
          </LoginFrame>
        </div>
      </section>
    </TenantShell>
  );
}
