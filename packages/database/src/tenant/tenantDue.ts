/**
 * Public-schema due pointers: how a fleet-wide background task learns which
 * tenants have work without asking every tenant whether it has any.
 *
 * A task whose predicate lives in per-tenant tables can only discover work by
 * enumerating schemas, and that cost tracks tenant count rather than pending
 * work. A pointer holds one row per tenant that has work, scored by the
 * earliest time that work comes due, and the task reads only it.
 *
 * Three properties make a pointer safe, and all three are structural rather
 * than conventional:
 *
 * Arming is a row trigger, never a call in the write primitives. Due times are
 * written from many call sites across several packages, including raw SQL
 * cascades and FK cascades that never pass through TypeScript; no
 * hand-maintained set of arming call sites stays complete against that, and the
 * one that lapses is invisible until work hangs. A trigger fires inside the
 * statement that writes the tenant row, so it covers every writer — including
 * writers that do not exist yet — and costs none of them a round trip.
 *
 * Disarming has no trigger at all. The pointer may be earlier than the truth
 * but never later, so a row whose work has gone is a wasted claim rather than
 * lost work: the claimant recomputes the tenant's next due time from the
 * authoritative predicates and either moves the pointer forward or drops it.
 * That is what lets deletes and cascades need no pointer maintenance at all.
 *
 * Seeding happens in the migration that installs the triggers. Triggers only
 * fire on future writes, and most of what is outstanding when they arrive is
 * never written again — for some domains the only thing that would rewrite the
 * row is the very work the pointer was supposed to trigger.
 *
 * Each domain gets its own pointer table rather than sharing one with a domain
 * column: a claim then never contends with, or has to filter past, another
 * domain's rows, and each index stays the size of its own backlog.
 */

/** Renders a column reference for the context the predicate is used in. */
type ColumnRef = (column: string) => string;

/** Renders a tenant table name qualified for the schema being rendered. */
type TableRef = (table: string) => string;

export interface TenantDueSource {
  /** Tenant table carrying a due time the task selects on. */
  readonly table: string;
  /** The column holding it. */
  readonly dueColumn: string;
  /**
   * Columns whose write can change whether or when the row is due. A column
   * that flips eligibility belongs here even when it is not a timestamp — an
   * unpause writes `status` and no due column at all.
   */
  readonly writtenBy: readonly string[];
  /** When a row of this table is work the task must eventually do. */
  readonly reconcilable: (ref: ColumnRef) => string;
  /**
   * A further condition the recompute applies and the trigger cannot: a trigger
   * `WHEN` clause may not contain a subquery, so a predicate that has to reach
   * another table lives here.
   *
   * Narrowing the settle below the arming predicate is the safe direction — the
   * pointer may be earlier than the truth but never later, so the extra arms
   * cost a claim while the recompute, which is what the task itself selects on,
   * still decides whether the tenant has work. Widening it would not be: rows
   * the trigger never sees would be settled past.
   */
  readonly recomputeOnly?: (qualify: TableRef) => string;
  /**
   * Distinguishes this source's trigger when a pointer arms twice on one table.
   * Without it the second `CREATE TRIGGER` drops the first, since the trigger is
   * otherwise named for the pointer alone.
   */
  readonly triggerSuffix?: string;
}

export interface TenantDuePointer {
  /** Fully qualified public pointer table. */
  readonly table: string;
  /**
   * Trigger and arming-function name. One per pointer rather than one shared
   * function taking the table as an argument: a shared body would have to reach
   * its table through dynamic SQL, and `EXECUTE` re-plans on every fire — a
   * cost paid by the source write, which is the one thing a due pointer is not
   * allowed to charge.
   */
  readonly trigger: string;
  /**
   * Every due time the task selects on. One list feeds both the triggers that
   * arm the pointer and the recompute that settles it, so a source can never be
   * armed without entering the recompute or the reverse.
   */
  readonly sources: readonly TenantDueSource[];
}

/**
 * The pointer table and the trigger body that maintains it.
 *
 * Emitted by both the public migration and the per-tenant one: a tenant schema
 * created at signup runs its own migrations, and a trigger whose target table
 * does not exist fails the first write to the source rather than the migration.
 */
export function tenantDuePointerDdl(pointer: TenantDuePointer): string {
  const bareTable = pointer.table.split('.')[1] ?? pointer.table;
  return `
    CREATE TABLE IF NOT EXISTS ${pointer.table} (
      tenant_id   UUID PRIMARY KEY,
      due_at      TIMESTAMPTZ NOT NULL,
      armed_seq   BIGINT NOT NULL DEFAULT 0,
      lease_until TIMESTAMPTZ,
      claimed_by  TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_${bareTable}_ready
      ON ${pointer.table} (due_at);

    -- The upsert takes the row lock even when it changes nothing, and that is
    -- load-bearing: a settle that recomputed before this write committed would
    -- otherwise push the pointer past work it never saw. Blocking here means
    -- the writer re-reads the settled value and lowers it.
    CREATE OR REPLACE FUNCTION public.${pointer.trigger}() RETURNS trigger
    LANGUAGE plpgsql AS $arm$
    DECLARE
      due_time TIMESTAMPTZ := (to_jsonb(NEW) ->> TG_ARGV[0])::timestamptz;
    BEGIN
      INSERT INTO ${pointer.table} AS d (tenant_id, due_at, armed_seq)
      VALUES (substring(TG_TABLE_SCHEMA from 3)::uuid, due_time, 1)
      ON CONFLICT (tenant_id) DO UPDATE
         -- Lower the pointer only if this arm is earlier, but count the arm
         -- either way. The counter is what tells a settle in flight that work
         -- landed after its snapshot, and work arriving with a *later* due time
         -- is the common case — a settle that could not see it would recompute
         -- an empty tenant and delete the pointer out from under it.
         SET due_at = LEAST(d.due_at, EXCLUDED.due_at),
             armed_seq = d.armed_seq + 1,
             updated_at = now();
      RETURN NULL;
    END;
    $arm$;
  `;
}

/** The trigger that arms one source — named for the pointer, plus the source's
 *  own suffix when a pointer arms more than once on the same table. */
export function tenantDueTriggerName(pointer: TenantDuePointer, source: TenantDueSource): string {
  return source.triggerSuffix ? `${pointer.trigger}_${source.triggerSuffix}` : pointer.trigger;
}

/** Install the arming triggers on one tenant schema. */
export function tenantDueTriggerDdl(pointer: TenantDuePointer, schemaName: string): string {
  return pointer.sources
    .map((source) => {
      const triggerName = tenantDueTriggerName(pointer, source);
      return `
    DROP TRIGGER IF EXISTS ${triggerName} ON "${schemaName}".${source.table};
    CREATE TRIGGER ${triggerName}
      AFTER INSERT OR UPDATE OF ${source.writtenBy.join(', ')}
      ON "${schemaName}".${source.table}
      FOR EACH ROW
      WHEN (${source.reconcilable((column) => `NEW.${column}`)})
      EXECUTE FUNCTION public.${pointer.trigger}('${source.dueColumn}');
  `;
    })
    .join('\n');
}

/**
 * A scalar SQL expression for the earliest time one tenant has work in this
 * domain, or NULL when it has none. `LEAST` ignores NULL arguments, so a source
 * with nothing outstanding simply drops out.
 */
export function tenantDueRecomputeSql(pointer: TenantDuePointer, schemaName: string): string {
  const qualify: TableRef = (table) => `"${schemaName}".${table}`;
  const perSource = pointer.sources.map((source) => {
    const bare: ColumnRef = (column) => column;
    const predicate = source.recomputeOnly
      ? `${source.reconcilable(bare)} AND ${source.recomputeOnly(qualify)}`
      : source.reconcilable(bare);
    return `(SELECT min(${source.dueColumn}) FROM ${qualify(source.table)} WHERE ${predicate})`;
  });
  return `LEAST(${perSource.join(', ')})`;
}

/** Arm the pointer from the rows a tenant schema already holds. */
export function tenantDueSeedDdl(pointer: TenantDuePointer, schemaName: string): string {
  return `
    INSERT INTO ${pointer.table} AS d (tenant_id, due_at, armed_seq)
    SELECT substring('${schemaName}' from 3)::uuid, seed.next_due, 1
      FROM (SELECT ${tenantDueRecomputeSql(pointer, schemaName)} AS next_due) seed
     WHERE seed.next_due IS NOT NULL
    ON CONFLICT (tenant_id) DO UPDATE
       SET due_at = LEAST(d.due_at, EXCLUDED.due_at),
           armed_seq = d.armed_seq + 1,
           updated_at = now();
  `;
}
