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

A folder whose commands may run can also declare its preview — how its project is served, so a change to its UI can be seen working; see the article on declaring a folder's preview. Its card shows the preview, or **Preview not declared** where the folder holds a web app and declares none.

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
    related: [
      'coding-agent-on-this-computer',
      'agent-browser',
      'folder-preview',
      'local-edition-limits',
    ],
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

Install **Coding Loop** from the Store once for Commission Change, Review Local Changes, Publish Local Changes, the Local PR Shepherd skill and agent, and the GitHub connector definition. They install and update as one version. Uninstall removes the combined installation, including separately installed loop parts; skills claimed by other installations stay installed. Installing the bundle keeps existing parts and customizations. When updating separate parts to Coding Loop, **Keep mine** leaves their content and records the offered version as skipped; **Replace with Store version** replaces customized workflows with the Store versions.

The install, the Coding Loop listing, **Check setup again** and — in a space made from **Coding with GitHub** — the help page list the same items, each with its state and where it changes:

- **Pair this machine** under **This Computer**. **Broken** when the machine holding the space's folders is no longer running its executor.
- **Connect the repository's folder** allowing commands and pushes under a branch prefix, with a merge posture: \`aflow connect <code> --write --run --branch-prefix <prefix> --merge-posture <never|when-green>\`, run in the folder. The item shows the prefix and posture in force. If Coding Loop was installed before the folder was connected, return to its listing and choose **Repair installation**, then confirm the install to create the missing agent; existing parts and customizations are kept, including an older version retained with **Keep mine**. A Local PR Shepherd written before the folder was connected does not tend it, and the item says so.
- **Bind a GitHub credential** to the **github** connection in **Integrations**. Fine-grained permissions: Metadata and Contents read, Checks and Actions read, Pull requests and Issues write; Contents write for merges. Classic tokens need repo (public_repo for public repositories). GitHub is asked about the credential: one it refuses is **Broken**, and a classic token without repo names it.
- **Choose the coding agent** the space runs under **This Computer** — Claude Code or Codex, as installed on the machine. **Broken** when the one chosen is not installed.
- **Arm the shepherd schedule.** The item offers the schedule: every five minutes unless you name another cron, at most 50 firings, with inputTemplate \`{ "input": "tend", "config": { "scheduleId": { "$schedule": "id" } } }\`, which lets the shepherd renew it before its firing cap. Nothing is scheduled until you arm it. Once it has expired, the item is **Broken** and recreates it from what it stored. An archived Local PR Shepherd does not satisfy readiness; restore it before arming its schedule.

**Needs setup** means a prerequisite is missing, including a disabled GitHub connection. **Broken** means something that was set up stopped working: besides the cases above, the shepherd schedule reports a dispatch error or its latest execution failed; inspect it under **Triggers**. A later successful execution clears the execution failure once its outcome is stored. Completing setup and repairing a failure are separate actions.

A change reaches a branch under the folder's prefix, \`aflow/\` by default, and the folder's setting under **Connected folders** says whether a push asks you first.

## Merging

The pull requests the loop opens are yours to merge, unless the folder's merge posture says otherwise. Set to \`when-green\` on the machine that holds the folder — the command is in the Aflow Local operator guide, beside the push setting's — the Local PR Shepherd merges a pull request by squash once every check its base branch requires has passed on its head, the review of the publication that pushed that head approved it, no person's review requests changes, and GitHub says the head merges into its base — while GitHub has not worked that out yet, the shepherd reads the pull request again on its next pass rather than ask. A draft is not merged until you mark it ready for review. Each merge still asks your approval of exactly that request, in the Action Center; decline it and that head is not asked about again until a push moves it. When GitHub refuses a merge only because another pull request merged into the base first, the shepherd sends it once more; if GitHub refuses again, its next pass asks you again for the same head. \`when-green\` needs the push setting \`unless-unreviewed\`, the one under which a publication reviews what it pushes. **Connected folders** shows each folder's merge posture under its push setting.

The Local PR Shepherd fixes a red check only so many times on one pull request — three unless you set its attempt budget. When CI fails again after that, it stops: its comment on the pull request says why, and one item in the Action Center asks you to take the pull request over. Answering the item changes nothing; push to the branch to have the shepherd read the new head, or label the pull request \`hands-off\` to have it left alone. When CI stays red on a check the shepherd already acted on and the base branch has moved since, it merges the base into the branch and publishes it through Local Publish, within the same attempt budget. It also waits, touching nothing, while work on the branch is under way — a publication or commission of the branch, or any run serving the plan step the pull request belongs to, whoever started it — and its comment says which. Whichever remedy it took — a fix, a dependency bump or a merge round — goes through Local Publish; where that remedy failed, or ran and left nothing to publish, the pass waits and its comment says why. A dependency bump the machine kept from the package registry fails naming the host: allow it for the coding agent on the machine, as on its first run. A bump needs \`registry.yarnpkg.com\` and \`registry.npmjs.org\` beside each other: Yarn installs and audits through the first, npm through the second.

When a pass ends on something its rules cannot act on — GitHub refused a merge for a reason other than a base that moved, the head conflicts with its base on a pull request the shepherd would merge, GitHub holds more reviews or check runs than the one page a pass reads, or the GitHub connection has not been able to list the repository's pull requests for fifteen minutes — the shepherd hands it to the Helmsman: a new conversation starts with what the pass read, what it decided and why, and what was tried before, and the Helmsman decides what to do with the skills it has — commission a merge of the base, publish it, or tell you what only you can do. A read GitHub did not answer once is read again on the next pass, a head whose CI is still running waits for CI to finish, and a draft, a folder whose merges are yours, a merge you declined, a review requesting changes, or a publication review that did not approve the head stays with you. Each case is handed over once: once per head of a pull request and per case, so a push, or a different problem on the same head, is a new case; and once for a repository that cannot be listed, until the shepherd lists its pull requests again.

## The resident

The Helmsman can take the next approved step of your plan without you starting it. Ask it once to create the space's resident schedule: it wakes every fifteen minutes unless you name another interval, reads the whole plan in the order the plans stand on the board, and acts — records a merged pull request on its step, publishes a finished commission, stops a step that keeps failing, then starts the next approved step — at most three things a wake. A wake with nothing to do says nothing. A run it started finishing, or your **Approve**, **Reopen**, **Mark done** or **Drop** on the plan page, or your answer to a plan decision in the Action Center, wakes it straight away; while it is already awake, it wakes once more when it finishes. The order of the plans on the board is the order it works in: ask the Helmsman to move a plan up, and the resident takes it first. A step is done when its pull request merges; the resident never asks whether your folder holds the merge. A step whose runs cost at least its ceiling — $50 by default, counted since you last approved or reopened it — stops, blocked, naming the spend and its runs. Only your approval or Reopen resets that spend window; the Helmsman cannot raise the ceiling. In the plan rail, **Approve** and **Reopen** offer an optional **Spend ceiling (cents, optional)**; enter a new ceiling to raise it, or leave it blank to keep the current ceiling. A finished patch is published before a spend stop and survives approval. The coding agent it commissions runs \`open\` at most, whatever your folder allows. The schedule renews itself; pause it to pause the resident, and runs under way still finish.

## A stream that continues itself

Work kept in the space's plan can carry on without you starting each round. Ask the Helmsman to continue a stream on a schedule, naming the stream and how often; both are yours to choose and to change on the schedule. Each time it fires, the Helmsman reads where the stream stands before it acts. While a commission or publication of the stream's current step is running or waiting on you, or its pull request is open, it waits and changes nothing. Once that pull request merges, it records the merge on the step and starts the next one. A pull request closed without merging, a push you declined, or a step whose commission failed more often than its attempts allow — two unless you name another number — stops the stream there: the step is marked blocked with the reason in its note, and nothing after it starts until you move it on. A step of kind **decide** holds the stream the same way until you answer it, and starts no work of its own. A schedule fires at most 50 times; ask again to renew it. **Plan** in the sidebar shows the stream's steps as a board: which is done, which needs you, and the runs under way for each — and moves a stream on without asking the Helmsman: open the step it stopped on and **Approve**, **Mark done** or **Drop** it, or **Decide** a decision, and the next firing takes it from there.

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
    id: 'driving-work-through-the-loop',
    theme: 'this-computer',
    question: 'How do I drive changes to my repository through the coding loop?',
    summary:
      'Keep one Helmsman conversation per stream of work, each stream on a node of the space’s plan. A round commissions the coding agent on the connected folder, reviews what it made, and publishes it as a pull request through the github connection; the Local PR Shepherd then tends the pull request until it merges or a person takes it over. The folder’s merge posture decides who merges, and a pull request labelled hands-off is left alone.',
    body: `**Where:** a space made from **Coding with GitHub**, or any space with **Coding Loop** installed — the chat for the Helmsman, **Plan** in the sidebar for the board

A change to your repository can be built by the space itself: the Helmsman commissions the coding agent on your machine, **Review Local Changes** reads what it made, and **Publish Local Changes** commits, scans, pushes and opens the pull request. This is the protocol that keeps several streams of work from taking each other's work down.

## Before the first round

The space lists what it still needs on its Store listing and on this help page, each item with its state and where it changes: a paired machine, the repository's folder connected with a branch prefix and a merge posture, a GitHub credential on the github connection, the coding agent the space runs, and the shepherd's schedule. Work through it until every item reads done.

## One conversation per stream

Each stream of work is one Helmsman conversation, kept on a node of the space's plan. A second stream starts a conversation of its own in the same space; it never posts into another stream's conversation and never cancels another stream's runs. **Plan** in the sidebar shows every stream as a board: which step is done, which waits on you, and the runs under way for each.

A conversation told only which stream to continue reads its node first — its goal and criteria, what is linked to it, and what is in flight under it — and briefs the round from there. When the round ends, it records where the node stands, and marks the node done only with the outcome that met its criteria. What a round taught that the next one should know is recorded on the node too.

## A round

1. **Commission.** The Helmsman starts **Commission Change** on the connected folder without waiting on it, briefed with each finding: the file, the line where it is known, what is wrong, what right looks like, and the tests to add. The coding agent works in a private checkout, so your uncommitted work is untouched, and returns a change with a title and a paragraph describing it.
2. **Review.** Publishing reviews the commit first: **Review Local Changes** reads the range and names every finding with its file and line. How deep it reads follows the change: deep where it touches the schemas, the orchestrator, the host executor or a database migration, however small; brief for documentation and tests alone, or under 30 changed lines; standard otherwise. A review that ends without a result is run once more before the publication asks you.
3. **Publish.** **Publish Local Changes** commits the change under the commission's summary, runs the folder's own checks where it declares them, scans for secrets, and decides by rule: a review short of approval, or one that approved over a real finding on the slice's first round, is a fix round on the same branch, pushed nothing; otherwise it pushes and opens or updates the pull request. A fix round commissions the fix onto the branch and publishes the branch again.
4. **Merge.** Under the folder's merge posture **never**, the default, you merge. Under **when-green** the Local PR Shepherd merges by squash once the checks the base branch requires pass on the head, the review approved that head and no person requests changes — each merge on your approval in the Action Center.

Approve a push only once the review is in: an approval given early pushes a commit the review may still send back.

## The shepherd

On its schedule, the **Local PR Shepherd** tends the pull requests the loop opened, one per pass. It fixes a red check by commissioning the fix on the branch and publishing it, within an attempt budget; when CI fails again after that, it stops, says why on the pull request, and asks you to take it over in the Action Center. It waits, touching nothing, while a publication or commission of the branch is under way. The schedule renews itself before its firing cap; once it has expired, the space's checklist recreates it from what it stored.

## Hands off

Label a pull request **hands-off** to have the shepherd leave it alone — while you work on it yourself, or have a fix in hand. Nothing is pushed to an open pull request outside the loop without your word, and a fix to a pull request is one more round on its branch rather than a new pull request.`,
    editions: ['community-local'],
    anchors: {
      routes: ['s/[space]/plan', 's/[space]/computer'],
      operations: [
        'plan.node.get',
        'plan.node.update',
        'workflow.run.start',
        'workflow.run.detail',
      ],
    },
    related: ['coding-agent-on-this-computer', 'pair-this-computer'],
    keywords: [
      'coding loop',
      'commission',
      'review',
      'publish',
      'pull request',
      'shepherd',
      'hands-off',
      'plan',
      'stream',
      'github',
    ],
  },
  {
    id: 'folder-preview',
    theme: 'this-computer',
    question: 'How do I tell Aflow how my project is served, so a UI change can be seen working?',
    summary:
      'Declare the folder’s preview once, under This Computer → Connected folders with Declare preview, or on the machine with aflow folder <bindingId> preview --command "<command>". It records the command that serves the project from a checkout, with {port} where its port goes; a fixed port if the project cannot be told one; the path that answers once it is up, / by default; and the files that make up its UI, by default every tsx, jsx, vue, svelte, astro, html, css, scss and less file and everything under each web app directory you name. A port Aflow itself serves on is refused. Only a person can declare it, and declaring it starts nothing: a coding agent run that asks for the preview has Aflow start it from a copy of that run’s checkout taken as the run begins — the commit the run started from, never the agent’s own edits, which the review sees — open it in that run’s browser alone, and stop it when the run ends. Where the folder has a web app and declares no preview, its card says Preview not declared.',
    body: `**Where:** **This Computer** in the sidebar → **Connected folders** → a folder's **Declare preview** or **Change preview**; or the \`folder\` command on the machine

A connected folder can be any project, so Aflow does not guess how it is served: you say so once, per folder. The declaration lives in the machine's own policy, beside the folder's other settings.

## What you declare

- **Command** — what serves the project, run from the root of a checkout: \`yarn dev --port {port}\`, \`npm run dev -- --port {port}\`, or whatever your project runs. \`{port}\` is replaced with the port it is to listen on.
- **Port** — leave it empty and each run takes a free port, passed to the command as \`{port}\`; without one the command must contain \`{port}\`. Fix a port only for a project that cannot be told one: a fixed port serves one run at a time. A port Aflow itself serves on — the API, the web app, the MCP server, Redis, Postgres — is refused, because a page from it could approve the agent's own requests.
- **Ready path** — the path that answers once the project is up, such as \`/health\`. \`/\` by default. It is a path on the project itself: one leading \`/\`, no second \`/\` straight after it, no backslash and no spaces.
- **UI paths** — globs naming the files that make up the UI, one per line; a change touching one is a UI change. Empty, every file ending in \`tsx\`, \`jsx\`, \`vue\`, \`svelte\`, \`astro\`, \`html\`, \`css\`, \`scss\` or \`less\`, and everything under each web app directory. Given, they replace that default whole.
- **Web app directories** — directories of the folder, such as \`apps/web\`, whose every file counts as UI in the default.

Defaults are read each time, never written in, so a folder that left one empty follows the default as it changes. **Saving replaces the declaration before; Clear preview removes it.** Declaring a preview starts nothing.

## When it runs

Nobody has to ask for it. Commission Change asks for the preview, with a throwaway browser, when its brief names one of the folder's UI files or the branch it continues already changes one; Review Local Changes asks when the range it reviews changes one, opens the changed pages there and reports what it saw as part of its verdict. Where the folder declares no preview, or the browser cannot be had, they run without one and say so in their result: "UI change not seen in a browser: the folder declares no preview", with the command that declares it. A commission whose run changed a UI file without the preview names that file too. The same holds where the preview they asked for cannot be had when the run starts — its fixed port held by another run or in use, or it never answers: they run on without the preview and its browser, and the result says what happened to it.

A coding agent run that asks for the preview — with the agent's own throwaway browser — has Aflow start it, never the agent: from a copy of that run's checkout taken before the agent starts, with the folder's installed dependencies, on the run's port. Aflow waits up to two minutes for the ready path to answer, on IPv4 or IPv6 loopback, then opens the preview in that run's browser alone and hands the agent its address. When the run ends, however it ends — failed runs included — the preview is stopped, and what it printed is kept with the run. A preview that never answers fails a run that asked for it itself, quoting the command and the last lines it printed; a run Commission Change or Review Local Changes gave it goes on without it instead.

The preview runs as you, with your reach, outside the sandbox the coding agent and the folder's checks run in — a deliberate step, not an oversight. That sandbox cannot listen on loopback on macOS, so a preview inside it could not serve at all; and the agents in the loop already act as you do — they push with your git, in your folder, on your machine — so holding the preview to a stricter posture would only add friction to the review. It is your command, and nothing an agent sends can change it. It never runs in the checkout the agent edits: the copy it runs in holds the commit the run started from, so nothing the agent writes during the run is executed by it, and no agent sees its own uncommitted edits in it. A coding agent making a change sees the app as it was before it; the change is seen working by the review that reads it, whose copy holds the committed change — which the preview runs as you. It is given none of the agent's credentials. A fixed port serves one run at a time: a run that finds it held by another run, or by anything else, is refused at once — naming the holding run when it is in your workspace — start it again once that run has ended.

## On the machine

\`\`\`bash
yarn workspace @aflow/aflow-executor-host folder <bindingId> preview --command "yarn dev --port {port}"
yarn workspace @aflow/aflow-executor-host folder <bindingId> preview --port 4321 --command "yarn dev" --ready /health --ui "src/**/*.tsx" --web-app apps/web
yarn workspace @aflow/aflow-executor-host folder <bindingId> preview          # print it
yarn workspace @aflow/aflow-executor-host folder <bindingId> preview --clear
\`\`\`

\`--ui\` and \`--web-app\` repeat, one glob or directory each. The folder must allow commands, since a preview is one.

## Preview not declared

Where a folder declares no preview, the machine looks for a web app in it: a \`package.json\` at its root, or one level under \`apps/\` or \`packages/\`, that depends on Next.js, Vite, Svelte, SvelteKit, Astro, Vue, Nuxt, React or Angular, or an \`index.html\` at its root. When it finds one, the folder's card says **Preview not declared** and where it looked. The finding only decides that line: nothing is run from it, and it does not fill in web app directories for you.

## Who can declare it

Only a person: no agent operation declares a preview, and API keys and MCP sessions are refused.`,
    editions: ['community-local'],
    anchors: { routes: ['s/[space]/computer'] },
    related: ['pair-this-computer', 'driving-work-through-the-loop', 'agent-browser'],
    keywords: ['preview', 'dev server', 'ui change', 'port', 'web app', 'ui paths', 'ready path'],
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
