import './env';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LoginMode, TenantBranding, TenantModel, TenantRecord, TenantTheme } from '../../shared/types';

export interface PocConfig {
  region: string;
  resourcePrefix: string;
  demoEmailTemplate: string;
  forcePromptLogin: boolean;
  localDevOrigin: string;
  /** Free-tier guardrails: scripts refuse to go past these */
  limits: { maxTenants: number; maxUsersPerTenant: number };
}

export interface Outputs {
  AppUrl: string;
  ApiUrl: string;
  TenantTable: string;
  PreTokenFnArn: string;
  PreAuthFnArn: string;
  Region: string;
  AccountId: string;
}

export interface IdpCreds {
  microsoft?: { clientId: string; clientSecret: string; entraTenantId: string };
  google?: { clientId: string; clientSecret: string };
}

export interface TenantFile {
  slug: string;
  displayName: string;
  appName: string;
  tagline: string;
  branding: TenantBranding;
  loginMode?: LoginMode;
  theme?: TenantTheme;
  allowedEmailDomains?: string[];
}

export const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
export function writeJson(p: string, v: unknown) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2));
}

export const config = readJson<PocConfig>('config/poc.config.json');

/** Values kept out of git, read from .env (see .env.example). */
function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. Add it to .env (see .env.example).`);
  return v;
}

/** Password given to every seeded demo user (DEMO_PASSWORD in .env). */
export const demoPassword = () => requiredEnv('DEMO_PASSWORD');

let accountChecked: Promise<string> | undefined;
/**
 * Refuses to continue unless the AWS credentials in use belong to AWS_ACCOUNT_ID (from .env),
 * so a wrong AWS profile can never create or delete resources in another account.
 */
export function assertAwsAccount(): Promise<string> {
  accountChecked ??= new STSClient({ region: config.region })
    .send(new GetCallerIdentityCommand({}))
    .then(({ Account }) => {
      const expected = requiredEnv('AWS_ACCOUNT_ID');
      if (Account !== expected) throw new Error(`AWS credentials are for account ${Account}, but .env says AWS_ACCOUNT_ID=${expected}. Stopping.`);
      return Account;
    });
  return accountChecked;
}

export function outputs(): Outputs {
  const f = '.poc/outputs.json';
  if (!existsSync(f)) {
    throw new Error('Missing .poc/outputs.json — run `npm run deploy` first (it writes the stack outputs there).');
  }
  const all = readJson<Record<string, Outputs>>(f);
  return all.CognitoPocPlatform;
}

export function idpCreds(): IdpCreds {
  const f = 'config/idp.local.json';
  if (!existsSync(f)) return {};
  const raw = readJson<IdpCreds & { _comment?: string }>(f);
  const valid: IdpCreds = {};
  const placeholder = (s?: string) => !s || /^0{8}-|your-|GOCSPX-your|1234567890-abc/.test(s);
  if (raw.microsoft && !placeholder(raw.microsoft.clientId) && !placeholder(raw.microsoft.clientSecret)) valid.microsoft = raw.microsoft;
  if (raw.google && !placeholder(raw.google.clientId) && !placeholder(raw.google.clientSecret)) valid.google = raw.google;
  return valid;
}

export const cognito = new CognitoIdentityProviderClient({ region: config.region });
export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.region }));

export function loadTenantFile(slug: string): TenantFile {
  const f = `tenants/${slug}.json`;
  if (!existsSync(f)) throw new Error(`No tenant definition at ${f}`);
  return readJson<TenantFile>(f);
}

export const tenantIdFor = (slug: string, model: TenantModel) => (model === 'shared' ? `${slug}-shared` : slug);

/** Cognito prefix domains are global per region, so add a short account-derived suffix. */
export function domainPrefix(label: string, accountId: string): string {
  const h = createHash('sha1').update(`${accountId}:${config.region}`).digest('hex').slice(0, 6);
  return `${config.resourcePrefix}-${label}-${h}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

export const loginDomainUrl = (prefix: string) => `https://${prefix}.auth.${config.region}.amazoncognito.com`;
export const issuerFor = (userPoolId: string) => `https://cognito-idp.${config.region}.amazonaws.com/${userPoolId}`;

export async function getTenant(tenantId: string): Promise<TenantRecord | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: outputs().TenantTable, Key: { tenantId } }));
  return res.Item as TenantRecord | undefined;
}

export async function listTenants(): Promise<TenantRecord[]> {
  const items: TenantRecord[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(new ScanCommand({ TableName: outputs().TenantTable, ExclusiveStartKey }));
    items.push(...((r.Items ?? []) as TenantRecord[]));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  // Skip client#… / pool#… lookup rows (see shared/types)
  return items.filter((t) => !t.tenantId.includes('#')).sort((a, b) => a.tenantId.localeCompare(b.tenantId));
}

export function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return fallback;
}
export const flag = (name: string) => process.argv.includes(`--${name}`);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Records each onboarding step and its wall-clock duration (requirement 8). */
export class StepTimer {
  steps: Array<{ step: string; ms: number; detail?: string }> = [];
  private t0 = Date.now();
  async step<T>(name: string, fn: () => Promise<T>, detail?: (r: T) => string): Promise<T> {
    const s = Date.now();
    process.stdout.write(`  • ${name} … `);
    try {
      const r = await fn();
      const ms = Date.now() - s;
      const d = detail?.(r);
      this.steps.push({ step: name, ms, detail: d });
      console.log(`${(ms / 1000).toFixed(2)}s${d ? `  (${d})` : ''}`);
      return r;
    } catch (e) {
      console.log('FAILED');
      throw e;
    }
  }
  get totalSeconds() {
    return Number(((Date.now() - this.t0) / 1000).toFixed(2));
  }
}

/** Demo login emails. Use plus-addressing on a real inbox so "forgot password" emails arrive. */
export function demoEmail(tenant: string, user: string): string {
  const tpl = config.demoEmailTemplate;
  if (!tpl || tpl.includes('CHANGE_ME')) return `${user}.${tenant}@example.com`;
  return tpl.replace('{tenant}', tenant).replace('{user}', user);
}
