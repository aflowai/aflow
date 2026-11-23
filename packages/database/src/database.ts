import type { PgDatabase } from 'drizzle-orm/pg-core';
import type { PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js';

/**
 * The query handle every repository and tenant helper takes.
 *
 * It is the base class that the root postgres-js database and its
 * transactions both extend. A transaction is therefore a real instance of it,
 * and `withTenantSchema` passes its transaction to helpers without a cast.
 */
export type Database = PgDatabase<PostgresJsQueryResultHKT>;
