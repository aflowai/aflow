import type { HelpArticleInput } from '@aflow/schemas';

export const APPROVALS_ARTICLES: readonly HelpArticleInput[] = [
  {
    id: 'what-is-waiting-for-me',
    theme: 'approvals',
    question: 'Where do I find approvals and other things waiting for me?',
    summary:
      "Everything in a space that needs a person collects in the Workbench beside the chat: approvals for writes and other actions, questions a run is waiting on, decisions the space's plan leaves to you, account sign-ins an integration needs, and proposals from agents such as the Coach. While anything is pending, a yellow indicator appears in the header of the space's other pages; choosing it opens Chat with the Workbench. The Helmsman can also bring an approval, a question, a plan step or a sign-in into the chat. Its card shows the item's kind, title and state, and you answer it where the item lives: on the Plan page or under Pending in the Workbench. Ask it what is waiting on you, and it counts the pending plan steps, run approvals and sign-ins, and points you at each one. Work that waits on an item stays paused until it is answered.",
    body: `## Where

- **Chat** — the **Workbench** sits beside the conversation. On a phone, switch between **Chat** and **Workbench** at the top; the Workbench shows how many items need you.
- **Every other page in the space** — a yellow indicator in the page header while one or more items are pending. Choosing it opens **Chat** with the **Workbench**.
- **In the conversation** — the Helmsman can bring an approval, a question, a plan step or a sign-in into the chat. Its card shows the item's kind, title and state, and it points to where you answer it: the step on the **Plan** page for a plan step, or **Pending** in the **Workbench** for anything else. The card itself has no answer controls.

## What appears

**Pending** holds items that are blocking work now:

- **Approvals**: a write the agent wants to make, an approval a skill asks for as one of its steps, or another action that asks first. A write approval card has **Approve**, **Deny** and an optional reason.
- **Plan steps**: a step of the space's plan that waits on you, from the moment it is blocked. **Pending approval · …** is a blocked step, with **Approve** to start it and **Drop** to leave it out. **Pending review · …** is a merge waiting for you to judge it, with **Close done** and **Drop**. At most 50 are listed, the newest first, and the **Plan** page holds the rest.
- **Inputs**: a question a run is waiting for you to answer, and a decision the space's plan leaves to you — a step of kind **decide**, titled **Pending decision · …**. Write your choice and choose **Decide**; it is recorded as the step's outcome and the step is marked done, as it would be on the **Plan** page. If the Helmsman changed the question after you opened it, your answer is refused and the card shows the question as it now stands.
- **Connections**: a **Connect** or **Reconnect** card when an integration needs you to sign in with an account, or a sign-in has expired.

Proposals are changes an agent wants to make to skills, evaluations or integrations. Each sits in a section named for its source. **Coach review** holds the Coach's proposals, and every other source, such as **Helmsman patch**, has a section of its own. Proposals do not block a run. They wait for you to **Ratify**, **Reject** or **Dismiss** them.

## When an item names someone else

A request addressed to another person stays visible, says who it is waiting on, and is not counted in your total. It can be handed to someone else from the card.

## What happens after you answer

The work that was waiting on the item continues from where it stopped; nothing needs to be restarted. **Pending** is hidden when nothing is pending, and the indicator goes back to its resting colour.`,
    editions: ['enterprise', 'community-local'],
    anchors: {
      routes: ['s/[space]/chat'],
      operations: ['user.interaction.ask', 'user.interaction.approve'],
    },
    related: [
      'write-approval',
      'proposals-need-approval',
      'run-failed-or-paused',
      'connect-mcp-server',
    ],
    keywords: [
      'action center',
      'bell',
      'yellow indicator',
      'inbox',
      'pending',
      'notifications',
      'pending approval',
      'pending review',
      'workbench',
      'waiting',
      'blocked',
      'hitl',
    ],
  },
  {
    id: 'write-approval',
    theme: 'approvals',
    question: 'Why is a write waiting for my approval, and how do I change which writes ask first?',
    summary:
      'Every endpoint of an API integration carries a risk tier. Before the agent, or a step of a running skill, makes a write call, the space checks that tier against its Write Policy: by default, low-risk writes run unattended, while medium-risk writes (external sends, hard-to-undo changes) and high-risk writes (money movement, destructive changes at scale) wait for a person to approve them in the Workbench. Nothing is sent until you approve. Denying stops that call and tells the agent why. Space admins change the defaults per tier under Settings → Write Policy.',
    body: `## Where

Approve or deny under **Pending** in the Workbench. Change the rules under **Settings → Write Policy**.

## Why it is waiting

Each endpoint carries one of three risk tiers, and the Store's connectors come with every write endpoint tiered, whether you install the connector on its own or a Store listing installs it for you:

- **Low**: internal, reversible writes: post a message, create an issue, add a record. Runs unattended by default.
- **Medium**: external sends or hard-to-undo changes: email or SMS, merging a pull request, deleting one thing. Requires approval by default.
- **High**: financial or destructive at scale: charges, refunds, bulk or irreversible deletes. Requires approval by default.

Read-only calls are never gated. An endpoint with no tier counts as read-only for a GET request and as low for any other method.

## The card

The card shows the risk badge, the method, the host, the endpoint and the request body with secrets removed.

- **Approve**: that exact request goes out. If the agent changes the request, it asks again.
- **Deny**: the call does not run. The agent is told it was refused, with your reason if you wrote one, and does not retry it. The rest of the run carries on.

A skill's step that makes a gated write waits the same way: its run shows as paused, and the card names the skill. Approving sends the step's request; denying fails that step with your reason, and the skill goes on as it does when that step fails.

Only a person approves; the Helmsman cannot approve a write on your behalf.

## Changing the rules

On **Settings → Write Policy**, each tier offers **Default**, **Require approval** or **Run unattended**; choose **Save Changes**. Only space admins can change it. Setting High to run unattended shows a warning: do this only for a trusted, deliberately automated space.

## Other actions that ask first

On the local edition, the same card asks before the agent acts in a browser profile set to ask before acting, and before the Helmsman changes the models on this computer.`,
    editions: ['enterprise', 'community-local'],
    anchors: {
      routes: ['s/[space]/settings/write-policy', 's/[space]/chat'],
      operations: ['api.http.call'],
    },
    related: [
      'what-is-waiting-for-me',
      'connect-an-integration',
      'agent-browser',
      'run-models-locally',
    ],
    keywords: [
      'write policy',
      'risk tier',
      'approve',
      'deny',
      'gated',
      'unattended',
      'send email',
      'refund',
      'human in the loop',
      'safety',
    ],
  },
  {
    id: 'proposals-need-approval',
    theme: 'approvals',
    question: 'Why do changes from the Coach or the Helmsman need my approval?',
    summary:
      'Agents propose changes to what a space runs; a person decides. The Coach reviews completed skill runs and proposes improvements, and the Helmsman proposes new skills and integrations it drafts in chat. Each proposal waits in the Workbench, under its source, until you Ratify, Reject or Dismiss it. Its card lists who created it, its source, the reason, when, and the skill it changes. Ratifying applies the whole change or none of it. Rejecting, with a reason, tells the Coach not to keep proposing the same change. The Helmsman asks you before it ratifies anything for you.',
    body: `## Where

The **Workbench** in **Chat**, opened from the yellow indicator in the page header. Each proposal sits under a heading that names its source, such as **Coach review** or **Helmsman patch**. The Helmsman can also show a proposal in the chat itself.

## What gets proposed

A proposal names its kind, for example:

- **Workflow Refinement** or **Eval Change**: the Coach, after reviewing runs of a skill.
- **Skill Compose**: a new skill the Helmsman drafted with you.
- **Capability Binding**: an integration the Helmsman drafted.
- **Store Install**: something to install from the Store.

## Who proposed it, and why

Under its title, a card lists where the proposal came from, one field to a line:

- **Created by**: the conversation it came from, linked by its title. Without a title, the agent's role name or its id.
- **Source**: **Coach review**, **Helmsman patch**, **Composed skill**, **Capability binding**, **Operator amendment** or **Platform issue**. A patch another agent made names that agent.
- **Reason**: the reason, in the words of whoever proposed it.
- **When**: when it was proposed.
- **Target**: the skill it changes.

While a proposal is pending, the conversation that proposed it can withdraw it. The Coach can withdraw any proposal an agent made, including a Helmsman patch. No other conversation can withdraw it. A withdrawn card adds **Withdrawn by**, naming the agent that withdrew it, and the reason it gave.

## Acting on a proposal

- **Details** shows the change and any validation flags. When there are flags, **Ratify** waits until you have opened the details.
- **Ratify** applies the change. It applies completely or not at all; if applying fails, the proposal stays pending and shows the error.
- **Reject** asks why you are rejecting it. A rejected change is not proposed again in the same form.
- **Dismiss** sets it aside without that signal, so the Coach may raise the issue again.

## When a proposal is out of date

If the skill changed after the proposal was written, the card says so. **Regenerate** asks the Coach for a fresh proposal against the current version; **Apply anyway…** applies it after you review the difference.

## Why it works this way

A proposal changes what every later run does. Keeping that decision with a person means a skill changes only when someone has looked at what changes.`,
    editions: ['enterprise', 'community-local'],
    anchors: {
      routes: ['s/[space]/chat'],
      operations: ['proposal.ratify', 'proposal.reject', 'proposal.dismiss'],
    },
    related: [
      'what-is-waiting-for-me',
      'skill-evals-and-coach-proposals',
      'create-or-change-a-skill',
      'helmsman-runner-coach',
    ],
    keywords: [
      'ratify',
      'reject',
      'dismiss',
      'coach',
      'proposal',
      'staged change',
      'review',
      'regenerate',
      'stale',
    ],
  },
];
