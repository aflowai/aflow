/**
 * A refused connect's message names Set as private network on the server's
 * card, so the card offers it in every binding state until an acknowledgment
 * is set, without a refused refresh first.
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MCP_SET_PRIVATE_NETWORK_LABEL } from '@aflow/schemas';
import type {
  McpServerBindingSummary,
  McpServerDefinitionSummary,
} from './use-mcp-integrations.js';

vi.mock('@aflow/design-system', () => {
  const tag =
    (name: string) =>
    ({ children }: { children?: ReactNode }) =>
      createElement('div', { 'data-ds': name }, children);
  return {
    Badge: tag('badge'),
    Button: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
    Card: tag('card'),
    CardBody: tag('card-body'),
    CodeBlock: tag('code'),
    Column: tag('column'),
    Divider: tag('divider'),
    Heading: tag('heading'),
    Icon: () => null,
    IconButton: ({ 'aria-label': label }: { 'aria-label': string }) =>
      createElement('button', null, label),
    ListingAvatar: () => null,
    Row: tag('row'),
    Text: tag('text'),
    Tooltip: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
  };
});

vi.mock('../user-avatar.js', () => ({ useCurrentUser: () => null }));
vi.mock('../../hooks/use-space-people.js', () => ({ useSpacePeople: () => () => undefined }));

const { McpIntegrationCard } = await import('./McpIntegrationCard.js');

const DEFINITION: McpServerDefinitionSummary = {
  serverId: 'corp',
  name: 'Corp',
  description: null,
  serverUrl: 'https://mcp.corp.example/mcp',
  transport: 'streamable_http',
  tags: [],
  source: 'custom',
  enabled: true,
  spaceId: 'space-1',
  observedProtocolVersion: null,
  toolFilter: null,
  privateNetwork: null,
  createdAt: '2026-10-30T12:00:00.000Z',
  updatedAt: '2026-10-30T12:00:00.000Z',
};

const BINDING: McpServerBindingSummary = {
  bindingId: 'corp-default',
  serverId: 'corp',
  name: 'Corp default',
  description: null,
  scope: {},
  authType: 'bearer',
  auth: {},
  credentialKeys: ['corp.token'],
  connectionPolicy: {},
  subscribeListChanged: false,
  samplingPolicy: 'off',
  pinnedOrigin: null,
  cachedToolCount: null,
  cachedToolsAt: null,
  cachedToolNames: null,
  sessionMetadata: null,
  enabled: true,
  createdAt: '2026-10-30T12:00:00.000Z',
  updatedAt: '2026-10-30T12:00:00.000Z',
};

const SECRET_SET = new Map([['corp.token', { key: 'corp.token', hasValue: true }]]);

function render(options: {
  binding?: McpServerBindingSummary;
  definition?: McpServerDefinitionSummary;
  readOnly?: boolean;
}): string {
  return renderToStaticMarkup(
    createElement(McpIntegrationCard, {
      definition: options.definition ?? DEFINITION,
      binding: options.binding,
      credentialsByKey: SECRET_SET as never,
      onEdit: () => undefined,
      onDelete: () => undefined,
      onConnect: () => undefined,
      onTest: () => Promise.resolve({ ok: true }),
      onSetPrivateNetwork: () => undefined,
      spaceId: 'space-1',
      ...(options.readOnly ? { readOnly: true } : {}),
    }),
  );
}

describe('the card with no private network acknowledgment', () => {
  it.each([
    ['with no binding', undefined],
    ['for a credentialed binding that has never connected', BINDING],
    [
      'for a paused binding',
      { ...BINDING, pinnedOrigin: 'https://mcp.corp.example', enabled: false },
    ],
    ['for a connected binding', { ...BINDING, pinnedOrigin: 'https://mcp.corp.example' }],
  ])('offers Set as private network %s', (_state, binding) => {
    expect(render(binding ? { binding } : {})).toContain(MCP_SET_PRIVATE_NETWORK_LABEL);
  });

  it('offers it on a never-connected binding where Refresh tools is not rendered', () => {
    const html = render({ binding: BINDING });
    expect(html).not.toContain('Refresh tools');
    expect(html).toContain(MCP_SET_PRIVATE_NETWORK_LABEL);
  });

  it('offers no write to a viewer', () => {
    expect(render({ binding: BINDING, readOnly: true })).not.toContain(
      MCP_SET_PRIVATE_NETWORK_LABEL,
    );
  });
});

describe('the card with an acknowledgment set', () => {
  it('shows the Private network section instead of the standing action', () => {
    const html = render({
      binding: BINDING,
      definition: {
        ...DEFINITION,
        privateNetwork: {
          hosts: ['mcp.corp.example'],
          setBy: 'user-1',
          setAt: '2026-10-30T12:00:00.000Z',
        },
      },
    });
    expect(html).not.toContain(MCP_SET_PRIVATE_NETWORK_LABEL);
    expect(html).toContain('Private network');
  });
});
