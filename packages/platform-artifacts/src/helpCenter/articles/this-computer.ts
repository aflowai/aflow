import type { HelpArticleInput } from '@aflow/schemas';

export const THIS_COMPUTER_ARTICLES: readonly HelpArticleInput[] = [
  {
    id: 'pair-this-computer',
    theme: 'this-computer',
    question: 'How do I let an agent reach a folder on my computer?',
    summary:
      'Open This Computer, press Get a code, and run the command it shows on the machine that holds the folder, from your aflow checkout. The command opens the system folder picker, then asks whether the folder may be written to and whether commands may run in it. The code lasts a few minutes, works once, and can only connect folders to that workspace. The folder then appears under Connected folders, where Disconnect removes it.',
    body: `**Where:** **This Computer** in the sidebar → **Connect a folder**

## Connect a folder

1. Press **Get a code**.
2. On the machine that holds the folder, run the command the page shows, from your aflow checkout. **Copy command** copies it:

   \`\`\`bash
   yarn workspace @aflow/aflow-executor-host connect <code>
   \`\`\`

3. The system folder picker opens. Choose the folder, then answer:
   - **Allow writing?** — off by default.
   - **Allow commands to run?** — off by default. Commands run in it cannot reach your home folder; when your own tools are installed there, the command asks whether commands may use them.
4. Keep the machine's side running with \`yarn executor:host\`, or have it start at login with \`yarn workspace @aflow/aflow-executor-host service install\`. Only one may run at a time.

The code lasts a few minutes, works once, and can connect folders to this workspace and nothing else. Over ssh, or without a window session, the command asks in text instead of opening a picker.

## What a connected folder allows

Each folder under **Connected folders** shows its grants: **read only** or **read and write**, **commands** when commands may run, and the branch prefix a repository publishes under. A git repository whose commands may run publishes only to branches under \`aflow/\`, never forced, and asks you before every push unless the command said otherwise.

A path outside a connected folder is refused. A folder is reachable only where the machine and the workspace both agree, so a workspace cannot reach a folder the machine never offered.

## Removing one

**Disconnect** removes the folder from this workspace.

## The agent's tools

Files, commands and local MCP servers are separate capabilities — **Files on this computer**, **Commands on this computer** and **Local MCP servers** — shown in the chat's **Tools & integrations** panel.`,
    editions: ['community-local'],
    anchors: {
      routes: ['s/[space]/computer'],
      operations: ['host.file.get', 'host.file.put', 'host.process.exec', 'host.binding.inspect'],
    },
    related: ['coding-agent-on-this-computer', 'agent-browser', 'local-edition-limits'],
    keywords: ['host', 'pairing', 'folder', 'binding', 'connect code', 'local files', 'repository'],
  },
  {
    id: 'coding-agent-on-this-computer',
    theme: 'this-computer',
    question: 'Can Aflow hand work to Claude Code or another coding agent on my machine?',
    summary:
      'Yes. In Aflow Local, a coding agent already installed and signed in on your paired machine, such as Claude Code or OpenCode, can be given a task over a connected repository, from chat or as a step in a skill. It works in a private clone at the repository’s current commit, so your uncommitted work is untouched, and it returns a diff to review; nothing is committed, pushed or applied. The folder must allow commands, the coding agent must be allowed on the machine, and the agent needs the Coding agents on this computer capability.',
    body: `**Where:** **This Computer** in the sidebar for the folder; the chat's **Tools & integrations** panel for the capability

## What you need

1. **A connected repository** whose commands may run — see the article on connecting a folder. It must be a git repository with at least one commit.
2. **The coding agent allowed on the machine.** Each coding agent is added on the machine itself and starts able to reach nothing. On its first run, the result names every host it was refused; allow the ones the work needs. A coding agent that keeps its sign-in in the macOS Keychain is given a command that reads it, and macOS asks for consent the first time. The commands are in the Aflow Local operator guide, under *Putting a coding agent to work*.
3. **The capability.** **Coding agents on this computer** in the chat's **Tools & integrations** panel.

## Asking for work

Ask in chat, and the Helmsman hands the task to the coding agent and reads back the result. Or make it a step in a skill, next to your APIs, sandboxed code, memory and approvals, run on demand, on a schedule or by a trigger.

## What comes back

The work happens in a private clone of the repository, so your uncommitted work is untouched and two runs cannot collide. The result is a diff to review, and says whether it still applies to the repository. Given a declared shape, the answer is validated, and a run that ends without one fails.

## Publishing

A change reaches a branch under the folder's prefix, \`aflow/\` by default, and the folder's setting under **Connected folders** says whether a push asks you first.

## Merging

The pull requests the loop opens are yours to merge, unless the folder's merge posture says otherwise. Set to \`when-green\` on the machine that holds the folder — the command is in the Aflow Local operator guide, beside the push setting's — the Local PR Shepherd merges a pull request by squash once every check its base branch requires has passed on its head, the review of the publication that pushed that head approved it, no person's review requests changes, and GitHub says the head merges into its base — while GitHub has not worked that out yet, the shepherd reads the pull request again on its next pass rather than ask. A draft is not merged until you mark it ready for review. Each merge still asks your approval of exactly that request, in the Action Center; decline it and that head is not asked about again until a push moves it. When GitHub refuses a merge only because another pull request merged into the base first, the shepherd sends it once more; if GitHub refuses again, its next pass asks you again for the same head. \`when-green\` needs the push setting \`unless-unreviewed\`, the one under which a publication reviews what it pushes. **Connected folders** shows each folder's merge posture under its push setting.

The Local PR Shepherd fixes a red check only so many times on one pull request — three unless you set its attempt budget. When CI fails again after that, it stops: its comment on the pull request says why, and one item in the Action Center asks you to take the pull request over. Answering the item changes nothing; push to the branch to have the shepherd read the new head, or label the pull request \`hands-off\` to have it left alone. When CI stays red on a check the shepherd already acted on and the base branch has moved since, it merges the base into the branch and publishes it through Local Publish, within the same attempt budget. It also waits, touching nothing, while work on the branch is under way — a publication or commission of the branch, or any run serving the plan step the pull request belongs to, whoever started it — and its comment says which.

When a pass ends on something its rules cannot act on — GitHub refused a merge for a reason other than a base that moved, the head conflicts with its base on a pull request the shepherd would merge, GitHub holds more reviews or check runs than the one page a pass reads, or the GitHub connection has not been able to list the repository's pull requests for fifteen minutes — the shepherd hands it to the Helmsman: a new conversation starts with what the pass read, what it decided and why, and what was tried before, and the Helmsman decides what to do with the skills it has — commission a merge of the base, publish it, or tell you what only you can do. A read GitHub did not answer once is read again on the next pass, and a draft, or a folder whose merges are yours, stays with you. Each case is handed over once: once per head of a pull request and per case, so a push, or a different problem on the same head, is a new case; and once for a repository that cannot be listed, until the shepherd lists its pull requests again.

## A stream that continues itself

Work kept in the space's plan can carry on without you starting each round. Ask the Helmsman to continue a stream on a schedule, naming the stream and how often; both are yours to choose and to change on the schedule. Each time it fires, the Helmsman reads where the stream stands before it acts. While a commission or publication of the stream's current step is running or waiting on you, or its pull request is open, it waits and changes nothing. Once that pull request merges, it records the merge on the step and starts the next one. A pull request closed without merging, a push you declined, or a step whose commission failed more often than its attempts allow — two unless you name another number — stops the stream there: the step is marked blocked with the reason in its note, and nothing after it starts until you move it on. A step of kind **decide** holds the stream the same way until you answer it, and starts no work of its own. A schedule fires at most 50 times; ask again to renew it. **Plan** in the sidebar shows the stream's steps as a board: which is done, which needs you, and the runs under way for each — and moves a stream on without asking the Helmsman: open the step it stopped on and **Mark done** or **Drop** it, or **Decide** a decision, and the next firing passes on to the step after it.

## While it runs

The machine is kept awake on power while a run is in flight. Work dispatched while it sleeps waits up to ten minutes for it to wake.`,
    editions: ['community-local'],
    anchors: { routes: ['s/[space]/computer'], operations: ['host.harness.run'] },
    related: ['pair-this-computer', 'agent-browser', 'what-is-a-skill', 'local-edition-limits'],
    keywords: [
      'claude code',
      'opencode',
      'diff',
      'branch',
      'pull request',
      'code change',
      'merge',
      'pr shepherd',
      'plan stream',
    ],
  },
  {
    id: 'agent-browser',
    theme: 'this-computer',
    question: 'How does the agent use a browser, and how do I control what it can do?',
    summary:
      'An agent can open and use web pages in a Chrome profile of its own on your paired machine, signed in to the sites you choose. Under This Computer → Browser, Sign in to sites opens the profile’s window so you can sign in. Each profile has a posture — autonomous, ask-to-act or read-only — origin rules that allow, ask or deny per site, a choice whether runs nobody is present for may use it, and the local ports its pages may load. Ask-to-act sends every action to the Workbench for approval.',
    body: `**Where:** **This Computer** in the sidebar → **Browser**

The agent's own browser on this machine. It reaches the sites you sign in to there, and nothing of your everyday browser. It needs a supported Chrome on the machine.

## Signing in

**Sign in to sites** opens the profile's window on the machine. Sign in to every site the agent should reach, in as many tabs as you like, then close it. Runs using the profile wait until you do. While its browser runs, the card lists the sites that hold a session.

## Posture

- **autonomous** — navigates, reads and acts without asking.
- **ask-to-act** — navigates and reads; every action waits for your approval in the Workbench.
- **read-only** — navigates and reads; every action is refused.

## Origin rules

A rule names one origin, such as \`https://mail.example.com\`, or a host with a leading wildcard, such as \`*.example.com\`, and sets **allow**, **ask** or **deny** over the posture. **deny** also refuses every connection to that host. Where several rules match, the most restrictive one holds.

## Runs nobody is present for

**Open to runs nobody is present for** decides whether a run set going by a schedule, a webhook, a timer, or an API or MCP client may use the profile. A run a person started may use it either way.

## Local ports

**Open port** lets the profile's pages load a dev server on this machine at \`localhost\`, \`127.0.0.1\` or \`[::1]\` on that port alone. The ports Aflow itself serves on stay refused, whatever the list says.

## Who can change it

Only a person: no agent operation changes a profile, and API keys and MCP sessions are refused. The agent's tools are the **Browser** capability in the chat's **Tools & integrations** panel.`,
    editions: ['community-local'],
    anchors: {
      routes: ['s/[space]/computer'],
      operations: ['browser.page.open', 'browser.page.act', 'browser.profile.list'],
    },
    related: [
      'pair-this-computer',
      'what-is-waiting-for-me',
      'write-approval',
      'schedule-or-trigger-a-skill',
    ],
    keywords: ['chrome', 'web', 'sign in', 'posture', 'origin', 'unattended', 'localhost'],
  },
];
