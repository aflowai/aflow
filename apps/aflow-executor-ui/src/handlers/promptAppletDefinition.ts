/**
 * Prompt sections for stateful-applet authoring — the definition emitted in
 * the same generation call as the view (one author, contract and code start
 * aligned). The host protocol itself is shell-injected; the model is taught
 * to CALL it, never to emit the plumbing.
 */

/**
 * The definition shape, shared between the generation section and the
 * definition repair prompt so both rounds teach the same contract.
 */
export const APPLET_DEFINITION_SHAPE_REFERENCE = `THE DEFINITION SHAPE:
{
  "appletKey": "<stable kebab-case handle, e.g. 'expense-board'>",
  "version": 1,
  "name": "<display name>",
  "description": "<one-line description>",
  "semanticDescription": "<agent-facing: what this object IS and is for — the agent reads this to participate>",
  "stateSchema": { <JSON Schema for the shared state object — well-formedness only, keep it tight: additionalProperties false, required fields> },
  "initialState": { <the state an instance is born with — MUST validate against stateSchema> },
  "roles": [ { "id": "<lowercase>", "description": "..." } ],
  "actions": [
    {
      "name": "<snake_case verb, e.g. 'set_budget'>",
      "description": "<rendered as a control label AND read by the agent>",
      "whenToUse": ["<optional, up to 5>"],
      "pitfalls": ["<optional, up to 5>"],
      "inputSchema": { <JSON Schema for the action input> },
      "patch": { "template": [ <template ops> ] }  OR  "actor_supplied",
      "notable": false,
      "wakes": false,
      "ends": false
    }
  ],
  "attentionProjection": { "title": "/<pointer into state>", "status": "/<pointer>", "waitingOn": "/<pointer>" },
  "recentActionsLimit": 20
}

Optional fields ("roles", "whenToUse", "pitfalls", "attentionProjection", "recentActionsLimit", the action flags) may be omitted.

PATCH MODES — how an action changes state:
- Template: a pure function of the action input, materialized by the platform. Each op is
  { "op": "replace"|"add"|"remove", "path": "/state/..." OR "pathTemplate": ["/state/columns", {"from": "/input/columnIndex"}, "cards", "-"], "value": <literal> XOR "valueFrom": "/input/<field>" }.
  All paths live under /state; all references draw from /input. Use a template whenever the change depends only on the input.
- "actor_supplied": the change depends on current state (moving an item, applying a move), so whoever acts computes the RFC 6902 patch against the state they just rendered and passes it at the call site.

ACTION FLAGS (effects, declared once here):
- "notable": true — the action posts an attributed message into the bound room (use for changes teammates should see narrated).
- "wakes": true — the action asks the agent to act now (use when the object needs the agent's move/decision).
- "ends": true — the platform flips the instance to 'ended' (the item is finished; declare it on the closing/finishing action).

RULES:
- Do NOT declare a "raw_patch" action — every applet already carries it built in.
- Action names are snake_case, unique; appletKey is kebab-case.
- "roles" are labels for people, never permissions — whose turn it is lives in state.`;

/**
 * Kind-specific host wiring: how live state arrives and how controls act.
 */
function buildHostWiringSection(kind: 'applet' | 'react_tsx'): string {
  if (kind === 'applet') {
    return `HOW YOUR CODE MEETS THE HOST (the bridge is injected by the wrapper — NEVER write postMessage plumbing or define window.aflow yourself):
- Live shared state arrives via the 'aflowstate' CustomEvent:
    window.addEventListener('aflowstate', (e) => { const { state, version, viewer } = e.detail; render(state, viewer); });
  Render a neutral loading shell until the first event; re-render from every event. The pushed state is the ONLY source of truth — never keep a divergent local copy (transient input drafts are fine).
- EVERY control that changes shared state calls the injected bridge with a declared action:
    window.aflow.act('<action_name>', { <input matching that action's inputSchema> })
  For an "actor_supplied" action, compute the patch from the state you rendered and pass it as an extra:
    window.aflow.act('<action_name>', input, { patch: [ { op: 'replace', path: '/state/...', value: ... } ], outcome: '<short summary>' })
  act() returns a Promise of { status: 'applied' | 'conflict' | 'rejected', ... } — on non-applied, surface a light courtesy message; fresh state arrives via 'aflowstate' either way.
- An image, clip or sound the state pins is shown by asking the host for its bytes — the frame itself can fetch nothing:
    const shown = await window.aflow.media(asset); // asset is the { path, version, contentHash } object exactly as it sits in state
    if (shown.status === 'ready') el.src = shown.url; // a blob: URL this frame owns, for <img>, <video> or <audio>
  The host serves ONLY the assets the current state pins; anything else answers { status: 'refused', reason, message } — show the message and render a placeholder.
- viewer.spaceRole and viewer.appletRoles are courtesy-rendering inputs (hide controls a viewer should not be nudged toward) — they are NEVER security gates; the platform authorizes.`;
  }
  return `HOW YOUR COMPONENT MEETS THE HOST (the bridge is injected by the shell — NEVER write postMessage plumbing or define window.aflow yourself):
- The default export receives live-instance props alongside data: { data, state, version, viewer }.
  state/viewer are undefined until the first host push — guard and render a neutral shell. The pushed state is the ONLY source of truth — never keep a divergent local copy (transient input drafts in React state are fine).
- EVERY control that changes shared state calls the injected bridge with a declared action:
    window.aflow.act('<action_name>', { <input matching that action's inputSchema> })
  For an "actor_supplied" action, compute the patch from the state you rendered and pass it as an extra:
    window.aflow.act('<action_name>', input, { patch: [ { op: 'replace', path: '/state/...', value: ... } ], outcome: '<short summary>' })
  act() returns a Promise of { status: 'applied' | 'conflict' | 'rejected', ... } — on non-applied, surface a light courtesy message; fresh state arrives as new props either way.
- An image, clip or sound the state pins is shown by asking the host for its bytes — the frame itself can fetch nothing:
    const shown = await window.aflow.media(asset); // asset is the { path, version, contentHash } object exactly as it sits in state
    if (shown.status === 'ready') el.src = shown.url; // a blob: URL this frame owns, for <img>, <video> or <audio>
  The host serves ONLY the assets the current state pins; anything else answers { status: 'refused', reason, message } — show the message and render a placeholder.
- viewer.spaceRole and viewer.appletRoles are courtesy-rendering inputs (hide controls a viewer should not be nudged toward) — they are NEVER security gates; the platform authorizes.`;
}

const WORKED_EXAMPLE = `WORKED EXAMPLE (a tiny shared counter — definition and matching call sites):
"definition": {
  "appletKey": "team-counter",
  "version": 1,
  "name": "Team Counter",
  "description": "A counter the team increments together",
  "semanticDescription": "A shared tally. Anyone increments it by a chosen step; closing it ends the item.",
  "stateSchema": { "type": "object", "properties": { "count": { "type": "number" }, "status": { "enum": ["open", "closed"] } }, "required": ["count", "status"], "additionalProperties": false },
  "initialState": { "count": 0, "status": "open" },
  "actions": [
    { "name": "set_count", "description": "Set the tally", "inputSchema": { "type": "object", "properties": { "value": { "type": "number" } }, "required": ["value"], "additionalProperties": false }, "patch": { "template": [ { "op": "replace", "path": "/state/count", "valueFrom": "/input/value" } ] } },
    { "name": "close", "description": "Close the counter", "inputSchema": { "type": "object", "additionalProperties": false }, "patch": { "template": [ { "op": "replace", "path": "/state/status", "value": "closed" } ] }, "ends": true }
  ],
  "attentionProjection": { "status": "/status" }
}
Matching call sites in the view: the +1 button calls window.aflow.act('set_count', { value: state.count + 1 }); the close button calls window.aflow.act('close', {}).`;

/**
 * Appended to the kind's system prompt when the caller requests applet
 * authoring — extends the JSON response with a "definition" field and teaches
 * the injected host protocol.
 */
export function buildAppletDefinitionPromptSection(kind: 'applet' | 'react_tsx'): string {
  return `

STATEFUL APPLET MODE — this artifact is a durable shared work item that people AND an agent operate together through declared actions. You author the contract and the view in this one response.

Add one more field to your JSON response: "definition".

${APPLET_DEFINITION_SHAPE_REFERENCE}

${buildHostWiringSection(kind)}

${WORKED_EXAMPLE}`;
}

/**
 * Repair-round prompts for an invalid (or missing) emitted definition. The
 * source is included so repaired actions stay aligned with real call sites.
 */
export function buildAppletDefinitionRepairMessages(params: {
  candidate: unknown;
  errors: string[];
  source: string;
}): Array<{ role: 'system' | 'user'; content: string }> {
  const { candidate, errors, source } = params;
  const system = `You repair applet definitions. Fix ONLY the reported issues; keep everything that already validates. The definition's actions must match the window.aflow.act(...) call sites in the provided source.

${APPLET_DEFINITION_SHAPE_REFERENCE}

Respond ONLY with the corrected definition JSON object. No markdown, no fences, no envelope.`;
  const user = `${
    candidate === undefined
      ? 'The generation response carried no "definition" field. Author it now from the source below.'
      : 'The emitted applet definition failed validation.'
  }

ERRORS:
${errors.map((error) => `- ${error}`).join('\n')}
${
  candidate !== undefined
    ? `
CURRENT DEFINITION:
${JSON.stringify(candidate, null, 2)}
`
    : ''
}
ARTIFACT SOURCE (its window.aflow.act call sites are the actions to declare):
${source}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}
