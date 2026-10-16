import { useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { federatedSignIn, MODULES, navigate, storeOwnSession, svgDataUrl, type ModuleId, type PublicTenantConfig } from '../lib';
import { TenantState, useTenant } from '../components/TenantShell';
import { OwnAuth, type Step } from '../ownAuth';
import type { TenantBranding, TenantTheme } from '../../../shared/types';

const FONTS: Record<TenantTheme['font'], string> = {
  system: "ui-sans-serif, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  serif: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif",
  rounded: "ui-rounded, 'SF Pro Rounded', 'Nunito', 'Segoe UI', sans-serif",
};

export const DEFAULT_THEME: TenantTheme = {
  layout: 'centered',
  font: 'system',
  radius: 12,
  welcomeTitle: 'Welcome',
  welcomeText: 'Sign in to continue.',
  buttonLabel: 'Sign in',
  footerText: '',
};

/** The tenant's themed login page frame. Used by the real login page and by the theme editor's live preview. */
export function LoginFrame({ tenant, theme, branding, children, preview }: {
  tenant: PublicTenantConfig;
  theme: TenantTheme;
  branding: TenantBranding;
  children: ReactNode;
  preview?: boolean;
}) {
  const style = {
    '--brand': branding.primary,
    '--brand-text': branding.primaryText,
    '--tenant-bg': branding.pageBackground,
    '--accent': branding.accent,
    '--ol-radius': `${theme.radius}px`,
    '--ol-font': FONTS[theme.font],
  } as CSSProperties;
  return (
    <div className={`own-login layout-${theme.layout}${preview ? ' preview' : ''}`} style={style}>
      {theme.layout === 'split' && (
        <aside className="ol-brand">
          <img src={svgDataUrl(branding.logoSvg)} alt={tenant.appName} className="ol-logo light" />
          <div>
            <h1>{theme.welcomeTitle}</h1>
            <p>{theme.welcomeText}</p>
          </div>
          <p className="ol-tagline">{tenant.tagline}</p>
        </aside>
      )}
      <main className="ol-main">
        <div className="ol-card">
          {theme.layout === 'centered' && (
            <>
              <img src={svgDataUrl(branding.logoSvg)} alt={tenant.appName} className="ol-logo" />
              <h1>{theme.welcomeTitle}</h1>
              <p className="muted">{theme.welcomeText}</p>
            </>
          )}
          {children}
        </div>
        {theme.footerText && <p className="ol-footer">{theme.footerText}</p>}
      </main>
    </div>
  );
}

export function OwnLogin({ tenantId }: { tenantId: string }) {
  const { tenant, error } = useTenant(tenantId);
  const module = (new URLSearchParams(window.location.search).get('module') as ModuleId) || 'module1';
  if (!tenant) return <TenantState tenantId={tenantId} tenant={tenant} error={error} />;
  if (tenant.loginMode !== 'own') {
    return (
      <TenantState tenantId={tenantId} tenant={tenant} error={`${tenant.displayName} uses Cognito's hosted login page. Open /t/${tenantId} to sign in.`} />
    );
  }
  return <LoginForm key={module} tenant={tenant} module={MODULES.some((m) => m.id === module) ? module : 'module1'} />;
}

type View = 'signin' | 'newPassword' | 'totp' | 'mfaSetup' | 'forgot' | 'forgotCode';

function LoginForm({ tenant, module }: { tenant: PublicTenantConfig; module: ModuleId }) {
  const theme = tenant.theme ?? DEFAULT_THEME;
  const client = tenant.modules[module];
  const auth = useMemo(() => new OwnAuth(tenant.userPoolId, client.clientId, tenant.appName), [tenant, client.clientId]);
  const [view, setView] = useState<View>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<{ secret: string; otpauth: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const go = async (p: Promise<Step>) => {
    setBusy(true);
    setProblem(null);
    const s = await p;
    setBusy(false);
    setPassword('');
    setCode('');
    if (s.kind === 'done') {
      await storeOwnSession(tenant, module, s.tokens);
      return navigate(`/t/${tenant.tenantId}/m/${module}`);
    }
    if (s.kind === 'error') return setProblem(s.message);
    if (s.kind === 'mfaSetup') setSetup({ secret: s.secret, otpauth: s.otpauth });
    if (s.kind === 'codeSent') setNotice(`If an account exists, a code was sent to ${s.destination}.`);
    if (s.kind === 'passwordReset') setNotice('Password updated. Sign in with your new password.');
    setView(({ newPassword: 'newPassword', totp: 'totp', mfaSetup: 'mfaSetup', codeSent: 'forgotCode', passwordReset: 'signin' } as const)[s.kind]);
  };
  const submit = (fn: () => Promise<Step>) => (e: FormEvent) => {
    e.preventDefault();
    void go(fn());
  };

  const federated = client.idps.filter((i) => i !== 'COGNITO');
  return (
    <LoginFrame tenant={tenant} theme={theme} branding={tenant.branding}>
      <nav className="ol-modules" aria-label="Module">
        {MODULES.map((m) => (
          <button key={m.id} type="button" className={m.id === module ? 'on' : ''} onClick={() => navigate(`/t/${tenant.tenantId}/login?module=${m.id}`)}>
            {m.name.split(' · ')[1]}
          </button>
        ))}
      </nav>

      {notice && <p className="ol-notice" role="status">{notice}</p>}
      {problem && <p className="ol-problem" role="alert">{problem}</p>}

      {view === 'signin' && client.idps.includes('COGNITO') && (
        <form onSubmit={submit(() => auth.signIn(email, password))} className="ol-form">
          <label>Email<input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <button className="btn ol-submit" disabled={busy}>{busy ? 'Signing in…' : theme.buttonLabel}</button>
          <button type="button" className="link small" onClick={() => { setNotice(null); setProblem(null); setView('forgot'); }}>Forgot your password?</button>
        </form>
      )}

      {view === 'newPassword' && (
        <form onSubmit={submit(() => auth.completeNewPassword(password))} className="ol-form">
          <p className="small">Choose a new password: at least 10 characters with upper and lower case letters, a number and a symbol.</p>
          <label>New password<input type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <button className="btn ol-submit" disabled={busy}>Set password</button>
        </form>
      )}

      {view === 'totp' && (
        <form onSubmit={submit(() => auth.submitTotp(code))} className="ol-form">
          <label>Code from your authenticator app<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required value={code} onChange={(e) => setCode(e.target.value)} /></label>
          <button className="btn ol-submit" disabled={busy}>Verify</button>
        </form>
      )}

      {view === 'mfaSetup' && setup && (
        <form onSubmit={submit(() => auth.verifyTotpSetup(code))} className="ol-form">
          <p className="small">{tenant.displayName} requires an authenticator app. Add this key to Google Authenticator, Microsoft Authenticator or 1Password, then enter the 6-digit code.</p>
          <code className="ol-secret">{setup.secret.match(/.{1,4}/g)?.join(' ')}</code>
          <a className="small" href={setup.otpauth}>Open in an authenticator app on this device</a>
          <label>6-digit code<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required value={code} onChange={(e) => setCode(e.target.value)} /></label>
          <button className="btn ol-submit" disabled={busy}>Verify and continue</button>
        </form>
      )}

      {view === 'forgot' && (
        <form onSubmit={submit(() => auth.forgotPassword(email))} className="ol-form">
          <label>Email<input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <button className="btn ol-submit" disabled={busy}>Send reset code</button>
          <button type="button" className="link small" onClick={() => setView('signin')}>Back to sign in</button>
        </form>
      )}

      {view === 'forgotCode' && (
        <form onSubmit={submit(() => auth.confirmForgotPassword(code, password))} className="ol-form">
          <label>Reset code<input inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} /></label>
          <label>New password<input type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <button className="btn ol-submit" disabled={busy}>Set new password</button>
        </form>
      )}

      {view === 'signin' && (federated.length > 0 || client.missing?.length) && (
        <div className="ol-federated">
          {client.idps.includes('COGNITO') && <span className="ol-or">or</span>}
          {federated.map((idp) => (
            <button key={idp} type="button" className="btn outline" onClick={() => federatedSignIn(tenant, module, idp)}>Continue with {idp}</button>
          ))}
          {client.missing?.map((m) => (
            <button key={m} type="button" className="btn outline" disabled title="Add identity provider credentials and re-onboard">
              {m === 'microsoft' ? 'Microsoft' : 'Google'} sign-in: credentials pending
            </button>
          ))}
        </div>
      )}

      <button type="button" className="link small ol-back" onClick={() => navigate(`/t/${tenant.tenantId}`)}>← {tenant.appName} home</button>
    </LoginFrame>
  );
}
