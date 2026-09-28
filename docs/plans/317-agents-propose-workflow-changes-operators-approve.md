# Plan 317 — Agents propose workflow changes; operators approve them

**Status:** 🔨 built

## 1. Problem

A workflow runs only when its status is `approved`, and a definition change reaches it only when the operator ratifies a proposal. Three agent routes stepped around both.

- **`workflow.manage.put` writes directly.** Its default `upsert` replaces an existing workflow wholesale — an approved one included — with whatever `status` and `origin` the agent supplies. Helmsman, failing to express an edit through `workflow.manage.patch`, rewrote an approved skill this way; the new revision went live without a proposal.
- **A metadata `workflow.manage.patch` sets `status` directly.** An agent can create a draft and flip it to `approved` itself, and the classic workflow agent's instructions teach exactly that.
- **The generic memory tools write the same document.** `/workflows/{slug}/workflow.json` is what `workflow.run.start` reads, and `memory.store.put` / `memory.store.patch` — pinned for Helmsman — could write it, approving a draft or replacing an approved workflow without either workflow operation.

None was a validation gap — the workflow operations run the full skill-validity check. They are an authority gap. The platform then points agents at the bypass — `patch` answers an edit shape it cannot stage with "for wholesale rewrites use workflow.manage.put".

## 2. Decisions

**D1 — An agent's `put` creates a draft and nothing else.** The operation takes no `writeMode`, `status`, `origin` or `expectedRevision`: it creates a workflow that does not exist yet, as a `draft`, with no origin claim. A slug that exists is refused with the remedy — `workflow.manage.patch`, whose definition changes become a proposal — and so is the slug of an archived skill, whose definition creating it again would overwrite. _Rejected:_ staging a whole-definition replacement as a proposal. A proposal is reviewed as a list of typed changes; a full replacement is one opaque change the operator cannot read, and it is what agents reach for when a targeted patch is hard to express — which is the problem to fix, in `patch`.

**D2 — Approving is ratifying.** An agent `patch` that moves a workflow into `approved` is refused; the operator approves from the skill's page. Moving a workflow out of `approved` (to `draft`, `completed` or `abandoned`) stays direct — it can only stop runs.

**D3 — Refusals name the missing shape, never the bypass.** Every `patch` refusal that suggested `put` says instead which shape is unsupported and, for decisions reserved to the operator (turning `iteration.auto` on or off, renaming the slug), that they are the operator's.

**D4 — A task is addressable by its id.** `patch` accepts `/tasks/{taskId}/...` as well as `/tasks/{index}/...`. Operations apply in order and an earlier add, remove or move shifts every position after it, so each id is resolved against the task list as the operations before it leave it, never against the list as stored. A segment of digits is always an index, as RFC 6902 reads it.

**D5 — Helmsman does not hold `put`.** Helmsman creates skills through compose-skill, which already proposes; `put` in its promotable set served only as the bypass.

**D6 — A workflow's definition is not memory an agent writes.** `workflow.json`, `activation.json` and `revisions/**` under `/workflows/{slug}/`, and a skill's `/skills/{id}/manifest.json` — which carries the goal and campaign contract `patch` sends through a proposal — are governed paths: the generic memory tools refuse to write, patch or delete them, and a directory whose removal takes one with it. The workflow handlers and ratification write them through the document repository, as before. Other documents a skill keeps under its folder — a data cache, notes — stay ordinary memory. _Rejected:_ governing all of `/workflows/`, which breaks skills that cache data there.

The operator's workflow routes are unchanged: the operator is the approver, and their direct edits there remain the escape hatch. The raw memory editor refuses these documents for everyone, as it already did the eval suite — a definition edited as a JSON document skips the validation the workflow routes run.

## 3. Affected packages and contracts

`packages/memory-store` (governed workflow-definition paths), `packages/schemas` (the `workflow.manage.put` input and output, and both operations' usage), `apps/aflow-orchestrator` (the put and patch handlers, the patch-to-proposal refusals), `packages/platform-artifacts` (Helmsman's promotable set, the classic workflow agent's instructions), `packages/database` (the seeded copy of those instructions).

No stored data changes. The `put` operation's input narrows: an agent passing `writeMode`, `status`, `origin` or `expectedRevision` is refused by the schema.

## 4. How it is proven

- An agent `put` on an existing slug is refused and writes nothing; on a new slug it writes a `draft` with no origin.
- An agent `patch` setting `/status` to `approved` is refused; setting it to `completed` applies.
- `memory.store.put`, `patch` and `delete` refuse a workflow's definition documents and a skill's manifest, and leave a skill's other documents writable.
- An agent `put` on an archived skill's slug is refused and writes nothing.
- With tasks `[a, b, c]`, "remove a, then set b's goal" sets `b`'s goal.
- No `patch` refusal names `workflow.manage.put`.
- `workflow.manage.put` is absent from Helmsman's promotable set.
