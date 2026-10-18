import type { HelpArticleInput } from '@aflow/schemas';

export const MODELS_ARTICLES: readonly HelpArticleInput[] = [
  {
    id: 'add-model-provider',
    theme: 'models',
    question: 'How do I add a model provider?',
    summary:
      'Paste an API key for the provider of the model your agents use. The first-run setup asks for it in its "Connect your provider" step. Afterwards, add or replace a key under Tenant Admin → Credentials (your personal keys and, for admins, tenant default keys) or under Settings → Credentials in a space (a key only that space uses). Each key is tested against the provider when you save it. Model usage is billed by the provider to your own account.',
    body: `## Where

**Tenant Admin → Credentials** for personal and tenant default keys, or **Settings → Credentials** for a key one space uses. Both list providers under **Agent Models**.

## Steps

1. Pick the provider of the model you want: OpenAI, Anthropic, Google AI, OpenRouter, Fireworks AI or xAI.
2. Paste the API key. The dialog links to the provider's site for getting one.
3. Choose **Save & test**. The key is saved, then checked against the provider, and a key that fails the check is reported on the spot.

The same dialog opens from the chat. When a space's model has no key, a banner above the composer says so, and **Review models** opens **Models & reasoning**, where a **Needs key — connect** pill opens **Connect** for that provider.

## Which scope to use

- **Personal key** (the default): used across all your spaces, and only for you.
- **Store for this workspace only**: a space key, shared with every member of the space who has no personal key.
- **Tenant Default Keys** (admins): shared with every member who has neither.

A personal key wins over a space key, and a space key over a tenant key. **Effective Resolution** on **Tenant Admin → Credentials** shows which key each provider resolves to.

Keys are stored encrypted and never shown again after saving.

## On the local edition

**Ollama** appears under **Agent Models** as well. It needs no key: models run on this computer, and nothing is billed.`,
    editions: ['enterprise', 'community-local'],
    anchors: {
      routes: ['settings/credentials', 's/[space]/settings/credentials', 's/[space]/chat'],
      operations: [],
    },
    related: [
      'no-key-resolves-model',
      'choose-models-per-role',
      'where-credentials-live',
      'run-models-locally',
    ],
    keywords: [
      'api key',
      'anthropic',
      'openai',
      'google',
      'openrouter',
      'fireworks',
      'xai',
      'byok',
      'bring your own key',
      'billing',
      'llm',
    ],
  },
  {
    id: 'no-key-resolves-model',
    theme: 'models',
    question: 'Why does the chat say the selected model requires a key?',
    summary:
      'Each agent role in a space runs on a model, and each model belongs to a provider. When no key for that provider resolves for you, a banner above the chat composer names the provider and the agents cannot run until it is fixed. Add a key for that provider, or choose a model from a provider you already have a key for. The same banner reports a key the provider rejected and a model that is no longer available. Readiness is worked out for you personally, because your own keys count only for you.',
    body: `## What the banner means

The banner above the composer is worked out from the space's models and the keys you can use, every time it is read.

- **"To run agents, the selected model requires a … key."** No key for that provider resolves: you have no personal key, the space has no space key, and the tenant has no default key.
- **"The … key used by the selected model was rejected."** A key exists, and the provider refused it. Update it.
- **"The model … is no longer available."** The model was removed from the catalog. No key fixes this; choose another model for the roles named.

## Fixing it

1. Choose **Review models** on the banner. **Models & reasoning** opens.
2. Either choose **Needs key — connect** beside the model and paste a key, or pick a model from a provider you already have a key for.

Changes in **Models & reasoning** apply to the space's agent across new sessions, not only the current chat.

## Why a teammate sees something different

Your personal keys count only for you. One member can be ready while another sees the banner in the same space. **Effective Resolution** on **Tenant Admin → Credentials** shows which key each provider resolves to for you: personal, then space, then tenant.

## Background summaries

The **Clerk** role writes conversation names and summaries. Without a key for its model, conversations keep plain names until one resolves.`,
    editions: ['enterprise', 'community-local'],
    anchors: {
      routes: ['s/[space]/chat', 'settings/credentials', 's/[space]/settings/credentials'],
      operations: [],
    },
    related: ['add-model-provider', 'choose-models-per-role', 'run-failed-or-paused'],
    keywords: [
      'banner',
      'missing key',
      'rejected key',
      'invalid key',
      'not ready',
      'review models',
      'model unavailable',
      'retired model',
    ],
  },
  {
    id: 'choose-models-per-role',
    theme: 'models',
    question: 'How do I choose which model each agent role uses?',
    summary:
      'A space has a default model that the Helmsman, Runner, Coach and Judge all use, and each of those roles can be given its own model instead. Set them under Settings → Agent → Models & reasoning, or from Models & reasoning in the chat composer. Each role also takes a reasoning effort. The Clerk, which writes conversation summaries, picks a small model on its own unless you choose one. Which models a space may choose from is set under Tenant Admin → Models.',
    body: `## Where

**Settings → Agent → Models & reasoning**, or **Models & reasoning** in the chat composer. Only space admins can change the agent's settings.

## The roles

- **Space default — model & reasoning**: applies to Helmsman, Runner, Coach and Judge unless a role is overridden.
- **Helmsman**: chats with you and drives the session.
- **Runner**: the worker that runs each task of a skill.
- **Coach**: reviews completed runs and proposes improvements.
- **Judge**: grades evaluations. A model set on one criterion still wins.
- **Clerk**: background summaries and conversation names. **Auto · small model** picks an economical model from the space default's provider.
- **Decisions**: routing, triage and gating steps in skills. **Auto** uses the first decision model with a key.

Leave a role's override empty to follow the space default. Each role also takes a reasoning effort; **Catalog default** leaves it to the model.

On the settings page, changes are saved with **Apply changes**. In the composer they save as you make them and apply across new sessions.

## Which models are offered

**Tenant Admin → Models** decides which models a space can assign. **Following platform recommendations** tracks the recommended set as it changes; turning models on or off makes a **Custom set**, and **Reset to recommended** returns to the platform's set. Narrowing the set blocks new assignments only: a space already running an excluded model keeps it until someone changes it.

A model you pick needs a key for its provider before the agents can run on it.`,
    editions: ['enterprise', 'community-local'],
    anchors: {
      routes: ['s/[space]/settings/agent', 'settings/models', 's/[space]/chat'],
      operations: [],
    },
    related: [
      'add-model-provider',
      'no-key-resolves-model',
      'helmsman-runner-coach',
      'run-models-locally',
    ],
    keywords: [
      'helmsman',
      'runner',
      'coach',
      'judge',
      'clerk',
      'reasoning effort',
      'thinking',
      'model allowlist',
      'default model',
      'override',
    ],
  },
  {
    id: 'run-models-locally',
    theme: 'models',
    question: 'Can I run models on my own computer instead of a cloud provider?',
    summary:
      'Yes, through Ollama. Aflow Local connects to Ollama on this computer with no key, and a model run that way sends nothing off the machine and is billed by no one. Add the Ollama connection under Agent Models in Settings → Credentials, then manage models under This Computer → Models on this computer: download one, load it, and choose Use for every role. The page says how well each model fits the machine, and a model that does not fit in GPU memory still answers, slowly.',
    body: `## Where

**This Computer → Models on this computer**. The Ollama connection itself is under **Settings → Credentials** or **Tenant Admin → Credentials**, in **Agent Models**.

## Setting it up

1. Install and start Ollama on this computer.
2. Under **Agent Models**, connect **Ollama**. It needs no key; **Connect & test** uses Ollama's usual address on this machine. The address, context window and parallelism can be changed there.
3. Open **This Computer**. **Models on this computer** shows the Ollama version, GPU memory and free disk space.
4. Choose **Download** on a model, then **Load now**.
5. Choose **Use for every role**, or pick the model for single roles under **Settings → Agent → Models & reasoning**.

First-run setup offers these models too, marked **Ollama, on this computer**.

## How well it fits

Each model says what it needs at the window the agents use, against this computer's GPU memory. A model that needs more spills onto the CPU and runs slowly. Problems Aflow can fix, such as a model a role uses that is not downloaded, carry a button; others say what to do.

## When the Helmsman changes it

The Helmsman can read this page's diagnosis. To download, delete, load or unload a model, it asks first: a card in the Workbench says what the change costs and which running requests it ends, and nothing changes until you approve it.`,
    editions: ['community-local'],
    anchors: {
      routes: ['s/[space]/computer', 'settings/credentials', 's/[space]/settings/credentials'],
      operations: ['model.runtime.status', 'model.runtime.change'],
    },
    related: [
      'what-leaves-this-computer',
      'choose-models-per-role',
      'add-model-provider',
      'write-approval',
    ],
    keywords: [
      'ollama',
      'local model',
      'offline',
      'gpu',
      'download model',
      'private',
      'no key',
      'free',
    ],
  },
];
