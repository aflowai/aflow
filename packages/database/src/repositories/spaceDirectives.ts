import { and, eq, sql } from 'drizzle-orm';
import { spaces } from '../schema/tenant.js';

export function spaceDirectivesUpdateGuard(spaceId: string, expectedDirectives: unknown) {
  return and(
    eq(spaces.id, spaceId),
    expectedDirectives === undefined
      ? undefined
      : sql`${spaces.directives} IS NOT DISTINCT FROM ${JSON.stringify(expectedDirectives)}::jsonb`,
  );
}
