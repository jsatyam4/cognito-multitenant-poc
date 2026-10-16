import { useEffect, useRef, useState } from 'react';
import { completeSignIn, navigate } from '../lib';

export function Callback() {
  const [error, setError] = useState<string | null>(null);
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return; // StrictMode double-invoke would reuse the one-time code
    once.current = true;
    const qs = new URLSearchParams(window.location.search);
    if (qs.get('error')) {
      setError(`${qs.get('error')}: ${qs.get('error_description') ?? ''}`);
      return;
    }
    completeSignIn()
      .then(({ tenantId, module }) => navigate(`/t/${tenantId}/m/${module}`))
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <main className="center-screen">
      {error ? (
        <div className="card narrow">
          <h2>Sign-in failed</h2>
          <p className="mono wrap">{error}</p>
          <p className="muted">
            A Cognito trigger rejection (e.g. wrong tenant in the shared pool) shows up here as
            <code> PreTokenGeneration failed</code>.
          </p>
          <button className="btn" onClick={() => navigate('/')}>Back to tenants</button>
        </div>
      ) : (
        <div className="spinner-wrap">
          <div className="spinner" />
          <p className="muted">Exchanging authorization code (PKCE)…</p>
        </div>
      )}
    </main>
  );
}
