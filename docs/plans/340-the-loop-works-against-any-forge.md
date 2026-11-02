# Plan 340 — The loop works against any forge

**Status:** P0, this document, awaits the operator's approval. P1 to P4 are not built.

**Builds on:** Plan 339 (the pull request event source and the shepherd on events), Plan 321 (the Local PR Shepherd and its rules), Plan 315 (the local loop and its publication), Plan 222 (the repo coordinate and its host), Plan 337 (the decision card), Plan 333 (D2's writing rules).

**Leaves alone:** the shepherd's rules and what each decision does, the push through the operator's own git, the folder's push approval, the secret scan, the event source's candidates and its cadence.

## Decision card

**What changes**

- Today: the loop speaks GitHub only. A GitLab folder pushes, and then nothing can open, read or merge its merge request.
- After: the loop speaks one forge vocabulary. GitHub and GitLab each answer it through a provider named from the folder's host.

**Why**

- A GitLab folder meets a dead end after the push. The publication cannot open a merge request, the shepherd cannot read or merge one, and the event source polls nothing.
- GitHub's endpoints and response shapes sit inside six skill and poller files, 134 references in all at `610b911b`.
- The shepherd's rules consume a handful of facts, not GitHub's shapes. A seam over those facts is small.
- The repo coordinate already keeps a host, so the folder already says which forge it lives on.

**What it affects**

- `@aflow/platform-artifacts`: Local Publish (`publishLocalChanges.ts`) and the Local PR Shepherd (`localPrShepherd.ts`, `localPrShepherdRules.ts`, `localPrShepherdMerge.ts`).
- `apps/aflow-orchestrator`: the pull request event source (`pullRequestEvents/github.ts`, `pullRequestEvents/source.ts`).
- `@aflow/schemas`: the forge vocabulary's shapes, and the coordinate's host as the provider's key.
- The API definitions: GitHub's stays as it is, and GitLab gains one of its own.
- The operator, who names a GitLab credential and a GitLab project to prove the loop against.

**Risks**

- P1 touches GitHub's path while it moves that path behind the seam. Mitigation: P1 changes no behaviour, and every existing test stays green.
- GitLab's facts may not map one to one onto GitHub's. Pipelines are not check runs, and approvals are not reviews. Mitigation: P2 measures each fact against a GitLab project the operator names before the provider is settled.
- The coordinate parses `owner/repo` and `host/owner/repo` only. A GitLab project inside nested groups may not parse. Mitigation: P2 reads the coordinate of the operator's project and widens the owner where it must.
- GitLab's refusal on a moved base may not carry GitHub's "Base branch was modified" text. Mitigation: each provider maps its own refusal to one vocabulary fact, and a test names each forge's refusal.

**Open questions**

- Does the shepherd merge a GitLab merge request itself, or set merge-when-pipeline-succeeds? Recommended: the shepherd merges itself, as it does on GitHub. Merge-when-pipeline-succeeds stays a later setting.
- Where does a self-hosted GitLab's host enter the coordinate? Recommended: it is already the coordinate's host field, and the provider is named from that host.
- How is the operator's GitLab token held? Recommended: a named credential per forge, resolved through a connection as the GitHub token is today.

**Not done on purpose**

- The skills are not duplicated per forge.
- No webhook reaches into the machine.
- No provider beyond GitHub and GitLab.

**Done when**

- P1's guard test fails on a provider's field name outside its provider.
- One plan is driven end to end through a GitLab repository the operator names.

## 1. Problem

A GitLab folder meets a dead end today. The push works, because it goes through the operator's own git and git is forge-neutral. After the push, the loop can do nothing:

- The publication cannot open a merge request.
- The shepherd cannot read a merge request, and it cannot merge one.
- The event source polls nothing.

The loop is written in GitHub's words. Its skills and its poller call GitHub's endpoints and read GitHub's response shapes directly. No seam sits between what the loop decides and the forge it asks.

## 2. What the code shows today

The counts are GitHub-specific references per file, measured at `610b911b`.

| File                             | Refs | What they are                                                                                                   |
| -------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------- |
| `publishLocalChanges.ts`         | 20   | The GitHub API definition it ships, five endpoint ids, and the calls that find, update and open a pull request. |
| `localPrShepherd.ts`             | 39   | Fourteen endpoint ids, the read calls, and the response fields it reshapes.                                     |
| `localPrShepherdRules.ts`        | 20   | Response shapes only. It calls no endpoint.                                                                     |
| `localPrShepherdMerge.ts`        | 21   | The merge, its reads of required checks and reviews, and the merge reply.                                       |
| `pullRequestEvents/github.ts`    | 14   | The space's GitHub binding, `api.github.com`, and GitHub's headers.                                             |
| `pullRequestEvents/source.ts`    | 20   | Four endpoint paths and the raw fields it parses from them.                                                     |
| `sweep.ts`, `arm.ts`, `owner.ts` | 0    | Nothing forge-specific.                                                                                         |

The shepherd's rules consume a handful of facts:

- Whether the pull request is mergeable.
- Whether its checks are green, read as the check-run rollup.
- The required checks of the base branch.
- Whether a review requested changes.
- The head sha.
- Whether it is a draft.
- Whether it carries the hands-off label.
- Whether it is open and the loop's own.
- The merge reply's 200 or 405.
- The raw 405 text "Base branch was modified".

No rule reads the pull request's merged field or its merge commit.

The poller reads no events API. It polls four paths: the pull request, its check runs, its combined status and its reviews. It derives `pull_request.changed` by comparing one poll with the next.

The repo coordinate (`packages/schemas/src/models/repoCoordinate.ts`) already keeps the git host as a field, with `github.com` as the default host.

## 3. Decisions

### D1 — One forge vocabulary the loop speaks

The loop speaks one vocabulary to any forge. It holds these acts:

- Open a change request.
- Read a change request's state as a handful of facts: mergeable, checks green, review requested changes, merged with its merge commit, and head.
- Merge a change request.
- Name the provider for a folder from the repo coordinate's host.

The facts are the ones §2 lists, named for what the rules decide on rather than for GitHub's fields. Merged and its merge commit join them, though no rule reads them today. A forge whose merge reply says less needs them to report a merge.

_Rejected:_ keeping GitHub's shapes as the vocabulary. Every other forge would then translate itself into GitHub's fields, and GitHub's quirks would become the loop's rules.

### D2 — A provider per forge behind the vocabulary

Each forge answers the vocabulary through a provider of its own.

- GitHub is first. Its provider is the code that exists today, moved behind the seam with no behaviour change.
- GitLab is second. Its provider maps merge requests to change requests, pipelines to check runs, approvals to reviews, and GitLab's squash setting to the merge.

_Rejected:_ duplicating the skills per forge. Two copies of the shepherd's rules drift apart, and a fix lands in one and not the other.

### D3 — The skills and the poller never touch a provider's endpoint or shape

Local Publish, the Local PR Shepherd and the event source speak the vocabulary only. A guard test fails when a provider's field name appears outside its provider.

_Rejected:_ a lint by convention with no test. A convention holds until the first change made in a hurry, and nothing reports when it breaks.

### D4 — The API definitions stay one per forge

Each forge keeps its own API definition, as GitHub's is today. The folder's host selects which one the provider calls.

_Rejected:_ one merged definition carrying every forge's endpoints. It would grow with each forge and offer an agent endpoints that cannot answer for its folder.

### D5 — What stays forge-specific on purpose

Two things stay forge-specific:

- The operator's credential, one per forge.
- GitLab's self-hosted host, held as part of the coordinate.

_Rejected:_ a webhook into the machine. The machine sits on a private network and takes no inbound calls, as Plan 339 D2 holds.

## 4. What it affects

- `@aflow/platform-artifacts`: Local Publish and the Local PR Shepherd call the vocabulary rather than GitHub's endpoints (D1, D3). The GitHub API definition moves under its provider (D4).
- `apps/aflow-orchestrator`: the event source polls through the vocabulary (P3). `pullRequestEvents/github.ts` becomes part of GitHub's provider.
- `@aflow/schemas`: the vocabulary's shapes, and the provider named from the coordinate's host (D1).
- A GitLab API definition beside GitHub's (D4).
- Stored data: a named credential per forge (D5). The event source's candidate records gain the folder's host where they lack it.
- `docs/dev/driving-work-through-the-loop.md`: which forges the loop works against, and the credential each needs.

## 5. Phases

Each phase lands on its own.

**P0 — This document and its index row.** _Exit:_ the operator approves it, or amends it and then approves it.

**P1 — The seam, extracted from what exists.** The vocabulary is drawn from the code that exists, with GitHub as its provider. _Exit:_ every existing test is green, the loop's behaviour on GitHub is unchanged, and the guard test of D3 fails on a GitHub field name outside GitHub's provider.

**P2 — The GitLab provider and its definition.** _Exit:_ the provider opens, reads and merges a merge request on a GitLab project the operator names. Each fact of D1 is shown against that project.

**P3 — The event source on the seam.** _Exit:_ the source emits `pull_request.changed` for a GitLab merge request as it does for a GitHub pull request. It reads no provider's shape itself.

**P4 — One plan end to end through GitLab.** _Exit:_ one plan is driven from commission to merge through a GitLab repository the operator names. No step is done by hand that GitHub does not also need.

## 6. How it is proven

- **P1:** the guard test fails when a provider's field name, such as `mergeable_state`, appears outside its provider. That case fails if the seam leaks.
- **P1:** the existing shepherd, publication and event source tests pass unchanged. That case fails if moving GitHub behind the seam changed its behaviour.
- **P2:** each fact of D1 is read from a merge request on the operator's GitLab project in a known state. That case fails where the mapping of pipelines or approvals is wrong.
- **P4:** one plan is driven end to end through a GitLab repository the operator names. The plan is wrong if any step needs GitHub or a person's relay.
