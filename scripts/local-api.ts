/**
 * OFFLINE sample API: runs the real lambda/api.ts handler with the in-memory tenant registry and
 * locally signed tokens from tests/fixtures.ts. No AWS calls. For the real one, use `npm run api`.
 *
 *   npm run local:api                                  # http://localhost:8787
 *   POC_API_URL=http://localhost:8787 npm run dev:frontend
 *   curl localhost:8787/__local/tokens                 # demo access tokens per tenant
 */
import type { Server } from 'node:http';
import { accessToken, idToken, installMocks, TENANTS } from '../tests/fixtures';
import { serveLambda } from './lib/http-adapter';

installMocks();
const { handler } = await import('../lambda/api');

export function startLocalApi(port = 8787): Promise<Server> {
  return serveLambda(handler, port, (path) =>
    path === '/__local/tokens'
      ? Object.fromEntries(TENANTS.map((t) => [t.tenantId, { user: accessToken(t), admin: accessToken(t, { role: 'admin' }), idToken: idToken(t) }]))
      : undefined,
  );
}

if (process.argv[1]?.includes('local-api')) {
  const port = Number(process.env.PORT ?? 8787);
  await startLocalApi(port);
  console.log(`Offline sample API on http://localhost:${port}  (tenants: ${TENANTS.map((t) => t.tenantId).join(', ')})`);
  console.log(`Tokens:   curl http://localhost:${port}/__local/tokens`);
  console.log(`Frontend: POC_API_URL=http://localhost:${port} npm run dev:frontend`);
}
