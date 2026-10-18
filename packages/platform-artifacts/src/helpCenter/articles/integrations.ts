import type { HelpArticleInput } from '@aflow/schemas';

export const INTEGRATIONS_ARTICLES: readonly HelpArticleInput[] = [
  {
    id: 'connect-an-integration',
    theme: 'integrations',
    question: 'How do I connect an API or tool so my agents can use it?',
    summary:
      'Integrations are space-level: open Integrations in the space. Browse integrations opens the Store, where ready-made connectors install with one click and then ask for what they still need, such as a secret or a site URL. Add integration → API defines your own API by hand. You can also ask the Helmsman in chat to connect one; it drafts the integration and sends it to you as a proposal to approve. Once a connection shows Ready, the agents in that space can find and call its tools.',
    body: `## Where

**Integrations** in the space's sidebar. Space editors and admins can add and change integrations.

## From the Store

1. Choose **Browse integrations**. The Store opens on **Integrations**.
2. Open a connector. **What you'll need** lists what it asks for, such as a key or a site address.
3. Choose **Install**.
4. Back on **Integrations**, the new connection shows **Needs setup** or **Needs secret** until it has what it needs. Choose a missing-secret pill, or **Edit**, to paste a secret; fill in the **Site URL** where the connector has one.

## By hand

**Add integration → API** opens **Add API**: a name, the base URL and the endpoints. Then **Connect** it, choosing an **Authentication Type**: bearer token, API key, basic auth, OAuth client credentials, OAuth sign-in with an account, or none.

For an MCP server, choose **Add integration → MCP server**.

## By asking

Ask the Helmsman to connect a service. It drafts the API integration and proposes it; nothing is added until you approve the proposal.

## Status

- **Ready**: agents can call it.
- **Needs setup**: authentication or a required value is missing.
- **Needs secret**: a secret has not been entered.
- **Not connected**: no connection yet, or an account sign-in has not happened.

A write the agent makes through an API integration can wait for your approval first, depending on the space's **Write Policy**.`,
    editions: ['enterprise', 'community-local'],
    anchors: {
      routes: ['s/[space]/integrations', 's/[space]/store', 's/[space]/store/[catalogId]'],
      operations: ['capability.binding.propose'],
    },
    related: [
      'connect-mcp-server',
      'where-credentials-live',
      'write-approval',
      'proposals-need-approval',
    ],
    keywords: [
      'connector',
      'api',
      'rest',
      'tool',
      'github',
      'jira',
      'install',
      'binding',
      'connection',
      'secret',
    ],
  },
  {
    id: 'connect-mcp-server',
    theme: 'integrations',
    question: 'How do I connect an MCP server?',
    summary:
      'In the space, open Integrations and choose Add integration → MCP server. Give it a name and the server URL, pick how it authenticates, and choose Save & connect. Tools from an MCP server are opt-in: after connecting, the agent sees none of them until you list the ones it may use under Tool permissions. MCP connectors from the Store install the same way as other integrations. When a server needs you to sign in, a Connect card appears in the Action Center.',
    body: `## Where

**Integrations → Add integration → MCP server**.

## Steps

1. Fill in **Integration name** and **Server URL**. A **Description** tells the agents what the server provides.
2. Under **Authentication**, choose an **Auth type**:
   - **No auth (public server)**
   - **API token** or **Custom header**, with the value to send
   - **OAuth — client credentials**, with a token URL, client ID and secret
   - **OAuth — browser sign-in** or **OAuth — automatic registration**, where you sign in with the service's own account
3. For sign-in types, choose who connects: **Each user connects their own account**, or **One shared connection for this space**.
4. Choose **Save & connect**. If the server cannot be reached, the dialog says why; you can still save it and connect later from its card.

## Pick the tools

After connecting, the card reads **No tools enabled yet — the agent sees zero tools by default.** Edit the integration and fill in **Tool permissions**:

- **Allow these tools**: the only tools the agent sees.
- **Block these tools**: always hidden.
- **Operation-task only**: callable from workflow tasks, never directly by an agent.

**Refresh tools** on the card fetches the server's current tool list. A card warns when an agent would see so many tools that the list should be narrowed.

## Sign-in later

When a sign-in is missing or has expired, a **Connect** or **Reconnect** card appears under **Needs attention**. Signing in resumes the work that was waiting on it.`,
    editions: ['enterprise', 'community-local'],
    anchors: { routes: ['s/[space]/integrations'], operations: [] },
    related: ['connect-an-integration', 'where-credentials-live', 'action-center'],
    keywords: [
      'mcp',
      'model context protocol',
      'server url',
      'oauth',
      'tool permissions',
      'allowlist',
      'sign in',
    ],
  },
  {
    id: 'where-credentials-live',
    theme: 'integrations',
    question: 'Where are my keys and integration secrets stored, and who can use them?',
    summary:
      'Model provider keys live at one of three levels: your personal keys (used only for you, in every space), a space key (shared with members of that space who have no personal key), or a tenant default key (shared with every member who has neither). A personal key wins over a space key, and a space key over a tenant key. Integration secrets belong to the connection in the space that owns it. Account sign-ins for integrations are kept either per person or as one shared connection for the space, as the integration was set up. Every secret is encrypted and never shown again after saving.',
    body: `## Model provider keys

Where: **Tenant Admin → Credentials** and **Settings → Credentials**.

- **Your Keys**: personal keys that follow you across all your spaces and are used only for you.
- **Space key**: set under a space's **Settings → Credentials**, or by ticking **Store for this workspace only** when you add a key. Shared with members of that space who have no personal key.
- **Tenant Default Keys**: set by admins on **Tenant Admin → Credentials**. Shared with every member who has neither.

When several exist, personal wins, then space, then tenant. **Effective Resolution** shows which one each provider uses for you, and a space's credentials list marks a provider **Covered by your key** or **Covered by tenant key**.

## Integration secrets

An API key or token for an integration belongs to that connection, in the space that owns the integration. **Add Secret** on the connection stores it; it is encrypted at rest and never shown again.

## Account sign-ins

An integration that signs in with an account is set up one of two ways:

- **Each user connects their own account**: every member signs in once and acts as themselves.
- **One shared connection for this space**: a single account everyone in the space shares.

A missing or expired sign-in appears as a **Connect** card in the Action Center.

## Your own OAuth app

Sign-in uses the built-in OAuth app unless you register your own under **Tenant Admin → OAuth Apps** and choose it on the integration.`,
    editions: ['enterprise', 'community-local'],
    anchors: {
      routes: [
        'settings/credentials',
        's/[space]/settings/credentials',
        's/[space]/integrations',
        'settings/oauth-apps',
      ],
      operations: [],
    },
    related: [
      'add-model-provider',
      'connect-an-integration',
      'connect-mcp-server',
      'what-leaves-this-computer',
    ],
    keywords: [
      'credentials',
      'secret',
      'api key',
      'encrypted',
      'personal key',
      'tenant key',
      'space key',
      'oauth',
      'token',
    ],
  },
];
