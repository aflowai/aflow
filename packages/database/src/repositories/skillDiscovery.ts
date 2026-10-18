import { tokenizeQuery } from '@aflow/schemas/catalog';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { listPlatformSkillBundles } from '@aflow/platform-artifacts';
import { SkillDiscoveryEntrySchema, type SkillDiscoveryEntry, type TenantId } from '@aflow/schemas';
import { createTenantContext } from '../tenant/context.js';
import { withTenantSchema } from '../tenant/queries.js';

export async function querySkillDiscovery(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  spaceId: string,
  options: {
    query?: string;
    offset?: number;
    limit?: number;
    excludedSlugs?: string[];
    onlySlugs?: string[];
  } = {},
): Promise<{ skills: SkillDiscoveryEntry[]; total: number }> {
  const platform = listPlatformSkillBundles().map((bundle) => bundle.workflow);
  const platformValues = platform.map(
    (w) => sql`(${w.slug}::text, ${w.name}::text, ${w.description}::text,
    ${w.mode}::text, ${w.status}::text, ${w.revision}::integer, 'platform'::text)`,
  );
  const platformCte = platformValues.length
    ? sql`VALUES ${sql.join(platformValues, sql`, `)}`
    : sql`SELECT NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::integer, NULL::text WHERE false`;
  const terms = tokenizeQuery(options.query ?? '');
  const searchable = sql`lower(slug || ' ' || name || ' ' || description)`;
  const escapeLike = (value: string): string => value.replace(/[\\%_]/g, '\\$&');
  const conditions = [sql`status NOT IN ('abandoned', 'archived')`];
  const matches = terms.map((term) => sql`${searchable} LIKE ${`%${escapeLike(term)}%`}`);
  if (matches.length) conditions.push(sql`(${sql.join(matches, sql` OR `)})`);
  const relevance = terms.length
    ? sql.join(
        terms.map(
          (term) =>
            sql`(CASE WHEN lower(name) LIKE ${`%${escapeLike(term)}%`} THEN 5 ELSE 0 END + CASE WHEN lower(slug) LIKE ${`%${escapeLike(term)}%`} THEN 3 ELSE 0 END + CASE WHEN lower(description) LIKE ${`%${escapeLike(term)}%`} THEN 1 ELSE 0 END)`,
        ),
        sql` + `,
      )
    : sql`0::integer`;
  if (options.excludedSlugs?.length)
    conditions.push(
      sql`slug NOT IN (${sql.join(
        options.excludedSlugs.map((s) => sql`${s}`),
        sql`, `,
      )})`,
    );
  if (options.onlySlugs)
    conditions.push(
      options.onlySlugs.length
        ? sql`slug IN (${sql.join(
            options.onlySlugs.map((s) => sql`${s}`),
            sql`, `,
          )})`
        : sql`false`,
    );
  const exact = (options.query ?? '').toLowerCase();
  if (exact)
    conditions.push(
      sql`(lower(slug) = ${exact} OR NOT EXISTS (SELECT 1 FROM library WHERE lower(slug) = ${exact}))`,
    );
  const filter = sql.join(conditions, sql` AND `);
  return withTenantSchema(db, createTenantContext(tenantId), async (tx) => {
    const cte = sql`WITH platform(slug, name, description, mode, status, revision, origin) AS (${platformCte}),
      library AS (SELECT * FROM platform UNION ALL SELECT slug, name, description, mode, status, revision, 'space' AS origin
        FROM skill_discovery WHERE space_id = ${spaceId} AND slug NOT IN (SELECT slug FROM platform))`;
    const countRows = await tx.execute(
      sql`${cte} SELECT count(*)::integer AS total FROM library WHERE ${filter}`,
    );
    const rows = await tx.execute(sql`${cte} SELECT * FROM library WHERE ${filter}
      ORDER BY CASE WHEN lower(slug) = ${exact} THEN 0 WHEN lower(name) = ${exact} THEN 1 ELSE 2 END, (${relevance}) DESC, slug
      LIMIT ${options.limit ?? 20} OFFSET ${options.offset ?? 0}`);
    const count = countRows[0] as { total?: number } | undefined;
    return {
      skills: rows.map((row) => SkillDiscoveryEntrySchema.parse(row)),
      total: count?.total ?? 0,
    };
  });
}
