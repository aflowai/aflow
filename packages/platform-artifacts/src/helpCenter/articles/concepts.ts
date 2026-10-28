import type { HelpArticleInput } from '@aflow/schemas';

export const CONCEPTS_ARTICLES: readonly HelpArticleInput[] = [
  {
    id: 'what-is-a-space',
    theme: 'concepts',
    question: 'What is a space, and when should I create another one?',
    summary:
      'A space (called a workspace on some screens) is a self-contained place where agents work. Each space has its own chat, skills, integrations, memory, plan, triggers and settings, and its Helmsman sees only what belongs to that space. Create a separate space when a body of work needs its own connections, its own memory or its own rules; use the space selector at the top of the sidebar and choose Create new workspace, or Start from a quick start for a space that comes with its skills. A space you no longer need can be archived from Settings → Danger zone, which hides it and pauses its schedules and webhooks, and can be undone.',
    body: `## Where

The space selector at the top of the sidebar lists your spaces. **Create new workspace** at the bottom of that list starts a new one, and **Workspace Settings** opens the current space's settings.

## What a space holds

Everything in the sidebar belongs to the space you are in:

- **Chat** — conversations with the space's Helmsman.
- **Skills** — the procedures agents run here.
- **Integrations** — the APIs and MCP servers this space can call.
- **Memory** — the space's documents and folders.
- **Plan** — the work the Helmsman is carrying out here, as a board: a tab per plan with its number of steps, the plan's header — how many of its steps are closed and how many stand in each column — and columns that say what the loop is doing with each step, in the order they ask for your attention: **Needs you**, **In flight**, **Up next**, **Done** and **Dropped**. **Needs you** holds what waits on you, each card saying why: a **Decision**, a step **Blocked** on a person, or a step **Under a closed step** — open work under a step already done or dropped, which the loop will not reach until the step above it is reopened or this one is dropped. **In flight** holds steps a run is on, and steps waiting on a run that has ended for the loop to advance them. **Up next** is the approved work no run is on yet, in the order the loop takes it, and the step it takes next is marked **Next**; **Move up** and **Move down** on an Up next card put it before or after the nearest open step beside it, and the loop takes them in the new order. Each card names its phase, runs under way, its pull request and review rounds; a plan with two or more phases can be filtered by **Phase**. **Done** folds by day — **Today**, **Yesterday**, then earlier ranges you open. Choose a card to open it at the side: **Now** — the first line of the step's working note — its goal, what it is done when, the whole **Working note** folded, how a finished one was met, its runs (**All runs** lists every one) and the findings carried forward. An open step has **Mark done** there, which asks how its criteria were met, and **Drop** — **Drop branch** when steps under it are still open, which leave the plan with it. A **Blocked** step has **Approve**, which makes it approved work the loop takes, with an optional reason that becomes the first line of its note. A done or dropped step has **Reopen**, which puts it back in the plan with what it claimed at the head of its note and your reason after it. A step **Under a closed step** offers **Reopen** on the closed step above it instead. A **decide** step is yours to answer: **Decide** on its card, at the side or in the Workbench, and your choice is its outcome. If the step changed since you opened it, nothing is written and the page reloads the plan to choose again.
- **Triggers** — schedules and webhooks that start work here.
- **Settings** — the space's name and default agent (**General**), the Helmsman's mandate and models (**Agent**), **Rules**, **Compute**, **Write Policy**, **Credentials** and **Danger zone**.

Switching spaces in the selector keeps you on the same page in the other space.

## When to create another space

Separate spaces keep work apart. A skill installed in one space, a connection bound in it, or a note in its memory is not visible from another. Create a new space when work needs different integrations or credentials, a memory of its own, or a different mandate for the Helmsman.

When you create a space and no model provider key is available for it, the dialog says so and offers **Add a provider key** or **Continue to chat**.

## Starting from a quick start

A quick start installs a space and has no uninstall. Archive the space from **Settings → Danger zone** when you no longer need it.

**Start from a quick start** in the space selector makes a new space that already holds the skills and the Helmsman directive a kind of work needs. Choose a quick start, name the space and choose **Create the space**. Its skills are installed the way the Store installs them anywhere, so they show as installed on that space's Store page and update from their own listings; the directive becomes the space's own, and you change it like any other. Nothing in your other spaces changes. Quick starts are also on the Store page, under **Quick starts**, with **Start a new space from it** — a quick start always makes a new space and is never applied to the one you are in.

In Aflow Local, while your only space is the one the instance started with and nothing has been made or installed in it, the quick starts are offered beside it when you open Aflow. Choosing the empty space keeps it as it is, and the offer is not shown again in that browser.

## Archiving a space

**Settings → Danger zone → Archive space** hides the space and pauses its schedules and webhooks. Run history is kept. Restore it from the **Archived spaces** list; schedules and webhooks paused by the archive stay paused until you turn them back on. Permanent deletion is offered only after a space is archived. The General space cannot be archived.`,
    editions: ['enterprise', 'community-local'],
    anchors: {
      routes: [
        'spaces',
        'spaces/archived',
        's/[space]/settings/general',
        's/[space]/settings/danger',
        's/[space]/plan',
        's/[space]/store',
      ],
      operations: [],
    },
    related: ['helmsman-runner-coach', 'memory', 'add-model-provider', 'connect-an-integration'],
    keywords: [
      'workspace',
      'create workspace',
      'switch space',
      'archive',
      'delete space',
      'project',
      'quick start',
      'template',
    ],
  },
  {
    id: 'helmsman-runner-coach',
    theme: 'concepts',
    question: 'Who are the Helmsman, the Runner and the Coach?',
    summary:
      'They are the roles the agents in every space play. The Helmsman is the agent you chat with: it plans, answers, runs skills and hands work off. A Runner carries out one task at a time, such as one step of a skill, with only the tools that task needs. The Coach reviews completed runs afterwards and proposes improvements for you to ratify. Each role can use its own model, set under Settings → Agent → Models & reasoning.',
    body: `## Where

**Settings → Agent** configures them for the current space. **Models & reasoning** sets the model each role uses.

## The Helmsman

The Helmsman chats with you and drives the session. It works out what you are asking for, runs the skill that fits, delegates one-off tasks, schedules work and points you at anything waiting for your decision. Each conversation starts from the space's **Mandate**, its settings and its memory.

## The Runner

A Runner is a worker for one task. When a skill runs, each of its tasks goes to a Runner with exactly the tools and connections that task declares, and nothing it learned in another task. The Helmsman also hands self-contained jobs to Runners and reads back the results.

## The Coach

The Coach reviews completed runs. From what it sees it proposes changes to a skill, writes or adjusts its evals, and records learnings. Its proposals appear in the Workbench and on the skill's **Proposals & Feedback** tab, where you ratify or reject them.

**Coach Tuning (advanced)** on the same page sets how often the Coach reviews: on procedural runs only, on a sample of runs, on every run, or only on anomalies and failures. **Autonomy** sets which kinds of change always need your approval, whatever the Coach's confidence.

## The Judge

**Models & reasoning** also lists a **Judge**: the model that grades runs for evals whose criteria need judgement rather than a fixed check.`,
    editions: ['enterprise', 'community-local'],
    anchors: { routes: ['s/[space]/settings/agent', 's/[space]/chat'], operations: [] },
    related: [
      'choose-models-per-role',
      'what-is-a-skill',
      'skill-evals-and-coach-proposals',
      'proposals-need-approval',
    ],
    keywords: ['agents', 'roles', 'judge', 'mandate', 'directives', 'learner', 'who does what'],
  },
  {
    id: 'sessions-and-runs',
    theme: 'concepts',
    question: 'What is the difference between a session, a run and a step?',
    summary:
      "A session is one agent working: a chat with the Helmsman is a session, and so is each task a Runner carries out. A run of a skill is one pass through its tasks, and each task gets a session of its own beneath it. A step is one thing an agent did inside a session, a model decision or a tool call, and every step is kept with its result and cost. A skill's Runs tab lists its runs; Open shows the run task by task, and Session opens Run Details.",
    body: `## Where

- **Skills →** a skill **→ Runs** lists that skill's runs with status, start time, duration, cost and eval result. **Open** shows one run task by task; **Session** opens **Run Details**.
- In **Chat**, the inspector beside the conversation has a **Session timeline** of every step and a **Session context** tab.

## Sessions

A session is one agent at work. Each conversation in **Chat** is a session with the Helmsman. When the Helmsman hands a job off, the worker gets its own session, linked back to the one that started it; **Run Details** names it as the **Parent session**.

A session's status reads:

- **Queued**, **Running** — waiting to start, or working.
- **Idle** — paused. A conversation is idle between turns: the Helmsman has answered and waits for you.
- **Completed**, **Failed**, **Cancelled**, **Stalled**.

## Runs of a skill

A run is one execution of a skill, from its first task to its outcome. The run page shows each task, its status and its output, with **View execution** for the detail. While a run is in progress it offers **Pause**, **Resume** and **Cancel**. A task that needs a person shows **Approve** or **Submit** in place.

## Steps

Every model decision and every tool call is a step. Steps keep their inputs, outputs and cost, which is what the timeline shows and what the Coach reads when it reviews a run.`,
    editions: ['enterprise', 'community-local'],
    anchors: {
      routes: [
        's/[space]/sessions',
        's/[space]/sessions/[sessionId]',
        's/[space]/runs/[runId]',
        's/[space]/skills',
        's/[space]/chat',
      ],
      operations: [],
    },
    related: [
      'run-failed-or-paused',
      'helmsman-runner-coach',
      'what-is-a-skill',
      'what-is-waiting-for-me',
    ],
    keywords: ['status', 'idle', 'timeline', 'run details', 'history', 'cost', 'tool call'],
  },
  {
    id: 'memory',
    theme: 'concepts',
    question: 'What is memory, and how do agents use it?',
    summary:
      "Memory is a space's own store of documents and folders. Agents read and write it across runs, and you can browse, search, create and delete its contents under Memory in the sidebar. Documents link to each other with [[/path/to/note]], and each document shows what it links to and what links to it. Separately, in a space where you are the only member, Settings → Memory holds standing notes the Helmsman carries into every conversation; the agent proposes them and only the ones you promote are used.",
    body: `## Where

**Memory** in the sidebar opens the **Memory Explorer** for the current space. **Settings → Memory** holds the agent's standing notes, and appears only in a space where you are the sole member.

## Documents and folders

Memory is organised like a file system. The left pane lists **Directories** and **Files** at the current path; choose an entry to see its **Content** and **Info**, download it or delete it. Create a file or a directory from the same pane; either can carry tags, and a directory a description.

Search the current space's memory three ways:

- **List** — browse the folder tree.
- **Semantic search** — find documents by meaning.
- **Grep** — find exact text.

Write \`[[/path/to/note]]\` anywhere in a document to link it. The document then lists **Links from this document**, marking a target that does not exist yet as **Not written yet**, and the target lists it under **Referenced by**.

## How agents use it

Agents keep what should outlast a run in memory: reports, datasets, notes and drafts a later run builds on. They search and read it the same three ways, and code running in a sandbox reads and writes the same documents. Each space's memory is its own; another space cannot see it.

## Standing notes

Under **Settings → Memory**, the Helmsman proposes short notes for it to carry into every conversation in the space. A note waits under **Awaiting review** until you **Promote** it; an active note can be **Revoked**, and any note deleted. Notes are reference, never rules, and your current message always wins over them.`,
    editions: ['enterprise', 'community-local'],
    anchors: {
      routes: ['s/[space]/memory', 's/[space]/memory/[...path]', 's/[space]/settings/memory'],
      operations: ['memory.store.query', 'memory.store.put', 'memory.context.remember'],
    },
    related: ['what-is-a-space', 'helmsman-runner-coach', 'what-is-a-skill'],
    keywords: [
      'documents',
      'files',
      'folders',
      'notes',
      'search',
      'grep',
      'wikilinks',
      'backlinks',
      'remember',
      'agent memory',
    ],
  },
];
