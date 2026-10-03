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

/**
 * A Redis started without an ACL file — the development Redis — holds the host
 * identity in memory only, so a Redis restart removes it. This full start is
 * the one start path that sets the host password, and it sets it whether or
 * not the identity exists: it has just read the durable value from
 * `instance.env`, and applying it is what corrects a live password that drifted
 * from it. The server restarting in place (`start.ts`) holds whatever its
 * supervisor captured, which after a revocation is the revoked credential, so
 * it asserts the grant and never the password.
 */
async function applyHostIdentity(values: Record<string, string | undefined>): Promise<void> {
  const hostPassword = values['PHOENIX_HOST_REDIS_PASSWORD']?.trim();
  if (hostPassword === undefined || hostPassword === '') return;
  try {
    await applyHostIdentityToRunningServer(getRedisConnection(), {
      defaultPassword: values['REDIS_PASSWORD'] ?? '',
      hostPassword,
    });
    console.log('[bootstrap] applied the host identity to the running Redis');
  } catch (error) {
    console.warn(
      `[bootstrap] could not apply the host identity to the running Redis: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function main(): Promise<void> {
  // Where the appliance keeps its own identity. Absent, this is a developer
  // running the command by hand and supplying it through the environment.
  //
  // Read before the descriptor is resolved, and that order is load-bearing:
  // the file carries the instance's pinned tenant and owner, so a descriptor
  // resolved first would take the defaults and provision a second tenant
  // beside the one a restored database already holds.
  const instanceDir = process.env['PHOENIX_INSTANCE_DIR']?.trim();
  let instanceValues: Record<string, string | undefined> = process.env;
  if (instanceDir !== undefined && instanceDir !== '') {
    const config = await ensureInstanceConfig(instanceDir);
    instanceValues = config.values;
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

    // What changed is named; what was already in place is counted, since on
    // every start after the first that is all of it.
    for (const step of report.steps) {
      if (step.outcome !== 'created') continue;
      const detail = step.detail === undefined ? '' : ` (${step.detail})`;
      console.log(`[bootstrap] created — ${step.name}${detail}`);
    }
    const unchanged = report.steps.filter((step) => step.outcome !== 'created').length;
    console.log(
      `[bootstrap] ✓ ${String(unchanged)} of ${String(report.steps.length)} already in place, ` +
        `${String(report.spaceIds.length)} workspace(s)`,
    );
    // The ACL file was rewritten before Redis started and Redis reads it once.
    // A deploy that leaves the container running would otherwise keep enforcing
    // the previous release's grants, which presents as NOPERM on keys that are
    // right in the file, in the source and in the test.
    const aclOutcome = await loadRedisAclIntoRunningServer(getRedisConnection());
    if (aclOutcome.outcome === 'loaded') {
      console.log('[bootstrap] reloaded the Redis ACL into the running server');
    } else if (aclOutcome.reason !== null) {
      console.warn(
        `[bootstrap] the running Redis refused the ACL reload and keeps its previous grants: ${aclOutcome.reason}`,
      );
    }
    if (aclOutcome.outcome === 'skipped') await applyHostIdentity(instanceValues);
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
