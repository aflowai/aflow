import 'dotenv/config';
import { randomUUID } from 'node:crypto';

import {
  closeConnection,
  createTenantContext,
  getConnection,
  getDatabase,
  listTenantSchemas,
  seedCyberneticAgents,
  spaces,
  withTenantSchema,
} from '@aflow/database';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq, isNull } from 'drizzle-orm';
import {
  DIRECTIVE_TEMPLATES,
  EntityDirectivesSchema,
  getDirectiveTemplate,
  type DirectiveTemplateId,
  type EntityDirectives,
  type TenantId,
} from '@aflow/schemas';
import { attachRedisErrorGuard, getRedisConnection, quitRedisWithTimeout } from '@aflow/redis';

import { bootstrapCyberneticEntity } from '../../packages/server-runtime/src/services/entityBootstrap.js';

// ============================================================================
// Safety rails
// ============================================================================

/**
 * Regex matches host patterns that almost certainly point at a production or
 * staging datastore. The script refuses to run if any of these match the
 * resolved `DATABASE_URL`. Keeping the set wide — false positives are
 * recoverable (run against a literal `localhost`/`127.0.0.1` URL), silent
 * production writes are not.
 */
const PROD_HOST_PATTERNS: RegExp[] = [
  /\.aflow\.ai$/i,
  /\.cloudsql\.[a-z0-9-]+$/i,
  /\.rds\.amazonaws\.com$/i,
  /\.supabase\.co$/i,
  /^10\.\d+\.\d+\.\d+$/,
];

function assertNotProduction(): void {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('Refusing to run: NODE_ENV=production. This script is local-dev only.');
  }

  const dbUrl = process.env['DATABASE_URL'];
  if (!dbUrl) {
    throw new Error('DATABASE_URL is not set. Configure a local dev connection string in .env.');
  }

  let host: string | null = null;
  try {
    host = new URL(dbUrl).hostname;
  } catch {
    throw new Error(`DATABASE_URL is not a valid URL: ${dbUrl}`);
  }

  for (const pattern of PROD_HOST_PATTERNS) {
    if (pattern.test(host)) {
      throw new Error(
        `Refusing to run: DATABASE_URL host "${host}" matches production pattern ${pattern}.`,
      );
    }
  }
}

// ============================================================================
// CLI
// ============================================================================

interface Flags {
  tenant: string | undefined;
  spaceName: string;
  template: DirectiveTemplateId;
}

const DEFAULT_SPACE_NAME = 'Cybernetic Lab';
const DEFAULT_TEMPLATE: DirectiveTemplateId = 'ml-optimization';

function printUsage(): void {
  const templateIds = DIRECTIVE_TEMPLATES.map((t) => t.id).join(' | ');
  console.log(
    [
      'Usage: yarn db:seed:cybernetic [options]',
      '',
      'Options:',
      '  --tenant <schema|uuid>    Target tenant (default: first tenant).',
      '  --space-name <string>     Space name (default: "Cybernetic Lab").',
      `  --template <id>           One of: ${templateIds} (default: ml-optimization).`,
      '  --help                    Show this message.',
      '',
    ].join('\n'),
  );
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    tenant: undefined,
    spaceName: DEFAULT_SPACE_NAME,
    template: DEFAULT_TEMPLATE,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h': {
        printUsage();
        process.exit(0);
        break;
      }
      case '--tenant': {
        const value = argv[++i];
        if (!value) throw new Error('`--tenant` requires a value');
        flags.tenant = value;
        break;
      }
      case '--space-name': {
        const value = argv[++i];
        if (!value) throw new Error('`--space-name` requires a value');
        flags.spaceName = value;
        break;
      }
      case '--template': {
        const value = argv[++i];
        if (!value) throw new Error('`--template` requires a value');
        if (!getDirectiveTemplate(value)) {
          const ids = DIRECTIVE_TEMPLATES.map((t) => t.id).join(', ');
          throw new Error(`Unknown template "${value}". Valid: ${ids}.`);
        }
        flags.template = value as DirectiveTemplateId;
        break;
      }
      default: {
        if (arg?.startsWith('--')) {
          throw new Error(`Unknown flag: ${arg}`);
        }
      }
    }
  }

  return flags;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Deterministic slug from a space name. Matches the API's tolerant slugifier
 * (lowercase, ASCII-only, collapsed hyphens). A random suffix is appended to
 * avoid collisions when the same `--space-name` is seeded twice.
 */
function makeSlug(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40);
  const suffix = randomUUID().slice(0, 6);
  const prefix = base || 'cybernetic-space';
  return `${prefix}-${suffix}`;
}

/**
 * Resolve the target tenant. If `--tenant` is omitted, picks the first tenant
 * from `listTenantSchemas`. This is the dev convention — the first tenant is
 * the one seeded by `scripts/seed-tenant.mjs` on a fresh stack.
 */
async function resolveTenant(
  sql: ReturnType<typeof getConnection>,
  hint: string | undefined,
): Promise<{ schemaName: string; tenantId: TenantId }> {
  const tenants = await listTenantSchemas(sql);
  if (tenants.length === 0) {
    throw new Error('No tenants found. Run `yarn db:migrate` and `scripts/seed-tenant.mjs` first.');
  }

  if (!hint) {
    const first = tenants[0];
    if (!first) {
      throw new Error('No tenants found.');
    }
    return { schemaName: first.schemaName, tenantId: first.tenantId };
  }

  const match = tenants.find((t) => t.schemaName === hint || t.tenantId === (hint as TenantId));
  if (!match) {
    const available = tenants.map((t) => t.schemaName).join(', ');
    throw new Error(`Tenant "${hint}" not found. Available: ${available}.`);
  }
  return { schemaName: match.schemaName, tenantId: match.tenantId };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  assertNotProduction();

  const template = getDirectiveTemplate(flags.template);
  if (!template) {
    // Defensive: parseFlags already validates, but keeps the type-narrowing honest.
    throw new Error(`Template "${flags.template}" not found.`);
  }

  // Parse through the schema so `training.inTraining` default and any other
  // schema-side fallback apply identically to the HTTP PATCH path.
  const directives: EntityDirectives = EntityDirectivesSchema.parse(template.directives);

  console.log('Phoenix — dev seed: cybernetic space');
  console.log(`  template    : ${template.id} (${template.name})`);
  console.log(`  space name  : ${flags.spaceName}`);

  const sql = getConnection();
  const db = getDatabase();
  const redis = getRedisConnection();
  attachRedisErrorGuard(redis, () => false, {
    debug() {
      // no-op in scripts
    },
    error(message, data) {
      console.error(`[redis] ${message}`, data ?? '');
    },
  });

  try {
    const tenant = await resolveTenant(sql, flags.tenant);
    console.log(`  tenant      : ${tenant.schemaName} (${tenant.tenantId})`);

    // Step 1: idempotent ensemble seed — matches what `release.mjs` does on deploy.
    console.log('\n[1/3] Ensuring cybernetic ensemble is seeded for tenant…');
    const seedResult = await seedCyberneticAgents(sql);
    if (seedResult.failed.length > 0) {
      for (const f of seedResult.failed) {
        const msg = f.error instanceof Error ? f.error.message : JSON.stringify(f.error);
        console.error(`  ✗ ${f.schema}: ${msg}`);
      }
      throw new Error('Cybernetic agent seed failed for one or more tenants.');
    }
    console.log(`  ✓ success: ${seedResult.success.length}, skipped: ${seedResult.skipped.length}`);

    // Step 2: upsert the space row — reuse an existing non-archived space with
    // the same name so repeated runs don't create duplicates.
    console.log(`\n[2/3] Ensuring space "${flags.spaceName}" in ${tenant.schemaName}…`);
    const tenantCtx = createTenantContext(tenant.tenantId);

    const existing = (await withTenantSchema(db, tenantCtx, async (tx: unknown) => {
      return (tx as PostgresJsDatabase)
        .select({ id: spaces.id, slug: spaces.slug })
        .from(spaces)
        .where(and(eq(spaces.name, flags.spaceName), isNull(spaces.archivedAt)))
        .limit(1);
    })) as Array<{ id: string; slug: string }>;

    let space: { id: string; slug: string };

    if (existing[0]) {
      space = existing[0];
      console.log(`  ✓ reusing existing spaceId=${space.id} slug=${space.slug}`);
    } else {
      const slug = makeSlug(flags.spaceName);
      const { tenantMemberships, spaceMemberships } = await import('@aflow/database');
      const admins = await db
        .select({ userId: tenantMemberships.userId })
        .from(tenantMemberships)
        .where(
          and(
            eq(tenantMemberships.tenantId, tenantCtx.tenantId),
            eq(tenantMemberships.status, 'active'),
          ),
        )
        .limit(1);
      const ownerId = admins[0]?.userId;
      if (!ownerId) {
        throw new Error('No active tenant member found to own the seeded space.');
      }
      const inserted = (await withTenantSchema(db, tenantCtx, async (tx: unknown) => {
        return (tx as PostgresJsDatabase)
          .insert(spaces)
          .values({
            name: flags.spaceName,
            slug,
            ownerId,
            createdBy: ownerId,
            description: `Cybernetic space seeded from template "${template.id}"`,
          })
          .returning({ id: spaces.id, slug: spaces.slug });
      })) as Array<{ id: string; slug: string }>;

      space = inserted[0]!;
      if (!space) {
        throw new Error('Failed to insert space row.');
      }
      await db.insert(spaceMemberships).values({
        tenantId: tenantCtx.tenantId,
        spaceId: space.id,
        userId: ownerId,
        role: 'admin',
      });
      console.log(`  ✓ created spaceId=${space.id} slug=${space.slug} owner=${ownerId}`);
    }

    // Step 3: write directives + run the real bootstrap function (idempotent).
    console.log('\n[3/3] Writing directives + bootstrapping cybernetic entity…');
    await withTenantSchema(db, tenantCtx, async (tx: unknown) => {
      return (tx as PostgresJsDatabase)
        .update(spaces)
        .set({ directives, updatedAt: new Date() })
        .where(eq(spaces.id, space.id));
    });

    const bootstrap = await bootstrapCyberneticEntity({
      tenantId: tenant.tenantId,
      spaceId: space.id,
      directives,
      db,
      redis,
      isFirstActivation: true,
      changedDirectiveKeys: [],
    });

    console.log(`  ✓ bootstrap completed in ${String(bootstrap.durationMs)}ms`);
    console.log(`    - artifacts created : ${String(bootstrap.created.length)}`);
    console.log(`    - helmsman agent    : ${bootstrap.resolvedAgents.helmsman}`);
    console.log(`    - runner agent      : ${bootstrap.resolvedAgents.runner}`);
    console.log(`    - coach agent       : ${bootstrap.resolvedAgents.coach}`);
    console.log(`    - event emitted     : ${bootstrap.emittedEvent}`);
    if (bootstrap.entityEventId) {
      console.log(`    - entity event id   : ${bootstrap.entityEventId}`);
    }

    console.log('\nDone. Open the space in the web app:');
    console.log(`  http://localhost:3001/spaces/${space.id}`);
    console.log(`  http://localhost:3001/console/${space.id}`);
    console.log(`  http://localhost:3001/chat?spaceId=${space.id}`);
  } finally {
    try {
      await quitRedisWithTimeout(redis);
    } catch {
      // teardown; ignore
    }
    await closeConnection();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : JSON.stringify(err);
  console.error(`\n✗ Seed failed: ${message}`);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(err instanceof Error && err.message.startsWith('Refusing') ? 1 : 2);
});
