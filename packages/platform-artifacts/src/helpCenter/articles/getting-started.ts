import type { HelpArticleInput } from '@aflow/schemas';

export const GETTING_STARTED_ARTICLES: readonly HelpArticleInput[] = [
  {
    id: 'install-local',
    theme: 'getting-started',
    question: 'How do I install Aflow Local on my own machine?',
    summary:
      'Aflow Local needs Docker and nothing else. Download the appliance bundle from the latest release, unpack it, run docker compose up -d in its folder, and open http://127.0.0.1:3001. There is no login: reaching the web app on this machine identifies you as the owner. macOS with Docker Desktop is supported; Linux is expected to work but is not yet qualified.',
    body: `## What you need

- **Docker.** Nothing else — no Node, no dependency install.
- **Disk:** about 4 GB for the published image, or about 20 GB to build it from source.
- **macOS with Docker Desktop** is the supported platform. Linux is expected to work and is not yet qualified.

## Install from a release

Download \`aflow-appliance-<version>.tgz\` from the latest release on the project's GitHub releases page, then:

\`\`\`bash
mkdir aflow && tar -xzf aflow-appliance-*.tgz -C aflow && cd aflow
docker compose up -d
open http://127.0.0.1:3001
\`\`\`

The image is pinned by digest, so it cannot change under an instance you have already installed. The first pull moves several gigabytes.

## Build from source instead

From a clone of the repository:

\`\`\`bash
docker compose -f docker-compose.local.yml up -d --build
\`\`\`

## Signing in

There is no login. Reaching the web app on this machine is what identifies you as the owner, and the app listens only on this machine.

## Check it came up

From a clone, \`./scripts/appliance-smoke.sh\` runs its checks inside the containers and needs only Docker. It covers the stack coming up, not an agent answering — that needs a model provider, which first run walks you through.`,
    editions: ['community-local'],
    anchors: { routes: [], operations: [] },
    related: ['first-run-setup', 'upgrade-and-backup', 'local-edition-limits'],
    keywords: ['docker', 'appliance', 'setup', 'download', 'release', 'macos', 'linux'],
  },
  {
    id: 'first-run-setup',
    theme: 'getting-started',
    question: 'What happens the first time I open Aflow?',
    summary:
      'First run walks you through naming your workspace, choosing the model your agents think with, and connecting that model provider’s API key, then offers a chat, the Store and integrations as places to start. Aflow Local starts with a workspace already made, so it asks only for its name. You can skip the key with “I’ll add it later”, but agents cannot answer until one is connected.',
    body: `## The steps

1. **Your workspace.** The hosted product asks you to set one up after the welcome screen. Aflow Local made one when the instance started, so it asks you to **Name your workspace** instead. Name it after the work it will own; you can create more later.
2. **Choose your model.** Pick the model your agents think with. **Advanced: choose per agent role** sets a different model for the Helmsman, Runner, Coach or Judge. In Aflow Local, a model running on this computer through Ollama is offered too; it needs no key, so the next step is skipped.
3. **Connect your provider.** Paste the provider's API key and press **Save & test**. **Where do I get this?** opens the provider's own key page. The key is stored encrypted and used only to run your agents; usage is billed to your provider account, not by Aflow. By default a key works across all your workspaces; tick **Store for this workspace only** to keep it to this one.
4. **Ready.** Start a chat with your agent, browse the Store, or connect integrations, then **Go to your workspace**.

## Skipping the key

**I'll add it later** finishes setup without a key. Until one is connected, agents cannot answer. In Aflow Local, setup opens again in a new browser session for as long as the workspace has no model it can use.

## Changing it later

Models and keys can be changed at any time — see the articles on adding a model provider and choosing models per role.`,
    editions: ['enterprise', 'community-local'],
    anchors: { routes: ['settings/models', 'settings/credentials'], operations: [] },
    related: [
      'add-model-provider',
      'choose-models-per-role',
      'run-models-locally',
      'what-is-a-space',
    ],
    keywords: ['onboarding', 'welcome', 'wizard', 'api key', 'workspace', 'provider'],
  },
  {
    id: 'upgrade-and-backup',
    theme: 'getting-started',
    question: 'How do I upgrade, back up or roll back Aflow Local?',
    summary:
      'Back up first, then upgrade: an installed bundle takes the new release’s image digest in docker-compose.yml followed by docker compose pull and docker compose up -d; a source build takes git pull and a rebuild. Migrations run forward only, so rolling back means restoring a backup taken before the upgrade. A backup holds the database, the instance configuration with its encryption key, and stored payloads, and is only usable with all three.',
    body: `## Back up

From the bundle's folder:

\`\`\`bash
bash scripts/appliance-backup.sh ./my-backup
bash scripts/appliance-restore.sh ./my-backup
\`\`\`

From a clone, \`yarn local:backup\` writes \`./aflow-backup-<timestamp>/\` and \`yarn local:restore <dir>\` loads one.

A backup takes three things together: the database, the instance configuration and the stored payloads. The configuration holds the key that encrypts every saved credential. A database restored without it has credentials nothing can read, and that key cannot be recovered. Never prune Docker volumes with \`--volumes\`.

A backup can run while Aflow is running. Work in flight at that moment is not captured; for a backup with no gap, stop the stack first. Restore checks the backup before it removes anything.

## Upgrade

**Installed from a release:** replace the image digest in \`docker-compose.yml\` with the new release's, then:

\`\`\`bash
docker compose pull
docker compose up -d
\`\`\`

**Built from source:**

\`\`\`bash
git pull
docker compose -f docker-compose.local.yml up -d --build
\`\`\`

Your workspaces, credentials and history live in volumes and survive. Schema migrations run before the API starts. A few seconds of connection errors in the logs during the switch are expected.

## Roll back

Migrations only move forward, so putting the old image back is not enough. Restore a backup taken before the upgrade, then put the previous digest back. \`docker compose config\` prints the digest in effect — keep it written down.`,
    editions: ['community-local'],
    anchors: { routes: [], operations: [] },
    related: ['install-local', 'where-credentials-live'],
    keywords: ['update', 'restore', 'migration', 'digest', 'volume', 'encryption key'],
  },
  {
    id: 'local-edition-limits',
    theme: 'getting-started',
    question: 'What does Aflow Local not have that the hosted product does?',
    summary:
      'Aflow Local is a single-owner edition. It has no team members, invitations, organisation administration, tenant governance, per-user capability grants, audit export, voice, or the managed cloud coding lane; coding work runs through a coding agent on your own paired machine instead. It cannot yet reach an API host the catalog does not already list, large downloads over 10 MB have no fallback, and it should not be exposed beyond this machine.',
    body: `## Not part of this edition

These are absent from Aflow Local rather than hidden:

- Team members and invitations, and sharing a space with other people
- Organisation administration and tenant governance
- Per-user capability grants
- Audit export
- Voice
- The managed cloud coding lane. Coding work runs through a coding agent installed on your own machine, over a folder you connect under **This Computer**.

## Missing for now

- **New API hosts.** Approving an API host the catalog does not list is a governance surface, so Aflow Local cannot yet reach one.
- **Large file transfers.** Direct upload links, and the download fallback for payloads over 10 MB, are unavailable. Smaller payloads are served as usual.

## Only on this machine

Aflow Local is meant to be reached from the computer it runs on. Its sign-in model is a single owner on one host, so exposing it to a network is not supported yet.

## What it has that the hosted product does not

**This Computer**: folders on your machine an agent can reach, a coding agent you already use, a browser of the agent's own, and models running locally.`,
    editions: ['community-local'],
    anchors: { routes: ['s/[space]/computer'], operations: [] },
    related: [
      'install-local',
      'pair-this-computer',
      'coding-agent-on-this-computer',
      'what-leaves-this-computer',
    ],
    keywords: ['local edition', 'community', 'missing', 'team', 'voice', 'audit', 'difference'],
  },
];
