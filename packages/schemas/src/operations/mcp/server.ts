import { z } from 'zod';
import type { OperationRegistration } from '../../catalog/operationCatalog.js';
import {
  McpServerDefinitionSchema,
  McpCachedToolSchema,
  McpSessionMetadataSchema,
} from '../../models/mcpServerDefinition.js';
import { NULL_CLEARS, RunSpaceIdSchema, UPDATE_KEEPS_OMITTED } from './runSpace.js';

const definitionShape = McpServerDefinitionSchema.shape;

/**
 * Upsert input: definition shape minus auto-populated timestamps. The optional
 * fields an operator sets also take `null`, which clears the stored value —
 * leaving one out on an update keeps it.
 */
export const McpServerUpsertInputSchema = McpServerDefinitionSchema.omit({
  createdAt: true,
  updatedAt: true,
})
  .extend({
    description: definitionShape.description.nullable().describe(NULL_CLEARS),
    toolFilter: definitionShape.toolFilter
      .nullable()
      .describe(`Restricts which of the server's tools are exposed. ${NULL_CLEARS}`),
    protectedResourceMetadataPath: definitionShape.protectedResourceMetadataPath
      .nullable()
      .describe(`Override path for OAuth Protected Resource Metadata discovery. ${NULL_CLEARS}`),
    icon: definitionShape.icon
      .nullable()
      .describe(`${definitionShape.icon.description ?? ''} ${NULL_CLEARS}`.trim()),
    tags: McpServerDefinitionSchema.shape.tags.describe(
      `Replaces the stored tags when given. ${UPDATE_KEEPS_OMITTED}`,
    ),
    source: McpServerDefinitionSchema.shape.source.describe(
      `Defaults to 'custom' on create. ${UPDATE_KEEPS_OMITTED}`,
    ),
    spaceId: RunSpaceIdSchema,
  })
  .describe(UPDATE_KEEPS_OMITTED);
export type McpServerUpsertInput = z.infer<typeof McpServerUpsertInputSchema>;

export const McpServerUpsertOutputSchema = z.object({
  serverId: z.string(),
  spaceId: z.string().uuid(),
  created: z.boolean().describe('True if the row was newly created; false if updated'),
});
export type McpServerUpsertOutput = z.infer<typeof McpServerUpsertOutputSchema>;

export const McpServerGetInputSchema = z.object({
  serverId: z.string().max(128),
  spaceId: RunSpaceIdSchema,
});
export type McpServerGetInput = z.infer<typeof McpServerGetInputSchema>;

export const McpServerGetOutputSchema = z.object({
  definition: McpServerDefinitionSchema.nullable(),
});
export type McpServerGetOutput = z.infer<typeof McpServerGetOutputSchema>;

export const McpServerListInputSchema = z.object({
  spaceId: RunSpaceIdSchema,
  /** Filter by source (platform/custom/discovered/bundle). */
  source: z.enum(['platform', 'custom', 'discovered', 'bundle']).optional(),
  /** Filter by enabled status. */
  enabled: z.boolean().optional(),
});
export type McpServerListInput = z.infer<typeof McpServerListInputSchema>;

export const McpServerListOutputSchema = z.object({
  definitions: z.array(McpServerDefinitionSchema),
});
export type McpServerListOutput = z.infer<typeof McpServerListOutputSchema>;

export const McpServerDeleteInputSchema = z.object({
  serverId: z.string().max(128),
  spaceId: RunSpaceIdSchema,
});
export type McpServerDeleteInput = z.infer<typeof McpServerDeleteInputSchema>;

export const McpServerDeleteOutputSchema = z.object({
  deleted: z.boolean(),
});
export type McpServerDeleteOutput = z.infer<typeof McpServerDeleteOutputSchema>;

/**
 * Connect with a binding's auth and refresh that binding's cached tool list +
 * pinned origin + session metadata. Routed through the MCP executor.
 */
export const McpServerRefreshToolsInputSchema = z.object({
  serverId: z.string().max(128),
  /** Binding to authenticate with; auth determines what tools the server returns. */
  bindingId: z.string().max(128),
});
export type McpServerRefreshToolsInput = z.infer<typeof McpServerRefreshToolsInputSchema>;

export const McpServerRefreshToolsOutputSchema = z.object({
  serverId: z.string(),
  bindingId: z.string(),
  tools: z.array(McpCachedToolSchema),
  pinnedOrigin: z.string(),
  sessionMetadata: McpSessionMetadataSchema,
  cachedToolsAt: z.string().datetime(),
});
export type McpServerRefreshToolsOutput = z.infer<typeof McpServerRefreshToolsOutputSchema>;

export const McpServerOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'mcp',
    group: 'server',
    verb: 'upsert',
    name: 'Upsert MCP Server Definition',
    actionLabel: 'Saving MCP server definition…',
    semanticDescription:
      "Create or update an MCP server definition in the run's space (serverId, URL, transport, " +
      'toolFilter, PRM hints). An update writes only the fields given; every field left out keeps ' +
      'its stored value, and schema defaults apply only when creating. description, toolFilter, ' +
      'icon and protectedResourceMetadataPath take null to clear the stored value. Definitions hold no ' +
      'credentials — pair with a binding to authorize access.',
    tags: ['crud', 'mcp', 'integration'],
    crudView: { entityType: 'mcp_server_definition', action: 'create' },
    privileged: true,
    idempotency: 'idempotent',
    mutates: true,
    inputAsSent: true,
    usage: {
      oneLine:
        'Register an MCP server definition. After this: create a binding (mcp.binding.upsert) to ' +
        'configure auth, then run mcp.binding.test to populate cache + origin pin.',
      whenToUse: [
        'Registering a new external MCP server for use by agents',
        'Updating tool filter, PRM path, or tags on an existing definition',
      ],
      whenNotToUse: [
        'Changing auth credentials — that is on the binding, not the definition',
        'Calling tools — use mcp.tool.call via a promoted binding',
      ],
      pitfalls: [
        "Definitions are written to the run's space; the same serverId can live in other spaces " +
          'independently. There is no spaceId to supply — naming another space is refused.',
        'serverId, name and serverUrl are required on every call, so an update always writes them. ' +
          'Every other field left out — tags, source, toolFilter, description, icon — keeps its ' +
          'stored value; a field given replaces the stored one whole.',
        'To remove a stored description, toolFilter, icon or protectedResourceMetadataPath, send ' +
          'it as null — leaving it out keeps it.',
        'Streamable HTTP is the only supported transport per spec rev 2025-11-25.',
      ],
      minimalExampleInput: {
        serverId: 'example-mcp',
        name: 'Example MCP',
        serverUrl: 'https://mcp.example.com/mcp',
        transport: 'streamable_http',
      },
      followUp: [
        {
          operationId: 'mcp.binding.upsert',
          note: 'Create a binding to configure credentials and policy',
          condition: 'when_available',
        },
      ],
    },
    accessMode: 'write',
    riskModifiers: ['privileged'],
    inputZod: McpServerUpsertInputSchema,
    outputZod: McpServerUpsertOutputSchema,
  },
  {
    stepType: 'mcp',
    group: 'server',
    verb: 'get',
    name: 'Get MCP Server Definition',
    actionLabel: 'Loading MCP server…',
    semanticDescription: "Load a single MCP server definition by serverId from the run's space.",
    tags: ['crud', 'mcp'],
    crudView: { entityType: 'mcp_server_definition', action: 'read' },
    idempotency: 'idempotent',
    usage: {
      oneLine: 'Get an MCP server definition by id.',
      whenToUse: ['Inspecting a definition before editing or wiring a binding to it'],
      whenNotToUse: ['Listing many definitions — use mcp.server.list'],
      pitfalls: [],
      minimalExampleInput: { serverId: 'kaggle' },
    },
    accessMode: 'read',
    inputZod: McpServerGetInputSchema,
    outputZod: McpServerGetOutputSchema,
  },
  {
    stepType: 'mcp',
    group: 'server',
    verb: 'list',
    name: 'List MCP Server Definitions',
    actionLabel: 'Listing MCP servers…',
    semanticDescription:
      "List the MCP server definitions in the run's space, optionally filtered by source or " +
      'enabled status. Other spaces are never listed.',
    tags: ['crud', 'mcp'],
    crudView: { entityType: 'mcp_server_definition', action: 'read' },
    idempotency: 'idempotent',
    usage: {
      oneLine: "List MCP server definitions in the run's space.",
      whenToUse: ['Browsing available MCP servers', 'Auditing platform vs custom installs'],
      whenNotToUse: ['Looking up a single known definition — use mcp.server.get'],
      pitfalls: [],
      minimalExampleInput: {},
    },
    accessMode: 'read',
    inputZod: McpServerListInputSchema,
    outputZod: McpServerListOutputSchema,
  },
  {
    stepType: 'mcp',
    group: 'server',
    verb: 'delete',
    name: 'Delete MCP Server Definition',
    actionLabel: 'Deleting MCP server…',
    semanticDescription:
      "Delete an MCP server definition from the run's space together with what exists only for " +
      "it there: every binding to it, the space's OAuth tokens and in-flight OAuth consent state " +
      'for it, and the stored credentials no remaining API or MCP binding in the space references. ' +
      'No binding survives to repoint.',
    tags: ['crud', 'mcp'],
    crudView: { entityType: 'mcp_server_definition', action: 'delete' },
    privileged: true,
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine: 'Delete an MCP server definition with its bindings, tokens and unused credentials.',
      whenToUse: ['Removing a server and every connection to it from this space for good'],
      whenNotToUse: [
        'Disabling temporarily — set enabled: false on the binding instead',
        'Removing one connection — use mcp.binding.delete, which keeps the server and its OAuth tokens',
      ],
      pitfalls: [
        'Irreversible: re-adding the server means upserting its bindings, storing their credential values and completing OAuth consent again.',
        "User- and tenant-owned OAuth tokens survive; only the space's own tokens for this server are removed.",
      ],
      minimalExampleInput: { serverId: 'example-mcp' },
    },
    accessMode: 'write',
    riskModifiers: ['privileged'],
    inputZod: McpServerDeleteInputSchema,
    outputZod: McpServerDeleteOutputSchema,
  },
  {
    stepType: 'mcp',
    group: 'server',
    verb: 'refresh_tools',
    name: 'Refresh MCP Server Tools',
    actionLabel: 'Refreshing MCP server tools…',
    semanticDescription:
      'Connect to the MCP server using the specified binding, call tools/list, and write the result ' +
      'to the binding (cachedTools, cachedToolsAt, pinnedOrigin, sessionMetadata). Routed through the ' +
      'MCP executor.',
    tags: ['mcp', 'discovery', 'cache'],
    privileged: true,
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine: "Refresh a binding's tool cache by reconnecting to the server.",
      whenToUse: [
        'After a server adds or renames tools',
        'After credential changes to verify the binding still works',
        'To populate the cache for a newly created binding before enabling it',
      ],
      whenNotToUse: ['As a substitute for mcp.binding.test on first connect'],
      pitfalls: [
        'MCP servers may return different tool lists per credential — refresh is per-binding, not per-definition.',
      ],
      minimalExampleInput: {
        serverId: 'kaggle',
        bindingId: 'kaggle-default',
      },
    },
    accessMode: 'write',
    riskModifiers: ['privileged'],
    inputZod: McpServerRefreshToolsInputSchema,
    outputZod: McpServerRefreshToolsOutputSchema,
  },
];
