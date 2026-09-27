import type postgres from 'postgres';

/**
 * Let `Full Access` run commands and coding harnesses on a connected machine.
 *
 * Migration 195 withheld `host.process` from every profile, reasoning that
 * running commands is general execution and should be chosen rather than
 * defaulted. The reasoning was sound; the consequence was not. Nothing granted
 * it anywhere, and a capability no profile carries is not "chosen" — it is
 * unreachable, unless an operator hand-builds a profile to hold it. The local
 * edition's operator is the admin of their own single workspace, so what they
 * met instead was a refusal telling them to ask a tenant admin: themselves.
 *
 * The act that gate was protecting already exists, and is better placed. A
 * command runs only in a folder the operator connected AND marked `--run`,
 * declared on the machine in a file the appliance cannot write. That is the
 * deliberate choice; requiring a second one, in a different system, in a
 * profile editor, is how a feature becomes unusable rather than safe.
 *
 * Withheld from the narrower profiles, which is where the graded choice lives.
 *
 * On the hosted product this widens the admin default too. It reaches nothing:
 * a host binding requires a paired machine, and no hosted deployment runs a
 * host executor — the lane refuses at dispatch. The widening is real only where
 * a machine is actually paired, which is the case this exists to serve.
 */
export async function applyMigration198(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[
          {"capabilityGroupId":"host.process","accessMode":"read"},
          {"capabilityGroupId":"host.process","accessMode":"write"},
          {"capabilityGroupId":"host.harness","accessMode":"read"},
          {"capabilityGroupId":"host.harness","accessMode":"write"}
        ]'::jsonb
      WHERE is_system_profile = true
        AND name = 'Full Access'
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"host.process","accessMode":"write"}]'::jsonb);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (198, 'Full Access may run host commands and coding harnesses')
      ON CONFLICT (version) DO NOTHING;
  `);
}
