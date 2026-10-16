/**
 * The REAL sample API, run locally (or in Docker): same lambda/api.ts handler that would run on
 * Lambda, verifying real Cognito tokens (public JWKS) and reading the real DynamoDB registry.
 *
 *   npm run infra:up      # once: creates the registry table + triggers, writes .poc/outputs.json
 *   npm run api           # http://localhost:8787
 */
import './lib/env';
import { readFileSync } from 'node:fs';
import { serveLambda } from './lib/http-adapter';

const o = JSON.parse(readFileSync('.poc/outputs.json', 'utf8')).CognitoPocPlatform;
process.env.TENANT_TABLE = o.TenantTable;
process.env.AWS_REGION = o.Region;
const { handler } = await import('../lambda/api');

const port = Number(process.env.PORT ?? 8787);
await serveLambda(handler, port);
console.log(`Sample API on http://localhost:${port}  (registry: ${o.TenantTable}, ${o.Region})`);
