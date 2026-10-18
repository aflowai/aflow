import type { HelpArticleInput } from '@aflow/schemas';

export const APPROVALS_ARTICLES: readonly HelpArticleInput[] = [
  {
    id: 'action-center',
    theme: 'approvals',
    question: 'What is the Action Center, and where do I find what is waiting for me?',
    summary:
      'The Action Center collects everything in a space that needs a person: approvals for writes and other actions, questions a run is waiting on, account sign-ins an integration needs, and proposals from the Coach. The bell at the top of each page shows how many items are pending; choosing it opens the chat with the Workbench, where Needs attention lists what is blocking work and the Coach section lists proposals. Work that waits on an item stays paused until it is answered.',
    body: `## Where

The bell at the top of each page in a space. Its label reads **Action Center — N pending**. Choosing it opens **Chat** with the **Workbench**.

## What appears

**Needs attention** holds items that are blocking work now:

- **Approvals**: a write the agent wants to make, an approval a skill asks for as one of its steps, or another action that asks first. A write approval card has **Approve**, **Deny** and an optional reason.
- **Inputs**: a question a run is waiting for you to answer.
- **Connections**: a **Connect** or **Reconnect** card when an integration needs you to sign in with an account, or a sign-in has expired.

The **Coach** section holds proposals: changes the Coach, or the Helmsman, wants to make to skills, evaluations or integrations. These do not block a run; they wait for you to **Ratify**, **Reject** or **Dismiss** them.

The Helmsman can also bring an item into the chat itself, so you can answer it where you are talking.

## When an item names someone else

A request addressed to another person stays visible, says who it is waiting on, and is not counted in your total. It can be handed to someone else from the card.

## What happens after you answer

The work that was waiting on the item continues from where it stopped; nothing needs to be restarted. Needs attention is hidden when nothing is pending.`,
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
      'bell',
      'inbox',
      'pending',
      'notifications',
      'needs attention',
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
      'Every endpoint of an API integration carries a risk tier. Before the agent makes a write call, the space checks that tier against its Write Policy: by default, low-risk writes run unattended, while medium-risk writes (external sends, hard-to-undo changes) and high-risk writes (money movement, destructive changes at scale) wait for a person to approve them in the Action Center. Nothing is sent until you approve. Denying stops that call and tells the agent why. Space admins change the defaults per tier under Settings → Write Policy.',
    body: `## Where

Approve or deny under **Needs attention** in the Action Center. Change the rules under **Settings → Write Policy**.

## Why it is waiting

Each endpoint carries one of three risk tiers, and the Store's connectors come with every write endpoint tiered:

- **Low**: internal, reversible writes: post a message, create an issue, add a record. Runs unattended by default.
- **Medium**: external sends or hard-to-undo changes: email or SMS, merging a pull request, deleting one thing. Requires approval by default.
- **High**: financial or destructive at scale: charges, refunds, bulk or irreversible deletes. Requires approval by default.

Read-only calls are never gated. An endpoint with no tier counts as read-only for a GET request and as low for any other method.

## The card

The card shows the risk badge, the method, the host, the endpoint and the request body with secrets removed.

- **Approve**: that exact request goes out. If the agent changes the request, it asks again.
- **Deny**: the call does not run. The agent is told it was refused, with your reason if you wrote one, and does not retry it. The rest of the run carries on.

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
    related: ['action-center', 'connect-an-integration', 'agent-browser', 'run-models-locally'],
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
      'Agents propose changes to what a space runs; a person decides. The Coach reviews completed skill runs and proposes improvements, and the Helmsman proposes new skills and integrations it drafts in chat. Each proposal waits in the Coach section of the Workbench until you Ratify, Reject or Dismiss it. Ratifying applies the whole change or none of it. Rejecting, with a reason, tells the Coach not to keep proposing the same change. The Helmsman asks you before it ratifies anything for you.',
    body: `## Where

The **Coach** section of the **Workbench** in **Chat**, opened from the Action Center bell. The Helmsman can also show a proposal in the chat itself.

## What gets proposed

A proposal names its kind, for example:

- **Workflow Refinement** or **Eval Change**: the Coach, after reviewing runs of a skill.
- **Skill Compose**: a new skill the Helmsman drafted with you.
- **Capability Binding**: an integration the Helmsman drafted.
- **Store Install**: something to install from the Store.

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
      'action-center',
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
