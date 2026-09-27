#!/usr/bin/env node
/**
 * Re-encrypt stored credentials under the current wrapping key.
 *
 * A master key can only be retired once nothing references it, and this is
 * what walks stored values to that point. It is safe to run repeatedly and
 * safe to interrupt: `credentialNeedsRewrap()` is recomputed per row, so a
 * re-run picks up exactly what is left rather than redoing finished work.
 *
 * Both keys must be readable while it runs — the new one to wrap with, the old
 * one to unwrap what it still holds. For a local-key rotation that means
 * CREDENTIAL_ENCRYPTION_KEY_PREVIOUS; for a move to Cloud KMS it means leaving
 * CREDENTIAL_ENCRYPTION_KEY in place alongside CREDENTIAL_KMS_KEY.
 *
 *   node scripts/rewrap-credentials.mjs --dry-run
 *   node scripts/rewrap-credentials.mjs
 *   node scripts/rewrap-credentials.mjs --schema t_<tenant>
 */
import postgres from 'postgres';
import {
  credentialNeedsRewrap,
  decryptCredentialAsync,
  encryptCredentialEnvelope,
  getKmsProvider,
} from '@aflow/database';

/**
 * Every column holding a value produced by the credential encryption path,
 * with the columns that identify a row. `api_credentials` is keyed by a
 * composite rather than an id, so the key is per-table rather than assumed.
 */
const TARGETS = [
  { table: 'api_credentials', column: 'encrypted_value', key: ['credential_key', 'space_id'] },
  { table: 'provider_credentials', column: 'encrypted_secrets', key: ['id'] },
  { table: 'oauth_clients', column: 'encrypted_client_secret', key: ['id'] },
  { table: 'webhook_endpoints', column: 'secret_encrypted', key: ['id'] },
];

/**
 * Every argument is recognised or the run stops. A typo like `--dryrun` would
 * otherwise be ignored and take the destructive path against live credentials.
 */
function parseArgs(argv) {
  const parsed = { dryRun: false, onlySchema: undefined };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--dry-run':
        parsed.dryRun = true;
        break;
      case '--schema': {
        const value = argv[++i];
        if (value === undefined || value.startsWith('--')) {
          throw new Error('--schema requires a schema name');
        }
        parsed.onlySchema = value;
        break;
      }
      default:
        throw new Error(
          `Unknown argument "${argv[i]}". Usage: rewrap-credentials.mjs [--dry-run] [--schema <name>]`,
        );
    }
  }

  return parsed;
}

let dryRun;
let onlySchema;
try {
  ({ dryRun, onlySchema } = parseArgs(process.argv.slice(2)));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 4 });

/** Tables can be absent in a schema that predates them; that is not an error. */
async function tableExists(schema, table) {
  const rows = await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = ${schema} AND table_name = ${table} LIMIT 1`;
  return rows.length > 0;
}

async function rewrapTable(schema, { table, column, key }) {
  if (!(await tableExists(schema, table))) return { scanned: 0, rewrapped: 0, failed: 0 };

  const rows = await sql`
    SELECT ${sql(key)}, ${sql(column)} AS value
    FROM ${sql(schema)}.${sql(table)}
    WHERE ${sql(column)} IS NOT NULL`;

  let rewrapped = 0;
  let failed = 0;
  let raced = 0;

  for (const row of rows) {
    if (!credentialNeedsRewrap(row.value)) continue;

    try {
      // Decrypt and re-encrypt individually so one unreadable row cannot
      // abort the pass — it is reported and the rest still migrate.
      const plaintext = await decryptCredentialAsync(row.value);
      const reencrypted = await encryptCredentialEnvelope(plaintext);

      // Read the new value back before overwriting the old one. This job
      // rewrites live credentials and the old ciphertext is gone afterwards,
      // so a silent round-trip failure would be unrecoverable — and would not
      // surface until something tried to use the credential.
      if ((await decryptCredentialAsync(reencrypted)) !== plaintext) {
        throw new Error('re-encrypted value did not decrypt back to the original');
      }

      if (dryRun) {
        rewrapped++;
        continue;
      }

      const where = key.reduce(
        (clause, col, i) =>
          i === 0 ? sql`${sql(col)} = ${row[col]}` : sql`${clause} AND ${sql(col)} = ${row[col]}`,
        sql``,
      );
      // Also match the ciphertext this pass read. A credential edited while
      // the job runs would otherwise be overwritten with a re-encryption of
      // the value it used to hold, losing the newer secret outright — and
      // silently, since the row would look correctly wrapped afterwards.
      const result = await sql`
        UPDATE ${sql(schema)}.${sql(table)}
        SET ${sql(column)} = ${reencrypted}
        WHERE ${where} AND ${sql(column)} = ${row.value}`;

      if (result.count === 0) {
        // Changed underneath us. Whatever replaced it was written by the
        // current key, so there is nothing left to do for this row.
        raced++;
        continue;
      }
      rewrapped++;
    } catch (err) {
      failed++;
      console.error(
        `  ! ${schema}.${table} ${key.map((c) => `${c}=${String(row[c])}`).join(' ')}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  return { scanned: rows.length, rewrapped, failed, raced };
}

async function main() {
  console.log(`Wrapping key: ${getKmsProvider().currentKeyId()}`);
  if (dryRun) console.log('Dry run — nothing will be written.\n');

  const schemas = onlySchema
    ? [onlySchema]
    : (
        await sql`
          SELECT nspname FROM pg_namespace WHERE nspname ~ '^t_' ORDER BY nspname`
      ).map((r) => r.nspname);

  const total = { scanned: 0, rewrapped: 0, failed: 0, raced: 0 };

  for (const schema of schemas) {
    const perSchema = { scanned: 0, rewrapped: 0, failed: 0, raced: 0 };
    for (const target of TARGETS) {
      const result = await rewrapTable(schema, target);
      for (const key of Object.keys(perSchema)) perSchema[key] += result[key];
    }
    for (const key of Object.keys(total)) total[key] += perSchema[key];
    console.log(
      `${schema}: ${perSchema.rewrapped} rewrapped, ${perSchema.scanned} scanned` +
        (perSchema.raced > 0 ? `, ${perSchema.raced} changed concurrently` : '') +
        (perSchema.failed > 0 ? `, ${perSchema.failed} FAILED` : ''),
    );
  }

  console.log(
    `\n${total.rewrapped} rewrapped across ${schemas.length} schema(s), ${total.failed} failed.`,
  );
  if (total.failed > 0) {
    console.error('Retired keys cannot be dropped while any row still fails.');
    process.exitCode = 1;
  } else if (total.rewrapped > 0 && !dryRun) {
    console.log('Re-run to confirm zero remaining before retiring the old key.');
  }
}

main()
  .catch((/** @type {unknown} */ err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
