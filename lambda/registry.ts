import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { clientKey, poolKey, type ClientLookup, type ModuleId, type PoolLookup, type TenantBranding, type TenantRecord, type TenantTheme } from '../shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TENANT_TABLE!;
const TTL_MS = 30_000;
/** Misses are cached briefly too, so requests for random ids can't hammer the table. */
const MISS_TTL_MS = 5_000;

/**
 * Tenant registry lookups. Every runtime read (triggers, API auth) is ONE GetItem by key:
 * tenant id, `client#<id>` or `pool#<id>` (see shared/types). Results are cached per key for
 * 30 s, so a new or changed tenant is picked up within that window, with no deploy.
 */
const cache = new Map<string, { at: number; value: unknown }>();

async function getItem<T>(key: string): Promise<T | undefined> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.value === undefined ? MISS_TTL_MS : TTL_MS)) return hit.value as T | undefined;
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { tenantId: key } }));
  const value = res.Item as T | undefined;
  cache.set(key, { at: Date.now(), value });
  return value;
}

const isTenantRow = (item: { tenantId: string }) => !item.tenantId.includes('#');
const active = (t: TenantRecord | undefined) => (t && t.status === 'active' ? t : undefined);

export async function tenantById(tenantId: string): Promise<TenantRecord | undefined> {
  if (!tenantId || tenantId.includes('#')) return undefined;
  return active(await getItem<TenantRecord>(tenantId));
}

export async function tenantByClientId(
  clientId: string,
): Promise<{ tenant: TenantRecord; module: ModuleId } | undefined> {
  const link = await getItem<ClientLookup>(clientKey(clientId));
  const tenant = link && (await tenantById(link.ref));
  return tenant ? { tenant, module: link.module } : undefined;
}

/** Tenants whose user pool issued tokens with this `iss` (one for pool-per-tenant, several for a shared pool). */
export async function tenantsByIssuer(iss: string): Promise<TenantRecord[]> {
  const m = /^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/([a-z0-9-]+_[A-Za-z0-9]+)$/.exec(iss);
  if (!m) return [];
  const link = await getItem<PoolLookup>(poolKey(m[1]));
  const refs = link ? [...link.refs] : [];
  const tenants = await Promise.all(refs.map((id) => tenantById(id)));
  return tenants.filter((t): t is TenantRecord => Boolean(t) && t!.issuer === iss);
}

/** Theme editor save (admin only, checked by the API). Clears this instance's cache for the tenant. */
export async function saveTheme(tenantId: string, theme: TenantTheme, branding: TenantBranding): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { tenantId },
      UpdateExpression: 'SET theme = :t, branding = :b',
      ConditionExpression: 'attribute_exists(tenantId)',
      ExpressionAttributeValues: { ':t': theme, ':b': branding },
    }),
  );
  cache.delete(tenantId);
  listCache = undefined;
}

let listCache: { at: number; tenants: TenantRecord[] } | undefined;
/** Public tenant directory only (not on any auth path). Scans, filters out lookup rows, caches 30 s. */
export async function allTenants(force = false): Promise<TenantRecord[]> {
  if (!force && listCache && Date.now() - listCache.at < TTL_MS) return listCache.tenants;
  const items: TenantRecord[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey }));
    items.push(...((res.Items ?? []) as TenantRecord[]));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  listCache = { at: Date.now(), tenants: items.filter((t) => isTenantRow(t) && t.status === 'active') };
  return listCache.tenants;
}
