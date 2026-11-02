import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';

import { applyMigration237 } from './migration237.js';

async function sentSql(): Promise<string> {
  const sent: string[] = [];
  const client = {
    unsafe: (text: string) => {
      sent.push(text);
      return Promise.resolve([]);
    },
  } as unknown as postgres.Sql;
  await applyMigration237(client, 't_00000000000000000000000000000237');
  return sent.join('\n');
}

describe('migration 237', () => {
  it('rewrites only the wait reason of a card that waits on design_document', async () => {
    expect(await sentSql()).toMatch(
      /UPDATE "[^"]+"\.plan_nodes\s+SET card = jsonb_set\(card, '\{waitsOn,reason\}', '"design_decision"'::jsonb\)\s+WHERE card -> 'waitsOn' ->> 'reason' = 'design_document';/,
    );
  });

  it('records itself as version 237', async () => {
    expect(await sentSql()).toMatch(/VALUES \(237, /);
  });
});
