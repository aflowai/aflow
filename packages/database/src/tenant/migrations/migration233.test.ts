import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';

import { applyMigration233 } from './migration233.js';

async function sentSql(): Promise<string> {
  const sent: string[] = [];
  const client = {
    unsafe: (text: string) => {
      sent.push(text);
      return Promise.resolve([]);
    },
  } as unknown as postgres.Sql;
  await applyMigration233(client, 't_00000000000000000000000000000233');
  return sent.join('\n');
}

describe('migration 233', () => {
  it('adds the private network acknowledgment column to MCP server definitions', async () => {
    expect(await sentSql()).toMatch(
      /ALTER TABLE "[^"]+"\.mcp_server_definitions\s+ADD COLUMN IF NOT EXISTS private_network_json JSONB;/,
    );
  });

  it('records itself as version 233', async () => {
    expect(await sentSql()).toMatch(/VALUES \(233, /);
  });
});
