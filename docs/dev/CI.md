# CI

Every pull request to `main` runs `.github/workflows/ci.yml`. All three jobs block
a merge.

| Job                  | Runs on              | What it does                                                                      |
| -------------------- | -------------------- | --------------------------------------------------------------------------------- |
| **Checks**           | pull request, push   | `format:check`, `build`, `typecheck`, schema determinism, `lint` (errors only)    |
| **Test**             | pull request         | `db:migrate` then `yarn test`, against Postgres 16 and Redis 7 service containers |
| **Dependency audit** | pull request, weekly | `yarn npm audit`; the weekly run catches advisories against an unchanged lockfile |

**Checks** also runs on every push to `main`, because two pull requests that each
pass can break `main` together.

Releases are separate workflows, triggered by tags: `appliance-image.yml`
(`appliance-v*`) and `publish-contracts.yml` (`contracts-v*`).

## Before pushing

```bash
yarn format
yarn typecheck
yarn test:changed
yarn lint
```

`yarn preflight` runs the whole set with a summary; `yarn preflight:no-test` skips
tests. Run neither while a dev stack is up — some suites drop and recreate schemas
in the database they are pointed at.

`yarn test` runs every workspace in one Vitest process. For quicker feedback use
`yarn test:changed`, `yarn test:workspace <name>` or `yarn test:file <path>`.

## Common failures

- **Format** — run `yarn format` and push again.
- **Typecheck passes locally, fails in CI** — stale `dist/` locally. Rebuild from
  scratch: `yarn clean && yarn install && yarn build && yarn typecheck`.
- **A suite skips locally and fails in CI** — suites that need the schema skip
  without it. Run `yarn db:migrate` against a throwaway database first.
