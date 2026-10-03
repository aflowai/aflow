/**
 * The host lane's operations as the catalog registers them. Their schemas are in
 * `host.ts`.
 */
import type { OperationRegistration } from '../catalog/operationCatalog.js';
import {
  HOST_HARNESS_CONCURRENCY_DEFAULT,
  HostBindingInspectInputSchema,
  HostBindingInspectOutputSchema,
  HostCommitCheckInputSchema,
  HostCommitCheckOutputSchema,
  HostCommitScanInputSchema,
  HostCommitScanOutputSchema,
  HostFileGetInputSchema,
  HostFileGetOutputSchema,
  HostFileListInputSchema,
  HostFileListOutputSchema,
  HostFilePatchInputSchema,
  HostFilePatchOutputSchema,
  HostFilePutInputSchema,
  HostFilePutOutputSchema,
  HostHarnessRunInputSchema,
  HostHarnessRunOutputSchema,
  HostMcpCallInputSchema,
  HostMcpCallOutputSchema,
  HostMcpListToolsInputSchema,
  HostMcpListToolsOutputSchema,
  HostProcessExecInputSchema,
  HostProcessExecOutputSchema,
  HostProcessInputInputSchema,
  HostProcessInputOutputSchema,
  HostProcessInspectInputSchema,
  HostProcessInspectOutputSchema,
  HostProcessStopInputSchema,
  HostProcessStopOutputSchema,
} from './host.js';

export const HostOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'host',
    group: 'file',
    verb: 'list',
    name: 'List Host Files',
    actionLabel: 'Listing files…',
    groupDisplayName: 'Host files',
    groupDescription:
      'Read and write files in a folder the operator connected, in place on their machine.',
    semanticDescription:
      'List entries inside a folder the operator connected through a host binding. ' +
      'Reads the live filesystem — not a Memory snapshot — so it reflects what the ' +
      'operator sees in their own file browser. Needs no execution authority: a ' +
      'file-only binding grants this without granting a shell.',
    tags: ['host', 'files', 'local'],
    idempotency: 'idempotent',
    accessMode: 'read',
    usage: {
      oneLine: 'List files in a connected folder on the operator machine.',
      minimalExampleInput: { bindingId: 'hb_project', path: 'src' },
      whenToUse: [
        'Discovering what is in a folder the operator connected before reading specific files',
        'Checking whether a file the workflow expects to exist is present',
      ],
      whenNotToUse: [
        'Searching Memory documents — that is memory.store, a different store with different authority',
        'Reading file contents — use host.file.get once the path is known',
      ],
      pitfalls: [
        'Paths are relative to the binding root. An absolute path or a `..` segment is refused, not resolved.',
        'A binding may be read-only; listing it says nothing about whether writes are permitted.',
      ],
    },
    inputZod: HostFileListInputSchema,
    outputZod: HostFileListOutputSchema,
  },
  {
    stepType: 'host',
    group: 'file',
    verb: 'get',
    name: 'Read Host File',
    actionLabel: 'Reading file…',
    semanticDescription:
      'Read one file from a connected folder on the operator machine. Returns a revision ' +
      'alongside the content; pass that revision to host.file.put so a change made in the ' +
      "operator's editor between read and write is reported as a conflict rather than lost.",
    tags: ['host', 'files', 'local'],
    idempotency: 'idempotent',
    accessMode: 'read',
    usage: {
      oneLine: 'Read a file from a connected folder, with the revision needed to write it back.',
      minimalExampleInput: { bindingId: 'hb_project', path: 'README.md' },
      whenToUse: [
        'Reading a config, source file or dataset the operator connected',
        'Getting the current revision before proposing a change to that file',
      ],
      whenNotToUse: [
        'Reading a file larger than the cap — raise maxBytes deliberately or work through a payload',
      ],
      pitfalls: [
        'The revision is only meaningful to host.file.put on the same binding; it is a content hash, not a version number.',
        'A file over maxBytes is refused rather than truncated. Raise the cap deliberately; there is no partial read.',
      ],
    },
    inputZod: HostFileGetInputSchema,
    outputZod: HostFileGetOutputSchema,
  },
  {
    stepType: 'host',
    group: 'file',
    verb: 'put',
    name: 'Write Host File',
    actionLabel: 'Writing file…',
    semanticDescription:
      'Write one file into a connected folder on the operator machine, in place, so their ' +
      'editor and other applications see it immediately. Requires a binding that grants ' +
      'writes. Supply expectedRevision from host.file.get to replace an existing file; omit ' +
      'it to create a file that must not already exist. A mismatch writes nothing.',
    tags: ['host', 'files', 'local'],
    idempotency: 'non_idempotent',
    mutates: true,
    accessMode: 'write',
    usage: {
      oneLine: 'Write a file into a connected folder, conflict-checked against its revision.',
      minimalExampleInput: {
        bindingId: 'hb_project',
        path: 'notes.md',
        content: '# Notes\n',
      },
      whenToUse: [
        'Writing content the operator gave verbatim, or content that one file already read fully determines',
        'Saving a result where the operator asked for it, in their own folder',
      ],
      whenNotToUse: [
        "Any change that needs the folder's or the repository's facts read or judged, however small — that is host.harness.run",
        'An edit spanning more than one file — that is host.harness.run, in one task',
        'Writing somewhere the operator did not connect — a binding cannot be widened by an operation',
        'Storing durable platform state — that is Memory, not the operator filesystem',
      ],
      pitfalls: [
        'A note needing facts the caller does not hold — which account, which script, what a module does — is not a small change, whatever its length.',
        "Composing from more than the one file read is the harness's task; read-then-write covers exactly one file.",
        'Omitting expectedRevision means create-only. It is not a blind overwrite, because the operator is a second writer and last-write-wins loses their work.',
        'A read-only binding refuses this operation; that is the binding, not the path.',
      ],
    },
    inputZod: HostFilePutInputSchema,
    outputZod: HostFilePutOutputSchema,
  },
  {
    stepType: 'host',
    group: 'file',
    verb: 'patch',
    inputZod: HostFilePatchInputSchema,
    outputZod: HostFilePatchOutputSchema,
    name: 'Apply a Patch on Host',
    actionLabel: 'Applying patch…',
    semanticDescription:
      'Take a diff into a connected folder — the change a coding harness produced, once ' +
      'someone has decided to keep it. Applies whole or not at all: a diff that no longer ' +
      'fits leaves the folder exactly as it was and says what it could not place. With ' +
      '`commit` it lands as a commit instead — on a new branch, or appended to the branch ' +
      'it was made on — leaving the working tree as it was. Nothing here pushes; what ' +
      'becomes of the change stays with the operator.',
    tags: ['host', 'file', 'patch', 'local'],
    idempotency: 'non_idempotent',
    mutates: true,
    accessMode: 'write',
    usage: {
      oneLine: 'Apply a diff to a connected folder, whole or not at all.',
      minimalExampleInput: {
        bindingId: 'hb_project',
        patchRef: 'gs://aflow-payloads/tenants/t_1/runs/r_1/steps/s_1/attempt/1/patch.json',
      },
      whenToUse: [
        'Keeping the change a `host.harness.run` produced, after it has been reviewed — the check that follows a delegation. Pass its `patchRef`',
        'Reapplying a diff that was held while something else moved',
        'Preparing a publication: with `commit`, the diff lands as a commit on a new branch and the working tree is left alone',
        'A patch made from a commission that started at a branch lands on that branch when `commit.branch` names it and `commit.baseSha` is the `baseSha` the commission reported; a fresh branch is created at that `baseSha`, so a commission started from a remote publishes without the folder pulling first',
        'A fix to a branch its base has moved past is commissioned with `mergeFrom: origin/<base>` and published with the sha the commission reported in `merge.from` as `commit.mergeFrom`; the branch then carries one merge commit holding the fix',
      ],
      whenNotToUse: [
        'Authoring a change here; a diff is something a harness produced and someone read, never something written for this call',
        'Writing one known file — that is host.file.put, which needs no diff',
        'Publishing the result; a commit is as far as this reaches, and pushing is a command the folder allows or does not',
      ],
      pitfalls: [
        "The review is the caller's, and the diff is applied whole or not at all — there is no keeping only the part that was read.",
        "A commission's change goes in as its `patchRef`, never as its `patch` text: that copy is for reading and is cut short on a large diff. `patch` is for a diff the operator hands over.",
        'Without `commit` the patch changes the working tree in place, where the operator is a second writer.',
        'A diff whose base has moved fails in `clean` mode rather than applying approximately. That is the point.',
        '`merge` can leave conflict markers in the working tree. The files carrying them come back in `conflicts`.',
        'Paths inside a repository `.git` are refused, whatever the diff says.',
        'An existing branch is appended to only when `commit.baseSha` is its head. A branch that moved since the commission started refuses the append rather than merging it — commission the fix again from the branch.',
      ],
    },
  },
  {
    stepType: 'host',
    group: 'process',
    verb: 'input',
    inputZod: HostProcessInputInputSchema,
    outputZod: HostProcessInputOutputSchema,
    name: 'Answer a Running Process',
    actionLabel: 'Sending input…',
    semanticDescription:
      'Write to the standard input of a process this run started and left running. ' +
      'For a command that asks something, or a session that takes a line at a time. ' +
      'Only the run that started a process can address it.',
    tags: ['host', 'process', 'terminal', 'local'],
    idempotency: 'non_idempotent',
    mutates: true,
    accessMode: 'write',
    usage: {
      oneLine: 'Send text to the standard input of a detached process this run started.',
      minimalExampleInput: { bindingId: 'hb_project', processId: 'hp_x', input: 'yes\n' },
      whenToUse: [
        'Answering a prompt from a command started with `detach`',
        'Driving a REPL or an interactive tool a line at a time',
      ],
      whenNotToUse: [
        'A command that takes its input as arguments — pass them in `command` instead',
        'A process another run started; handles are not shared and will read as unknown',
      ],
      pitfalls: [
        'Nothing is appended. A process reading lines waits until the text carries a newline.',
        'A process that already exited reports `exited` rather than failing; the text is discarded.',
      ],
    },
  },
  {
    stepType: 'host',
    group: 'mcp',
    verb: 'list_tools',
    inputZod: HostMcpListToolsInputSchema,
    outputZod: HostMcpListToolsOutputSchema,
    name: 'List Tools of a Local MCP Server',
    actionLabel: 'Listing local MCP tools…',
    groupDisplayName: 'Local MCP servers',
    groupDescription:
      "Use MCP servers installed on the operator's machine, inside the boundary their binding declares.",
    semanticDescription:
      "Ask an MCP server running on the operator's own machine what it can do. Unlike a " +
      'remote server, this one has their filesystem underneath it, so what it can reach is ' +
      'the binding it runs in rather than what the server promises about itself.',
    tags: ['host', 'mcp', 'local'],
    idempotency: 'idempotent',
    mutates: false,
    accessMode: 'read',
    usage: {
      oneLine: 'Discover what a local MCP server offers.',
      minimalExampleInput: { bindingId: 'hb_project', serverId: 'sqlite' },
      whenToUse: ['Finding out what a machine-local MCP server exposes before calling it'],
      whenNotToUse: ['A server reachable over the network — that is the mcp lane'],
      pitfalls: [
        'The server runs only while the question is being answered; nothing is kept warm between calls.',
      ],
    },
  },
  {
    stepType: 'host',
    group: 'mcp',
    verb: 'call',
    inputZod: HostMcpCallInputSchema,
    outputZod: HostMcpCallOutputSchema,
    name: 'Call a Local MCP Tool',
    actionLabel: 'Calling local MCP tool…',
    semanticDescription:
      "Call a tool on an MCP server running on the operator's own machine. The server runs " +
      "inside the binding's boundary — it reaches the folder that binding names and nothing " +
      'else, enforced by the operating system rather than by the server behaving.',
    tags: ['host', 'mcp', 'local'],
    idempotency: 'non_idempotent',
    mutates: true,
    accessMode: 'write',
    usage: {
      oneLine: 'Call a tool on a local MCP server, inside its binding.',
      minimalExampleInput: {
        bindingId: 'hb_project',
        serverId: 'sqlite',
        toolName: 'query',
        arguments: { sql: 'select 1' },
      },
      whenToUse: ['Using a tool from a server the operator installed and configured locally'],
      whenNotToUse: ['A server reachable over the network — that is the mcp lane'],
      pitfalls: [
        '`isError` is the server saying the call failed. The step still succeeded; read it and decide.',
        'What the server can reach is its binding. A tool asking for more fails rather than being rewritten.',
      ],
    },
  },
  {
    stepType: 'host',
    group: 'harness',
    verb: 'run',
    inputZod: HostHarnessRunInputSchema,
    outputZod: HostHarnessRunOutputSchema,
    name: 'Run Harness on Host',
    actionLabel: 'Running harness…',
    groupDisplayName: 'Host harnesses',
    groupDescription:
      'Put an agent the operator already installed and signed in to work over a connected folder.',
    semanticDescription:
      'Delegate a whole task over the files in a connected folder to a harness installed on ' +
      "the operator's machine — the same tool they use themselves, already authenticated, " +
      'with their toolchain around it. It executes any work over those files: analysis, ' +
      'documents, data and code alike. The run happens in an isolated checkout at the ' +
      'current commit, or at the branch or commit it names, so their uncommitted work is ' +
      'untouched. A hook refuses ordinary git in that checkout when it would move the ' +
      "repository's branches or tags; a git call that names its own `core.hooksPath`, or " +
      'pushes locally into the folder, is not refused, and `refChanges` records every branch ' +
      'or tag that moved during the run, whoever moved it. Given an `outputSchema` it ' +
      'returns a validated `result`; where it changed files it returns a diff to review, ' +
      'committed, pushed and merged nowhere.',
    tags: ['host', 'harness', 'files', 'local'],
    idempotency: 'non_idempotent',
    mutates: true,
    accessMode: 'write',
    usage: {
      oneLine: 'Delegate work over a connected folder to an installed harness.',
      minimalExampleInput: {
        bindingId: 'hb_project',
        task: 'Add a test covering the empty-input case in the parser.',
      },
      whenToUse: [
        "Any change that needs the folder's facts, however small — the harness holds them and the caller does not",
        'Any task over the files in a connected folder — assessing a codebase, revising a document set, reconciling a ledger, making a code change',
        'Answering a question about a folder that needs the files read and reasoned over, with `outputSchema` naming the shape of the answer',
        'Producing a reviewable diff rather than editing the working copy in place',
        "A fix to a reviewed range starts from the branch the review covered, `base: <branch>`, so its patch is relative to that branch and lands on it; absent, the run starts from the folder's last commit",
        'A fix to a branch its base has moved past is commissioned with `mergeFrom: origin/<base>` and published with the sha the commission reported in `merge.from` as `commit.mergeFrom`; the branch then carries one merge commit holding the fix',
        'A smoke test or a brief look, with `maxTurns` naming how many turns brief means',
        "Pinning the model for a run that has a reason to — a comparison, a cost ceiling, a capability the default lacks; otherwise leave it out, and the run gets the model the operator configured for that harness on the machine, or the harness's own default when none is",
        "A change to a UI that should be seen working — the harness opens the page it changed on the dev server and checks it: `browser: { profile: 'ephemeral' }`, the default choice, which holds no sign-ins and reaches the harness's allowed domains plus the dev-server ports the operator declared for that harness on this machine",
      ],
      whenNotToUse: [
        'Running a build or a test suite — that is host.process.exec, which needs no worktree',
        'Reading one known file — that is host.file.get',
        'Folders reached over the network; this operates on one already on the machine',
      ],
      pitfalls: [
        "Send the intent and the acceptance criteria, and an `outputSchema` when the answer matters — never a draft. A draft written without the folder's facts is what the harness is here to avoid.",
        'Without `outputSchema` the run returns only a diff, and an assessment comes back as loose text. Name the shape of the answer to get one.',
        'The diff is returned, never applied. The operator decides what becomes of it.',
        'A publication takes the diff as `patchRef`, which holds all of it. `patch` is a copy for reading, cut short on a large change — never pass it on.',
        'A continued run returns the diff of the whole conversation against its original starting commit, not only the latest turn — unless it names a `base`, which continues the conversation in a fresh checkout at that base.',
        "A patch made from a `base` is relative to that base, not the folder's HEAD: publish it with the run's `baseSha`, onto the branch it started from or onto a new branch, which is created at that base.",
        'A harness only runs if the operator configured it on that machine; the id here cannot introduce one. Omitted, it resolves to the one offered machine-side — the space context lists them.',
        "The run takes the folder's `sandbox` posture, which `host.binding.inspect` shows. Under both the harness runs in the machine's sandbox and writes only its checkout, never the folder or its `.git`. `open` reaches every host but this machine; `confined` reaches only the hosts its profile allows. Under neither does it reach a server on the machine's loopback, and on macOS it cannot listen on loopback either. `blockedDomains` names every host it could not reach, and `boundaryNote` says whether that stopped the run or only narrowed it.",
        'The folder must be a git repository with at least one commit — the run needs a base to diff against.',
        `A machine runs only so many coding agents at once — the number its operator set, ${String(HOST_HARNESS_CONCURRENCY_DEFAULT)} unless they chose another. A run past it waits for one to end rather than being refused; it is scheduled, not started, while it waits, and its \`timeoutMs\` and its duration count from when it starts.`,
        'A `maxTurns` budget the task cannot meet ends the run with whatever the harness had reached, and that result is still validated against `outputSchema` — a budget too small for the task fails the step rather than returning a partial answer.',
        '`model` is spelled the way the harness spells it, not as this platform names a model in its own catalog — the harness resolves the name, and an id from the catalog is one it has never heard of.',
        "A named browser profile carries the operator's sign-ins and never reaches this machine's own servers, so it cannot open a dev server; `ephemeral` opens one only on a port the operator declared for that harness, and on none when no port is declared. A harness the machine configured without `mcpArgs` refuses a run asking for a browser, and the refusal names the command that sets them.",
        "Leaving `model` out does not guarantee the harness's own default: the run gets the model the operator configured for that harness on the machine, and the harness default only when none is configured. A run naming no model can still be refused when that configured model cannot be passed to the harness — the refusal names it.",
      ],
    },
  },
  {
    stepType: 'host',
    group: 'process',
    verb: 'exec',
    name: 'Run Command on Host',
    actionLabel: 'Running command…',
    groupDisplayName: 'Host processes',
    groupDescription: "Run the operator's own tools, inside the boundary their binding declares.",
    semanticDescription:
      "Run a command on the operator's machine, inside a binding, using the toolchain they " +
      'actually installed — their interpreter version, their virtualenv, their compilers. ' +
      'Output streams while it runs and the step completes when the process does. ' +
      'What the command may read, write and reach is the binding, enforced by the operating ' +
      'system rather than by inspecting the command; a command asking for more fails rather ' +
      'than being rewritten.',
    tags: ['host', 'process', 'terminal', 'local'],
    idempotency: 'non_idempotent',
    mutates: true,
    accessMode: 'write',
    usage: {
      oneLine: "Run a command in a connected project using the operator's installed toolchain.",
      minimalExampleInput: { bindingId: 'hb_project', command: ['npm', 'test'] },
      whenToUse: [
        'The one command that proves a delegated result — a test file, a typecheck, a build',
        'Running a build, a test suite or a script in a project the operator connected',
        'Using a CLI that only exists on their machine, or needs their login',
      ],
      whenNotToUse: [
        'Doing through a sequence of commands the work a harness does in one task — that is host.harness.run',
        'Running generated code over supplied data — that is compute.sandbox.exec, which has no ambient authority and needs no binding',
        'Anything the operator has not connected a binding for; a binding cannot be widened by an argument',
      ],
      pitfalls: [
        'Pass argv, not a command line: ["npm", "test"] rather than "npm test". Nothing splits a string for you, deliberately.',
        'Descendants are killed with the process on timeout or stop, so a backgrounded child does not outlive the step.',
        'Egress follows the binding. A command that reaches the network may find it closed even though it runs.',
        "A push runs as the operator's own git, outside the sandbox, only to a branch under the folder's `branchPrefix` — named bare or as `refs/heads/<branch>` — never with force, with the branch named on the command and no environment or git global option; a folder without a prefix pushes nothing.",
        "A push the remote refuses — a branch that moved on, a non-fast-forward — fails the step with git's own message, rather than succeeding with a non-zero `exitCode`.",
        "A push carries `pushBase` and `scan.receipt`, the receipt `host.commit.scan` returned for the range it sends, and names that range's last commit as the source of its one refspec. A push with no receipt, one this executor did not issue since it started, one for another folder, or one more than a day old is refused with nothing pushed.",
        "In the push's own step, just before git is spawned, `origin/<pushBase>` is fetched and read: a push to anything but `origin`, an `origin` whose push URL is not its fetch URL, or a receipt for any range but `<that commit>..<the refspec's source>` fails with nothing pushed. A base that moved since the scan, forward or back, needs a scan of the range as it is now. `origin` can still move in the moment between that fetch and git's push, which no check from this machine closes.",
        "A push from a folder that declares checks carries `check.receipt`, the receipt `host.commit.check` returned for the refspec's source against that same base, and is refused with nothing pushed where it carries none, one this executor did not issue since it started, one more than a day old, one for another commit, base or folder, one for checks the folder no longer declares, or one whose checks failed. A folder that declares no checks needs none, and a push from it carrying one is refused.",
        "A push whose scan could not read everything or found lines marked allowed goes ahead only once the operator has approved exactly this push — this folder, this refspec, this receipt — at an approval in the same run; nothing the push's own input says stands in for that approval.",
      ],
    },
    inputZod: HostProcessExecInputSchema,
    outputZod: HostProcessExecOutputSchema,
  },
  {
    stepType: 'host',
    group: 'process',
    verb: 'inspect',
    name: 'Inspect Host Process',
    actionLabel: 'Inspecting process…',
    semanticDescription:
      'Report whether a process started by this binding is still running, and how many ' +
      'descendants it has. Useful between a long command and a decision to stop it.',
    tags: ['host', 'process', 'local'],
    idempotency: 'idempotent',
    accessMode: 'read',
    usage: {
      oneLine: 'Check whether a host process is still running.',
      minimalExampleInput: { bindingId: 'hb_project', processId: 'hp_01J' },
      whenToUse: ['Deciding whether a long-running command needs stopping'],
      whenNotToUse: ['Reading its output — that arrives with the exec step that started it'],
      pitfalls: [
        'A process id is meaningful only to the binding that started it, and only until the executor restarts.',
      ],
    },
    inputZod: HostProcessInspectInputSchema,
    outputZod: HostProcessInspectOutputSchema,
  },
  {
    stepType: 'host',
    group: 'process',
    verb: 'stop',
    name: 'Stop Host Process',
    actionLabel: 'Stopping…',
    semanticDescription:
      'Stop a process this binding started, and its descendants. Omit the process id to ' +
      'stop everything the binding is running, which is the control an operator reaches for ' +
      'when something is loose.',
    tags: ['host', 'process', 'local'],
    idempotency: 'non_idempotent',
    mutates: true,
    accessMode: 'write',
    usage: {
      oneLine: 'Stop a host process and its descendants, or all of them.',
      minimalExampleInput: { bindingId: 'hb_project', processId: 'hp_01J' },
      whenToUse: [
        'Cancelling a command that is taking too long or doing the wrong thing',
        'Stopping everything a binding is running, by omitting the process id',
      ],
      whenNotToUse: ['Stopping a process another binding started — ids do not cross bindings'],
      pitfalls: [
        'Stopping is not undoing. Whatever the process already wrote, sent or deleted stays done.',
      ],
    },
    inputZod: HostProcessStopInputSchema,
    outputZod: HostProcessStopOutputSchema,
  },
  {
    stepType: 'host',
    group: 'binding',
    verb: 'inspect',
    name: 'Read Push Posture',
    actionLabel: 'Reading the folder’s push posture…',
    groupDisplayName: 'Connected folders',
    groupDescription: 'What the operator declared about a folder on their own machine.',
    semanticDescription:
      'Read, from the policy file on the machine that holds a connected folder, which branches ' +
      'it may push, when a publication from it asks before pushing, the checks a ' +
      'publication runs first and for how long, and how many coding agents that machine ' +
      'runs at once. Touches nothing in the folder itself.',
    tags: ['host', 'binding', 'local'],
    idempotency: 'idempotent',
    accessMode: 'read',
    // A publication reads the posture as data for its own `when`; the machine
    // block already shows it to an agent.
    agentTool: false,
    usage: {
      oneLine: "Read a connected folder's push posture from its machine.",
      minimalExampleInput: { bindingId: 'hb_project' },
      whenToUse: ["A skill deciding whether its push asks, on the folder's posture"],
      whenNotToUse: [
        'Listing or reading files in the folder — that is host.file.list and host.file.get',
      ],
      pitfalls: [
        'The machine holding the folder answers it, so it completes only while that machine runs its executor.',
      ],
    },
    inputZod: HostBindingInspectInputSchema,
    outputZod: HostBindingInspectOutputSchema,
  },
  {
    stepType: 'host',
    group: 'commit',
    verb: 'scan',
    name: 'Scan Commits for Secrets',
    actionLabel: 'Scanning the commits for secrets…',
    groupDisplayName: 'Commits on this computer',
    groupDescription: 'Read the commits of a repository the operator connected, on their machine.',
    semanticDescription:
      'Read the lines a range of commits adds in a connected repository, the headers and ' +
      'messages of those commits, and any text that leaves with them — a pull request’s ' +
      'title and body — and report where one looks like a secret — a private key, a cloud or ' +
      'service token, a high-entropy value assigned to a secret-looking name — by where it ' +
      'is, line and the name of the rule that matched. Reads the repository’s objects only, ' +
      'as they are stored and as a push sends them, never as a `refs/replace/` ref ' +
      'substitutes them: the working tree, the index and every ref are left as they are.',
    tags: ['host', 'git', 'secrets', 'local'],
    idempotency: 'idempotent',
    accessMode: 'read',
    // A publication scans what its push would carry and reads the result
    // as data; an agent has no decision this would inform that the
    // publication does not already make.
    agentTool: false,
    usage: {
      oneLine: 'Scan the lines a range of commits adds for secrets, before they are pushed.',
      minimalExampleInput: {
        bindingId: 'hb_project',
        range: `${'a'.repeat(40)}..${'c'.repeat(40)}`,
      },
      whenToUse: ['A skill about to push commits, checking them for secrets first'],
      whenNotToUse: [
        'Reviewing a change for anything but secrets — that is the Local Code Review skill',
      ],
      pitfalls: [
        'Every commit in the range is read, so a secret added in one commit and removed in a later one is still found: the push would carry both.',
        "Each commit's headers — author, committer, `mergetag` and any other, which a push carries too — and its message are read as texts of their own and reported as `<sha> (headers)` and `<sha> (message)`; each entry of `texts` is reported under its name. A finding in any of them fails the scan as one in a file does.",
        'A file that is binary, holds a NUL byte, adds more than the scanned size in one commit, adds a line longer than the scanned line, or adds a Git LFS pointer — whose content git uploads on push without it being in the commit — is listed in `unscanned` with why, and the range is not `clean`; findings from the part that was read are kept.',
        'A line ending in a comment that carries `aflow-scan: allow` is reported in `allowed` instead of `findings`, and the range is not `clean`: the marker turns a stop into a question for the operator, never into a clearance. It counts only as the last thing on the line, after a comment leader set off by a space and outside any string opened earlier on the same line — inside such a string or a URL, or with anything after it, it does not. Only strings opened on the same line are seen: lines are read one at a time, so in a string opened on an earlier line, a comment leader and the marker ending a line count.',
        'A clean scan says no rule matched, not that the range holds no secret.',
        '`receipt` is what a push of the range must carry, and there is none where a rule matched: nothing that was found can be pushed. It is valid on the executor that scanned until that executor restarts, and for a day at most.',
      ],
    },
    inputZod: HostCommitScanInputSchema,
    outputZod: HostCommitScanOutputSchema,
  },
  {
    stepType: 'host',
    group: 'commit',
    verb: 'check',
    name: "Run the Folder's Checks on a Commit",
    actionLabel: "Running the folder's checks on the commit…",
    groupDisplayName: 'Commits on this computer',
    groupDescription: 'Read the commits of a repository the operator connected, on their machine.',
    semanticDescription:
      'Run the checks the operator declared for a connected repository — one command, set on ' +
      'their machine — in a detached checkout of one commit, with the folder’s installed ' +
      "dependencies linked so nothing is installed, under the folder's sandbox posture, " +
      'and report whether they passed, with the end of what they printed. The commit and the ' +
      'base it is measured against reach the command as `AFLOW_CHECK_SHA` and ' +
      '`AFLOW_CHECK_BASE`. The checkout is removed afterwards; the folder, its working tree ' +
      'and its refs are left as they were.',
    tags: ['host', 'git', 'checks', 'local'],
    idempotency: 'idempotent',
    // It runs the repository's own code, which is execution whatever the
    // command is.
    accessMode: 'write',
    // A publication runs it on the commit it made and reads the result as
    // data; the command is the operator's, so an agent has nothing to choose.
    agentTool: false,
    usage: {
      oneLine: "Run a connected folder's declared checks on one commit, before it is pushed.",
      minimalExampleInput: {
        bindingId: 'hb_project',
        sha: 'c'.repeat(40),
        base: 'a'.repeat(40),
      },
      whenToUse: ['A skill about to push a commit, running the checks the folder declares first'],
      whenNotToUse: [
        'Running a command of your choosing — that is host.process.exec; this runs only what the folder declares',
        'Reading a change for what a check cannot see — that is the Local Code Review skill',
      ],
      pitfalls: [
        'The command is declared on the machine with `aflow harness checks <folder> -- <argv>`, and nothing in this call can name one. A folder that declares none answers `passed` with `skipped`, and nothing ran.',
        'The checks get the folder’s `checksTimeoutMs`, `HOST_CHECKS_TIMEOUT_DEFAULT_MS` where the operator chose none; a check still running then is stopped and fails, naming that time.',
        'The checkout has the folder’s installed dependencies but none of its build output: a check that needs a package built builds it.',
        "The checks run as a coding agent does in the folder, in the machine's sandbox: with every host but this machine in an `open` folder, and in a `confined` one with egress closed. The machine's loopback is closed under both, and on macOS a check cannot listen on loopback either, so a test that serves itself fails there. The posture they ran under is in the result and the receipt, and a push records it.",
        '`receipt` is what a push of the commit from a folder that declares checks must carry as `check.receipt`; it is issued whether the checks passed or failed, and a push takes only one that says they passed, for the commit and base it sends and the checks the folder declares then. It is valid on the executor that ran them until that executor restarts, and for a day at most.',
        'Passing is evidence from this machine about one commit. The pull request’s own checks remain the proof.',
      ],
    },
    inputZod: HostCommitCheckInputSchema,
    outputZod: HostCommitCheckOutputSchema,
  },
];
