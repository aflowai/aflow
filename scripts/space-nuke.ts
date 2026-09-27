#!/usr/bin/env npx tsx
import postgres from 'postgres';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { cascadeDeleteSpace, previewCascadeForSpace } from '@aflow/database';

// ============================================================================
// Args
// ============================================================================

interface ParsedArgs {
  tenant?: string;
  space?: string;
  slug?: string;
  allArchived: boolean;
  dryRun: boolean;
  yes: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { allArchived: false, dryRun: false, yes: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--tenant':
        args.tenant = argv[++i];
        break;
      case '--space':
        args.space = argv[++i];
        break;
      case '--slug':
        args.slug = argv[++i];
        break;
      case '--all-archived':
        args.allArchived = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--yes':
        args.yes = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        // Ignore unknown args silently — keeps the entry forgiving.
        break;
    }
  }
  return args;
}

const HELP = `
yarn space:nuke — dev-only hard delete for workspace spaces (Plan 121 §4.15)

Required env (every invocation):
  PHOENIX_ALLOW_LOCAL_NUKE=1
  DATABASE_URL pointing at localhost / 127.0.0.1 / host.docker.internal

Modes (pick exactly one):
  --tenant <id> --space <id>       Single space by UUID
  --tenant <id> --slug  <slug>     Single space by slug
  --tenant <id> --all-archived     Every space with archived_at IS NOT NULL

Flags:
  --dry-run    Print row counts per table; no mutations.
  --yes        Skip the typed-name confirmation. For test scripts.
  --help       This message.

Refuses on slug='general' regardless of mode.
`;

// ============================================================================
// Safety gates
// ============================================================================

function assertLocalDatabaseUrl(databaseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error(`REFUSED: DATABASE_URL is not a parseable URL.`);
  }
  const host = parsed.hostname;
  const allowed = new Set(['localhost', '127.0.0.1', 'host.docker.internal']);
  if (!allowed.has(host)) {
    throw new Error(
      `REFUSED: this script only runs against a local database. ` +
        `DATABASE_URL host = '${host}'. Allowed: ${[...allowed].join(', ')}.`,
    );
  }
}

function assertExplicitOptIn(): void {
  if (process.env['PHOENIX_ALLOW_LOCAL_NUKE'] !== '1') {
    throw new Error(
      `REFUSED: set PHOENIX_ALLOW_LOCAL_NUKE=1 to confirm. ` +
        `This will permanently delete all rows for the targeted space(s).`,
    );
  }
}

// ============================================================================
// Tenant / space resolution
// ============================================================================

interface SpaceRow {
  id: string;
  slug: string;
  name: string;
  archived_at: Date | null;
}

async function resolveSchemaName(sql: postgres.Sql, tenantId: string): Promise<string> {
  const rows = (await sql`
    SELECT schema_name FROM public.tenants WHERE tenant_id = ${tenantId}::uuid LIMIT 1
  `) as unknown as Array<{ schema_name: string }>;
  const row = rows[0];
  if (!row) {
    throw new Error(`Tenant '${tenantId}' not found in public.tenants.`);
  }
  // Sanity check: schema names follow a known shape (`t_<hex>`).
  if (!/^t_[a-z0-9_]+$/.test(row.schema_name)) {
    throw new Error(`Refusing to operate on suspicious schema name: ${row.schema_name}`);
  }
  return row.schema_name;
}

async function findOneSpace(
  sql: postgres.Sql,
  schemaName: string,
  args: { space?: string; slug?: string },
): Promise<SpaceRow | null> {
  if (args.space) {
    const rows = (await sql`
      SELECT id, slug, name, archived_at FROM ${sql(schemaName)}.spaces
        WHERE id = ${args.space}::uuid LIMIT 1
    `) as unknown as SpaceRow[];
    return rows[0] ?? null;
  }
  if (args.slug) {
    const rows = (await sql`
      SELECT id, slug, name, archived_at FROM ${sql(schemaName)}.spaces
        WHERE slug = ${args.slug} LIMIT 1
    `) as unknown as SpaceRow[];
    return rows[0] ?? null;
  }
  return null;
}

async function findAllArchived(sql: postgres.Sql, schemaName: string): Promise<SpaceRow[]> {
  const rows = (await sql`
    SELECT id, slug, name, archived_at FROM ${sql(schemaName)}.spaces
      WHERE archived_at IS NOT NULL
      ORDER BY archived_at DESC
  `) as unknown as SpaceRow[];
  return rows;
}

// ============================================================================
// Confirmation
// ============================================================================

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  // ---- Gate 1: DATABASE_URL points at localhost ----
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error('REFUSED: DATABASE_URL is not set.');
  }
  assertLocalDatabaseUrl(databaseUrl);

  // ---- Gate 2: explicit env opt-in ----
  if (!args.dryRun) {
    assertExplicitOptIn();
  }

  // ---- Mode validation ----
  if (!args.tenant) {
    console.error('Missing --tenant. Pass --help for usage.');
    process.exit(1);
  }
  const modeCount = Number(!!args.space) + Number(!!args.slug) + Number(args.allArchived);
  if (modeCount !== 1) {
    console.error('Pick exactly one mode: --space <id>, --slug <slug>, or --all-archived.');
    process.exit(1);
  }

  const sql = postgres(databaseUrl);
  try {
    const schemaName = await resolveSchemaName(sql, args.tenant);
    console.log(`tenant ${args.tenant} → schema '${schemaName}'`);

    // ---- Resolve target space(s) ----
    let targets: SpaceRow[];
    if (args.allArchived) {
      targets = await findAllArchived(sql, schemaName);
      if (targets.length === 0) {
        console.log('No archived spaces in this tenant. Nothing to do.');
        return;
      }
    } else {
      const one = await findOneSpace(sql, schemaName, args);
      if (!one) {
        const ref = args.space ?? args.slug ?? '<unknown>';
        console.error(`Space '${ref}' not found in tenant ${args.tenant}.`);
        process.exit(1);
        return;
      }
      targets = [one];
    }

    // ---- General-space guard ----
    for (const t of targets) {
      if (t.slug === 'general') {
        console.error(
          `REFUSED: the General space ('${t.id}') cannot be nuked. ` +
            `Tenants depend on it existing for fallback membership.`,
        );
        process.exit(1);
        return;
      }
    }

    // ---- Print preview ----
    console.log(`\nTargets (${String(targets.length)}):`);
    for (const t of targets) {
      const archived = t.archived_at ? `archived ${t.archived_at.toISOString()}` : 'ACTIVE';
      console.log(`  - ${t.id}  slug='${t.slug}'  name='${t.name}'  ${archived}`);
    }

    console.log('\nCascade preview (rows that would be deleted):');
    let totalRows = 0;
    for (const t of targets) {
      const counts = await previewCascadeForSpace(sql, schemaName, t.id);
      const subtotal = Object.values(counts).reduce((a, b) => a + b, 0);
      totalRows += subtotal;
      console.log(`  [${t.slug}]  ${String(subtotal)} row(s):`);
      for (const [table, c] of Object.entries(counts).sort()) {
        console.log(`    ${table.padEnd(36)} ${String(c)}`);
      }
    }
    console.log(`\nTotal rows across all targets: ${String(totalRows)}`);

    // ---- Dry-run exit ----
    if (args.dryRun) {
      console.log('\n--dry-run set. No changes made.');
      return;
    }

    // ---- Confirmation gate ----
    if (!args.yes) {
      const expected =
        targets.length === 1
          ? `DELETE ${targets[0]?.name ?? ''}`
          : `DELETE ${String(targets.length)} SPACES`;
      console.log(`\nType the exact phrase to confirm: ${expected}`);
      const answer = await prompt('> ');
      if (answer !== expected) {
        console.log('Confirmation phrase did not match. Aborting.');
        return;
      }
    }

    // ---- Execute cascade in a single tx per space ----
    for (const t of targets) {
      console.log(`\nNuking ${t.slug} (${t.id})…`);
      const start = Date.now();
      const counts = (await sql.begin(async (tx) => {
        // postgres-js types the tx handle as `TransactionSql` (its `Omit`
        // drops the call signatures); it's callable at runtime, so re-type
        // as `Sql` for the cascade's tagged-template SQL.
        return cascadeDeleteSpace(tx as unknown as postgres.Sql, schemaName, t.id);
      })) as Record<string, number>;
      const elapsed = Date.now() - start;
      const subtotal: number = Object.values(counts).reduce((a, b) => a + b, 0);
      console.log(`  done in ${String(elapsed)}ms — ${String(subtotal)} row(s) deleted:`);
      for (const [table, c] of Object.entries(counts).sort()) {
        console.log(`    ${table.padEnd(36)} ${String(c)}`);
      }
    }
    console.log('\nNuke complete.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  if (err instanceof Error) {
    console.error(err.message);
  } else {
    console.error(err);
  }
  process.exit(1);
});
