/**
 * Vercel function entry point: every request to /api/* lands here and is handed to the same
 * lambda/api.ts handler that runs locally and in tests. Bundled by scripts/vercel-build.ts.
 *
 *   /api/public/tenants/acme  →  handler sees  /public/tenants/acme
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { handler } from '../../lambda/api';
import { setOidcToken } from '../../lambda/aws-credentials';

export default async function vercelApi(req: IncomingMessage, res: ServerResponse) {
  // Vercel's short-lived identity token, exchanged for AWS credentials (lambda/aws-credentials.ts)
  setOidcToken(req.headers['x-vercel-oidc-token'] as string | undefined);

  const url = new URL(req.url ?? '/', 'http://localhost');
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);

  const event = {
    rawPath: url.pathname.replace(/^\/api(?=\/|$)/, '') || '/',
    headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)])),
    requestContext: { http: { method: req.method ?? 'GET' } },
    body: chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined,
  } as unknown as APIGatewayProxyEventV2;

  try {
    const out = (await handler(event)) as APIGatewayProxyStructuredResultV2;
    res.writeHead(out.statusCode ?? 200, out.headers as Record<string, string>).end(out.body);
  } catch (e) {
    console.error(e);
    res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"internal_error"}');
  }
}
