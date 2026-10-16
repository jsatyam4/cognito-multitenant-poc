import { useEffect, useState } from 'react';
import { Directory } from './pages/Directory';
import { TenantHome } from './pages/TenantHome';
import { ModulePage } from './pages/ModulePage';
import { Callback } from './pages/Callback';
import { OwnLogin } from './pages/OwnLogin';
import { ThemeEditor } from './pages/ThemeEditor';
import type { ModuleId } from './lib';

function usePath() {
  const [path, setPath] = useState(window.location.pathname + window.location.search);
  useEffect(() => {
    const on = () => setPath(window.location.pathname + window.location.search);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return path;
}

/**
 * Routes (path-based tenancy, one codebase for every tenant):
 *   /                              tenant directory (POC convenience)
 *   /t/:tenantId                   tenant portal — 3 module tiles
 *   /t/:tenantId/login?module=     our own login page (scenario C tenants)
 *   /t/:tenantId/admin/branding    login theme editor (scenario C, tenant admins)
 *   /t/:tenantId/m/:module         signed-in module: tokens + API console
 *   /callback                      OIDC redirect URI shared by all clients
 * With a real domain the tenant would come from the subdomain (acme.ourapp.com) instead.
 */
export function App() {
  const full = usePath();
  const path = full.split('?')[0];
  if (path === '/callback') return <Callback />;
  const m = path.match(/^\/t\/([a-z0-9-]+)(?:\/(login|admin\/branding|m\/(module[123])))?\/?$/);
  if (m) {
    if (m[2] === 'login') return <OwnLogin key={full} tenantId={m[1]} />;
    if (m[2] === 'admin/branding') return <ThemeEditor key={full} tenantId={m[1]} />;
    if (m[3]) return <ModulePage key={full} tenantId={m[1]} module={m[3] as ModuleId} />;
    return <TenantHome key={full} tenantId={m[1]} />;
  }
  return <Directory />;
}
