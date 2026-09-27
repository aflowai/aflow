import type postgres from 'postgres';

export async function applyMigration129(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  // memory.run_output.get is FLOOR-granted to every agent turn
  // (withGuaranteedReadOps), and compaction/clearing notes teach it as the
  // §4.9 reread path. Any profile that already grants general memory read
  // (memory.store:read) must therefore also carry memory.run_output:read, or
  // the reread the notes promise fails at scheduleStep ("not covered by any
  // allowed capability"). The run-output group is strictly NARROWER than
  // memory.store (this run's tool outputs only), so appending it to every
  // read-granting profile — system OR custom — cannot widen anyone's access.
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[
          {"capabilityGroupId":"memory.run_output","accessMode":"read"}
        ]'::jsonb
      WHERE allowed_capabilities @> '[{"capabilityGroupId":"memory.store","accessMode":"read"}]'::jsonb
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"memory.run_output","accessMode":"read"}]'::jsonb);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (129, 'Plan 233 Part 2 — memory.run_output capability group (run-scoped reread floor) appended to every profile granting memory.store:read')
      ON CONFLICT (version) DO NOTHING;
    `);
}
