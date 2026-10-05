# Aflow Local — running the appliance

The single-user edition of the platform, on infrastructure the operator controls. It is the same source tree as the hosted product; what differs is one resolved edition descriptor (Plan 246a).

**Supported on macOS with Docker Desktop.** Linux is expected to work — the
containers are Linux either way — but is not yet qualified, and the differences
that would bite are host-boundary ones a Docker Desktop VM hides: bind-mount
path resolution, named-volume ownership, and the security module labelling the
sandbox profile. Run it there by all means; report what breaks.

## Start it

```bash
docker compose -f docker-compose.local.yml up -d --build
open http://127.0.0.1:3001
```

There is no login. Reaching the web app is what identifies the operator as the owner, and the loopback binding is what limits who can.

The first build needs roughly **20 GB free inside the container runtime** — one
~4 GB image plus the build cache that produces it — and it downloads about
1.1 GB of packages. Docker Desktop's VM has its own disk, separate from the
host's, so a Mac with free space can still fail with `ENOSPC` partway through
`yarn install`. `docker system df` reports what is actually free;
`docker builder prune -f` reclaims cache without touching any volume. Never
prune with `--volumes`: the appliance keeps Postgres, payloads and the
instance's encryption key in named volumes, and the key is not recoverable.

Model access is the one thing the appliance cannot generate for itself, and it
is entered **through the UI**, not the environment. A provider key becomes a
credential encrypted with the instance's own key and scoped to the workspace
holding it, which is why an agent turn reads it from there and from nowhere
else. Until one exists the workspace reports itself unready and no turn runs;
first run leads to the provider setup that fixes it.

`.env.local` beside the compose file is read, but for a different job: the
memory embedder takes `OPENAI_API_KEY` from the environment to embed memory in
the background. Only that one — the embedder requests the default embedding
model, which is an OpenAI model, and the appliance has no surface for choosing
another, so a key for any other provider reaches the embedder and embeds
nothing.

```
# Background memory embedding only — agent turns use the credential entered in the UI.
OPENAI_API_KEY=...
```

A key placed only in `.env.local` therefore leaves the workspace unready, and
one entered only in the UI leaves memory unembedded. An instance that wants both
supplies both.

## Check it came up

```bash
./scripts/appliance-smoke.sh          # or `yarn local:smoke` in a dev checkout
```

The checks run inside the containers, so this needs Docker and nothing else —
the same as installing the appliance, which never asks for Node or a dependency
install. Six checks against the running stack: the API's own view of Postgres and Redis,
the edition and surface list the process reports, that a surface this edition
does not carry answers 404 rather than 403, the single workspace bootstrap
leaves, a populated operation catalog, and the first-run entry point the web app
redirects to.

It covers the boot and the composed surface, not the product: an agent turn
needs a provider credential, which is entered through the UI into the encrypted
per-workspace store, so the model-dependent paths stay a manual check. Every
appliance defect so far was invisible to the type checker and the test suite and
appeared only when the thing was run, which is what this exists to shorten.

## What comes up

| Service     | Published        | Role                                                                                 |
| ----------- | ---------------- | ------------------------------------------------------------------------------------ |
| `web`       | `127.0.0.1:3001` | The UI, and the BFF that authenticates to the API                                    |
| `api`       | `127.0.0.1:3000` | REST, SSE, and the realtime WebSocket                                                |
| `worker`    | —                | Orchestrator and the standard executors                                              |
| `compute`   | —                | Sandboxed code execution; holds the Docker socket, so it has host reach              |
| `postgres`  | —                | Durable state                                                                        |
| `redis`     | `127.0.0.1:6380` | Streams, hot state, timers; published, authenticated, for the paired host executor   |
| `migrate`   | one-shot         | Forward schema migrations                                                            |
| `bootstrap` | one-shot         | Instance secrets and their per-service cuts, tenant, owner, workspace, agent ceiling |
| `mcp`       | `127.0.0.1:3100` | Aflow MCP server — opt in with `--profile mcp`                                       |

The API is published, unlike Postgres, because the realtime WebSocket gateway lives on it and the browser connects to that directly with a short-lived token the BFF mints. Every other call the browser makes goes through the BFF.

## Secrets and backups

First boot writes four values into the `instance_config` volume, at `instance.env`. Two are generated secrets:

- `PHOENIX_INSTANCE_SECRET` — what the BFF authenticates to the API with.
- `CREDENTIAL_ENCRYPTION_KEY` — what wraps every stored credential.

Two are the instance's identity, recorded as bootstrap resolves them:

- `PHOENIX_LOCAL_TENANT_ID` — the tenant whose schema holds everything.
- `PHOENIX_LOCAL_OWNER_ID` — the user who owns every workspace.

The ids default to well-known values and are only interesting when an operator pins their own, but they are recorded either way. They live in `instance.env` rather than only in `.env.local` because `.env.local` is not in the backup: an instance restored onto a clean host without them boots under the defaults, provisions a second tenant beside the one it just loaded, and leaves the restored tenant unreachable. Each value is checked before it is written — a secret shorter than 32 characters, an encryption key that does not decode to 32 bytes, or an id that is not a UUID is refused rather than stored, because a stored value the API rejects at startup also turns the operator's correction into a conflict.

Every service in the stack runs as the same user, so ownership separates none of them: what a container mounts is the whole of what it can read, and a process handed `instance.env` can reopen it whatever it dropped from its environment. Bootstrap therefore cuts the file into one volume per audience, and each service mounts only its own, read-only:

| Volume            | Holds                                             | Mounted read-only by |
| ----------------- | ------------------------------------------------- | -------------------- |
| `instance_config` | `instance.env` — all four values                  | `api`                |
| `worker_config`   | `wrapping-key.env` — `CREDENTIAL_ENCRYPTION_KEY`  | `worker`             |
| `web_config`      | `instance-secret.env` — `PHOENIX_INSTANCE_SECRET` | `web`                |

`api` is the one reader of the whole file: it compares the instance secret, unwraps credentials, and resolves the instance's identity from the pinned ids. `bootstrap` is the one writer, and the only service that mounts any of these writable. The cuts are re-derived on every start and are not archived — a restored `instance_config` replaces them on the next boot, before the worker or the web process reads one.

Model-provider keys are **not** in `instance.env`. The credential entered in the UI is in the database, encrypted with the key that is in the backup, so it restores with everything else; the embedder's `.env.local` copy is not, and the operator supplies that again on a new host.

**Back that volume up with the database.** A database restored without its encryption key has credential rows nothing can read. Restoring both together works; supplying the original key through the environment on a fresh instance also works, and bootstrap will adopt it rather than generate past it.

```bash
yarn local:backup                      # → ./aflow-backup-<timestamp>/
docker compose -f docker-compose.local.yml down
yarn local:restore ./aflow-backup-...
```

Backup runs against the live instance and does not need downtime: the database is dumped with `pg_dump` rather than copied, because a `tar` of a running PostgreSQL data directory is a physical copy taken mid-write, not a consistent snapshot. The destination directory is created `0700` and its files `0600` — they hold the instance secret and the credential-encryption key.

A backup is written whole or not at all. It is staged in a sibling `.partial` directory and renamed once every artefact is on disk, so an interrupted run leaves nothing behind, and an existing destination is **refused** rather than merged — a set assembled from two runs would describe a moment that never existed. Alongside the archives it writes `SHA256SUMS`, covering the manifest, the dump, and both volume archives.

Restore verifies everything **before** it removes anything: the checksums, that each archive opens as a gzipped tar, and that the dump reads as a custom-format `pg_dump` archive. A backup that fails any of those stops the restore with the target untouched. The digests and both readability checks run inside the same images that wrote and will load the artefacts, so a macOS host (which ships no `sha256sum`) and a Linux host verify identically.

### What a running backup does and does not capture

The dump is consistent with itself, and that is the whole of what is guaranteed. The database is snapshotted at one instant, the payload volume is archived a moment later, and Redis is not archived at all — so a backup taken while the instance is working can:

- reference a payload written after the dump, or one deleted before the archive;
- restore a run that was mid-flight, whose execution state lived in the Redis this backup deliberately omits. The stall watchdog moves such a run to `STALLED` rather than resuming it.

For a backup with no seam, stop the stack first and bring up only the database it is dumped from:

```bash
docker compose -f docker-compose.local.yml down
docker compose -f docker-compose.local.yml up -d postgres
yarn local:backup
docker compose -f docker-compose.local.yml down
```

A coordinated boundary that quiesces dispatch and waits for the projection to flush would remove the choice. It is not built.

Restore then replaces the database and both volumes, and **discards Redis**. Redis holds in-flight execution belonging to the instance being replaced; left in place, its streams and hot state would replay against an older database.

It requires the containers to be **removed**, not merely stopped: a stopped container still holds a reference to its volumes, and a removal that failed would leave the old volume in place for the restore to overlay.

Payloads live on a volume rather than in Redis: the Redis payload store expires a non-persistent payload after 24 hours, which is a cache for development and data loss for an instance whose database rows reference those payloads indefinitely.

## Upgrade

```bash
git pull
docker compose -f docker-compose.local.yml up -d --build
```

`migrate` runs forward-only migrations before anything opens a connection, and `bootstrap` repairs any missing scaffolding without touching what the operator has built. Migrations are not reversible; roll back by restoring a backup taken before the upgrade.

An instance that predates the Redis ACL upgrades with the same command. The
one-shot that establishes the instance's secrets adds the two Redis passwords to
the file it already keeps, writes the ACL from them, and Redis restarts
authenticated — in that order, because Redis waits on that one-shot. The
instance secret, the credential-wrapping key, the tenant and the workspaces are
read and left alone, which is what makes stored credentials still decrypt
afterwards.

Expect a short window of connection errors in the logs during the upgrade: the
running services hold the old configuration until Compose replaces them, and
Redis has already started asking who they are. They are replaced within seconds
and the errors stop.

## Running sandboxed code

On by default. Running code is one of the capabilities the product exists to
offer, so the sandbox starts with everything else — `yarn local:up` brings it up
and nothing has to be opted into.

```bash
# Sandbox scratch lives here on the host. The default is /var/lib/aflow/sandbox,
# which suits Linux; name your own where that path is not writable or not shared
# with the daemon, as on Docker Desktop.
AFLOW_SANDBOX_DIR=/absolute/path/for/sandbox/scratch \
  docker compose -f docker-compose.local.yml up -d
```

The path must be absolute, and the service refuses to start otherwise rather
than letting compose resolve a relative one against this file — which would
produce a bind whose two halves name different directories.

The directory is mounted at the identical path it has on the host, because the
daemon resolves the sandbox's mount source in its own namespace rather than the
executor's. The executor proves that at boot and refuses to start if it does not
hold: a path visible only inside the container is silently created empty by the
daemon, and the sandbox then sees nothing while the manifest says the files were
written.

`PHOENIX_COMPUTE_RUNTIME: present` is set in the compose file, which is how
workspace settings knows a sandbox exists to enable a policy against. It is a
claim about the deployment rather than an observation of a running executor —
stopping the service does not retract it.

`PHOENIX_CODE_LANE` is not set, and the local edition reads that as `absent`: the
appliance composes no managed coding lane, so readiness reports a `code.*` skill
as unavailable on this edition instead of asking for a coding-lane key or a repo
designation, and coding work runs through the host lane on the paired machine.
`present` is for a composition that adds the lane's executor.

**What this costs.** The service mounts the host Docker socket, which is host
root whichever user holds it. Nothing in the sandbox's own hardening — non-root,
dropped capabilities, network off, memory and time limits — defends the host
against that socket.

The service is given no instance secret, no credential-wrapping key and no
`.env.local`, which keeps those out of its environment — but that is hygiene,
not containment. Anything reaching the socket can ask the daemon to mount the
host filesystem or the config volumes and read them regardless, and it already
holds the datastore network and the payload volume. Treat a compromise here as
appliance-wide, with host access; the omissions only reduce what is exposed by
accident.

Qualified on macOS with Docker Desktop. Linux qualification is separate work and
has not been done.

An operator who does not want that host reach stops the one service, and
disables compute in workspace settings so no stored policy outlives it:

```bash
# Disable compute in workspace settings first — a stored policy stays stored,
# and nothing revokes it on restart.
docker compose -f docker-compose.local.yml rm -sf compute
```

Stopping it does not change what the API reports, because `PHOENIX_COMPUTE_RUNTIME`
is set in the compose file rather than observed; remove it there too if the
settings page should stop offering the switch.

## Changing it

The appliance runs compiled output in containers, so there is no watch mode and
an edit is not live. Rebuild and recreate against the same volumes:

```bash
yarn local:up          # rebuilds the one image, recreates the containers
```

The workspace, credentials, payloads and history survive: they live in named
volumes, not in the image.

For anything more than a one-off, `yarn start` runs this same edition from
source under `tsx watch` — see below.

After a rebuild, `./scripts/appliance-smoke.sh` confirms the stack still
composes what this edition declares.

## Running commands and reading files on this machine

The appliance can reach the operator's own projects — their real repositories,
their installed toolchains, the files their editor has open — through a **host
executor** paired to it. That executor is not a container: it runs as the
ordinary user on the machine, because reaching those things is the point of it
and a container cannot.

What a job may reach is a **binding**: a folder the operator connected, and
whether writes are allowed. Bindings are declared on the machine, in a file no
job can write, and an operation cannot widen one — a path outside a binding is
refused rather than resolved.

Get a code from the workspace — **Settings → This Computer → Connect a folder**
— then run one command in the folder you want it to reach. The code lasts a few
minutes, works once, and can do nothing but connect folders to that space.

```bash
# From your aflow checkout — `yarn workspace` resolves from there.
yarn workspace @aflow/aflow-executor-host connect 7K2P-9XQM

#   [ the Finder folder chooser opens ]
#
#   Connect /Users/you/code/thing?        [Y/n]
#   Allow writing?                        [y/N] y
#   Allow commands to run?                [y/N] y
#
#   Commands here cannot reach your home folder. These hold tools you have
#   installed:
#       /Users/you/.local/bin  (e.g. mytool)
#   Allow commands to use them?           [Y/n]

yarn executor:host
```

## Developing against the appliance

First check that you want to. This runs compiled containers, so the third row of
the rebuild table below costs an image build per iteration — worth it when the
appliance _artifact_ is the subject, wasted on anything else. Everything else
belongs in `yarn start`, which runs from source under `tsx watch`. CLAUDE.md
carries the table under **Which stack for which change**.

Two commands. The first brings up the API and worker on ports that do not
collide with a dev stack; the second runs the web app from source against them,
with hot reload.

```bash
yarn local:dev:up    # API on 3200, worker, web container stopped
yarn local:dev:web   # the web app on 3201, hot-reloading
```

Then http://127.0.0.1:3201 — the same address the packaged app uses, so the API's
CORS and realtime origins keep matching and the chat connects.

The ports are pinned in the script rather than passed by hand, because passing
them once and later running a plain `yarn local:up` recreates the containers on
the defaults (3000/3001) while the web server is still pointed at the old ones.
That presents as `ECONNREFUSED 127.0.0.1:3200` from a stack that looks up.

What still needs a rebuild is worth knowing, because most of it does not:

| Changed                      | To see it                                                    |
| ---------------------------- | ------------------------------------------------------------ |
| `apps/web`                   | nothing — the dev server reloads on save                     |
| the host executor            | `launchctl kickstart -k gui/$(id -u)/ai.aflow.host-executor` |
| API, orchestrator, executors | `yarn local:dev:up` again                                    |

`yarn local:up` puts the packaged web back on its own port when you are done.

To stop thinking about it, install it as a launch agent — it then starts at
login and restarts if it stops:

```bash
yarn workspace @aflow/aflow-executor-host service install   # status | uninstall
```

Only one may run: a second executor claims the same jobs. Stop a foreground
`yarn executor:host` before installing.

That script loads no `.env`, and the omission is deliberate: an ambient
`REDIS_URL` wins over the paired one, so a root env file pointed at a different
instance would have the executor start cleanly, claim nothing, and look from the
appliance exactly like a lane that is down. It says so now when something
shadows a paired value.

Both halves are written by that one command: the folder is recorded in
`~/.aflow/host-policy.json`, which nothing on the appliance side can write, and
the workspace is told the binding exists. Neither half grants anything alone.

The chooser is the operating system's own, because a browser cannot supply a
path: `webkitdirectory` yields relative names and `showDirectoryPicker` yields a
handle scoped to the page, and neither discloses an absolute path to anything.
Upload works because a page may hold the bytes; a binding needs the path, and the
executor that opens it is a different process. Where there is no window session —
over ssh, or on Linux — it asks in text instead.

For a scripted setup, `--folder /path/to/it --yes` takes every default and asks
nothing. The folder has to be named there: with no terminal to ask, assuming the
working directory would connect whichever package `yarn workspace` started in.
The other defaults are the narrow ones — read only, no commands.

Pairing establishes who the machine is; the bindings say what it may reach.
They are deliberately separate, so connecting one project does not imply
trusting every future one.

A folder is reachable only where both halves agree. The workspace connects it in
**Settings → This Computer**, the machine offers it in its policy file, and what
applies is the intersection — so an appliance cannot invent access to a folder
the machine never offered, and a folder the machine offers is unused until a
workspace connects it. Pairing prints both mismatches, because a name typed
differently on the two sides is otherwise silent until a run fails.

Running commands is its own grant on both sides. A binding without
`allowsExecution` reads and writes files and refuses `host.process.*`, including
inspecting what is running — a folder connected for its contents does not become
a shell by being connected.

### Where your own tools live

Home is denied as a region — that is what protects keys, cloud credentials and
browser profiles — and it catches every CLI installed under it too. A tool in
`/usr/local/bin` or `/opt/homebrew/bin` runs; one in `~/.local/bin`, `~/go/bin`
or a home npm prefix cannot be read, and the shell reports that as
`Operation not permitted` or `command not found`, which reads like a broken
install rather than a boundary.

Say once where they live:

```bash
yarn workspace @aflow/aflow-executor-host harness tools ~/.local/bin ~/go/bin
```

Read-only, and only for commands run in a folder connected with `--run`. It
carves out exactly what is named; the rest of home stays denied. A symlink from
a system path does **not** work — the kernel resolves it to the home target and
the policy denies that.

When a command does fail this way, the result says so and names `toolPaths`,
rather than leaving a missing-file error to be puzzled over.

### What confines a command

Commands run inside a policy compiled from their binding, enforced by the
operating system. Home is denied as a region and re-allowed selectively — keys,
cloud credentials, browser profiles and the executor's own pairing state all
live there. Egress is closed unless a binding opens it.

One limit is worth stating because it is not obvious: **paths outside home stay
readable**. The enforcement adapter permits reads by default and narrows by
denial, so `/usr`, `/opt` and their peers are visible to a confined command.
What keeps their contents on the machine is the egress policy, not the read
policy.

There is no unconfined path. A machine where the adapter cannot enforce refuses
to run commands rather than running them openly.

On Linux the mechanism needs `bubblewrap`, `ripgrep` and `socat` installed. A
machine missing them cannot confine anything, so it refuses — and the refusal
names which are absent, because that list is the whole of the fix.

### Putting a coding agent to work

A coding agent already installed on the machine — the operator's own, already
signed in — can be handed a task against a connected repository. The run happens
in a **worktree of its own**, detached at the repository's current commit, so
uncommitted work is untouched, two runs cannot collide, and the result is a diff
to review rather than an edit already made. Nothing is committed, pushed or
applied.

```bash
# What is installed here, and what is allowed to run:
yarn workspace @aflow/aflow-executor-host harness list

# Allow one. It starts able to reach nothing:
yarn workspace @aflow/aflow-executor-host harness add claude
```

While a run is in flight the executor holds the machine awake on power —
`harness keep-awake always` holds it on battery too, `never` not at all — and work
the appliance dispatches while the machine sleeps waits up to ten minutes for it to
wake rather than failing.

A harness needs two things the boundary refuses by default, and both are granted
on the machine rather than assumed by the platform.

**Egress, a host at a time.** No domain list ships for any harness, because none
would be right: the first real run of a signed-in Claude Code was refused
connections to five distinct hosts — the model API, a code-assistant API, a
package registry, an MCP endpoint and a telemetry sink. Run it once, read
`blockedDomains` off the result, and allow what the work needs:

```bash
yarn workspace @aflow/aflow-executor-host harness allow claude api.anthropic.com
```

**Its credential.** A harness that keeps its token in a file needs only its
config directory, which `harness add` already suggests. On macOS a signed-in
coding agent typically keeps it in the **Keychain**, which a confined process
cannot reach — reaching it needs a Unix socket, and that grant is all-or-nothing,
so permitting the Keychain would also permit the SSH agent and the Docker socket.
For that case the profile names a command that prints the credential; it runs
outside the boundary as the operator, macOS prompts for consent the first time,
and the value is scrubbed from everything the run reports.

```bash
yarn workspace @aflow/aflow-executor-host harness add claude \
  --credential "security,find-generic-password,-s,Claude Code-credentials,-w" \
  --credential-json "<field holding the token>" \
  --credential-env CLAUDE_CODE_OAUTH_TOKEN
```

The command is comma-separated so no shell parses it, which is why a service name
containing a space needs no quoting inside it. `--credential-json` is the field to
take when the store prints JSON rather than a bare token; which field that is
depends on the harness, and a wrong one fails with a message naming the path it
looked for rather than handing the harness an empty string. Omit it entirely when
the command prints the token alone.

**Its default model.** A task that names no `model` runs whatever the profile
names, and a profile naming none runs the harness's own default. A task's own
`model` still wins. Name it as the harness spells it, with `--model` on `add` or
afterwards:

```bash
yarn workspace @aflow/aflow-executor-host harness model claude <model>
yarn workspace @aflow/aflow-executor-host harness model claude --clear
```

A harness that takes no model argument refuses a profile model the same way it
refuses a task's.

**Its browser.** A task with `browser: { profile: 'ephemeral' }` gives the harness
this machine's browser as MCP tools — a throwaway Chrome profile made for the run,
which can open a dev server here on a port declared for the harness — and one naming a declared profile gives it that
profile, under its rules. The harness is handed the configuration through its
profile's `mcpArgs`; `harness add claude` writes the measured ones, and a profile
added before them is given them, or has them taken away, with:

```bash
yarn workspace @aflow/aflow-executor-host harness browser claude
yarn workspace @aflow/aflow-executor-host harness browser claude --clear
```

A harness without `mcpArgs` refuses a task asking for a browser, and says so.

A declared profile's posture, whether runs nobody is present for may use it, and
its origin rules are set under **This Computer → Browser** in the application, or
here with the command, which writes the same policy file the same way:

```bash
yarn workspace @aflow/aflow-executor-host browser posture default ask-to-act
yarn workspace @aflow/aflow-executor-host browser unattended default refuse
yarn workspace @aflow/aflow-executor-host browser rule default https://mail.example.com deny
```

Either is a person's change: the application's routes refuse an API key, a
service principal or an MCP session, and no operation an agent can call changes them.

A declared profile reaches nothing on this machine until a port is opened to it.
Open the port a dev server listens on, and Helmsman and Runners using the profile
can load it at `localhost`, `127.0.0.1` or `[::1]` on that port alone; every other
port, every other address of this machine (its LAN address, link-local,
`0.0.0.0`), and any other name that resolves to loopback stay refused. The same
list is under **This Computer → Browser**, and `browser.profile.list` tells the
agent which ports are open:

```bash
yarn workspace @aflow/aflow-executor-host browser local-port default 5173
yarn workspace @aflow/aflow-executor-host browser local-port default 5173 --remove
```

A page there is an origin like any other: the profile's posture and origin rules
hold for `http://localhost:5173` as they do for any site. A port this stack serves
on is refused, by the command, the application and the profile's proxy alike,
even when written into the policy file by hand: the API (3000), the web
application (3001, or 3002 run on its own), the MCP server (3100), Redis (6379,
the appliance's 6380), Postgres (5433), pgAdmin (8080) and Redis Commander (8081),
and wherever the environment of the process deciding moves one of them
(`PORT`, `WEB_BASE_URL`, `MCP_PORT`, `REDIS_URL`, `DATABASE_URL`, the `AFLOW_*_PORT`
the appliance publishes on; a URL counts only when it names `localhost` or a
loopback address). A page from any of them could approve the agent's own
requests. One written into the file by hand is shown as listed and refused, with
that reason, by `browser list` and under **This Computer → Browser**, where it can
be removed; `browser.profile.list` shows the agent only the open ones. The
executor cannot see a port another process was moved to in its own environment — the dev stack's `.env` is not the executor's — so a service moved
off its default is refused by the application, which reads the server's
environment, and by the executor only where its own environment names it too.

The throwaway profile reaches no more than the harness itself: the hosts allowed
with `harness allow`, and on this machine only the ports declared for it, on
loopback (`localhost`, `127.0.0.1`, `[::1]`) and never on a LAN address:

```bash
yarn workspace @aflow/aflow-executor-host harness browser-ports claude 5173
yarn workspace @aflow/aflow-executor-host harness browser-ports claude --clear
```

Declaring one of this stack's own ports for a harness (the API's 3000 and the web
application's 3001 by default, and the rest listed above) lets the harness's
browser load it — the web app presents the instance secret to whoever loads it, so
the harness could approve its own requests. The command warns before it writes
such a port.

A harness run needs `allowsExecution` on the binding, like any command, and the
**Coding agents on this computer** capability, which no profile carries by
default.

The result reports whether its diff still fits the repository: a run that took a
while can be overtaken by the operator committing or editing the same lines.
`applies` distinguishes a diff that can be taken from one that needs a decision,
and names the file git could not place. A repository that merely moved on to
other files still applies cleanly.

### What this changes about Redis

The appliance's Redis now authenticates. Services inside it share one identity;
the paired executor gets its own, narrow enough that a stolen credential reaches
the host job stream and little else. Redis publishes on `127.0.0.1` so the
executor can reach it, which is why the identity exists rather than a reason to
widen it.

`redis-cli` needs `-a` now, and the passwords are in the instance config that
`yarn local:backup` already captures — losing them would leave a Redis nothing
can talk to.

## What the local edition does not have

Team members, invitations, organization administration, tenant governance, per-user capability grants, audit export, the managed cloud coding lane (`code.*`, which clones a remote and runs a harness in a container — the local edition runs the operator's own installed harness over a folder on their machine instead), and voice. These are not hidden — the process never registers them, which the [edition composition tests](../../packages/server-runtime/src/routes/__tests__/editionComposition.test.ts) assert by booting the server both ways.

Two things are missing rather than withheld. Approving a new API host is a tenant-governance surface today, so the local edition cannot yet reach a host the catalog does not already list. And the filesystem payload store has no object host to sign against, so direct upload URLs and the fallback for downloads over 10 MB are unavailable — smaller payloads are served inline by the API as usual.

## Exposing it beyond this machine

Don't, yet. `PHOENIX_BIND=any` requires `PHOENIX_REQUIRE_TLS=true` and a TLS terminator, and the process refuses the combination without it — but the authentication model is still a single long-lived instance secret held by the BFF, which is a boundary suited to one host and one operator, not a network.

## Running it from source

```bash
yarn dev:local
```

The same edition under `tsx watch`, which is what an edit costs six seconds
instead of six minutes. It starts the datastores if they are not already
listening, applies migrations, provisions the instance into `~/.aflow/dev-local/`,
and runs the services this edition composes — the coding lane and voice are not
among them.

Three things it handles that are not obvious by hand. A development `.env`
configures an identity and authorization plane this edition refuses to start
beside, and the dev runner merges that file over its own environment, so those
values have to be overridden after the merge rather than unset before it. The
instance identity is a file rather than a variable, and it carries the wrapping
key that unwraps stored credentials as well as the secret that authenticates —
a process given only the secret authenticates but decrypts nothing. And it sets
`PHOENIX_EDITION` for its own processes only, since unset it resolves to
`enterprise`.

`~/.aflow/dev-local/instance.env` is this instance's identity, and what a second
run reuses rather than provisioning a second instance beside the first. It is
**per machine, not per checkout**, which is what an appliance is: every worktree
attaches to the one Postgres on this machine, so a per-checkout identity meant a
provider credential stored by one checkout could not be decrypted by any other —
surfacing two systems away as a decryption error on an agent turn.

A checkout that still holds a `.aflow-local/instance.env` from before has it
**adopted** into that location on the next run, copied rather than moved, and
only when nothing is there yet: the identity that matters is whichever one
wrapped the credentials already in the database. Backup and inspection therefore
want `~/.aflow/dev-local/`, not the checkout.

`PHOENIX_INSTANCE_DIR` still names a directory explicitly, which is how a
deliberately separate instance is asked for. Nothing is adopted into it — a
request for a separate instance is answered with one.

### Every service asks for a credential

The development stack's services listen on loopback, and loopback is the whole
machine: any process here reaches them. So each of them asks for a credential
(Plan 315 D20), and `yarn start` prints each one's state before it starts
anything.

- **Redis** requires a password, and it is the machine's rather than the
  checkout's: every checkout and worktree here shares the one Redis container,
  so a password per checkout would be one the running Redis never had. It lives
  in `~/.aflow/stack.env`, which the sandbox withholds from jobs, written once
  by the first `yarn start`, `yarn dev:local` or `yarn redis:password`. The stack's loader lays it
  into each checkout's `REDIS_URL` (`scripts/stackEnv.mjs`), so `.env` names
  only where Redis is, and `yarn infra:up` starts Redis with the same password
  (`scripts/infra.mjs`). It publishes on `127.0.0.1` only. Every entry point
  gets it through that one loader: each script that runs tsx on a file of the
  repository runs under `scripts/with-stack-env.mjs`, which reads `.env` under
  whatever the caller set — `DATABASE_URL=… yarn db:seed` seeds that database,
  and `yarn dev --env <file>` hands its services that file — and lays it only
  into a `REDIS_URL` naming this machine. A `REDIS_URL` naming another host is
  the checkout's own Redis: `yarn start` checks it with the credential it
  carries, and `yarn redis:password` leaves it as it is. A paired machine keeps its
  own identity in `~/.aflow/host.env`, read-only on write approvals; pairing
  hands it the address without the stack's password.
- **The MCP server** gives the owner's key only to a session that presents the
  session token `yarn mcp:setup` wrote into `mcp.local.json`. `.mcp.json` sends
  it from `AFLOW_MCP_LOCAL_TOKEN`, and `yarn mcp:setup` prints the line that sets
  that from the file. A session presenting nothing is refused with a `401` that
  says so.
- **Redis Commander and pgAdmin** (`yarn infra:tools`, off otherwise) log in
  with the Redis password — Commander as `aflow`, pgAdmin as
  `admin@phoenix.dev` — and publish on `127.0.0.1`. Behind a login rather than
  left open as loopback-only tooling, because Commander needs the Redis password
  to reach Redis at all: an open Commander would hand everything the password
  guards to any page or process that reached it, and with the password already
  in the compose file the login is two lines. pgAdmin sets its login once, when
  it creates its volume, so the volume is now `pgadmin_login`; the old
  `pgadmin_data`, which still holds the fixed login, is unused and can go
  (`docker volume rm aflow-dev_pgadmin_data`). For the same reason pgAdmin
  keeps the password it was first created with when the machine's changes, and
  `yarn start`'s readiness says so: removing its volume
  (`docker rm -f aflow-pgadmin && docker volume rm aflow-dev_pgadmin_login`)
  gives it the current one at the next `yarn infra:tools`. The login is not
  written at every start because compose has no way to: pgAdmin reads it only
  into an empty volume, so it would mean discarding pgAdmin's saved servers at
  every start or reaching into the image's own setup script.
- **Postgres** publishes on `127.0.0.1` only, with the fixed development
  login it has always had. A generated one is its own slice: `DATABASE_URL`
  reaches every tool and every Postgres-gated test.
- **The Redis integration suites** resolve the URL exactly as the services do —
  the shell over `.env`, the machine's password laid in, `REDIS_PASSWORD`
  emptied as `yarn dev:local` empties it for the services — through `scripts/stackRedis.mjs`, and connect only to this machine's
  own Redis: some empty their database and rewrite ACL users, so a URL naming
  another host, a managed Redis included, skips them without a connection and
  names the host. Where no Redis answers they skip;
  where one answers and refuses that credential they fail, naming the refusal,
  because a credential the stack wrote that a test cannot use is a defect.

`yarn start` authenticates to Redis with the machine's password and says which
it found — no password required, the password accepted, the password refused —
and stops, naming the remedy, on the first and the last, and when this
checkout's `REDIS_URL` carries a Redis password of its own for this machine's
Redis.

**With a `.env` or a Redis from before this, run one command:**

```bash
yarn redis:password
```

It writes the machine's password if there is none yet, takes a password of the
checkout's own out of `REDIS_URL`, and restarts Redis with the machine's; the
data is in a volume and stays. Then `yarn start` as usual: it gives an existing
`mcp.local.json` its session token (`yarn mcp:setup`, once the stack is
healthy), which a Claude Code session started from a shell where
`AFLOW_MCP_LOCAL_TOKEN` is set then presents.
