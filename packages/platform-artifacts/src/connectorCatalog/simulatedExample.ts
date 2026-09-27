import type { ConnectorCatalogEntry } from '@aflow/schemas';

/**
 * The reference simulated connector: an integration with no host behind it.
 *
 * Hidden, because it is a fixture rather than something an operator should find
 * in the store. What it exists to hold is the SHAPE — a contract complete
 * enough to answer, `authKind: 'none'` because nothing is authenticated, and no
 * world, because the world is minted per space at install and authored there.
 *
 * Every endpoint declares its response schemas, which is what lets the minted
 * simulation answer from the first call: `unmatched: 'generate'` needs a
 * contract to generate against, and an endpoint without one can be called but
 * not simulated.
 */
export const SIMULATED_EXAMPLE_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'simulated-example',
  version: 1,
  name: 'Example (simulated)',
  tagline: 'a worked example of an integration answered by a declared world',
  description:
    'A two-endpoint contract with no service behind it. Installing it mints a simulation for ' +
    'the space and binds it, so calls are answered from a world rather than sent to a host — ' +
    'no credential, no egress, bound on arrival. It answers by generation until collections ' +
    'and effects are authored into the simulation, which is what walks it from plausible ' +
    'answers to fixed ones.',
  tags: ['simulation', 'example'],
  category: 'example',
  honestyLabel: 'curated',
  authKind: 'none',
  fulfillment: 'simulated',
  hidden: true,
  definition: {
    apiId: 'simulated-example',
    name: 'Example (simulated)',
    description: 'A worked example of a contract answered by a declared world.',
    baseUrl: 'https://simulated.invalid',
    version: '1',
    callMode: 'endpoint',
    tags: ['simulation', 'example'],
    endpoints: [
      {
        endpointId: 'listWidgets',
        name: 'List widgets',
        method: 'GET',
        pathTemplate: '/widgets',
        description: 'Widgets belonging to the calling account.',
        params: [
          { name: 'status', location: 'query', required: false, schema: { type: 'string' } },
        ],
        tags: [],
        responseSchemas: {
          '2xx': {
            type: 'array',
            items: {
              type: 'object',
              required: ['widgetId', 'name', 'status'],
              properties: {
                widgetId: { type: 'string' },
                name: { type: 'string' },
                status: { type: 'string', enum: ['active', 'retired'] },
              },
            },
          },
        },
      },
      {
        endpointId: 'getWidget',
        name: 'Get widget',
        method: 'GET',
        pathTemplate: '/widgets/{widgetId}',
        description: 'One widget by its reference.',
        params: [
          { name: 'widgetId', location: 'path', required: true, schema: { type: 'string' } },
        ],
        tags: [],
        responseSchemas: {
          '2xx': {
            type: 'object',
            required: ['widgetId', 'name', 'status'],
            properties: {
              widgetId: { type: 'string' },
              name: { type: 'string' },
              status: { type: 'string', enum: ['active', 'retired'] },
              retiredOn: { type: 'string' },
            },
          },
          '4xx': {
            type: 'object',
            required: ['error'],
            properties: { error: { type: 'string' } },
          },
        },
      },
    ],
  },
};
