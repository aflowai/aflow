/**
 * Who may write the plan outside `plan.node.*` (Plan 322 D3, D7). The plan is
 * the Helmsman's through its operations; every other write — the plan page's
 * close, an Action Center decision answered — is the operator's own act, so it
 * is taken only from a person signed in interactively (`isInteractiveUser`).
 * An API key is refused whoever it belongs to: the MCP server's key is how a
 * coding agent drives this stack, and a service principal is how a Runner's
 * API call arrives. Both surfaces read this one rule, so neither can be the
 * way round the other.
 */
export const PLAN_WRITE_OPERATOR_ONLY =
  'Only a person signed in to the web application writes the plan here. An agent writes the plan through plan.node.update, and only the Helmsman holds it; an API key or a run never closes a step or answers a decision.';
