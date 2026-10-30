import { expect, it } from 'vitest';
import type postgres from 'postgres';
import { applyMigration232 } from './migration232.js';
it('leaves existing links untrusted instead of blessing resident-written history', async () => {
  const sent: string[] = [];
  const client = {
    unsafe: (text: string) => {
      sent.push(text);
      return Promise.resolve([]);
    },
  } as unknown as postgres.Sql;
  await applyMigration232(client, 'tenant_test');
  expect(sent.join('')).toContain('trusted_for_close BOOLEAN NOT NULL DEFAULT false');
});
