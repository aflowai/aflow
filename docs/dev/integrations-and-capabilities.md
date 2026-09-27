# Integrations and Capabilities

> **Authoritative reference for the unified integration surface (Plan 155).**
> Use this doc when wiring agents, skills, or tools to APIs or MCP servers,
> when reading workflow grants, or when adding a new integration source.

## What "integration" means

An **integration** is any external surface your agents can call —
a REST API or an MCP server. The platform treats both under one umbrella
(`IntegrationDescriptor`) so agents discover, promote, bind, and call them
through the same operations. Protocol-specific behavior lives below the
surface; the agent-facing model is uniform.

| Concept          | API source                    | MCP source                             |
| ---------------- | ----------------------------- | -------------------------------------- |
| Definition table | `api_definitions`             | `mcp_server_definitions`               |
| Binding table    | `api_bindings`                | `mcp_server_bindings`                  |
| Tool unit        | endpoint                      | tool                                   |
| Call operation   | `api.http.call`               | `mcp.tool.call`                        |
| Discovery extras | endpoint params + body schema | tool input schema (cached on test/use) |

Both surfaces share:

- `IntegrationDescriptor { sourceKind: 'api' | 'mcp', integrationId, … }`
- `IntegrationToolDescriptor { sourceKind, integrationId, toolName, … }`
- `catalog.tool.search` / `catalog.tool.promote` (agent-callable)
- `integration.registry.list` / `integration.registry.lookup` (agent-callable)
- `discovery.integrations: { mode: 'none' | 'bound' | 'allowlist' }`
- `context.capabilities.integrations[]` (unified workflow grants)

## Templated base URLs (binding-time variables)

An API definition's host can vary per binding — a JIRA site subdomain, a region,
an account id. Instead of baking it into `baseUrl`, the definition declares a
**`baseUrlTemplate`** with `{name}` placeholders and a **`variables[]`** array
describing each; the binding supplies the values in **`variableValues`**
(non-secret, space-scoped — never credentials). At call time the api executor
resolves the template against `variableValues` (`resolveBaseUrl`), and the egress
allowlist is enforced against the **resolved** host.

- Exactly one of `baseUrl` (concrete) or `baseUrlTemplate` is set; a concrete
  `baseUrl` may not contain `{}` (schema-enforced teaching error).
- A variable value is host-safe — letters, digits, dot, underscore, hyphen only,
  never URL delimiters (`/`, `@`, `:`) — so it can't escape the template's host
  (the egress boundary). Validated at write time and again at call time.
- A binding with required variables unfilled is **needs configuration** until the
  operator supplies them (recompute-at-read, no persisted flag).
- Authored three ways, one shape: the integrations form (type `{name}` in the
  Base URL, describe each), `bind-capability` in chat, or a curated catalog entry.
  The Connect dialog renders the template as a fill-in-the-blank Site URL.

## Installable connectors (catalog)

The **head** connectors (JIRA, GitHub, …) ship as curated `ConnectorCatalogEntry`
items (`packages/platform-artifacts/src/connectorCatalog/`) — a vetted
`ApiDefinition` + auth/variable prompts + honesty label. Installing one
(`POST /v1/spaces/:spaceId/store/install`) registers the definition and creates a
needs-config binding **through the same write path as `bind-capability`** (no fork);
the operator then supplies credentials + variable values. `bind-capability` remains
the long-tail authoring path. List/discover via `GET /v1/store/listings?kind=connector`.

**A catalog entry declares its embedded definition under its own `catalogId`** — `github`'s definition is
`apiId: 'github'`, pinned by `packages/platform-artifacts/src/__tests__/connectorCatalogIdentity.test.ts`
because nothing in `ConnectorCatalogEntrySchema` can express it and a drift fails _silently_ (see
[How an integration gets its avatar](#how-an-integration-gets-its-avatar), which depends on it).

### How an integration gets its avatar

`resolveIntegrationIcon(id, definitionJson)` (`packages/server-runtime/src/routes/integrations/`) runs in the one
row mapper each definition kind goes through, and both API and MCP definition responses carry the result as an
optional `icon: IconRef`. Precedence:

1. **`icon` on the definition** — the author's/operator's own choice. Because it lives on
   `ApiDefinitionSchema` / `McpServerDefinitionSchema`, it round-trips through `definition_json` with no
   migration and no route change, and it is the path by which a **hand-authored** integration gets real
   artwork (a UI picker only has to write this field).
2. **The curated default for that id** — `curatedIntegrationIcon(id)`, a code-level registry keyed by
   `catalogId`, valid because a curated connector's id is platform-owned and install registers its definition
   verbatim under that id.
3. **Nothing** — `ListingAvatar` draws its deterministic initials tile. Artwork is never required.

Two consequences worth knowing:

- **The curated rung is a live read, not a copy.** Nothing per-space is stored, so changing a listing's icon
  changes it in every space that installed it, retroactively, on the next deploy — no migration, no stale
  copies. Since it ships in code, it is a deploy rather than a data change and cannot vary per tenant. This is
  deliberately _different_ from the endpoints beside it, which are copied at install and frozen at
  `store_installs.installedVersion`: a rebrand should propagate, a behaviour change should not.
- **Setting an explicit icon on a store-installed connector is a local modification**, so it counts as
  divergence like any other and `replace_on_update` will drop it on update. That is the correct reading of
  both mechanisms; override artwork belongs on definitions the space owns.

We deliberately **do not** resolve the curated rung through install provenance, even though
`store_install_artifacts` records `(catalogId, spaceId, 'api_definition', <definitionId>)` and could support a
real join. It would add a per-space query to hot read paths and thread tenant context into synchronous row
mappers, to correct a case that requires someone to hand-author a definition named exactly after a curated
connector they did not install — where inheriting that brand mark is arguably right anyway. The id is not a
proxy for provenance here; it _is_ the identifier, and rung 1 covers everything rung 2 would get wrong.

## How an agent uses an integration

```
catalog.tool.search → catalog.tool.promote → <call tool by promoted ID>
```

1. **Discover.** `catalog.tool.search` returns matching tools across every
   integration the agent's discovery scope covers, with each tool tagged
   `sourceKind: 'api' | 'mcp'`.
2. **Promote.** `catalog.tool.promote` registers the tool on the current
   agent turn — only promoted tools are callable. The runtime lowers the
   call to the right execution kernel (`api.http.call` or `mcp.tool.call`)
   internally; the agent does not pick a protocol.
3. **Call.** The promoted tool ID appears in `agentTurn`'s tool list and
   the agent calls it like any other tool.

**Endpoint body contract (Plan 210).** An endpoint that declares a request
body MUST carry a JSON Schema on its body — it becomes the promoted tool's
`body` input schema, so the agent's tool-call args are validated against it
in-session (`validateToolArgs`) before the HTTP call, and the caller can't
guess field names. The model schema (`ApiDefinitionSchema`) requires it and
`capability.binding.propose` rejects a body schema that won't compile, so a
loose-body definition can't be persisted. Put per-field guidance in each
property's `description` and set `additionalProperties: false` for an exact
contract.

## Write-action safety (per-endpoint risk tiers — Plan 253)

A write call's blast radius is uneven — a Slack post is cheap and reversible; a
Stripe refund moves money and can't be undone. So safety is a property of the
**endpoint**, not a global switch. Every endpoint carries a curated
`writeRiskTier` (`packages/schemas` `ApiEndpointSchema`):

| Tier     | Meaning                                                                                 | Default gate     |
| -------- | --------------------------------------------------------------------------------------- | ---------------- |
| `read`   | no remote state change (GET/HEAD, or a POST that only fetches/searches)                 | never            |
| `low`    | internal, reversible write the caller controls (post a message, create an issue/record) | runs unattended  |
| `medium` | external send, or a not-easily-undone change (email/SMS, merge a PR, delete one thing)  | gated by default |
| `high`   | financial movement or destructive-at-scale (charge/refund, bulk/irreversible delete)    | always gated     |

**Authoring rule** — when adding a connector, tier every **non-GET** endpoint
explicitly (a guard test fails otherwise). `effectiveWriteRiskTier()` derives
`read` for GET/HEAD and `low` for any other method when a tier is absent, so the
dangerous direction (a write unattended at medium/high) always requires a
deliberate tier. The tier lives in the orchestrator/executor plane and is
**never exposed to agents** — an agent must not read the tier and route around
the gate.

**How the gate works** — the API executor computes the effective decision
(`requiresWriteApproval(tier, spaceWritePolicy)`) after the body is fully
resolved, and for a gated call with no matching approval it pauses the step as a
`write_approval` PAUSE **before any HTTP side effect**, reusing the OAuth-consent
pause machinery. It surfaces in the Action Center as an approve/deny card
(method · host · **redacted** body · risk badge). Approve → an authenticated
grant (keyed by `(tenant, run, requestHash)`) lets the re-dispatched call
through; deny → the step fails with a non-retryable `permission` tool error
carrying the operator's reason. Operators raise or lower the default per tier
per space in **Settings → Write Policy** (`spaces.write_policy`).

## Discovery scope (who can the agent discover?)

`AgentStepConfig.discovery.integrations` controls what the agent can see:

| Mode        | Behavior                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `none`      | Discovery disabled. Only platform built-ins and any pre-promoted tools are callable.                                 |
| `bound`     | Every enabled integration in the space is in scope. Best for Helmsman-style ergonomics.                              |
| `allowlist` | Only integrations listed in `discovery.integrations.allowed[]` are in scope. Binding-pinned entries supersede broad. |

Allowlist mode is the strict variant — the runtime checks both
`integrationId` _and_ the per-tool ACL (`toolNames[].toolName` or `allTools`). In `bound` mode the
runtime only checks that the integration is enabled; per-tool ACLs are not
enforced (they're discovery hints, not policy).

## Workflow grants (the lowered shape)

After `compose-skill` and `assemble-workflow` complete, every task carries
its capability grants in `context.capabilities.integrations[]`. Example:

```jsonc
{
  "context": {
    "capabilities": {
      "operations": ["ai.text.generate", "memory.store.put"],
      "integrations": [
        {
          "sourceKind": "api",
          "integrationId": "github",
          "bindingId": "github-acme",
          "capabilityId": "github",
          "toolNames": [{ "toolName": "listIssues" }, { "toolName": "createIssue" }],
        },
        {
          "sourceKind": "mcp",
          "integrationId": "kaggle",
          "bindingId": "kaggle",
          "capabilityId": "kaggle",
          "allTools": true,
        },
      ],
    },
  },
}
```

Single array, single shape. The orchestrator's `lowerAgentContext` reads
each grant's `sourceKind` and applies the same checks (binding enabled,
credentials present, tool allowlist if narrow).

`capability-references-bound` is the runtime validator that enforces
"every grant points at an enabled binding in this space" at submit_output,
apply, and ratify time.

## MCP OAuth readiness

Two auth flows behave differently after install:

- **`oauth2_client_credentials`** — static keys + secret. Operator fills
  credentials; the binding tests on Save.
- **`oauth2_pkce` / `oauth2_cimd`** — user-delegated. Tokens live in the unified
  `oauth_tokens` table (see **OAuth credential ownership** below) and refresh
  automatically. The post-install manifest emits `run_mcp_binding_test` so the
  operator completes the handshake.

## OAuth credential ownership

OAuth is the one place where credential ownership has **two orthogonal
dimensions** that static credentials (api_key, bearer, basic,
client-credentials) don't. Both MCP and API integrations share a single unified
model.

### Three "scopes" — keep them distinct

| Axis                                | Question                                          | Values                                                         |
| ----------------------------------- | ------------------------------------------------- | -------------------------------------------------------------- |
| **Where the binding lives**         | which space owns the integration                  | always the **space** (Plan 175) — unchanged by OAuth           |
| **`ownerScope`** (identity axis)    | _whose_ access/refresh tokens are stored          | `user` \| `space` \| `tenant`                                  |
| **`clientScope`** (client/app axis) | _whose_ registered OAuth app (`client_id`/secret) | `platform` (our CIMD app) \| `tenant` (org BYO app) \| `space` |

The two OAuth axes are independent: `clientScope='tenant' + ownerScope='user'` =
"each user in this org authorizes their own account, through the org's app."
Neither changes the Plan 175 rule that the binding (definition, governance, egress)
is space-owned — only the **secret material** may be owned above the space, and
only via an _explicit_ declaration. This is the scoped exception Plan 175 anticipated.

### Unified tables (replace `mcp_oauth_*`)

| Table           | Holds                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| `oauth_clients` | registered OAuth apps (Dimension B) — `(scope, scope_id, issuer_key)`, secret envelope-encrypted, write-only |
| `oauth_tokens`  | access/refresh tokens (Dimension A) — PK `(integration_kind, resource_key, owner_scope, owner_id)`           |
| `oauth_state`   | transient consent state (PKCE verifier, redirect URI, the real owner id)                                     |

`integration_kind ∈ {'mcp','api'}`; `resource_key` is the logical provider
(`serverId` for MCP, `apiId` for API), **not** the binding. Keying tokens on the
resource + owner — not the binding — gives **connect-once**: a user who connects
Gmail once reuses it from every binding/space they own. `ownerScope='space'` /
`'tenant'` mean one shared connection per resource at that scope.

### Pinned resolution — no fallback

OAuth identity resolution is **pinned** to the binding's `ownerScope` (look up
exactly `userId` / `spaceId` / `tenantId`, no precedence walk). This is the
deliberate divergence from Plan 67 BYOK (`provider_credentials`), which keeps its
`user → space → tenant` fallback resolver. The two resolution semantics coexist
by design: falling back from an absent user token to a shared tenant token would
silently impersonate. Client resolution is pinned too — the binding names the
exact client tier; a missing tenant/space client is a hard config error.

### The `needs_oauth_consent` recoverable pause — dual-plane

An **absent or expired** token does not fail the step. It becomes a recoverable
**"Connect {provider}"** Action Center item (`SessionBlockedOn` member
`needs_oauth_consent`, carrying `reason: 'never_connected' | 'expired'`), resumed
by the OAuth callback completing. It spans **two planes**:

- **Step/session plane** — direct callers (`ai.agent.turn` tool calls, direct
  API calls); resumed via `sessionService.resumeSession`.
- **Workflow-run plane** — the cybernetic **Runner** calling `mcp.tool.call` /
  `api.http.call` inside a sub-session with `workflowExecution` set: the pause
  converts to a **workflow-run** pause and resumes via `handleWorkflowRunResume`
  (un-pause the run + re-dispatch the paused Runner step). The callback hook
  routes resume to the plane the pause landed on.

### Auth types

| Surface | Auth types                                                     |
| ------- | -------------------------------------------------------------- |
| MCP     | `oauth2_pkce`, `oauth2_cimd`                                   |
| API     | `oauth2_authorization_code` (the 3-legged user-delegated type) |

`ownerScope` / `clientScope` live in the binding's `auth_json` (governance) — not
in `variable_values_json` (non-secret host labels only, Plan 218). An OAuth API
connector composes with Plan 218's `baseUrlTemplate` / `variableValues`.

### Registration, policy, and surfaces

- **OAuth-app registration.** A tenant admin registers a tenant app
  (`oauth_clients` `scope='tenant'`); a space admin registers a space app
  (`scope='space'`, for a multi-org tenant or a freemium BYO-app). The platform
  CIMD app is the default and is never a row. Client secrets are write-only.
- **Per-tenant default policy** (first-class columns on `public.tenants`) sets
  the default `ownerScope` + `clientScope` for new OAuth bindings and whether
  end-users may self-connect.
- **Curated O4 issuer registry** (google / github / microsoft / slack) carries
  display name, endpoints, default scopes, and the incremental-auth flag —
  enabling connector cards (Plan 218 P4).
- **Per-user connected-accounts** surface (under `/account`) lets each human
  connect/disconnect their own providers (the connect-once tokens).
- **Callback endpoint** is the single `GET /v1/oauth/callback` (handler
  dispatches by `oauth_state.integration_kind`); the redirect URI stays the one
  platform constant even for tenant/space apps (open-redirect guard — the
  tenant/space registers _our_ callback in _their_ app).

Spec: Plan 185.

## Adding a new integration source kind

If a third protocol appears (e.g. gRPC, WebSocket), it joins the union by:

1. Extending `IntegrationSourceKindSchema` and `IntegrationDescriptor`.
2. Adding rows in the platform-level definition tables (mirror the
   `api_definitions` / `mcp_server_definitions` pattern).
3. Implementing a kernel call op (mirror `api.http.call`).
4. Wiring it into `readIntegrations` so it shows up in catalog search.
5. Adding the kind to capability profiles (Migration 88+89 pattern).

No agent-facing surface needs to change. `catalog.tool.search` already
reports `sourceKind` per result; promote/lower/grant infrastructure
already keys on it.

## Where the unified contract lives

| File                                                                                    | Role                                                  |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `packages/schemas/src/integrations/index.ts`                                            | `IntegrationDescriptor` + `IntegrationToolDescriptor` |
| `packages/schemas/src/operations/integration.ts`                                        | `integration.registry.{lookup,list}` ops              |
| `packages/schemas/src/operations/platform.ts`                                           | `catalog.tool.{search,promote}` ops                   |
| `packages/schemas/src/runtime/agentTurn.ts`                                             | `DiscoveryScope.integrations`                         |
| `packages/schemas/src/runtime/spaceContext.ts`                                          | `SpaceContextIntegrationsSectionSchema`               |
| `packages/schemas/src/cybernetic/context.ts`                                            | `TaskCapabilityGrant.integrations[]`                  |
| `apps/aflow-orchestrator/src/services/SessionOrchestrator/helpers/integrationReader.ts` | Shared read model with `readIntegrations`             |
| `packages/cybernetic-runtime/src/scheduling/capabilityReferencesValidator.ts`           | `capability-references-bound` validator               |

## Useful patterns

- Use `buildIntegrationScopeFilter()` whenever you need to filter by the
  current agent's discovery scope — never re-derive.
- For workflow validation, the canonical walk is in
  `capabilityReferencesValidator.ts:collectCapabilityReferences()`.
- For UI, the integration components under `packages/web-product/src/ui/components/integrations/`
  is the canonical readiness strip: walks `tasks[].context.capabilities.integrations[]`,
  cross-references API + MCP definitions/bindings, renders source-kind badges.
