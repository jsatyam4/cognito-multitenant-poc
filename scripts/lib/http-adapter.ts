/** Serves an API Gateway (HTTP API, payload v2) Lambda handler over plain Node HTTP, for local runs. */
import { createServer, type Server } from 'node:http';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

type Handler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>;

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, PUT, OPTIONS',
};

export function serveLambda(handler: Handler, port: number, extra?: (path: string) => unknown): Promise<Server> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'OPTIONS') return void res.writeHead(204, CORS).end();
    const special = extra?.(url.pathname);
    if (special !== undefined) {
      return void res.writeHead(200, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify(special, null, 2));
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const event = {
      rawPath: url.pathname,
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)])),
      requestContext: { http: { method: req.method ?? 'GET' } },
      body: chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined,
    } as unknown as APIGatewayProxyEventV2;
    try {
      const out = (await handler(event)) as APIGatewayProxyStructuredResultV2;
      res.writeHead(out.statusCode ?? 200, { ...CORS, ...(out.headers as Record<string, string>) }).end(out.body);
    } catch (e) {
      console.error(e);
      res.writeHead(500, { ...CORS, 'content-type': 'application/json' }).end('{"error":"internal_error"}');
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
