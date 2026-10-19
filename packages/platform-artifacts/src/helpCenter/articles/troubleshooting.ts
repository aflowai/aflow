import type { HelpArticleInput } from '@aflow/schemas';

export const TROUBLESHOOTING_ARTICLES: readonly HelpArticleInput[] = [
  {
    id: 'run-failed-or-paused',
    theme: 'troubleshooting',
    question: 'A run failed or seems stuck. How do I find out why and get it going again?',
    summary:
      "When a conversation fails, the chat shows the error and the step it happened in, with Retry, New run and Inspect; Inspect opens the session timeline, where every step and its result is listed. A run that is paused is usually waiting for you: an approval, an answer, or a missing connection, each shown as an item in the Workbench or as an Approve or Submit row on the run's page. A conversation marked Idle has finished its turn and waits for your next message. For a skill, the Runs tab lists every run with its status; Open shows which task failed or is waiting.",
    body: `## A conversation failed

The chat ends with a card showing the error and, when known, **Step:** with the step that failed.

- **Retry** runs the failed session again.
- **New run** starts a fresh conversation.
- **Inspect** opens the inspector; **Session timeline** lists every step with its result.

If the error is about a model key, a banner above the composer names the provider: add the key, or choose a model from a provider you already have.

## A run is paused

A paused run is usually waiting for a person. Look for:

- An item in the **Workbench** under **Needs attention**: an approval for a write, a question, or a proposal.
- On the skill run's page, a task marked **Paused — action expected**, with **Approve** or **Submit** in place.
- A skill that starts with a connection missing pauses at the beginning; complete the setup it names.

Once you answer, the run continues.

An approval or question must be resolved on its task; acknowledging the run cannot answer it. If the run reports that its resume contract is unavailable, it stays paused. Ask the Helmsman to inspect the pause before trying to resume it again.

## A conversation says Idle

**Idle** means the Helmsman has answered and is waiting for your next message. Nothing is stuck.

## A skill run failed or will not move

1. Open **Skills**, select the skill, and choose **Runs**.
2. **Open** on the run shows each task with its status; **View execution** shows what a task did. **Session** opens **Run Details** for the steps underneath.
3. While a run is in progress, the run page offers **Pause**, **Resume** and **Cancel**.

**Run Details** marks a run that waits on a finished sub-run as **Stuck — parent waiting on a terminal child**.

## Ask the Helmsman

In the same space, ask the Helmsman what happened to a run. It can read the run's steps and errors and say what to change.

## A bar says your session needs renewing

That bar is about your sign-in to the app, not a run. When it offers **Sign in again**, use it.`,
    editions: ['enterprise', 'community-local'],
    anchors: {
      routes: [
        's/[space]/chat',
        's/[space]/skills',
        's/[space]/runs/[runId]',
        's/[space]/sessions/[sessionId]',
      ],
      operations: ['workflow.run.detail'],
    },
    related: [
      'sessions-and-runs',
      'what-is-waiting-for-me',
      'write-approval',
      'skill-needs-setup',
      'no-key-resolves-model',
    ],
    keywords: [
      'error',
      'failed',
      'stuck',
      'paused',
      'idle',
      'stalled',
      'retry',
      'cancel',
      'not working',
      'debug',
    ],
  },
];
