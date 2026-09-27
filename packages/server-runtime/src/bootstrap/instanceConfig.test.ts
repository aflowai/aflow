import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOCAL_EDITION_OWNER_ID, LOCAL_EDITION_TENANT_ID } from '@aflow/schemas';
import {
  INSTANCE_CONFIG_FILENAME,
  InvalidInstanceValueError,
  ensureInstanceConfig,
  type InstanceConfigResult,
} from './instanceConfig.js';

describe('ensureInstanceConfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'instance-config-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('generates every managed secret on a first boot', async () => {
    const env: NodeJS.ProcessEnv = {};
    const result = await ensureInstanceConfig(dir, env);

    // Pinned rather than counted: a secret appearing here should be a decision
    // someone made, not something a refactor added.
    expect(result.generated.sort()).toEqual([
      'CREDENTIAL_ENCRYPTION_KEY',
      'PHOENIX_HOST_REDIS_PASSWORD',
      'PHOENIX_INSTANCE_SECRET',
      'REDIS_PASSWORD',
    ]);
    expect(env['PHOENIX_INSTANCE_SECRET']).toHaveLength(64);
    expect(Buffer.from(env['CREDENTIAL_ENCRYPTION_KEY'] ?? '', 'base64')).toHaveLength(32);
    // Two Redis identities, never the same one: the appliance's services and
    // the paired host executor authenticate as different users.
    expect(env['REDIS_PASSWORD']).toHaveLength(64);
    expect(env['PHOENIX_HOST_REDIS_PASSWORD']).toHaveLength(64);
    expect(env['REDIS_PASSWORD']).not.toBe(env['PHOENIX_HOST_REDIS_PASSWORD']);
  });

  // The whole point: the second boot reads what the first one wrote. A newly
  // generated encryption key would decrypt nothing already stored.
  it('reads back the same secrets on every boot after', async () => {
    const first = await ensureInstanceConfig(dir, {});
    const second = await ensureInstanceConfig(dir, {});

    expect(second.generated).toEqual([]);
    expect(second.values).toEqual(first.values);
  });

  it('writes a file only the owner can read', async () => {
    const result = await ensureInstanceConfig(dir, {});
    const mode = (await stat(result.path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // Restoring a backup means supplying the original key; generating a second
  // one beside it would leave every stored credential unreadable.
  it('adopts a supplied secret rather than generating past it', async () => {
    const supplied = 'a'.repeat(64);
    const result = await ensureInstanceConfig(dir, { PHOENIX_INSTANCE_SECRET: supplied });

    expect(result.generated.sort()).toEqual([
      'CREDENTIAL_ENCRYPTION_KEY',
      'PHOENIX_HOST_REDIS_PASSWORD',
      'REDIS_PASSWORD',
    ]);
    expect(result.values['PHOENIX_INSTANCE_SECRET']).toBe(supplied);

    const onDisk = await readFile(result.path, 'utf-8');
    expect(onDisk).toContain(`PHOENIX_INSTANCE_SECRET='${supplied}'`);
  });

  it('treats a blank stored value as absent', async () => {
    await writeFile(join(dir, INSTANCE_CONFIG_FILENAME), 'PHOENIX_INSTANCE_SECRET=\n');
    const result = await ensureInstanceConfig(dir, {});
    expect(result.generated).toContain('PHOENIX_INSTANCE_SECRET');
    expect(result.values['PHOENIX_INSTANCE_SECRET']).toHaveLength(64);
  });

  it('leaves values it does not own alone', async () => {
    await writeFile(join(dir, INSTANCE_CONFIG_FILENAME), '# a note\nOPERATOR_NOTE=keep-me\n');
    const result = await ensureInstanceConfig(dir, {});
    expect(result.values['OPERATOR_NOTE']).toBe('keep-me');
    expect(await readFile(result.path, 'utf-8')).toContain("OPERATOR_NOTE='keep-me'");
  });

  it('creates the directory when it is not there yet', async () => {
    const nested = join(dir, 'deeper', 'still');
    const result = await ensureInstanceConfig(nested, {});
    expect(result.generated).toHaveLength(4);
    await expect(stat(result.path)).resolves.toBeDefined();
  });

  it('rewrites nothing when nothing changed', async () => {
    const first = await ensureInstanceConfig(dir, {});
    await chmod(first.path, 0o400);
    // A second run that tried to write would fail against a read-only file.
    await expect(ensureInstanceConfig(dir, {})).resolves.toBeDefined();
  });

  // `mode` applies only on creation, so a file restored at 0644 would keep
  // those permissions through every rewrite.
  it('tightens permissions on a file that arrived readable', async () => {
    const path = join(dir, INSTANCE_CONFIG_FILENAME);
    await writeFile(path, 'OPERATOR_NOTE=restored\n', { mode: 0o644 });
    const result = await ensureInstanceConfig(dir, {});
    expect((await stat(result.path)).mode & 0o777).toBe(0o600);
  });

  // The API and worker `.` this file before exec'ing. An operator-supplied
  // secret carrying `$`, a backtick, or a space would otherwise be rewritten
  // or executed by that shell, and never match what the BFF presents.
  it.each([
    ['a space', 'one two three four five six seven eight nine ten1'],
    ['a dollar', '$(whoami)aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['a backtick', '`id`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['a single quote', "it's a secret aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  ])('round-trips a secret containing %s', async (_label, secret) => {
    const written = await ensureInstanceConfig(dir, { PHOENIX_INSTANCE_SECRET: secret });
    expect(written.values['PHOENIX_INSTANCE_SECRET']).toBe(secret);

    // Read back from disk by a second run, which is what every boot after the
    // first actually does.
    const reread = await ensureInstanceConfig(dir, {});
    expect(reread.values['PHOENIX_INSTANCE_SECRET']).toBe(secret);
    expect(reread.generated).toEqual([]);
  });

  // Overwriting is silent and one-way: the rows stay wrapped with the key
  // being discarded, and this file is the only place it existed.
  it('refuses a supplied key that contradicts the stored one', async () => {
    const first = await ensureInstanceConfig(dir, {});
    const stored = first.values['CREDENTIAL_ENCRYPTION_KEY'];

    await expect(
      ensureInstanceConfig(dir, {
        CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
      }),
    ).rejects.toThrow(/differs from the one stored/);

    // The stored value is untouched by the refusal.
    const after = await ensureInstanceConfig(dir, {});
    expect(after.values['CREDENTIAL_ENCRYPTION_KEY']).toBe(stored);
  });

  // Restoring a backup means supplying the key it was taken with, which agrees.
  it('accepts a supplied value identical to the stored one', async () => {
    const first = await ensureInstanceConfig(dir, {});
    const same = first.values['PHOENIX_INSTANCE_SECRET'] as string;
    const again = await ensureInstanceConfig(dir, { PHOENIX_INSTANCE_SECRET: same });
    expect(again.values['PHOENIX_INSTANCE_SECRET']).toBe(same);
    expect(again.generated).toEqual([]);
  });

  // The tenant and owner ids are what connect a restored database to the
  // instance serving it, and the overrides that pin them live in `.env.local`
  // — which is neither of the volumes a backup archives.
  describe('identity pins', () => {
    it('records the ids the instance resolves to on a first boot', async () => {
      const env: NodeJS.ProcessEnv = {};
      const result = await ensureInstanceConfig(dir, env);

      expect(result.recorded.sort()).toEqual(['PHOENIX_LOCAL_OWNER_ID', 'PHOENIX_LOCAL_TENANT_ID']);
      expect(result.values['PHOENIX_LOCAL_TENANT_ID']).toBe(LOCAL_EDITION_TENANT_ID);
      expect(result.values['PHOENIX_LOCAL_OWNER_ID']).toBe(LOCAL_EDITION_OWNER_ID);
      expect(env['PHOENIX_LOCAL_TENANT_ID']).toBe(LOCAL_EDITION_TENANT_ID);
    });

    it('records the ids an operator pinned rather than the defaults', async () => {
      const tenantId = '11111111-1111-4111-8111-111111111111';
      const ownerId = '22222222-2222-4222-8222-222222222222';
      const result = await ensureInstanceConfig(dir, {
        PHOENIX_LOCAL_TENANT_ID: tenantId,
        PHOENIX_LOCAL_OWNER_ID: ownerId,
      });

      expect(result.values['PHOENIX_LOCAL_TENANT_ID']).toBe(tenantId);
      const onDisk = await readFile(result.path, 'utf-8');
      expect(onDisk).toContain(`PHOENIX_LOCAL_TENANT_ID='${tenantId}'`);
      expect(onDisk).toContain(`PHOENIX_LOCAL_OWNER_ID='${ownerId}'`);
    });

    // The restore case: the archived file arrives on a host whose environment
    // pins nothing, and the instance must come up as the tenant it restored
    // rather than provision a second one under the defaults.
    it('applies restored ids to an environment that supplies none', async () => {
      const tenantId = '33333333-3333-4333-8333-333333333333';
      await ensureInstanceConfig(dir, { PHOENIX_LOCAL_TENANT_ID: tenantId });

      const env: NodeJS.ProcessEnv = {};
      const restored = await ensureInstanceConfig(dir, env);

      expect(restored.recorded).toEqual([]);
      expect(env['PHOENIX_LOCAL_TENANT_ID']).toBe(tenantId);
      expect(env['PHOENIX_LOCAL_TENANT_ID']).not.toBe(LOCAL_EDITION_TENANT_ID);
    });

    it('refuses a supplied tenant id that contradicts the stored one', async () => {
      await ensureInstanceConfig(dir, {
        PHOENIX_LOCAL_TENANT_ID: '44444444-4444-4444-8444-444444444444',
      });

      await expect(
        ensureInstanceConfig(dir, {
          PHOENIX_LOCAL_TENANT_ID: '55555555-5555-4555-8555-555555555555',
        }),
      ).rejects.toThrow(/differs from the one stored/);
    });
  });

  // Every appliance process runs as the same user, so a file it can open is a
  // file it can read whatever it dropped from its environment. The cuts are
  // what let each service be given only the value it uses.
  describe('per-audience cuts', () => {
    const audienceEnv = (): NodeJS.ProcessEnv => ({
      PHOENIX_WORKER_CONFIG_DIR: join(dir, 'worker'),
      PHOENIX_WEB_CONFIG_DIR: join(dir, 'web'),
    });

    const cutOf = (result: InstanceConfigResult, audience: string): string => {
      const path = result.audiences[audience];
      if (path === undefined) throw new Error(`nothing was cut for ${audience}`);
      return path;
    };

    it('gives the worker the wrapping key and nothing else', async () => {
      const result = await ensureInstanceConfig(dir, audienceEnv());
      const path = cutOf(result, 'worker');
      expect(path).toBe(join(dir, 'worker', 'wrapping-key.env'));

      const cut = await readFile(path, 'utf-8');
      expect(cut).toContain(
        `CREDENTIAL_ENCRYPTION_KEY='${result.values['CREDENTIAL_ENCRYPTION_KEY'] ?? ''}'`,
      );
      expect(cut).not.toContain('PHOENIX_INSTANCE_SECRET');
    });

    it('gives the web process the instance secret and nothing else', async () => {
      const result = await ensureInstanceConfig(dir, audienceEnv());
      const path = cutOf(result, 'web');
      expect(path).toBe(join(dir, 'web', 'instance-secret.env'));

      const cut = await readFile(path, 'utf-8');
      expect(cut).toContain(
        `PHOENIX_INSTANCE_SECRET='${result.values['PHOENIX_INSTANCE_SECRET'] ?? ''}'`,
      );
      expect(cut).not.toContain('CREDENTIAL_ENCRYPTION_KEY');
    });

    // Read by a `.` before an exec, exactly as the full file is.
    it('shell-quotes a cut value that would otherwise be rewritten', async () => {
      const secret = "it's $(whoami) aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const result = await ensureInstanceConfig(dir, {
        ...audienceEnv(),
        PHOENIX_INSTANCE_SECRET: secret,
      });

      expect(await readFile(cutOf(result, 'web'), 'utf-8')).toBe(
        `PHOENIX_INSTANCE_SECRET='it'\\''s $(whoami) aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'\n`,
      );
    });

    it('writes cuts only the owner can read', async () => {
      const result = await ensureInstanceConfig(dir, audienceEnv());
      for (const path of Object.values(result.audiences)) {
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }
    });

    // The restore case: the file the cuts come from is replaced and the cuts
    // are left where they are, so a boot that read them unchanged would serve
    // the previous instance's secrets.
    it('replaces a cut that disagrees with the file it comes from', async () => {
      const first = await ensureInstanceConfig(dir, audienceEnv());
      await rm(join(dir, INSTANCE_CONFIG_FILENAME));
      const second = await ensureInstanceConfig(dir, audienceEnv());

      const before = first.values['CREDENTIAL_ENCRYPTION_KEY'] ?? '';
      const after = second.values['CREDENTIAL_ENCRYPTION_KEY'] ?? '';
      expect(after).not.toBe(before);

      const cut = await readFile(cutOf(second, 'worker'), 'utf-8');
      expect(cut).toContain(after);
      expect(cut).not.toContain(before);
    });

    // A developer running bootstrap by hand serves every process from one
    // environment, and has no volumes to keep apart.
    it('cuts nothing when no audience directory is named', async () => {
      const result = await ensureInstanceConfig(dir, {});
      expect(result.audiences).toEqual({});
      await expect(stat(join(dir, 'worker'))).rejects.toThrow(/ENOENT/);
    });
  });

  // Written first and validated by the API afterwards, a rejected value leaves
  // the instance unbootable and unfixable at once: the correction supplied in
  // `.env.local` then reads as a conflict with what is stored.
  describe('validation before persistence', () => {
    const pathOf = (): string => join(dir, INSTANCE_CONFIG_FILENAME);

    it('refuses an instance secret shorter than the API accepts', async () => {
      await expect(
        ensureInstanceConfig(dir, { PHOENIX_INSTANCE_SECRET: 'too-short' }),
      ).rejects.toThrow(InvalidInstanceValueError);

      await expect(stat(pathOf())).rejects.toThrow(/ENOENT/);
    });

    it('refuses an encryption key that does not decode to 32 bytes', async () => {
      await expect(
        ensureInstanceConfig(dir, {
          CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(16, 7).toString('base64'),
        }),
      ).rejects.toThrow(/decode from base64 to exactly 32 bytes/);

      await expect(stat(pathOf())).rejects.toThrow(/ENOENT/);
    });

    it('refuses an owner id that is not a UUID', async () => {
      await expect(
        ensureInstanceConfig(dir, { PHOENIX_LOCAL_OWNER_ID: 'local-user' }),
      ).rejects.toThrow(/must be a UUID/);

      await expect(stat(pathOf())).rejects.toThrow(/ENOENT/);
    });

    // A file hand-edited into an unusable state is refused on the way out too,
    // so the refusal names the value rather than surfacing as a startup error
    // three services later.
    it('refuses a stored value the API would reject, leaving the file as it was', async () => {
      const contents = "PHOENIX_INSTANCE_SECRET='nope'\n";
      await writeFile(pathOf(), contents);

      await expect(ensureInstanceConfig(dir, {})).rejects.toThrow(/the stored value must/);
      expect(await readFile(pathOf(), 'utf-8')).toBe(contents);
    });
  });
});
