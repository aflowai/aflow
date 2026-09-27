# Contributing to Aflow

Contributions are welcome — bug reports, fixes, skills and connectors, docs, and
larger design work. This document is what you need before the first pull request;
`docs/dev/CONTRIBUTING.md` carries the code standards in detail.

## Before you start

**Security issues do not go here.** If what you found lets someone cross a
boundary the system is supposed to hold, read [SECURITY.md](SECURITY.md) and report
it privately. A public pull request is disclosure.

**Small things need no ceremony.** A failing test, a wrong error message, a broken
link, a dependency bump — open a pull request. No issue or plan required.

**Larger things start with a plan.** Anything that changes behaviour, a schema, an
operation, persistence, security, or architecture wants a numbered plan in
[`docs/plans/`](docs/plans/README.md) before the code. That is not bureaucracy: the plan is where a
reviewer can disagree with the approach while it is still cheap, and a large pull
request whose approach is wrong wastes far more of your time than the plan costs.
Open an issue first if you are unsure which side of the line you are on.

## Licensing your contribution

Aflow is dual-licensed: AGPL-3.0-or-later for everyone, and a commercial licence for
organisations that cannot accept the AGPL's terms. Distributing the same code under
two licences means the project needs rights in every contribution broad enough to do
that.

**Contributions are made under the Apache License 2.0.** By opening a pull request
you licence your contribution to the project under Apache-2.0, and the project
distributes it under the licences above.

That licence rather than another for two reasons: Apache-2.0's copyright grant is
**sublicensable**, which is what makes the commercial licence possible, and it
carries an **express patent grant**, so a contribution cannot later be encumbered by
a patent its author holds. An AGPL-only inbound licence would give neither.

**You keep the copyright in your own work.** Nothing here assigns it, and there is
no agreement to sign, no bot, and no signature to chase — the policy is this
paragraph, and contributing is how it is accepted.

If your employer owns work you do, make sure you are permitted to contribute it
before you do. If you cannot contribute under Apache-2.0, say so in the pull request
and it can be discussed.

> This is the project's licensing policy and counsel has not reviewed the wording.
> Contributions are accepted on it as written.

## Copyright headers

**Do not add per-file copyright headers.** The licence applies to the repository
through `LICENSE` and `NOTICE`, which is where it belongs — thousands of files each
carrying a header is thousands of files that drift, and a header naming the wrong
year or holder is worse than none.

The git history is the attribution record, and substantial work is named in the
release notes.

## Getting it running

```bash
yarn install
yarn start
```

`yarn start` creates `.env`, starts Postgres and Redis, builds, migrates, and runs
every service in watch mode. The [README](README.md) covers the appliance image,
which is only worth rebuilding when the change is to the packaging itself.

## Before you open a pull request

```bash
yarn format          # CI enforces format:check
yarn typecheck
yarn test:changed    # the full `yarn test` is slow; run it for proof
yarn lint
```

Then:

- **Branch off `main`.** Never push to `main` directly.
- **One pull request, one thing.** A refactor bundled with a fix makes both harder
  to review and impossible to revert separately.
- **Conventional commit titles** — `feat:`, `fix:`, `docs:`, `chore:`, with a plan
  number where one applies: `feat(246): …`.
- **Say what you verified**, and how. "Tests pass" is weaker than naming the case
  that used to fail.
- **Reference the plan** if the change has one.

Two repository-specific gates catch more first pull requests than anything else:

- **New operations are schema-first.** A Zod schema in `packages/schemas`, a catalog
  registration, an executor handler, and a capability-profile migration if the
  operation introduces a new capability group. Skipping the last one produces
  "Operation X not covered by any allowed capability" at runtime rather than at
  build.
- **New workspaces touch three Dockerfile lists.** A contract test fails if they
  drift, which is the friendly version of an image that builds green and then dies
  at startup.

## Review

Maintainers review for correctness, the boundary the change sits on, and whether
the tests would fail if the change were wrong. Expect questions; they are usually
about a case the pull request does not yet cover.

Security-sensitive areas — authorization, credentials, the execution lanes, the
edition boundary — need a designated maintainer, so they can take longer.

Maintainers hold the final technical and product decision. When a proposal is
declined the reason is given once, in the thread, and the plan documents are where
the rationale lives.

## Community and commercial

The public repository is the whole product: the runtime, the local appliance,
skills, the Store, integrations, memory, human-in-the-loop, and every safety
mechanism. It has no premium stubs, no telemetry, no phone-home, and no licence
server.

What is commercial is what an _organisation_ needs — enterprise identity,
multi-user administration, governance and compliance, managed deployment and
support. A contribution is never declined for being too useful to be free; the
boundary is organisational scope rather than capability.

## Where things are

|                                      |                                                      |
| ------------------------------------ | ---------------------------------------------------- |
| Architecture and quick start         | [README.md](README.md)                               |
| Code standards in detail             | [docs/dev/CONTRIBUTING.md](docs/dev/CONTRIBUTING.md) |
| Plans, and the plan process          | [docs/plans/README.md](docs/plans/README.md)         |
| Repository context for coding agents | [CLAUDE.md](CLAUDE.md)                               |
| Reporting a vulnerability            | [SECURITY.md](SECURITY.md)                           |
| Conduct                              | [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)             |
| Using the name                       | [TRADEMARK.md](TRADEMARK.md)                         |

## Questions

Open a discussion or an issue. A question that turned out to be hard to answer is
usually a documentation bug, so it is worth asking in public.
