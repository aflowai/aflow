/**
 * Instance init — the one-shot that must finish before Redis starts.
 *
 * Separate from `bootstrapLocal` because of what each one needs. Bootstrap
 * provisions the database, so it runs after migrations, which run after
 * Postgres. The instance's own secrets need none of that, and Redis needs its
 * ACL file before it accepts a connection — so the file cannot be written by
 * anything that waits for a datastore to come up.
 *
 * Generating the passwords here rather than in a shell fragment keeps one
 * generator: the same `ensureInstanceConfig` that every other secret goes
 * through, with the same read-before-write and the same refusal to generate
 * past a supplied value.
 */
import './env.js';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  REDIS_ACL_FILENAME,
  ensureInstanceConfig,
  renderRedisAcl,
} from '@aflow/server-runtime/bootstrap';

async function main(): Promise<void> {
  const instanceDir = process.env['PHOENIX_INSTANCE_DIR']?.trim();
  if (instanceDir === undefined || instanceDir === '') {
    throw new Error(
      'PHOENIX_INSTANCE_DIR is required: it is where this instance keeps its identity.',
    );
  }

  const config = await ensureInstanceConfig(instanceDir);
  if (config.generated.length > 0) {
    console.log(`[instance-init] generated ${config.generated.join(', ')} in ${config.path}`);
  }

  const aclDir = process.env['PHOENIX_REDIS_ACL_DIR']?.trim() ?? instanceDir;
  await mkdir(aclDir, { recursive: true });
  const aclPath = join(aclDir, REDIS_ACL_FILENAME);

  const defaultPassword = config.values['REDIS_PASSWORD'];
  const hostPassword = config.values['PHOENIX_HOST_REDIS_PASSWORD'];
  if (defaultPassword === undefined || hostPassword === undefined) {
    throw new Error('Instance config carries no Redis passwords, so no ACL can be written.');
  }

  // Rewritten every run rather than only when absent: the file is derived from
  // the stored passwords, so a restored backup and a rotated password both have
  // to reach Redis, and neither would if this only ran once.
  // Group-readable for the same reason as the Redis config cut: the server
  // reads this as a different uid, and a file only the writer can open aborts
  // its startup rather than degrading.
  await writeFile(aclPath, renderRedisAcl({ defaultPassword, hostPassword }), { mode: 0o640 });
  await chmod(aclPath, 0o640);
  console.log(`[instance-init] wrote the Redis ACL to ${aclPath}`);
}

main().catch((error: unknown) => {
  console.error('[instance-init] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
