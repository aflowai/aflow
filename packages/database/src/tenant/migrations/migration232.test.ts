import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';

import { applyMigration232 } from './migration232.js';

async function sentSql(): Promise<string> {
  const sent: string[] = [];
  const client = {
    unsafe: (text: string) => {
      sent.push(text);
      return Promise.resolve([]);
    },
  } as unknown as postgres.Sql;
  await applyMigration232(client, 't_00000000000000000000000000000232');
  return sent.join('\n');
}

describe('migration 232', () => {
  it('adds the private network acknowledgment column to MCP server definitions', async () => {
    expect(await sentSql()).toMatch(
      /ALTER TABLE "[^"]+"\.mcp_server_definitions\s+ADD COLUMN IF NOT EXISTS private_network_json JSONB;/,
    );
  });

  it('records itself as version 232', async () => {
    expect(await sentSql()).toMatch(/VALUES \(232, /);
  });
});
