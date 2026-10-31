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
      'In the space, open Integrations and choose Add integration → MCP server. Give it a name and the server URL, pick how it authenticates, and choose Save & connect. Tools from an MCP server are opt-in: after connecting, the agent sees none of them until you list the ones it may use under Tool permissions. MCP connectors from the Store install the same way as other integrations. When a server needs you to sign in, a Connect card appears in the Workbench.',
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

When a sign-in is missing or has expired, a **Connect** or **Reconnect** card appears under **Needs attention**. Signing in resumes the work that was waiting on it.

## When the connect is refused

A server URL whose host resolves to an address outside the public internet is refused. The dialog and the card name the host and its range in words:

- **Private network address** (10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16), and **shared address space** (100.64.0.0/10), which overlay VPNs use. A setting can lift these two ranges for a server.
- **Loopback** (127.0.0.0/8), **link-local** (169.254.0.0/16) and **cloud metadata** (169.254.169.254, 100.100.100.200 and the metadata names). No setting reaches these. The same holds for current network, IETF protocol, benchmarking, multicast, reserved and broadcast addresses, IPv6 addresses and numeric addresses not written as a dotted quad.

For a server on your private network, such as one behind a VPN:

1. Choose **Set as private network** under the refusal, or on the server's card. The card offers it until a list is set, whether or not the server has connected. The **Private network** form opens for that server.
2. List each host the server uses, exactly, one per line: the server URL host, and any token or authorization endpoint host. A wildcard is refused.
3. Choose **Save**. Then edit the integration and choose **Save & connect** again.

A listed host is reached over https only, so its server URL must start with \`https://\`. No setting lifts that rule. The card's **Private network** section lists the hosts and who set them, and when. **Change hosts** edits the list, and **Clear** removes it. Only a signed-in operator sets the list. An agent cannot.

In the hosted edition, a listed host is reached only when whoever runs the deployment also lists it in \`MCP_PRIVATE_NETWORK_HOSTS\`. Until then the refusal says so.

When the refusal says this machine cannot resolve the host, the name is not known here. The VPN or its DNS may not reach the service from this machine.

## A corporate server's first run

A corporate MCP server sits on your company's network, often behind a VPN. Its first connect needs the five things below.

### 1. Set its hosts as private network

**Set as private network** saves the host list through \`PUT /v1/integrations/mcp/servers/:serverId/private-network\`. Only a signed-in operator can call it. An agent and a service principal cannot. Saving an empty list clears it.

What a listed host may reach:

- A listed host may resolve to a private network address or a shared address space address. The install connects to whichever such address the name answers with.
- A host not on the list stays refused on those ranges. That includes a host an agent writes into the server URL later.
- Loopback, link-local and cloud metadata addresses stay refused for every host, listed or not. So do IPv6 addresses and numeric addresses not written as a dotted quad.
- Every request to a listed host goes over https. An http URL to a listed host is refused before its name is looked up.

The risk is the DNS answer. Whoever controls a listed name's DNS record chooses which machine on your network it reaches. The https certificate is what proves that machine is the server named. List only hosts your organisation runs.

Every set, change and clear writes a security entry to the tenant's audit log. The entry records who made the change, when, and the hosts before and after. Saving the list already stored writes nothing. Deleting the server, or archiving its space, writes a clear entry.

### 2. Allow the redirect URI on the corporate authorization server

Sign-in returns to a callback address that ends in \`/v1/oauth/callback\`. Its origin depends on the edition.

On a local install:

- An installed bundle: \`http://127.0.0.1:3000/v1/oauth/callback\`.
- A source build from \`docker-compose.local.yml\`: \`http://127.0.0.1:<AFLOW_API_PORT>/v1/oauth/callback\`. \`AFLOW_API_PORT\` is 3000 unless you set it.
- A dev checkout: \`API_BASE_URL\` from \`.env\` followed by \`/v1/oauth/callback\`. By default that is \`http://localhost:3000/v1/oauth/callback\`.

In the hosted edition, the callback is the deployment's public API origin followed by \`/v1/oauth/callback\`, such as \`https://api.example.com/v1/oauth/callback\`. That origin is \`API_BASE_URL\`, which whoever runs the deployment sets. Ask them for its value.

The corporate authorization server must allow that exact URI for the client you use. It treats \`127.0.0.1\` and \`localhost\` as different URIs. Your browser follows the redirect, so the authorization server never connects to the callback address. Aflow derives the address from \`API_BASE_URL\` and accepts no other. Only the authorization server's administrators can allow it.

### 3. Register a client with the corporate authorization server

The built-in OAuth app is a public client with no secret. Its client ID is the URL of a document Aflow serves at \`/.well-known/cimd\` under \`API_BASE_URL\`. The authorization server fetches that document to learn the app's name and redirect URI.

- On a local install, the built-in app cannot sign in. Its document sits on the install's loopback address, and an authorization server on another machine cannot fetch it.
- In the hosted edition, the document sits on the deployment's public origin and names the callback from step 2. Aflow does not stop the built-in app from signing in there. It works only when the corporate authorization server accepts a document URL as a client ID and can fetch that document. Aflow does not check either before sign-in.

When the built-in app cannot sign in, use a client registered with the corporate authorization server instead:

1. Ask its administrators for a client that allows the redirect URI from step 2. Sign-in uses the authorization code flow with PKCE. A client secret is optional, for a public client.
2. Under **Tenant Admin → OAuth Apps**, choose **Register app**, then **Issuer → Other (custom)**.
3. Set **Issuer key** to the server URL's origin, such as \`https://mcp.corp.example\`. Sign-in looks the app up by this key, so it must match exactly. When the integration's **Auth server** is filled in, use that value as typed instead.
4. Set **Authorization server URL** to the corporate authorization server. Fill in **Client ID**, **Client secret** and **Default scopes**. Sign-in asks for the default scopes, or for the scopes the server advertises when you give none.
5. Edit the integration. Choose **OAuth — browser sign-in**, and set **Which OAuth app drives sign-in?** to **A tenant-registered OAuth app**.

In the hosted edition, a space admin can register the client under the space's **Settings → OAuth Apps** instead. The integration then names **A space-registered OAuth app**.

Sign-in reads the client ID and secret from the registered app, not from the integration form. It reads the server's protected resource metadata first, so the server must publish it. When the authorization server's host resolves to a private address, list it in step 1 too.

A server that takes **OAuth — client credentials** needs no redirect URI and no registered app. Its client ID and secret go on the integration form, and **Token URL** names the token endpoint. List the token endpoint's host in step 1 when it is on your private network. **Scopes** under **More OAuth options** go with the token request.

### 4. In the hosted edition, the deployment lists the host

The hosted edition reaches a listed host only when \`MCP_PRIVATE_NETWORK_HOSTS\` also names it. The variable holds comma-separated hostnames, matched exactly, with no wildcards. Whoever runs the deployment sets it in the deployment's environment. A tenant admin cannot set it, and no screen sets it.

- Saving a host list with a host the variable does not name is refused. The refusal names the variable.
- The variable is read again at every connect. A host removed from it is refused at the next connect, and the refusal says the deployment does not list it.
- Set it on the API server, which runs sign-in, and on the worker, which runs the MCP connection.

The local edition does not read the variable. Its operator is the deployment.

### 5. Test that the install's containers resolve and reach the server

A VPN client may resolve corporate names for this machine and not for Docker's containers. That depends on the VPN client and on Docker. Test from inside Aflow Local, in the folder that holds its compose file:

\`\`\`sh
docker compose exec worker node -e "require('node:dns').lookup('mcp.corp.example',{family:4},(e,a)=>console.log(e?e.code:a))"
\`\`\`

Use your server's hostname, and run it again with \`api\` in place of \`worker\`. A source build adds \`-f docker-compose.local.yml\` after \`docker compose\`.

- An address such as \`10.1.2.3\` means the container resolves the name.
- \`ENOTFOUND\` or \`EAI_AGAIN\` means it cannot. Aflow reports the same failure as a host this machine cannot resolve.

Then test the route:

\`\`\`sh
docker compose exec worker node -e "fetch('https://mcp.corp.example/').then(r=>console.log(r.status),e=>console.log(e.cause?.code??e.message))"
\`\`\`

- Any HTTP status, even 401 or 404, means the container reaches the server over https.
- \`ETIMEDOUT\`, \`UND_ERR_CONNECT_TIMEOUT\`, \`ECONNREFUSED\` or \`EHOSTUNREACH\` means the name resolves but the container has no route to it.
- A certificate code such as \`UNABLE_TO_VERIFY_LEAF_SIGNATURE\` or \`SELF_SIGNED_CERT_IN_CHAIN\` means the container does not trust the server's certificate. Aflow's connect fails the same way.`,
    editions: ['enterprise', 'community-local'],
    anchors: {
      routes: ['s/[space]/integrations', 'settings/oauth-apps', 's/[space]/settings/oauth-apps'],
      operations: [],
    },
    related: ['connect-an-integration', 'where-credentials-live', 'what-is-waiting-for-me'],
    keywords: [
      'mcp',
      'model context protocol',
      'server url',
      'oauth',
      'tool permissions',
      'allowlist',
      'sign in',
      'private network',
      'vpn',
      'refused',
      'MCP_PRIVATE_NETWORK_HOSTS',
      'corporate',
      'redirect uri',
      'callback',
      'oauth app',
      'dns',
      'first run',
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

A missing or expired sign-in appears as a **Connect** card in the Workbench.

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
