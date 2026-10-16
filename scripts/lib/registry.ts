/** Writes to the tenant registry: the tenant row plus its client#/pool# lookup rows (see shared/types). */
import { DeleteCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, outputs } from './common';
import { clientKey, poolKey, type TenantRecord } from '../../shared/types';

export async function putTenant(t: TenantRecord) {
  const TableName = outputs().TenantTable;
  await ddb.send(new PutCommand({ TableName, Item: t }));
  for (const [module, c] of Object.entries(t.modules)) {
    await ddb.send(new PutCommand({ TableName, Item: { tenantId: clientKey(c.clientId), kind: 'client', ref: t.tenantId, module } }));
  }
  await ddb.send(
    new UpdateCommand({
      TableName,
      Key: { tenantId: poolKey(t.userPoolId) },
      UpdateExpression: 'SET kind = :k ADD refs :r',
      ExpressionAttributeValues: { ':k': 'pool', ':r': new Set([t.tenantId]) },
    }),
  );
}

export async function removeTenant(t: TenantRecord) {
  const TableName = outputs().TenantTable;
  for (const c of Object.values(t.modules)) {
    await ddb.send(new DeleteCommand({ TableName, Key: { tenantId: clientKey(c.clientId) } }));
  }
  const res = await ddb.send(
    new UpdateCommand({
      TableName,
      Key: { tenantId: poolKey(t.userPoolId) },
      UpdateExpression: 'DELETE refs :r',
      ExpressionAttributeValues: { ':r': new Set([t.tenantId]) },
      ReturnValues: 'ALL_NEW',
    }),
  );
  if (!res.Attributes?.refs?.size) await ddb.send(new DeleteCommand({ TableName, Key: { tenantId: poolKey(t.userPoolId) } }));
  await ddb.send(new DeleteCommand({ TableName, Key: { tenantId: t.tenantId } }));
}
