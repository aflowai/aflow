import type postgres from 'postgres';

import { schemaNameToTenantId } from '../context.js';

/**
 * The operator's own tenant. Full Circle and Trading Joe are its spaces, and
 * only there did their owner choose `full`. A space of either name in another
 * tenant keeps the default.
 */
const OPERATOR_TENANT_ID = '00000000-0000-4000-8000-0000000ed1c0';

/**
 * A space keeps its autonomy posture and its Store update setting (Plan 345 D).
 * NULL reads as `ratify` and `follow-catalog`, so a space that never chose
 * keeps asking as before. In the operator's tenant alone, Full Circle and
 * Trading Joe take `full` explicitly. A space that has stored a choice keeps it.
 */
export async function applyMigration239(client: postgres.Sql, schema: string): Promise<void> {
  const grantFull =
    schemaNameToTenantId(schema) === OPERATOR_TENANT_ID
      ? `UPDATE "${schema}".spaces
      SET autonomy_policy = '{"autonomy":"full"}'::jsonb
      WHERE name IN ('Full Circle', 'Trading Joe') AND autonomy_policy IS NULL;`
      : '';
  await client.unsafe(`
    ALTER TABLE "${schema}".spaces
      ADD COLUMN IF NOT EXISTS autonomy_policy jsonb;
    ${grantFull}
    INSERT INTO "${schema}".schema_migrations (version, description)
    VALUES (239, 'Spaces keep an autonomy policy, and Full Circle and Trading Joe take full')
    ON CONFLICT (version) DO NOTHING;
  `);
}
