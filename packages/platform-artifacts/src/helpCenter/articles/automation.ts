import type { HelpArticleInput } from '@aflow/schemas';

export const AUTOMATION_ARTICLES: readonly HelpArticleInput[] = [
  {
    id: 'schedule-or-trigger-a-skill',
    theme: 'automation',
    question: 'How do I run a skill on a schedule or when something happens?',
    summary:
      'Ask the Helmsman in chat, for example "run the weekly report every Monday at 9:00". It can schedule work once at a set time, on a repeating schedule in a time zone, or when another agent\'s run finishes, and it can create a webhook that starts a run whenever an outside system calls it. Everything armed this way is listed under Triggers in the sidebar, with when it runs next and when it last ran, and can be paused, resumed or deleted there. A triggered run reaches exactly what a run you start yourself reaches.',
    body: `## Where

**Triggers** in the sidebar lists everything that starts work in the current space without anybody asking: **On a schedule** and **On an event**.

## Setting one up

Ask in chat and say what should run and when. The Helmsman can arrange:

- **Once** — at a date and time up to 90 days ahead.
- **Repeating** — every day, on weekdays, weekly, monthly, hourly, or another pattern, in a time zone you name.
- **After another run** — when a given agent's run succeeds, fails, or finishes either way.
- **On a webhook** — an address an outside system calls, such as a repository host or a payment provider. Each call starts a new run. The signing secret is shown once, when the webhook is created; keep it then. Only space or tenant admins can create webhooks.

A schedule runs as the person who created it, with that person's access.

## Limits on schedules set up in chat

A schedule the Helmsman creates fires at most once a minute and stops after 50 runs. A repeating one also ends after 30 days unless it is given a different end date. A schedule that has ended shows as **expired**; ask the Helmsman for a new one, or for a later end date when you set it up.

## Reading the Triggers page

Each schedule shows its name, when it repeats, what it will ask the agent to do, when it runs next and when it last ran. **set up in chat** marks one an agent created during a conversation. A failed last run shows **Last run failed:** with the reason. Each webhook shows when it was last called.

## Pausing and removing

- **Pause** stops a schedule from firing; **Resume** starts it again.
- **Delete** removes a schedule or a webhook and cannot be undone.

Archiving a space pauses all its schedules and webhooks, and restoring it leaves them paused until you resume them.`,
    editions: ['enterprise', 'community-local'],
    anchors: {
      routes: ['s/[space]/triggers', 's/[space]/chat'],
      operations: ['agent.schedule.create', 'agent.schedule.update', 'api.webhook.upsert'],
    },
    related: ['what-is-a-skill', 'sessions-and-runs', 'run-failed-or-paused', 'what-is-a-space'],
    keywords: [
      'cron',
      'recurring',
      'daily',
      'weekly',
      'timer',
      'webhook',
      'event',
      'automation',
      'pause schedule',
      'unattended',
    ],
  },
];
