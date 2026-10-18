import type { HelpArticleInput } from '@aflow/schemas';

export const PRIVACY_ARTICLES: readonly HelpArticleInput[] = [
  {
    id: 'what-leaves-this-computer',
    theme: 'privacy',
    question: 'What data leaves my computer when I use Aflow Local?',
    summary:
      'Only the calls you configure leave the machine: requests to the model providers you connect, and to the integrations and MCP servers you connect. Aflow Local sends no telemetry, crash reports, analytics or update checks, needs no account and checks no licence. Interactive artifacts load open-source libraries from public CDNs and catalog logos from an image host; those hosts see a request for a file, not your data. A model run on this computer through Ollama sends nothing anywhere.',
    body: `## What goes out

Only calls you set up:

- **Model providers.** Each agent turn sends its prompt to the provider of the model it uses, with the key you connected. Usage is billed by that provider.
- **Integrations and MCP servers you connect.** An agent calling one of your tools sends that request to the tool's own host.
- **Sites the agent's browser opens**, when you give an agent the browser on **This Computer**, and the hosts a coding agent on this machine is allowed to reach.

Nothing else. There is no telemetry, crash reporting, analytics or update check, no account, and no licence server.

## What comes in

When an interactive artifact uses them, your browser loads open-source libraries (React, charting, maps and similar) from public CDNs such as jsDelivr and esm.sh, and catalog provider logos load from an image host. Those hosts see a request for a library or an image, never your data. Such artifacts need a network connection to render.

## Keeping a model on the machine

A model run through Ollama on this computer — offered at first run and under **This Computer** — runs on this machine: nothing leaves it, no key is needed, and nothing is billed.

## Where your data is kept

Workspaces, memory, run history and credentials stay in the appliance's own storage on this machine. Provider keys are stored encrypted with a key generated for this instance. The web app is reachable only from this computer.`,
    editions: ['community-local'],
    anchors: { routes: ['s/[space]/computer'], operations: [] },
    related: [
      'run-models-locally',
      'where-credentials-live',
      'agent-browser',
      'local-edition-limits',
    ],
    keywords: ['telemetry', 'analytics', 'network', 'offline', 'phone home', 'cdn', 'data'],
  },
];
