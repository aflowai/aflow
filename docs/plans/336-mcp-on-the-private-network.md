# Plan 336 — An MCP server on the operator's private network connects

**Status:** P0 merged. P1 is built: D1, D2, D3, D5 and the D7 audit. Its unit cases in §5 pass, and the live connect its exit names has not been run. The operator's review deferred D4, so https stays required for every credentialed request in both editions. P2 to P4 are not built.

**Builds on:** Plan 185 (OAuth bindings, consent pause), Plan 253 (operator-owned settings carry a server-stamped principal), Plan 315 (the local edition's first run), Plan 323 D4 (`CREDENTIAL_EXTRA_BASE_URL_ORIGINS` admits a host on the network), Plan 325 (help articles).

**Leaves alone:** the public-address egress rules, the tenant integration policy allowlist, API definitions and their direct-URL calls, the raw `serverUrl` path of `mcp.tool.call`, IPv6 egress, and the OAuth callback URL itself.

## 1. Problem

A corporate MCP server cannot be connected. It has an internal hostname that resolves to a `10.x` address. It is reachable only over the VPN, and it asks for OAuth or a bearer token. `mcp.binding.test`, the connect before a tool call, and `mcp.server.refresh_tools` all stop at the private-address refusal. A credentialed binding cannot be enabled without a successful test, because the test pins its origin. The UI then says only "connection error".

The operator has decided the direction. Reaching a private address becomes an operator setting. The platform fixes the limits of that setting, and no setting moves them.

This round changes documentation only. It did not reproduce the case on a live stack. The facts below come from reading the code at `054f1c6e`.

## 2. What the code shows today

| #   | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **One function decides reachability.** `resolveAndValidateHost` in `packages/network-safety/src/index.ts` refuses an IPv6 literal (`ipv6-literal`) and a non-canonical numeric spelling (`non-canonical-numeric`). It range-checks a canonical dotted quad directly. Any other name it resolves with `lookup(hostname, { family: 4 })` and range-checks the answer. `validateUrl` and `validateCredentialedUrl` both reach it. `safeFetch` reaches it through `validateUrl`.                                                                                                              |
| F2  | **The blocked ranges carry labels.** `BLOCKED_CIDRS` lists `current-network`, `private-rfc1918` (three blocks), `shared-address-space` (`100.64.0.0/10`), `loopback`, `link-local`, `cloud-metadata`, `ietf-protocol`, `benchmark`, `multicast`, `reserved` and `broadcast`. `isPrivateIp` returns the first match. `169.254.0.0/16` precedes `169.254.169.254/32`, so the metadata address reports `link-local` and the `cloud-metadata` label is never emitted. An address form `isIPv4` does not accept fails closed as `unrecognized-address-form`.                                   |
| F3  | **No name is refused, only addresses.** `metadata.google.internal` is refused because it resolves into `link-local`. Nothing in the package refuses it by name.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| F4  | **The https rule lives in `validateCredentialedUrl`.** It refuses any scheme but `https:` before any DNS work. Its comment says why. Callers fetch by name after the check, so the DNS check alone can race, and TLS certificate validation is what closes the race.                                                                                                                                                                                                                                                                                                                      |
| F5  | **`safeFetch` pins http and goes by name over https.** Over http it dials the validated IP and carries the original host in the `Host` header, so resolution cannot change between check and connect. Over https it goes by name, because a pinned IP would present a certificate for the wrong name, and the certificate already defeats a rebind. `safeFetchImpl` wraps it as a `typeof fetch` with no policy argument.                                                                                                                                                                 |
| F6  | **The refusal is typed.** `SsrfBlockedError` carries `code: 'API_SSRF_BLOCKED'`, `kind` (`allowlist-host`, `private-ip`, `invalid-protocol`, `invalid-url`, `unresolvable`) and an optional `rangeLabel`. Nothing raises `unresolvable`. A failed lookup raises `DnsBlockedError` instead, with no kind.                                                                                                                                                                                                                                                                                  |
| F7  | **The MCP connect checks twice.** `acquireManaged` in `apps/aflow-executor-mcp/src/handlers/mcpHandler.ts` runs `assertTenantPolicyPermitsConnect`. It then runs `validateCredentialedUrl` when the binding sends auth headers, else `validateUrl`. `acquire` gives `StreamableHTTPClientTransport` the `safeFetchImpl` transport, so every later request is checked again.                                                                                                                                                                                                               |
| F8  | **The MCP executor drops the label.** `handleManagedCall` and `refreshBindingCache` turn an `SsrfBlockedError` or `DnsBlockedError` into `validationError(err.message)`. `validationError` accepts `details`, but none are passed, so `kind` and `rangeLabel` stop at the executor.                                                                                                                                                                                                                                                                                                       |
| F9  | **The tenant guard is a separate refusal.** `tenantPolicyGuard.ts` refuses a host outside the tenant allowlist and the catalog grant, as `kind: 'allowlist-host'`. It does not call `resolveAndValidateHost`. `assertTenantPolicyPermitsTokenEndpoint` applies the same set to a client-credentials token endpoint.                                                                                                                                                                                                                                                                       |
| F10 | **Token exchanges check, then fetch by name without pinning.** `getClientCredentialsToken` (`apps/aflow-executor-mcp/src/auth/clientCredentialsToken.ts`), `postToTokenEndpoint` (`packages/oauth/src/tokenManager.ts`) and the API executor's `oauth2.ts` each call `validateCredentialedUrl`. Each then calls plain `fetch` with `redirect: 'error'`. They rely on F4.                                                                                                                                                                                                                  |
| F11 | **OAuth discovery checks and fetches through the safe transport.** `discoverPRM` and `discoverPRMReactive` (`packages/oauth/src/prmDiscovery.ts`) and `discoverAsMetadata` (`asMetadata.ts`) call `validateUrl(..., [])` and fetch with `safeFetchImpl`. `discoverPRMReactive` takes its URL from the server's own `WWW-Authenticate` header.                                                                                                                                                                                                                                             |
| F12 | **The credentialed API egress uses `validateUrl` and pins.** `executeSingle` in `apps/aflow-executor-api/src/handlers/api/execution.ts` calls `validateUrl(resolved.url, allowedHosts)`, and again on every redirect hop. It dials the IP over http and the name over https. `errors.ts` logs `kind` and `range` but returns `API_SSRF_BLOCKED` with the message only.                                                                                                                                                                                                                    |
| F13 | **The other callers.** `apiAdminOpenApiImport.ts` (orchestrator) fetches an OpenAPI document with `validateUrl` and `safeFetch`. `runware.ts` and `googleVideo.ts` (`packages/ai-client`) fetch provider results with `validateUrl`, `validateCredentialedUrl` and `safeFetch`.                                                                                                                                                                                                                                                                                                           |
| F14 | **The repo precedent allows RFC1918.** `isBlockedInternalHost` in `packages/schemas/src/models/repoBinding.ts` refuses `localhost`, `metadata`, any `*.internal` name and any name containing `:`. It also refuses loosely parsed `0/8`, `127/8` and `169.254/16`. RFC1918 stays allowed so a self-hosted GitHub on a private network works.                                                                                                                                                                                                                                              |
| F15 | **The deployment precedent belongs to whoever runs the deployment.** `operatorAllowedOrigins()` in `packages/server-runtime/src/routes/credentials.ts` reads `CREDENTIAL_EXTRA_BASE_URL_ORIGINS`. Its comment says that whoever runs the deployment sets it, never a tenant admin through the API, so a credential writer cannot choose where a secret goes. `ownership.ts` marks the key `core`.                                                                                                                                                                                         |
| F16 | **The definition holds one URL.** `McpServerDefinitionSchema` (`packages/schemas/src/models/mcpServerDefinition.ts`) has `serverUrl` and `protectedResourceMetadataPath`. The token endpoint (`oauth2_client_credentials.tokenEndpoint`) and the authorization server (`.authorizationServer` on `oauth2_pkce` and `oauth2_cimd`) sit on the binding's `auth`. Without one, the authorization server comes from PRM discovery. `buildMcpOAuthDescriptor` (`packages/oauth/src/mcpBinding.ts`) carries `serverUrl`, the PRM path and the authorization server as `McpDiscovery`.           |
| F17 | **An agent can write a definition.** `POST /v1/integrations/mcp/servers` (`mcp-servers.ts`, authz `api_config` `write`) takes `McpServerDefinitionSchema`. So does the `mcp.server.upsert` operation. The Helmsman's surface in `cyberneticAgents.ts` holds it, with `mcp.binding.upsert`. A skill bundle carries the same schema (`skillBundle.ts`). Any field added to that schema is writable by an agent and travels in a bundle.                                                                                                                                                     |
| F18 | **Edition on the server is a descriptor, not a helper.** `resolveEditionDescriptor` and `processEditionDescriptor` (`packages/schemas/src/edition/descriptor.ts`) read `PHOENIX_EDITION`. An unset value means `enterprise`. No server-side `isLocalEdition` function exists, although CLAUDE.md names one. The client has `useEdition()` (`packages/web-product/src/ui/hooks/useEdition.ts`), whose `id` is `community-local` or `enterprise`. On the appliance every runtime service, the worker included, inherits `PHOENIX_EDITION: community-local` from `docker-compose.local.yml`. |
| F19 | **The UI never receives the error.** `testBinding` (`use-mcp-integrations.ts`) starts a one-step session with `?wait=30s` and reads `body.error?.message`. The wait branch in `packages/server-runtime/src/routes/runs.ts` sends `errorRef` and never sets `error`, although its response schema declares `error`. So every failure, every consent pause and every timeout renders as "Couldn't refresh: connection error" on the card (`McpIntegrationCard.tsx`), or as "Couldn't connect." in the form.                                                                                 |
| F20 | **A 401 at connect is a retryable internal error.** `refreshBindingCache` turns any non-SSRF connect failure into `internalError(..., { retryable: true })`. Only a tool call retries a 401, through `isUnauthorizedError`, and only for an OAuth binding. A consent pause comes only from token resolution (`oauthConsentReasonFromError`, reasons `never_connected` and `expired`).                                                                                                                                                                                                     |
| F21 | **A successful test closes the form.** `McpIntegrationFormDialog` enables the binding and closes. An empty `toolFilter.include` exposes no tool (`applyToolFilter`). The agent sees nothing until the operator opens **Tool permissions** separately.                                                                                                                                                                                                                                                                                                                                     |
| F22 | **The local callback is on loopback.** `resolveOAuthCallbackUrl()` (`packages/oauth/src/config.ts`) is `API_BASE_URL` plus `/v1/oauth/callback`. The appliance sets `API_BASE_URL: http://127.0.0.1:${AFLOW_API_PORT:-3000}`. A dev checkout's `.env.example` sets `http://localhost:3000`. The platform client id of a `clientScope: 'platform'` binding is the CIMD document under the same base (`resolveCimdDocumentUrl()`).                                                                                                                                                          |
| F23 | **An audit table exists.** `tenant_audit_log` (`packages/database/src/schema/tenant/audit.ts`) records `timestamp`, `actorId`, `actorKind`, `category`, `action`, `outcome`, `resourceType`, `resourceId`, `spaceId` and `details`. `skillLifecycle.ts` and `spaceLifecycle.ts` write it.                                                                                                                                                                                                                                                                                                 |

## 3. Decisions

### D1 — The exception follows who chose the destination, not the edition

A destination is **operator-fixed** when the operator wrote it in a setting before any run. That covers an MCP definition's `serverUrl` host. It also covers the token and authorization endpoint hosts the operator names for that definition. A destination is **agent-chosen** when a run composes it: a direct-URL API call, the raw `serverUrl` path of `mcp.tool.call`, an OpenAPI import URL. An agent-chosen destination never gets the exception, in any edition.

F17 makes the definition itself writable by an agent. So the exception does not trust the stored `serverUrl`. It trusts the list of hosts the operator acknowledged (D2). If the Helmsman rewrites `serverUrl` to another private host, that host is not on the list and is refused.

A discovered endpoint is chosen by the MCP server, not the operator. That includes an authorization server from PRM and a `resource_metadata` URL from a `WWW-Authenticate` header (F11). It gets the exception only when its host is on the list. A skill bundle never carries the list, because the list is not part of `McpServerDefinitionSchema`.

_Rejected:_

- **Widen every private address in the local edition.** On a local install `192.168.x` is the operator's router, printer and NAS. A prompt-injected run could make a direct-URL call to the router's admin page. The edition says who runs the deployment. It does not say who chose the URL.
- **Trust the stored `serverUrl` host.** An agent can write it (F17). Trust would then pass to whoever last ran `mcp.server.upsert`.

### D2 — One acknowledgment per definition lifts RFC1918 and shared address space for its listed hosts

The definition gains an operator-only record, the **private network acknowledgment**. It holds these fields:

- The hosts it covers. These are the `serverUrl` host at the time of setting, plus any token or authorization endpoint host the operator adds.
- Who set it and when (D7).

The record holds no plaintext field. D4 is deferred, so a listed host is reached over https only.

Hosts match exactly. Each entry is a hostname or a canonical dotted quad. There are no wildcards.

For a listed host, `resolveAndValidateHost` admits an address labelled `private-rfc1918` or `shared-address-space`. Every other label stays refused for every host, listed or not:

- `loopback`, `current-network` and `link-local`.
- Cloud metadata, by address and by name.
- `non-canonical-numeric`, `ipv6-literal` and `unrecognized-address-form`.
- `ietf-protocol`, `benchmark`, `multicast`, `reserved` and `broadcast`.

Shared address space (`100.64.0.0/10`) is included. Overlay VPNs such as Tailscale give corporate hosts addresses in that block. A corporate server reached that way is the same case as one on `10.x`. One address inside the block is a metadata endpoint on one cloud (`100.100.100.200`). P1 lists it as `cloud-metadata`, ahead of `shared-address-space`. P1 also moves `169.254.169.254/32` ahead of `link-local`, so the metadata label is reachable and D6 can name it (F2).

Metadata names are refused before resolution, in `@aflow/network-safety`, for every caller. The names are `metadata`, `metadata.google.internal` and `metadata.goog`. Today they are refused only through their address (F3). The write route also refuses a listed host that is one of these names. It refuses any host `isBlockedInternalHost` refuses, except under its `*.internal` rule.

The `*.internal` rule from F14 is not copied. ICANN has reserved `.internal` for private use, so a corporate MCP server may be named `mcp.corp.internal`. The metadata name is refused by name. Every other `.internal` name is judged by the address it resolves to.

_Rejected:_

- **A boolean on the definition that covers whatever `serverUrl` names.** It fails D1, because an agent can rewrite the URL.
- **Wildcard host entries (`*.corp.example`).** A wildcard covers names the server or an agent later chooses, such as a discovered authorization server under the same suffix.
- **Lift RFC1918 only.** Overlay-VPN users would hit the same dead end, labelled `shared-address-space`.
- **One switch per tenant or per space.** It covers definitions the operator did not look at, including ones a bundle installs later.

### D3 — The policy is one argument of the one validation function

`resolveAndValidateHost(hostname, policy)` takes a `PrivateNetworkPolicy`. The default is the empty policy, which refuses exactly what is refused today. `validateUrl`, `validateCredentialedUrl` and `safeFetch` pass the argument through. `safeFetchImpl` stays the default-policy transport. A new `safeFetchFor(policy)` returns a `typeof fetch` bound to one policy, for the injected-transport callers.

A caller supplies a value. It never decides reachability. One pure function in `@aflow/network-safety`, `privateNetworkPolicyFor({ acknowledgment, edition, deploymentHosts })`, builds the value from the stored acknowledgment, the edition and the deployment list (D5). The MCP executor's space loader builds it once per definition, so every path in that process reads one value. The API server builds it the same way for consent.

| Caller                                                                                               | Reaches the function through                                                 | Policy it passes                            |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------- |
| `McpHandler.acquireManaged` (connect, test, refresh, 401 retry)                                      | `validateCredentialedUrl` or `validateUrl`                                   | the definition's                            |
| `McpHandler.acquire`, managed transport requests                                                     | `safeFetchImpl` → `safeFetch` → `validateUrl`, which becomes `safeFetchFor`  | the definition's                            |
| `McpHandler.handleRawCall` (raw `serverUrl`)                                                         | `safeFetchImpl`                                                              | default, by D1                              |
| `tenantPolicyGuard.ts`                                                                               | does not reach it (F9). It runs first, and the acknowledgment never lifts it | —                                           |
| `getClientCredentialsToken` (MCP)                                                                    | `validateCredentialedUrl`                                                    | the definition's                            |
| `postToTokenEndpoint`, `discoverPRM`, `discoverPRMReactive`, `discoverAsMetadata` for an MCP binding | `validateCredentialedUrl`, `validateUrl`, `safeFetchImpl`                    | the definition's, carried on `McpDiscovery` |
| the same `@aflow/oauth` functions for an API binding (`api-oauth.ts`)                                | as above                                                                     | default                                     |
| API executor `oauth2.ts`                                                                             | `validateCredentialedUrl`                                                    | default                                     |
| API executor `executeSingle` and its redirect hops                                                   | `validateUrl`                                                                | default                                     |
| `apiAdminOpenApiImport.ts`                                                                           | `validateUrl`, `safeFetch`                                                   | default                                     |
| `runware.ts`, `googleVideo.ts`                                                                       | `validateUrl`, `validateCredentialedUrl`, `safeFetch`                        | default                                     |

A guard test fails if any module outside `@aflow/network-safety` calls `isPrivateIp` or compares a `rangeLabel` to decide whether to connect. That keeps the decision in one function.

_Rejected:_

- **A wrapper in the MCP executor that catches `private-rfc1918` and connects anyway.** Every caller in the table would need its own copy. The discovery and token paths in `@aflow/oauth` would be missed, and consent would then fail at the authorization server.
- **A process-wide switch in `@aflow/network-safety`, read from the environment.** It would widen the API executor and the OpenAPI import in the same process, which D1 refuses.
- **Extend the exception to API definitions now.** The case is MCP. API definitions can take the same argument in a later plan, once their write path separates the operator from the agent as D2 does here.

### D4 — Deferred — https required; a plaintext acknowledgment is designed when a server that terminates no TLS is actually in front of an operator

The operator's review deferred this decision. `validateCredentialedUrl` refuses `http:` for every credentialed request, in both editions and under every policy. A private network policy widens the addresses a listed host may resolve to. It never lifts the https rule.

So nothing in this plan admits plaintext:

- The record has no plaintext field (D2).
- No label names a public answer for a listed host, and no remedy offers plaintext (D6).
- The audit records only setting and clearing hosts (D7).
- The token exchanges keep their transport. `getClientCredentialsToken` and `postToTokenEndpoint` fetch by name over https (F10), and the certificate still defeats a rebind (F4).

The reason for waiting is the risk the design would accept. Over http the bearer token, the OAuth access token or the client secret travels in the clear on the local network. Pinning (F5) makes the checked address the dialled one, but it does not authenticate the peer. A name that rebinds between two private addresses passes both the check and the pin. A host that takes over the address by ARP or DHCP spoofing receives the token, and an observer on the path reads it.

Most corporate MCP servers serve https. The design is written when an operator is in front of one that terminates no TLS. It then starts from the rules this section's first draft named: a second acknowledgment the operator sets after reading the risk, every credentialed http request through the pinned `safeFetch`, and a refusal of any public answer for a listed host.

_Rejected:_

- **Build the plaintext acknowledgment now.** No operator has a server that needs it yet, and it would put credentials on the wire for a case nobody has shown.
- **Allow http on private hosts without an acknowledgment, because pinning holds.** Pinning does not stop the LAN cases above.

### D5 — The local edition accepts the acknowledgment, and the hosted edition needs the deployment to list the host

`privateNetworkPolicyFor` reads the edition from `processEditionDescriptor()` (F18). P1 adds a server-side `isLocalEdition()` beside it, so the code matches the helper CLAUDE.md names.

- **`community-local`.** The acknowledgment takes effect as set. The person who runs the install is the deployment.
- **`enterprise`.** A listed host takes effect only when the deployment's environment also names it in `MCP_PRIVATE_NETWORK_HOSTS`. The variable holds comma-separated hostnames. It is registered `core` in `ownership.ts` and documented in `.env.example`, on the `CREDENTIAL_EXTRA_BASE_URL_ORIGINS` precedent (F15). The write route refuses an acknowledgment naming an unlisted host, and its message names the variable.

The executor applies the rule again at every connect. A record that predates a change to the variable is refused rather than honoured. So is a record that arrived in a database copied from a local install.

In the hosted deployment, RFC1918 is the platform's own network: its Redis, its Postgres and its other services. A tenant admin who could reach it from the worker could read another tenant's data. Only whoever runs the deployment can know which private hosts are a customer's and not the platform's.

_Rejected:_

- **A tenant-admin setting under Integrations Policy.** It hands the worker's reach into the platform network to a tenant.
- **Reuse `CREDENTIAL_EXTRA_BASE_URL_ORIGINS`.** It answers where a model credential's config may point. Sharing it would widen both questions at once. Its entries are origins, and this rule is about hosts.
- **Refuse the acknowledgment outright in the hosted edition.** A dedicated hosted deployment with a VPN peering to one customer has the same need. Its operator can say so in the environment.

### D6 — A refusal names the range and the remedy, a 401 leads to consent, and a successful test leads to tool permissions

**Refusals.** `resolveAndValidateHost` sets a `remedy` on every address refusal. The MCP executor passes `details` to `validationError` (F8): `kind`, `rangeLabel`, the refused `target` and the `remedy`. The remedies are these:

- `acknowledge_private_network`, for a `private-rfc1918` or `shared-address-space` host with no acknowledgment or not on the list.
- `deployment_must_list_host`, for the hosted case in D5.
- `none`, for every label D2 keeps refused. The message says that no setting reaches that address.

A credentialed http request is refused as `invalid-protocol`. No setting lifts that refusal while D4 is deferred.

`DnsBlockedError` gets `kind: 'unresolvable'`, so the kind F6 declares is finally raised. Its remedy text says that this machine cannot resolve the name. It adds that the VPN or its DNS may not reach the service.

The message carries the same remedy in words, because the Helmsman reads the message on its next turn. Each remedy names where the operator acts: **Integrations → the server → Private network**. The Helmsman cannot set the acknowledgment. It is not in `McpServerUpsertInputSchema`, so no prompt prose is needed to forbid it.

**UI.** The wait branch in `runs.ts` fills the `error` its schema already declares (F19), with the step's stored error code, message and details. `testBinding` reads them. The card and the form name the range in words, for example "private network address (10.0.0.0/8)" or "cloud metadata address". They offer the remedy as an action. That is **Set as private network** for the first remedy, and the remedy text for the others.

**Auth on connect.** In `refreshBindingCache`, `isUnauthorizedError` recognises a 401 at connect. The step result depends on the binding:

- An OAuth binding pauses with `mcpConsentPause`, under a new consent reason `rejected` in `OAuthConsentReasonSchema`.
- A `bearer` or `header` binding fails with the remedy `replace_credential`.
- An `auth: none` binding fails with the remedy `choose_oauth`, because the server wants credentials the binding does not send.

A `PAUSED` result with an `oauth_consent` request renders **Connect account**, not "connection error". P3 answers one open question against the MCP SDK. The question is whether its connect error exposes the `WWW-Authenticate` header. If it does, an auth challenge without a 401 status can be recognised too.

**After a successful test.** When `toolFilter.include` is empty, the form stays open on **Tool permissions** with the fetched tools listed. It does not close. The card's refresh opens the same section in the same state (F21).

_Rejected:_

- **Keep the generic text and log the label.** The operator's complaint is exactly this.
- **Fetch `errorRef` from the hook.** Every caller of `?wait` would repeat it. The route already declares the field.
- **Retry the connect after a forced token refresh, as the tool call does.** For a token that was never issued, or that the server rejects, that is the dead refresh the operator sees.

### D7 — The local consent callback is on loopback, and every change to the acknowledgment is audited

**Operator note, not a platform change.** On the appliance the OAuth redirect URI is `http://127.0.0.1:<AFLOW_API_PORT>/v1/oauth/callback`. In a dev checkout it is `http://localhost:3000/v1/oauth/callback` (F22). The corporate authorization server must list that exact URI for the client in use. The browser follows the redirect on the operator's own machine, so the authorization server never has to reach it.

A `clientScope: 'platform'` binding identifies itself by the CIMD document under the same loopback base. An authorization server on another machine cannot fetch that document. So a corporate server needs a client registered with it, used through `clientScope: 'tenant'` or `'space'`. The platform cannot change either fact. The callback is derived from `API_BASE_URL` on purpose, and `config.ts` refuses a caller-supplied one.

**Audit.** The acknowledgment is written only through `PUT /v1/integrations/mcp/servers/:serverId/private-network`. The body is the host list, and an empty list clears the record. There is no separate `DELETE`. The authz is `api_config` `write`, as for definitions. The route refuses a service principal, as `mcp-oauth.ts` does for user-scoped consent. Writing the hosts already stored changes nothing and writes no row. Every set, change and clear writes a `tenant_audit_log` row in the same transaction, with these values:

- `category: 'security'`.
- `action` set to `mcp.private_network.set` or `mcp.private_network.cleared`.
- `resourceType: 'mcp_server_definition'`, with the server id and the space.
- The actor and the timestamp, which record who and when.
- `details` holding the hosts before and after, and the edition.

Deleting a definition that has the record writes the `cleared` row, with the deletion as its cause. The row names whoever deleted it: the user of the REST route or the store uninstall, or `system` for `mcp.server.delete` in a run. The record also stores `setBy` and `setAt`, so the UI can show them without reading the log.

_Rejected:_

- **Let `mcp.server.upsert` set the acknowledgment and audit it there.** An agent would then set it (F17), and D1 would mean nothing.
- **Rewrite the callback to a reachable hostname.** It breaks the loopback-only exposure of the local API. The authorization server would still have to list the URI.

## 4. What it affects

- `@aflow/network-safety`: the policy argument, `safeFetchFor`, `privateNetworkPolicyFor`, the reordered and added metadata entries, the metadata names and the `unresolvable` kind.
- `@aflow/schemas`: the acknowledgment record and its route schemas, outside `McpServerDefinitionSchema`. Also the `rejected` consent reason, `isLocalEdition()` and the `MCP_PRIVATE_NETWORK_HOSTS` ownership entry.
- `@aflow/database`: one column on `mcp_server_definitions` holding the record, added by tenant migration.
- `@aflow/cybernetic-runtime`: the one writer of the record, its audit rows, and the `cleared` row when a definition holding a record is deleted.
- `@aflow/server-runtime`: the one `PUT` route, the wait branch's `error`, and the policy on consent discovery.
- `@aflow/oauth`: the policy carried on `McpDiscovery`, and `mcpPrivateNetworkPolicy`, which every MCP caller reads the policy from. The token exchanges keep fetching by name over https.
- `apps/aflow-executor-mcp`: the policy at connect, on the transport and for client credentials. Also the refusal details and the 401 handling at connect.
- `@aflow/web-product`: the refusal text and actions, **Connect account**, the **Private network** section and the **Tool permissions** landing.
- `packages/platform-artifacts/src/helpCenter/articles/integrations.ts`: the `connect-mcp-server` article.
- Unchanged: the API executor, the OpenAPI import, `ai-client`, the tenant allowlist and the raw MCP path all keep the default policy.

## 5. How it is proven

Each case fails if the change is wrong.

- **Listed host, private address.** `resolveAndValidateHost('mcp.corp.example', policy)` passes with the host listed and DNS answering `10.1.2.3`. The same name answering `127.0.0.1`, `169.254.169.254` or `100.100.100.200` is refused as `loopback`, `cloud-metadata` and `cloud-metadata`.
- **Unlisted host.** An unlisted name answering `10.1.2.3` is refused as `private-rfc1918` under the same policy.
- **Metadata name.** `metadata.google.internal` is refused by name under every policy. The write route refuses it as a listed host.
- **Default argument.** The existing `index.test.ts` passes unchanged with no policy argument.
- **Https.** `validateCredentialedUrl('http://…', policy)` to a listed host is refused as `invalid-protocol`, before any resolution. So is the http token exchange for client credentials and for `postToTokenEndpoint`.
- **Agent-chosen destinations.** With a definition listing `mcp.corp.example`, the raw `mcp.tool.call` path and an API direct-URL call to the same host are both refused as `private-rfc1918`.
- **Agent rewrite.** `mcp.server.upsert` with a `serverUrl` on another private host leaves that host refused. An upsert input carrying the acknowledgment leaves the stored record unchanged.
- **Hosted.** Under `PHOENIX_EDITION=enterprise`, the route refuses an acknowledgment for a host missing from `MCP_PRIVATE_NETWORK_HOSTS`. An executor given a stored record for that host refuses with `deployment_must_list_host`.
- **Audit.** Set and clear each write one `tenant_audit_log` row naming the actor. Deleting a definition that holds a record writes the `cleared` row.
- **UI.** `testBinding` given a wait response with a `private-rfc1918` error renders the range and **Set as private network**. Given `PAUSED` with an `oauth_consent` request, it renders **Connect account**.
- **Guard test.** No module outside `@aflow/network-safety` calls `isPrivateIp` or compares a `rangeLabel` to decide whether to connect.
- **Live (P4).** On a local install on a VPN, a corporate MCP server with OAuth goes through test, consent and tool permissions to a tool call.

## 6. Phases

**P0 — This document and its index row.** _Exit:_ the operator approves or amends §3.

**P1 — The policy argument and the definition's acknowledgment (D1, D2, D3, D5, and the D7 audit). Built.** D4 is deferred. It holds these parts:

- The `@aflow/network-safety` changes and their tests.
- The record, its column and its one `PUT` route, with the edition rule and `MCP_PRIVATE_NETWORK_HOSTS`.
- The audit rows.
- The policy passed by every MCP caller in the D3 table.
- The `remedy` on an address refusal and the MCP executor's refusal `details`, which the hosted case in §5 reads.

_Exit:_ every case in §5 except UI and Live passes. A local install connects to a listed `10.x` host over https.

**P2 — The UI and the Helmsman's remedy text (the D6 refusals).** It holds the remedy text in the step message, the `unresolvable` remedy text, `error` in the wait branch, and the card and form text and actions. It also holds the **Private network** section, which shows who set the acknowledgment and when, and the help article. _Exit:_ the UI cases in §5 pass. A refused test names the range and the remedy in the UI and in the step error the Helmsman reads.

**P3 — The auth nudge and the tool-permissions landing (D6 auth and landing).** It holds the `rejected` consent reason, the 401 handling at connect, **Connect account** and the **Tool permissions** landing. It also answers whether an auth challenge without a 401 can be recognised. _Exit:_ a test against a server that answers 401 at connect pauses for consent instead of failing as retryable. A successful first test of a definition with no tools picked lands on **Tool permissions**.

**P4 — An operator note for a corporate MCP server's first run (the D7 note).** A section in the `connect-mcp-server` help article covers these points:

- The acknowledgment and its risk.
- The loopback redirect URI to register with the corporate authorization server.
- The client registration that replaces the platform CIMD client.
- The hosted deployment variable.
- A test that the install's containers can resolve and route the VPN's names, which may depend on the VPN client.

_Exit:_ the live case in §5 is run by following the article as written.
