/**
 * The columns an MCP upsert's ON CONFLICT update writes are derived from the
 * Zod and drizzle shapes, so a field added to either is written without a
 * hand-kept list to extend. These pin what the derivation yields today and
 * that every field an agent can send reaches the row.
 */
import { describe, expect, it } from 'vitest';
import { McpBindingUpsertInputSchema, McpServerUpsertInputSchema } from '@aflow/schemas';
import { mcpBindingUpdateColumns, mcpDefinitionUpdateColumns } from '../mcpIntegrationAdmin.js';

describe('MCP upsert update columns', () => {
  it('derives the definition columns, leaving the rest to definition_json', () => {
    expect(mcpDefinitionUpdateColumns()).toEqual({
      name: 'name',
      description: 'description',
      serverUrl: 'server_url',
      transport: 'transport',
      tags: 'tags',
      source: 'source',
    });
  });

  it('derives a column for every binding field', () => {
    expect(mcpBindingUpdateColumns()).toEqual({
      serverId: 'server_id',
      name: 'name',
      description: 'description',
      auth: 'auth_json',
      subscribeListChanged: 'subscribe_list_changed',
      samplingPolicy: 'sampling_policy',
      ownerScope: 'owner_scope',
      clientScope: 'client_scope',
      enabled: 'enabled',
    });
  });

  it('writes every binding field an agent can send', () => {
    // The conflict key, and the inputs written apart from the column list.
    const writtenApart = ['bindingId', 'scope', 'connectionPolicy', 'clear'];
    const unwritten = Object.keys(McpBindingUpsertInputSchema.shape).filter(
      (field) => !writtenApart.includes(field) && !(field in mcpBindingUpdateColumns()),
    );
    expect(unwritten).toEqual([]);
  });

  it('gives every definition field an agent can send a column or a place in definition_json', () => {
    const notStored = ['serverId', 'spaceId', 'clear'];
    const columnFields = Object.keys(mcpDefinitionUpdateColumns());
    const jsonFields = Object.keys(McpServerUpsertInputSchema.shape).filter(
      (field) => !notStored.includes(field) && !columnFields.includes(field),
    );
    // definition_json holds the whole definition; these live only there.
    expect(jsonFields.sort()).toEqual(
      ['icon', 'observedProtocolVersion', 'protectedResourceMetadataPath', 'toolFilter'].sort(),
    );
  });
});
