# Plan 340 — The loop works against any forge

**Status:** P0 merged at `93310bda`. P1 built: the forge seam, with GitHub as its only provider (§5, P1 as built). P2 to P4 are not built.

**Builds on:** Plan 339 (the pull request event source and the shepherd on events), Plan 321 (the Local PR Shepherd and its rules), Plan 315 (the local loop and its publication), Plan 222 (the repo coordinate and its host), Plan 337 (the decision card), Plan 333 (D2's writing rules).

**Leaves alone:** the shepherd's rules and what each decision does, the push through the operator's own git, the folder's push approval, the secret scan, the event source's candidates and its cadence.

## Decision card

**What changes**

- Today: the loop speaks GitHub only. A GitLab folder pushes, and then nothing can open, read or merge its merge request.
- After: the loop speaks one forge vocabulary. GitHub and GitLab each answer it through a provider named from the folder's host.

**Why**

- A GitLab folder meets a dead end after the push. The publication cannot open a merge request, the shepherd cannot read or merge one, and the event source polls nothing.
- GitHub's endpoints and response shapes sit inside 17 skill and poller files, 234 references in all at `610b911b`.
- Two files beneath the skills shape GitHub's replies for the shepherd. They hold 97 references more.
- The shepherd's rules consume a handful of facts, not GitHub's shapes. A seam over those facts is small.
- The repo coordinate already keeps a host, so the folder already says which forge it lives on.

**What it affects**

- `@aflow/platform-artifacts`: Local Publish (`publishLocalChanges.ts` and two of its sibling files) and the Local PR Shepherd (`localPrShepherd.ts` and ten of its sibling files), as §2 lists them.
- `apps/aflow-orchestrator`: the pull request event source (`pullRequestEvents/github.ts`, `pullRequestEvents/source.ts`) and the `index.ts` that builds it.
- `apps/aflow-executor-api`: the shepherd's response presets (`githubShepherd.ts`).
- `@aflow/schemas`: the forge vocabulary's shapes, the shepherd's preset records (`pullRequestShepherd.ts`), and the coordinate's host as the provider's key.
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

The counts are GitHub-specific references per file, measured at `610b911b`. The method is this:

- A reference is an identifier, a literal, a comment, an endpoint id or path, an API definition or binding name, or a response field name read.
- Each distinct reference counts once per file, however often it recurs.
- A field that a transform preset names counts where the file reads it from a GitHub read.
- A GitHub term such as check run counts once per file, whatever names carry it.
- The words "pull request" alone do not count. A generic HTTP status does not count either.

The skill and poller files that D3 holds to the vocabulary are these. Skill files sit in `packages/platform-artifacts/src/skillCatalog/`, and poller files in `apps/aflow-orchestrator/src/services/pullRequestEvents/`.

| File                                   | Refs | What they are                                                                                                   |
| -------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------- |
| `publishLocalChanges.ts`               | 20   | The GitHub API definition it ships, five endpoint ids, and the calls that find, update and open a pull request. |
| `publishLocalChangesOverride.ts`       | 15   | Two endpoint ids, their parameters, and the preset fields that read the hands-off label and the handoff.        |
| `publishLocalChangesRepository.ts`     | 4    | Prose that names the folder's origin as a GitHub repository.                                                    |
| `localPrShepherd.ts`                   | 39   | Fourteen endpoint ids, the read calls, and the response fields it reshapes.                                     |
| `localPrShepherdRules.ts`              | 20   | Response shapes only. It calls no endpoint.                                                                     |
| `localPrShepherdMerge.ts`              | 21   | The merge, its reads of required checks and reviews, and the merge reply.                                       |
| `localPrShepherdHandoff.ts`            | 26   | Four issue-comment endpoint ids and their parameters, the comment's id and author login, and the merge reply.   |
| `localPrShepherdHandOver.ts`           | 25   | Fourteen response fields it carries to the Helmsman, and the prose that quotes GitHub's answers.                |
| `localPrShepherdWiring.ts`             | 10   | The `github` task builder, its `'github'` API id, the read projection, and the preset fields every read binds.  |
| `localPrShepherdRemedies.ts`           | 6    | The head, base, failing checks and jobs it briefs from, and GitHub's rule on runs after a base moves.           |
| `localPrShepherdAbandon.ts`            | 4    | The head sha and the failing check run it claims on, and the `pulls/` record path.                              |
| `localPrShepherdTurn.ts`               | 4    | GitHub's `updated_at` order, and GitHub's refusal to list pull requests.                                        |
| `localPrShepherdLease.ts`              | 3    | The head sha and the failing check run the lease holds.                                                         |
| `localPrShepherdDecisions.ts`          | 1    | GitHub Actions, named as a cause of a failure.                                                                  |
| `pullRequestEvents/github.ts`          | 14   | The space's GitHub binding, `api.github.com`, and GitHub's headers.                                             |
| `pullRequestEvents/source.ts`          | 20   | Four endpoint paths and the raw fields it parses from them.                                                     |
| `apps/aflow-orchestrator/src/index.ts` | 2    | The GitHub reader it builds the event source with.                                                              |

These 17 files hold 234 references in all. Eleven sibling files hold none:

- The shepherd's `localPrShepherdRenewal.ts`.
- Local Publish's `publishLocalChangesAfterReview.ts`, `publishLocalChangesDecisions.ts`, `publishLocalChangesFixRound.ts` and `publishLocalChangesGate.ts`.
- Local Publish's `publishLocalChangesMessage.ts`, `publishLocalChangesProse.ts` and `publishLocalChangesReview.ts`.
- The poller's `sweep.ts`, `arm.ts` and `owner.ts`.

Two more files sit beneath the skills. They shape GitHub's replies into the records the shepherd's rules compare, so they belong to GitHub's provider:

| File                                                                                   | Refs | What they are                                                                                         |
| -------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------- |
| The API executor's `githubShepherd.ts`, moved by P1 to `forge/github/shepherdReads.ts` | 70   | The response presets. They read 35 response fields from the replies of nine endpoints.                |
| `packages/schemas/src/operations/pullRequestShepherd.ts`                               | 27   | The preset records' shapes, with descriptions that name GitHub's fields, endpoints and review states. |

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

- List the open change requests of a repository.
- Read a change request's state as a handful of facts: mergeable, checks green, review requested changes, merged with its merge commit, and head.
- Open a change request.
- Update a change request's title and body.
- Merge a change request.
- Read the handoff comment on a change request.
- Post the handoff comment on a change request.
- Update the handoff comment on a change request.
- Name the provider for a folder from the repo coordinate's host.

These are the acts the loop performs today. Local Publish lists, opens and updates. The shepherd lists, reads and merges, and it keeps its handoff in a comment.

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
- `apps/aflow-executor-api`: the shepherd's response presets (`githubShepherd.ts`) become part of GitHub's provider (D2).
- `@aflow/schemas`: the vocabulary's shapes, and the provider named from the coordinate's host (D1).
- A GitLab API definition beside GitHub's (D4).
- Stored data: a named credential per forge (D5). The event source's candidate records gain the folder's host where they lack it.
- `docs/dev/driving-work-through-the-loop.md`: which forges the loop works against, and the credential each needs.

## 5. Phases

Each phase lands on its own.

**P0 — This document and its index row.** _Exit:_ the operator approves it, or amends it and then approves it.

**P1 — The seam, extracted from what exists.** The vocabulary is drawn from the code that exists, with GitHub as its provider. _Exit:_ every existing test is green, the loop's behaviour on GitHub is unchanged, and the guard test of D3 fails on a GitHub field name outside GitHub's provider.

**P1 as built.** The seam sits wherever a skill or the poller once spelled a forge's call. The vocabulary and each provider live here:

- `packages/schemas/src/forge/vocabulary.ts` holds the acts in `FORGE_ACTS`: the nine of D1, then the reads the shepherd makes one call at a time. It also holds the records the shepherd's rules compare. A schema of D1's facts waits for P2, because no P1 code reads or writes one.
- `SkillForge` in `packages/platform-artifacts/src/forge/vocabulary.ts` holds a call for every act but naming the provider. Its type fails to compile on an act with no call, and `vocabulary.test.ts` fails on a call that is no act.
- `packages/schemas/src/forge/providers.ts` names the provider from a repo coordinate's host. This is the ninth act.
- `packages/platform-artifacts/src/forge/vocabulary.ts` is the skills' side of the seam. Local Publish and the shepherd build every forge task from its acts.
- `packages/platform-artifacts/src/forge/github/` builds each act as the GitHub call it was. GitHub's API definition moved there unchanged (D4).
- `apps/aflow-executor-api/src/handlers/api/forge/github/shepherdReads.ts` shapes GitHub's answers into the vocabulary's records. It was `githubShepherd.ts`.
- `apps/aflow-orchestrator/src/services/forge/github/` holds the poller's GitHub reads, moved out of `source.ts`. It also holds the conditional reader that was `pullRequestEvents/github.ts`.
- `packages/schemas/src/forge/github.ts` holds GitHub's response transforms, its check-run conclusions and the field names that are GitHub's alone. The GitHub half of `pullRequestShepherd.ts` moved there and to the vocabulary.

The event source names a pull request's provider from the host of its address. That one name selects both the reader that parses the forge's answers and the conditional GET that carries them. A skill is built once, before any folder is read. So each skill is built against the provider the coordinate's default host names.

No behaviour changed. The skill catalog, the bundles and the connector catalog serialise byte for byte as they did at `93310bda`. The existing shepherd, publication and event source tests pass with their assertions unchanged. Tests of a moved module changed their import paths only.

The guard is `packages/platform-artifacts/src/forge/forgeSeam.test.ts`. It reads its terms from GitHub's provider:

- the field names the provider declares, each of which it must also find in the provider
- the endpoint ids of GitHub's API definition
- the names of GitHub's response transforms
- every name a module of the provider exports

The guard fails on any of these in a `localPrShepherd*` or `publishLocalChanges*` file, in the poller, or in the orchestrator's `index.ts`. A `mergeable_state` planted in `localPrShepherdRules.ts` fails it.

P1 leaves two things as they were. The skills' prose still names GitHub, because the guard reads names and not prose. The records keep the field names the rules already read, so `headSha` stays `headSha`.

**P2 — The GitLab provider and its definition.** _Exit:_ the provider opens, reads and merges a merge request on a GitLab project the operator names. Each fact of D1 is shown against that project.

**P2 as built.** P2 adds GitLab as a second provider in the places P1 made for one. It is built in these steps:

1. GitLab joins `FORGE_PROVIDERS`, with `gitlab.com` and the operator's own host as its hosts. The coordinate's host field already carries a self-hosted host (D5).
2. P2 reads the coordinate of the operator's project first. Where its owner holds nested groups, the coordinate's owner widens to hold them.
3. A GitLab API definition sits beside GitHub's, with the merge request, pipeline, approval and note endpoints the acts call (D4). GitHub's definition stays as it is.
4. GitLab's provider answers each act in each layer, beside GitHub's. Merge requests read as change requests, pipeline jobs as checks, and approvals as reviews (D2).
5. The folder's host names the provider when a task runs, by the ninth act. One skill then serves both forges, and no skill is copied per forge (D2).
6. GitLab's refusal of a merge on a moved base maps to the vocabulary's base-moved refusal. A test names GitLab's refusal beside GitHub's.
7. The guard holds GitLab's field names, endpoint ids and exports as it holds GitHub's.

P2 is proven against the GitLab project the operator names. A merge request is put in each known state, and each fact of D1 is read from it through the provider:

- mergeable, and not mergeable on a conflict
- checks green, and red on a failing pipeline job
- a review that requests changes
- merged, with its merge commit
- the head

A fact that reads wrong in any state fails P2, and the mapping of pipelines or approvals is fixed before the provider is settled. The prose that names GitHub is worded by each provider before a GitLab folder runs a skill.

**P3 — The event source on the seam.** _Exit:_ the source emits `pull_request.changed` for a GitLab merge request as it does for a GitHub pull request. It reads no provider's shape itself.

**P4 — One plan end to end through GitLab.** _Exit:_ one plan is driven from commission to merge through a GitLab repository the operator names. No step is done by hand that GitHub does not also need.

## 6. How it is proven

- **P1:** the guard test fails when a provider's field name, such as `mergeable_state`, appears outside its provider. That case fails if the seam leaks.
- **P1:** the existing shepherd, publication and event source tests pass unchanged. That case fails if moving GitHub behind the seam changed its behaviour.
- **P2:** each fact of D1 is read from a merge request on the operator's GitLab project in a known state. That case fails where the mapping of pipelines or approvals is wrong.
- **P4:** one plan is driven end to end through a GitLab repository the operator names. The plan is wrong if any step needs GitHub or a person's relay.
