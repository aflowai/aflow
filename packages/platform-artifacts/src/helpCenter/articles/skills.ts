import type { HelpArticleInput } from '@aflow/schemas';

export const SKILLS_ARTICLES: readonly HelpArticleInput[] = [
  {
    id: 'what-is-a-skill',
    theme: 'skills',
    question: 'What is a skill?',
    summary:
      "A skill is a procedure the agents in a space know how to carry out, written down once and run as often as it is needed. It has a goal, a set of tasks that depend on each other, a description of when the Helmsman should use it, and optionally evals that grade every run. Each task is done by an agent, by a single tool call, or by a person who approves or supplies something. The Helmsman runs a skill when you ask for it in chat or when a trigger fires, and the skill is checked against the platform's rules every time it runs. Skills live under Skills in the sidebar.",
    body: `## Where

**Skills** in the sidebar. The switcher at the top picks a skill; the tabs are **Design**, **Performance**, **Evals** and **Runs**, and **More ▾** holds **Raw config**, **Proposals & Feedback** and **Danger zone**.

## What a skill is made of

- **Goal** — what a successful run achieves.
- **Tasks** — the steps, connected by what each one needs from the others. A task is carried out by an agent (a Runner working with the tools that task declares), by one operation, or by a person: an **approval gate** asks you to approve or reject, and **collect input** asks you for an answer.
- **Activation** — the phrases and situations that tell the Helmsman this skill applies.
- **Outcomes** — what the run hands back.
- **Evals** — optional criteria that grade each run.

## Kinds of skill

- **Process** — a repeatable multi-step procedure.
- **Project** — a one-off goal with milestones.
- **Optimization** — works towards a measured objective over many attempts; its runs show an **Attempt** number.

## Running one

Ask the Helmsman in chat. It picks the skill whose activation matches, or the one you name, and starts a run; the run appears on the skill's **Runs** tab. A trigger can start the same skill on a schedule or on an event.

## A skill stays valid

A skill's structure is checked whenever it is read or run, against the rules as they are now. The designer shows **Contract valid — no issues. Ready to run.** or lists the problems. A skill that fails the check is not run; the page says it **failed validation and needs repair by the agent**.

## Where skills come from

Install one from the **Store**, describe one to the Helmsman, start one with **New skill**, or **Clone** an existing one.`,
    editions: ['enterprise', 'community-local'],
    anchors: {
      routes: ['s/[space]/skills', 's/[space]/chat'],
      operations: ['workflow.run.start'],
    },
    related: [
      'install-skill-from-store',
      'create-or-change-a-skill',
      'skill-needs-setup',
      'skill-evals-and-coach-proposals',
      'schedule-or-trigger-a-skill',
    ],
    keywords: [
      'workflow',
      'procedure',
      'tasks',
      'activation',
      'process',
      'project',
      'optimization',
      'run a skill',
      'validation',
    ],
  },
  {
    id: 'install-skill-from-store',
    theme: 'skills',
    question: 'How do I install a skill from the Store?',
    summary:
      'Open Store in the sidebar and choose the Skills tab, or Skill store on the Skills page. A listing shows what is inside it and what it needs. Install opens a preview of everything it will add, anything already in the space that conflicts, and anything that will still need setup; confirm with Install. The installed skill is your own copy and can be edited. When a new version arrives the listing shows Update available, and you choose between the Store version and keeping yours. Space admins and editors can install.',
    body: `## Where

**Store** in the sidebar, **Skills** tab. The **Skill store** button on the **Skills** page opens the same list.

## Steps

1. Open a listing. **What's inside** lists the skills and integrations it carries; **What you'll need** lists the connections it depends on, or says it is ready right after install.
2. Choose **Install**. The dialog shows:
   - **This will add** — every skill and integration the install creates.
   - **Already in this space** — conflicts with something you have. Resolve these first; **Install** stays disabled until you do.
   - **Needs setup after install** — what will still be missing.
3. Confirm with **Install**. The result shows a **Setup checklist** and, where a provider sign-in is needed, **Connect your account**. **Open** takes you to the skill.

## After installing

The skill is a copy in your space, and you can change it like any other. The listing then shows **Installed**, with **Check setup again**, **Update** when a newer version exists, and **Uninstall**.

**Update** shows what changes. When you have changed the skill since installing it, the dialog lists what you changed and offers **Replace with Store version**, which discards your changes, or **Keep mine**, which leaves everything as it is until the next version.

**Uninstall** archives the skill, which can be restored, and turns off or removes the integrations it brought. A skill with runs still in progress cannot be uninstalled until they stop.

## The Helmsman can find skills too

Ask in chat for a capability you lack. The Helmsman searches the Store and proposes an install, which appears as a **Store Install** proposal; the install happens when you ratify it.

## On the hosted edition

A tenant admin decides which listings are offered under **Tenant Admin → Store**. Hiding a listing blocks new installs only.`,
    editions: ['enterprise', 'community-local'],
    anchors: {
      routes: ['s/[space]/store', 's/[space]/store/[catalogId]', 's/[space]/skills'],
      operations: ['store.listing.install'],
    },
    related: [
      'what-is-a-skill',
      'skill-needs-setup',
      'proposals-need-approval',
      'connect-an-integration',
    ],
    keywords: [
      'catalog',
      'marketplace',
      'template',
      'install',
      'update',
      'uninstall',
      'curated',
      'download skill',
    ],
  },
  {
    id: 'create-or-change-a-skill',
    theme: 'skills',
    question: 'How do I create a new skill or change an existing one?',
    summary:
      "Describe what you want to the Helmsman in chat and it composes the skill for you, checks it, and proposes it for you to ratify. You can also start one yourself with New skill on the Skills page, giving it a name, a goal and a template, or Clone an existing skill. To change a skill, edit it on the Design tab and use Review & Save, which shows the change and refuses to save while there are errors. When the Helmsman or the Coach changes a skill's tasks or goal, the change arrives as a proposal you ratify.",
    body: `## Where

**Skills** in the sidebar. **New skill** and **Clone** sit beside the skill switcher; editing happens on the **Design** tab.

## Ask the Helmsman

Describe the outcome in chat: what should happen, with which tools, how often. The Helmsman designs the tasks, checks them against the rules and the connections the space has, and proposes the result as a **Skill Compose** proposal. Ratify it to add the skill. If the skill needs an integration the space does not have yet, the Helmsman proposes connecting it too.

## Start one yourself

**New skill** asks for:

- **Name**.
- **Goal** — what a successful run should achieve.
- **Template** — **Process** for a repeatable procedure, **Project** for a one-off goal with milestones. An optimization skill needs a metric and a campaign contract; describe it to the Helmsman instead.

The skill opens on **Design** to fill in.

**Clone** copies a skill's tasks, campaign contract and activation into an independent skill. Runs, learnings, campaigns and evals stay with the original.

## Edit in the designer

The **Design** tab draws the skill as a graph. Add a step with **Task**, select any node to edit it in the **Inspector**, and switch between control flow and data flow. The skill is checked as you edit; issues are listed with a link to where each one is. **Review & Save** shows every changed line and saves only when the contract is valid. The designer needs a wide screen; on a phone the other tabs remain available.

## Ask for a change

Ask the Helmsman to change a skill. A change to its tasks, goal, outcomes or campaign is staged as a **Workflow Refinement** proposal for you to ratify; a rename or a budget change applies directly.

## Archive or delete

**More ▾ → Danger zone → Archive skill** hides it from the agent and keeps its history; **Unarchive skill** restores it. **Permanently delete** is offered only for an archived skill. Platform-owned skills cannot be archived or deleted.`,
    editions: ['enterprise', 'community-local'],
    anchors: {
      routes: ['s/[space]/skills', 's/[space]/chat'],
      operations: ['workflow.manage.patch', 'skill.manage.archive'],
    },
    related: [
      'what-is-a-skill',
      'proposals-need-approval',
      'skill-evals-and-coach-proposals',
      'install-skill-from-store',
    ],
    keywords: [
      'new skill',
      'author',
      'compose',
      'clone',
      'duplicate',
      'edit',
      'designer',
      'save',
      'archive',
      'delete skill',
    ],
  },
  {
    id: 'skill-needs-setup',
    theme: 'skills',
    question: 'Why does a skill say it needs setup, and how do I fix it?',
    summary:
      "A skill needs setup when it is valid but something it relies on is missing in this space: an integration that is not connected, a connection without its credential or sign-in, a coding repository, or a key for a provider one of its tasks uses. The Store lists these as Needs setup after install, and the listing's Check setup again shows what is still missing. Connect what is listed, usually under Integrations, then check again. The Helmsman knows which skills need setup and what closes each gap, and does not offer to run them until it is closed.",
    body: `## Where

- The skill's Store listing: **Check setup again** opens a **Setup check** that lists what is **Still needs setup**, with **Open Integrations**.
- **Integrations** in the sidebar, where an incomplete connection shows **Needs setup**.

## What "needs setup" means

The skill itself is sound. What it lacks is something only this space can supply:

- **An integration** — an API or MCP server one of its tasks calls, not yet connected here.
- **A credential or sign-in** — the integration exists but has no key, or needs **Connect your account** with the provider.
- **A coding repository** — a coding skill needs a repository designated for this space.
- **A provider key** — for example, for the coding agent's model or for web search.

## How to fix it

1. Read the list on the Store listing, or ask the Helmsman which setup a skill is missing; it names each gap and what closes it.
2. Open **Integrations** and connect or complete each one. For a provider sign-in, use **Connect your account** where the install result offers it, or connect the integration from **Integrations**.
3. Choose **Check setup again**. **Everything this needs is set up in this space** means it is ready.

An item that reads **A managed coding lane, which this edition does not include** cannot be supplied by any setup in this space.

## What happens until then

The Helmsman does not offer the skill as something it can run. A run that starts anyway pauses at the beginning and waits, rather than failing partway through a task.

## Not the same as an invalid skill

A skill whose page says it **failed validation and needs repair by the agent** has a problem in its own structure. No connection fixes that; ask the Helmsman to repair it, or edit it on the **Design** tab.`,
    editions: ['enterprise', 'community-local'],
    anchors: {
      routes: ['s/[space]/store/[catalogId]', 's/[space]/integrations', 's/[space]/skills'],
      operations: [],
    },
    related: [
      'connect-an-integration',
      'connect-mcp-server',
      'where-credentials-live',
      'install-skill-from-store',
      'run-failed-or-paused',
    ],
    keywords: [
      'missing integration',
      'not ready',
      'binding',
      'credential',
      'oauth',
      'setup checklist',
      'capability',
      'repository',
    ],
  },
  {
    id: 'skill-evals-and-coach-proposals',
    theme: 'skills',
    question: 'How are skills measured and improved — evals, golden cases and Coach proposals?',
    summary:
      'A skill can carry evals: criteria that grade every run, shown in the Eval column of its Runs tab and on its Performance tab. On the Evals tab, a golden dataset of cases lets you replay the skill as a batch and compare the result against a pinned baseline. The Coach reviews completed runs and proposes improvements, new or changed evals among them, which you ratify or reject on the Proposals & Feedback tab or in the Workbench. Nothing the Coach proposes changes a skill until it is ratified.',
    body: `## Where

On the **Skills** page, for the selected skill: **Performance**, **Evals**, and **More ▾ → Proposals & Feedback**. The **Coach** pane in the designer lists the same proposals beside the graph.

## Grading every run

A skill's eval suite holds **Goal criteria**, **Task criteria** and **Trajectory** criteria. Fixed checks run on every completed run; criteria that need judgement go to the **Judge** model, on every run or on a sample. **Performance** shows the suite, recent results and a rolling baseline. A skill with no suite is valid: the Coach writes one when the runs warrant it, and criteria can be added in the designer.

## Golden cases and batches

The **Evals** tab has three sections:

- **Cases** — the golden dataset. Ask in chat to "promote this run to a golden case" and ratify the draft here, or **Add case** directly. Drafts count only once ratified.
- **Batches** — **Launch batch** freezes the current dataset, pins the skill as it is now, and replays every case. Set the trials per case (three or more for a baseline) and a cost ceiling; the batch stops dispatching when it is crossed. **Pin as baseline** makes later batches compare against that one. The Helmsman launches a batch only when you ask, because a batch spends model usage.
- **Review** — mark agent replies as passing or failing. Marks grade the automatic judges; they never change a run's result.

## Coach proposals

After a run, the Coach may propose a **Workflow Refinement**, an **Eval Change**, a **Directive**, a **Capability Binding** and more. Each card offers **Details**, **Ratify**, **Reject** (which asks why) and **Dismiss**. When the skill has changed since the proposal was written, it offers **Regenerate**, or **Apply anyway…** after a warning. A **Platform Issue** is a note for the platform team and can only be dismissed.

The Coach also records **Learnings · the skill's memory**. Ratify or reject a proposed learning, or **Prune** an active one that is wrong.`,
    editions: ['enterprise', 'community-local'],
    anchors: {
      routes: ['s/[space]/skills', 's/[space]/settings/agent'],
      operations: ['eval.case.promote', 'eval.batch.run'],
    },
    related: [
      'helmsman-runner-coach',
      'proposals-need-approval',
      'what-is-waiting-for-me',
      'create-or-change-a-skill',
    ],
    keywords: [
      'evaluation',
      'golden dataset',
      'baseline',
      'judge',
      'regression',
      'quality',
      'learnings',
      'ratify',
      'feedback',
      'improve',
    ],
  },
];
