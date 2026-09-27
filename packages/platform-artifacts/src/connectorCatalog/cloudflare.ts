import type { ConnectorCatalogEntry } from '@aflow/schemas';

const zoneIdParam = {
  name: 'zone_id',
  location: 'path' as const,
  required: true,
  description: 'The zone id the record or cache belongs to.',
  schema: { type: 'string' },
};

const dnsRecordIdParam = {
  name: 'dns_record_id',
  location: 'path' as const,
  required: true,
  description: 'The id of the DNS record.',
  schema: { type: 'string' },
};

const dnsRecordBodyProperties = {
  type: {
    type: 'string',
    description: 'Record type, e.g. "A", "AAAA", "CNAME", "TXT", "MX".',
  },
  name: {
    type: 'string',
    description: 'DNS record name (the fully-qualified host, e.g. "www.example.com").',
  },
  content: {
    type: 'string',
    description: 'Record content — the target value, e.g. the IPv4 address for an A record.',
  },
  ttl: {
    type: 'integer',
    description: 'Time to live in seconds. 1 means "automatic".',
  },
  proxied: {
    type: 'boolean',
    description:
      'Whether the record is receiving the Cloudflare proxy (orange cloud) with its ' +
      'performance and security benefits.',
  },
};

export const CLOUDFLARE_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'cloudflare',
  version: 1,
  name: 'Cloudflare',
  tagline: 'Manage Cloudflare zones, DNS records, and cache from the API.',
  description:
    'Cloudflare API (v4). List and inspect zones, list/read/create/update/delete a zone’s ' +
    'DNS records, and purge a zone’s cache. Authenticated with a scoped API token sent as a ' +
    'bearer token — not the legacy X-Auth-Key/X-Auth-Email pair.',
  tags: ['dns', 'cdn', 'cache', 'zones', 'cloudflare'],
  vendor: 'Cloudflare',
  category: 'developer-tools',
  honestyLabel: 'curated',
  authKind: 'bearer',
  setupNote:
    'Create a scoped API token at dash.cloudflare.com → My Profile → API Tokens (e.g. a ' +
    'Zone:DNS:Edit token). It is sent as Authorization: Bearer <token>. Do not use the legacy ' +
    'Global API Key with X-Auth-Key/X-Auth-Email.',
  credentialPrompts: [
    {
      authField: 'credentialKey',
      label: 'Cloudflare API token',
      setupNote:
        'From dash.cloudflare.com → My Profile → API Tokens → Create Token. Use a scoped token ' +
        '(e.g. Zone:DNS:Edit), not the Global API Key. Sent as Authorization: Bearer.',
    },
  ],
  definition: {
    apiId: 'cloudflare',
    name: 'Cloudflare',
    description: 'Cloudflare API v4 — zones, DNS records, and cache purge.',
    baseUrl: 'https://api.cloudflare.com/client/v4',
    version: '4',
    callMode: 'endpoint',
    defaultHeaders: { Accept: 'application/json' },
    suggestedEgressPolicy: { allowedMethods: ['GET', 'POST', 'PUT', 'DELETE'] },
    tags: ['dns', 'cloudflare'],
    endpoints: [
      {
        endpointId: 'listZones',
        name: 'List zones',
        description:
          'List the zones (domains) on the account, optionally filtered by name or status.',
        method: 'GET',
        pathTemplate: '/zones',
        params: [
          {
            name: 'name',
            location: 'query',
            required: false,
            description: 'Filter to zones matching this domain name.',
            schema: { type: 'string' },
          },
          {
            name: 'status',
            location: 'query',
            required: false,
            description:
              'Filter by zone status, e.g. "active", "pending", "initializing", or "moved".',
            schema: { type: 'string' },
          },
        ],
        tags: ['zones'],
      },
      {
        endpointId: 'getZone',
        name: 'Get zone',
        description: 'Retrieve the details of a single zone by its id.',
        method: 'GET',
        pathTemplate: '/zones/{zone_id}',
        params: [zoneIdParam],
        tags: ['zones'],
      },
      {
        endpointId: 'listDnsRecords',
        name: 'List DNS records',
        description: 'List the DNS records for a zone, optionally filtered by record type or name.',
        method: 'GET',
        pathTemplate: '/zones/{zone_id}/dns_records',
        params: [
          zoneIdParam,
          {
            name: 'type',
            location: 'query',
            required: false,
            description: 'Filter to records of this type, e.g. "A", "CNAME", "TXT".',
            schema: { type: 'string' },
          },
          {
            name: 'name',
            location: 'query',
            required: false,
            description: 'Filter to records matching this name.',
            schema: { type: 'string' },
          },
        ],
        tags: ['dns'],
      },
      {
        endpointId: 'getDnsRecord',
        name: 'Get DNS record',
        description: 'Retrieve the details of a single DNS record in a zone.',
        method: 'GET',
        pathTemplate: '/zones/{zone_id}/dns_records/{dns_record_id}',
        params: [zoneIdParam, dnsRecordIdParam],
        tags: ['dns'],
      },
      {
        endpointId: 'createDnsRecord',
        name: 'Create DNS record',
        description:
          'Create a new DNS record in a zone. This changes live DNS serving for the domain.',
        method: 'POST',
        writeRiskTier: 'medium',
        pathTemplate: '/zones/{zone_id}/dns_records',
        params: [
          zoneIdParam,
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The DNS record to create.',
            schema: {
              type: 'object',
              required: ['type', 'name', 'content'],
              properties: dnsRecordBodyProperties,
              additionalProperties: false,
            },
          },
        ],
        tags: ['dns'],
      },
      {
        endpointId: 'updateDnsRecord',
        name: 'Update DNS record',
        description:
          'Overwrite an existing DNS record in a zone. This changes live DNS serving for the domain.',
        method: 'PUT',
        writeRiskTier: 'medium',
        pathTemplate: '/zones/{zone_id}/dns_records/{dns_record_id}',
        params: [
          zoneIdParam,
          dnsRecordIdParam,
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The full record definition to write.',
            schema: {
              type: 'object',
              required: ['type', 'name', 'content'],
              properties: dnsRecordBodyProperties,
              additionalProperties: false,
            },
          },
        ],
        tags: ['dns'],
      },
      {
        endpointId: 'deleteDnsRecord',
        name: 'Delete DNS record',
        description:
          'Delete a DNS record from a zone. This removes it from live DNS serving for the domain.',
        method: 'DELETE',
        writeRiskTier: 'medium',
        pathTemplate: '/zones/{zone_id}/dns_records/{dns_record_id}',
        params: [zoneIdParam, dnsRecordIdParam],
        tags: ['dns'],
      },
      {
        endpointId: 'purgeCache',
        name: 'Purge cache',
        description:
          'Purge cached content for a zone — either everything, or a specific set of files, ' +
          'tags, hosts, or prefixes. This affects live cache serving for the domain.',
        method: 'POST',
        writeRiskTier: 'medium',
        pathTemplate: '/zones/{zone_id}/purge_cache',
        params: [
          zoneIdParam,
          {
            name: 'body',
            location: 'body',
            required: true,
            description:
              'What to purge. Supply purge_everything, or exactly one of files/tags/hosts/prefixes.',
            schema: {
              type: 'object',
              properties: {
                purge_everything: {
                  type: 'boolean',
                  description: 'Purge every cached file for the zone.',
                },
                files: {
                  type: 'array',
                  description: 'Specific URLs to purge from cache.',
                  items: { type: 'string' },
                },
                tags: {
                  type: 'array',
                  description: 'Cache-Tag values to purge (Enterprise).',
                  items: { type: 'string' },
                },
                hosts: {
                  type: 'array',
                  description: 'Hostnames whose cached content should be purged (Enterprise).',
                  items: { type: 'string' },
                },
                prefixes: {
                  type: 'array',
                  description: 'URL prefixes whose cached content should be purged (Enterprise).',
                  items: { type: 'string' },
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['cache'],
      },
    ],
  },
};
