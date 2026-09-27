/**
 * `bootstrap` — the one-shot that makes a local instance usable.
 *
 * Runs before the API in the appliance's Compose stack, and again on every
 * start after that. See `bootstrap/localEdition.ts` for what it establishes and
 * why each step reads before it writes.
 */
import './env.js';
import { randomBytes } from 'node:crypto';
import { createDatabase, getDatabaseConfig } from '@aflow/database';
import { resolveEditionDescriptor } from '@aflow/schemas';
import {
  bootstrapLocalEdition,
  ensureInstanceConfig,
  findLocalAuthConfigViolations,
  loadRedisAclIntoRunningServer,
  applyHostIdentityToRunningServer,
  localOwner,
} from '@aflow/server-runtime/bootstrap';
import { closeRedisConnection, getRedisConnection } from '@aflow/redis';

async function main(): Promise<void> {
  // Where the appliance keeps its own identity. Absent, this is a developer
  // running the command by hand and supplying it through the environment.
  //
  // Read before the descriptor is resolved, and that order is load-bearing:
  // the file carries the instance's pinned tenant and owner, so a descriptor
  // resolved first would take the defaults and provision a second tenant
  // beside the one a restored database already holds.
  const instanceDir = process.env['PHOENIX_INSTANCE_DIR']?.trim();
  if (instanceDir !== undefined && instanceDir !== '') {
    const config = await ensureInstanceConfig(instanceDir);
    if (config.generated.length > 0) {
      console.log(`[bootstrap] generated ${config.generated.join(', ')} in ${config.path}`);
      console.log('[bootstrap] back this file up with the database — it unwraps every credential');
    }
    // The only visibility an operator has into the per-service split, and the
    // first thing to check when a service reports the value it needs missing.
    for (const [audience, file] of Object.entries(config.audiences)) {
      console.log(`[bootstrap] cut ${audience}'s values into ${file}`);
    }
  }

  const edition = resolveEditionDescriptor();

  const violations = findLocalAuthConfigViolations(edition);
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`[bootstrap] ${violation.key}: ${violation.message}`);
    }
    // Offered rather than written: where the value belongs is the operator's
    // secret store or compose env file, and this process cannot know which.
    console.error(
      `[bootstrap] A usable secret: PHOENIX_INSTANCE_SECRET=${randomBytes(32).toString('hex')}`,
    );
    process.exitCode = 1;
    return;
  }

  // One connection: applying the tenant migrations issues its own
  // transactions, which a pooled client refuses.
  const { sql, db, close } = createDatabase({ ...getDatabaseConfig(), maxConnections: 1 });

  try {
    const report = await bootstrapLocalEdition({
      edition,
      sql,
      db,
      ownerId: localOwner().userId,
    });

    for (const step of report.steps) {
      const detail = step.detail === undefined ? '' : ` (${step.detail})`;
      const verb = step.outcome === 'created' ? 'created' : 'ok';
      console.log(`[bootstrap] ${verb} — ${step.name}${detail}`);
    }
    console.log(
      `[bootstrap] ${String(report.spaceIds.length)} workspace(s) in tenant ${report.tenantId}: ${report.spaceIds.join(', ')}`,
    );
    // The ACL file was rewritten before Redis started and Redis reads it once.
    // A deploy that leaves the container running would otherwise keep enforcing
    // the previous release's grants, which presents as NOPERM on keys that are
    // right in the file, in the source and in the test.
    const aclOutcome = await loadRedisAclIntoRunningServer(getRedisConnection());
    console.log(
      aclOutcome === 'loaded'
        ? '[bootstrap] reloaded the Redis ACL into the running server'
        : '[bootstrap] the running Redis did not accept an ACL reload; it reads the file at start',
    );
    // A server that takes no ACL file holds the host identity in memory alone,
    // so whatever removed it since the last boot stays removed until the next
    // pairing. The instance owns that identity; boot asserts it.
    const hostPassword = process.env['PHOENIX_HOST_REDIS_PASSWORD']?.trim();
    if (aclOutcome === 'skipped' && hostPassword !== undefined && hostPassword !== '') {
      try {
        await applyHostIdentityToRunningServer(getRedisConnection(), {
          defaultPassword: process.env['REDIS_PASSWORD'] ?? '',
          hostPassword,
        });
        console.log('[bootstrap] asserted the host identity on the running Redis');
      } catch (error) {
        console.warn(
          `[bootstrap] could not assert the host identity: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } finally {
    await close();
    // The ACL reload above opens the shared connection, and a one-shot command
    // that leaves a socket open never exits. `close()` is the database's alone,
    // so this ran to completion and then held the deploy at "Waiting" until
    // somebody interrupted it — three hours, in the case that found it.
    await closeRedisConnection();
  }
}

main().catch((err: unknown) => {
  console.error('[bootstrap] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
