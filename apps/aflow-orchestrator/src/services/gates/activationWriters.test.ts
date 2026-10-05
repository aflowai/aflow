/**
 * Guard: every write of `activatedByPerson` — whether a session is attended —
 * is a named site, with who acts there and why its value is right.
 *
 * The rule is the field's (`SessionHotState.activatedByPerson`). Where a run
 * sets another going, the value is `attendedAsActingRun` of the acting run's
 * hot state and never a literal; where a person's authenticated request does,
 * it is read from the request's credential; a literal `false` is right only
 * where nothing with a person behind it acts, and a literal `true` nowhere.
 * A site this list does not name fails until it is added with its reason.
 *
 * A resume may leave the fact out, and then the session keeps it as it was —
 * which is right only for a resume that knows nothing of who is present. The
 * type cannot make the others say it, so every resume that states no value is
 * named here too, with its reason.
 */
import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

async function findRepoRoot(from: string): Promise<string> {
  let dir = from;
  const { root } = parse(dir);
  while (dir !== root) {
    try {
      await access(join(dir, 'yarn.lock'));
      return dir;
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error(`repo root not found above ${from}`);
}

const repoRoot = await findRepoRoot(dirname(fileURLToPath(import.meta.url)));

const SEARCH_ROOTS = [
  'apps/aflow-orchestrator/src',
  'packages/server-runtime/src',
  'packages/cybernetic-runtime/src',
];

type Actor =
  /** A person's authenticated request: decided from its credential. */
  | 'person'
  /** One run sets another going: the acting run as it is now. */
  | 'run'
  /** Nothing with a person behind it. */
  | 'nothing'
  /** Moves a value decided at one of the above to its next hop, deciding nothing. */
  | 'carried';

interface Writer {
  readonly file: string;
  /** The write as it reads in the source, whitespace collapsed. */
  readonly write: string;
  readonly times?: number;
  readonly acts: Actor;
  readonly why: string;
}

const O = 'apps/aflow-orchestrator/src/services';
const SO = `${O}/SessionOrchestrator`;
const H = `${O}/cybernetic/harness`;
const S = 'packages/server-runtime/src';
const C = 'packages/cybernetic-runtime/src';

const ACTIVATION_WRITERS: readonly Writer[] = [
  // ── A run sets another going ────────────────────────────────────────────
  {
    file: `${SO}/handlers/inlineOps/delegate.ts`,
    write: 'activatedByPerson = attendedAsActingRun(parentState)',
    acts: 'run',
    why: 'agent.control.delegate: the parent delegates; the child is queued and started as the parent is now.',
  },
  {
    file: `${SO}/handlers/inlineOps/delegate.ts`,
    write: 'activatedByPerson',
    times: 2,
    acts: 'run',
    why: 'The QUEUED child state and its start_run carry the value bound above.',
  },
  {
    file: `${SO}/handlers/inlineOps/resume.ts`,
    write: 'activatedByPerson: attendedAsActingRun(actingRun)',
    acts: 'run',
    why: 'agent.control.resume: the parent re-parents and answers its paused child; the child resumes as the parent is now.',
  },
  {
    file: `${H}/taskAuthority.ts`,
    write: 'activatedByPerson: attendedAsActingRun(anchorState)',
    acts: 'run',
    why: 'A workflow task is set going by the session that anchors its run, as that session is when the task is dispatched or retried.',
  },
  {
    file: `${H}/pollPolicy.ts`,
    write: 'activatedByPerson: attendedAsActingRun(helmsmanState)',
    acts: 'run',
    why: 'A polling task’s next cycle is dispatched for the anchor session, as it is when the cycle is armed.',
  },
  {
    file: `${H}/sessionWakeup.ts`,
    write: 'activatedByPerson: attendedAsActingRun(state)',
    acts: 'run',
    why: 'A run the session started without waiting reports in and wakes it; that run acts as the session anchoring it is now.',
  },
  {
    file: `${SO}/handlers/inlineOps/coachCrud.ts`,
    write:
      'activatedByPerson: attendedAsActingRun( await getSessionState(args.redis, tenantIdStr, args.context.runId), )',
    times: 3,
    acts: 'run',
    why: 'An agent asks for a Coach review, a retrigger or a campaign synthesis; the review is attended as the asking run is now.',
  },
  {
    file: `${SO}/handlers/inlineOps/workflowCrud/campaign/end.ts`,
    write:
      'activatedByPerson: attendedAsActingRun( await getSessionState(args.redis, tenantIdStr, args.context.runId), )',
    acts: 'run',
    why: 'An agent ends a campaign; its synthesis review is attended as that run is now.',
  },

  // ── A person's authenticated request ────────────────────────────────────
  {
    file: `${S}/routes/runs.ts`,
    write: 'activatedByPerson: interactiveUser',
    acts: 'person',
    why: 'Start: `interactiveUser` is `isInteractiveUser(request.authUser)`, whatever mode the request names.',
  },
  {
    file: `${S}/routes/runs.ts`,
    write: 'activatedByPerson: isInteractiveUser(request.authUser)',
    times: 2,
    acts: 'person',
    why: 'Resume and retry.',
  },
  {
    file: `${S}/routes/sessionRoomMessages.ts`,
    write: 'activatedByPerson: isInteractiveActor(actorContext)',
    acts: 'person',
    why: 'A message in a conversation resumes it.',
  },
  {
    file: `${S}/services/appletEffectsRelay.ts`,
    write: 'activatedByPerson: isInteractiveActor(actorContext)',
    acts: 'person',
    why: 'An applet’s effect resumes its run on behalf of whoever used the applet.',
  },
  {
    file: `${S}/services/actionCenter/sources/pausedStepSource.ts`,
    write: 'activatedByPerson: ctx.actorIsInteractiveUser === true',
    acts: 'person',
    why: 'An operator’s answer in the Action Center; the route sets the flag from the credential.',
  },
  {
    file: `${S}/routes/agui.ts`,
    write: 'activatedByPerson: isInteractiveUser(request.authUser)',
    acts: 'person',
    why: 'An AG-UI start, decided by credential like any other start.',
  },
  {
    file: `${S}/routes/a2a.ts`,
    write: 'activatedByPerson: isInteractiveUser(request.authUser)',
    acts: 'person',
    why: 'An A2A streaming start; the plain send passes the same value through its parameter.',
  },
  {
    file: `${S}/routes/a2a.ts`,
    write: 'activatedByPerson',
    acts: 'person',
    why: 'An A2A send, with the value its route read from the credential.',
  },
  {
    file: `${S}/routes/cybernetic/proposals.ts`,
    write: 'activatedByPerson: isInteractiveUser(request.authUser)',
    acts: 'person',
    why: 'An operator regenerates a proposal, which starts a Coach review.',
  },
  {
    file: `${S}/routes/workflows/campaigns.ts`,
    write: 'activatedByPerson: isInteractiveUser(request.authUser)',
    acts: 'person',
    why: 'An operator ends a campaign, which starts its synthesis review.',
  },

  // ── Nothing with a person behind it ─────────────────────────────────────
  {
    file: `${O}/ScheduleEvaluator.ts`,
    write: 'activatedByPerson: false',
    times: 2,
    acts: 'nothing',
    why: 'A schedule starts or resumes a run.',
  },
  {
    file: `${S}/routes/webhook-ingest.ts`,
    write: 'activatedByPerson: false',
    acts: 'nothing',
    why: 'A webhook starts a run.',
  },
  {
    file: `${O}/cybernetic/evalBatch/startWorkflowRunAtRevision.ts`,
    write: 'activatedByPerson: false',
    acts: 'nothing',
    why: 'The eval batch engine replays a frozen trial; no one is present for it by construction.',
  },
  {
    file: `${O}/cybernetic/postRunHooks.ts`,
    write: 'activatedByPerson: false',
    times: 2,
    acts: 'nothing',
    why: 'The platform’s post-run gate raises a background Coach review, and a goal-met campaign end its synthesis.',
  },
  {
    file: `${C}/coachTriggerValidityDispatch.ts`,
    write: 'activatedByPerson: false',
    acts: 'nothing',
    why: 'A validity repair review is raised by the platform noticing an invalid skill.',
  },

  // ── Carried from where it was decided ───────────────────────────────────
  {
    file: `${O}/ControlConsumer.ts`,
    write: 'activatedByPerson: message.activatedByPerson',
    times: 3,
    acts: 'carried',
    why: 'Hands a start, resume or retry command to the lifecycle as it was sent.',
  },
  {
    file: `${O}/ControlConsumer.ts`,
    write:
      "activatedByPerson = message.type === 'start_run' ? message.activatedByPerson : existingState?.activatedByPerson",
    acts: 'carried',
    why: 'A command that fails before it runs records the start’s value, or keeps the session’s.',
  },
  {
    file: `${O}/ControlConsumer.ts`,
    write: 'activatedByPerson',
    acts: 'carried',
    why: 'The failed state carries the value bound above.',
  },
  {
    file: `${SO}/lifecycle/startRun.ts`,
    write: 'activatedByPerson: params.activatedByPerson',
    times: 3,
    acts: 'carried',
    why: 'Writes the start command’s value with the session it starts.',
  },
  {
    file: `${SO}/lifecycle/retryRun.ts`,
    write: 'activatedByPerson: params.activatedByPerson',
    acts: 'carried',
    why: 'Writes the retry command’s value.',
  },
  {
    file: `${SO}/lifecycle/resumeRun.ts`,
    write: 'activatedByPerson: params.activatedByPerson',
    times: 3,
    acts: 'carried',
    why: 'Writes the resume command’s value; a parent paused on its child’s question takes it and relays the answer, with it, to the child.',
  },
  {
    file: `${SO}/helpers/delegationState.ts`,
    write: 'activatedByPerson: opts.activatedByPerson',
    acts: 'carried',
    why: 'Applies the relaying resume’s value to the parent as it goes back to waiting.',
  },
  {
    file: `${SO}/scheduling/scheduleStep.ts`,
    write: 'activatedByPerson: runState.activatedByPerson',
    acts: 'carried',
    why: 'Stamps a session’s own step job from its state.',
  },
  {
    file: `${SO}/scheduling/timers.ts`,
    write: 'activatedByPerson: timerRunState.activatedByPerson',
    acts: 'carried',
    why: 'Stamps the job a session’s timer dispatches from its state.',
  },
  {
    file: `${SO}/scheduling/workflowTimerJob.ts`,
    write: 'activatedByPerson: timer.activatedByPerson',
    acts: 'carried',
    why: 'Stamps a workflow task’s timer job from the value its task authority put on the timer.',
  },
  {
    file: `${H}/dispatchTask.ts`,
    write: 'activatedByPerson: taskAuthority.activatedByPerson',
    acts: 'carried',
    why: 'From `resolveWorkflowTaskAuthority`.',
  },
  {
    file: `${H}/dispatchRetriedTask.ts`,
    write: 'activatedByPerson: taskAuthority.activatedByPerson',
    acts: 'carried',
    why: 'From `resolveWorkflowTaskAuthority`.',
  },
  {
    file: `${H}/runnerBridge.ts`,
    write: 'activatedByPerson: authority.activatedByPerson',
    times: 2,
    acts: 'carried',
    why: 'A Runner task’s QUEUED state and start_run, from `resolveWorkflowTaskAuthority`.',
  },
  {
    file: `${H}/operationTaskDispatch.ts`,
    write: 'activatedByPerson',
    times: 3,
    acts: 'carried',
    why: 'An operation task’s job and timer, with the value its caller took from `resolveWorkflowTaskAuthority`.',
  },
  {
    file: `${S}/services/sessions.ts`,
    write: 'activatedByPerson: request.activatedByPerson',
    times: 3,
    acts: 'carried',
    why: 'Puts a route’s value on the start, resume or retry command it sends.',
  },
  {
    file: `${C}/resumeDispatch.ts`,
    write: 'activatedByPerson: request.activatedByPerson',
    acts: 'carried',
    why: 'Puts its caller’s value on the resume command.',
  },
  {
    file: `${C}/coachTrigger.ts`,
    write: 'activatedByPerson: params.activatedByPerson',
    acts: 'carried',
    why: 'Starts the Coach review with its caller’s value.',
  },
  {
    file: `${C}/coachTriggerCampaignEndDispatch.ts`,
    write: 'activatedByPerson: params.activatedByPerson',
    times: 2,
    acts: 'carried',
    why: 'Passes its caller’s value to the Coach dispatch.',
  },
];

interface UnstatedResume {
  readonly file: string;
  /** The call that resumes: `resumeSession`, `resumeRun`, `dispatchResume`, or `addControlMessage` sending `resume_run`. */
  readonly call: string;
  readonly times?: number;
  readonly why: string;
}

const RESUMES_STATING_NOTHING: readonly UnstatedResume[] = [
  {
    file: `${S}/services/oauthConsentResume.ts`,
    call: 'resumeSession',
    why: 'Finishing an OAuth consent resumes the session through the provider’s redirect, which is authenticated as nobody; the session stays as attended as it was.',
  },
  {
    file: `${S}/routes/applets.ts`,
    call: 'resumeSession',
    why: 'Hands on the applet relay’s request unchanged; the relay states the value.',
  },
];

/** Drops comments so a write described in prose is not read as one. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, '');
}

/** The expression starting at `from`, up to the `,` `;` `}` or `)` that ends it at depth zero. */
function expressionAt(source: string, from: number): string {
  let depth = 0;
  let end = from;
  for (; end < source.length; end++) {
    const ch = source[end];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break;
      depth--;
    } else if ((ch === ',' || ch === ';') && depth === 0) break;
  }
  return source.slice(from, end);
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

const NAME = /(?<![\w$'"`])activatedByPerson\b/g;

/** Every write of the field in one source: a property, a shorthand, or an assignment. */
function writesIn(source: string): string[] {
  const code = stripComments(source);
  const writes: string[] = [];
  for (const match of code.matchAll(NAME)) {
    const end = match.index + match[0].length;
    const after = code.slice(end, end + 40);
    const before = code.slice(Math.max(0, match.index - 40), match.index);
    const assignment = /^\s*=(?![=>])\s*/.exec(after);
    if (assignment) {
      writes.push(
        `activatedByPerson = ${collapse(expressionAt(code, end + assignment[0].length))}`,
      );
      continue;
    }
    // Any other use as a member is a read.
    if (/\.\s*$/.test(before)) continue;
    const property = /^\s*:\s*/.exec(after);
    if (property) {
      const value = collapse(expressionAt(code, end + property[0].length));
      if (/^(boolean|z\.)/.test(value)) continue;
      writes.push(`activatedByPerson: ${value}`);
      continue;
    }
    if (/^\s*[,}]/.test(after) && /[{,]\s*$/.test(before)) writes.push('activatedByPerson');
  }
  return writes;
}

/** The argument list of the call whose `(` is at `open`, without its parentheses. */
function argumentsAt(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return source.slice(open + 1);
}

const RESUME_CALL =
  /(?<!function\s+)(?:\.(resumeSession|resumeRun)|\b(dispatchResume|addControlMessage))\(/g;

/** Every resume in one source that does not state `activatedByPerson`, by the call it goes through. */
function unstatedResumesIn(source: string): string[] {
  const code = stripComments(source);
  const unstated: string[] = [];
  for (const match of code.matchAll(RESUME_CALL)) {
    const call = match[1] ?? match[2] ?? '';
    const args = argumentsAt(code, match.index + match[0].length - 1);
    if (call === 'addControlMessage' && !/type:\s*'resume_run'/.test(args)) continue;
    // A request built just above and passed by name is read where it is built.
    const passed = /(?:^|,)\s*([A-Za-z_$][\w$]*)\s*,?\s*$/.exec(args)?.[1];
    const built = passed
      ? new RegExp(`\\bconst\\s+${passed}\\s*(?::[^=]+)?=\\s*\\{`).exec(code)
      : null;
    const request = built ? argumentsAt(code, built.index + built[0].length - 1) : args;
    if (!/(?<![\w$'"`])activatedByPerson\b/.test(request)) unstated.push(call);
  }
  return unstated;
}

async function sourcesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__')
        continue;
      out.push(...(await sourcesUnder(full)));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.includes('.test.') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

async function writesInTrees(): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  for (const root of SEARCH_ROOTS) {
    const files = await sourcesUnder(join(repoRoot, root));
    // An empty sweep would pass vacuously.
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const relative = file.slice(repoRoot.length + 1);
      for (const write of writesIn(await readFile(file, 'utf-8'))) {
        const key = `${relative} | ${write}`;
        found.set(key, (found.get(key) ?? 0) + 1);
      }
    }
  }
  return found;
}

async function unstatedResumesInTrees(): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  for (const root of SEARCH_ROOTS) {
    for (const file of await sourcesUnder(join(repoRoot, root))) {
      const relative = file.slice(repoRoot.length + 1);
      for (const call of unstatedResumesIn(await readFile(file, 'utf-8'))) {
        const key = `${relative} | ${call}`;
        found.set(key, (found.get(key) ?? 0) + 1);
      }
    }
  }
  return found;
}

const keyOf = (writer: Writer): string => `${writer.file} | ${writer.write}`;

describe('activatedByPerson writers', () => {
  it('names every site that writes it, as many times as it does', async () => {
    const found = await writesInTrees();
    const listed = new Map(ACTIVATION_WRITERS.map((w) => [keyOf(w), w.times ?? 1]));
    const unlisted = [...found].filter(([key, n]) => listed.get(key) !== n);
    const gone = [...listed].filter(([key]) => !found.has(key));
    expect(
      unlisted.map(([key, n]) => `${key} (×${String(n)})`),
      'A write of activatedByPerson this guard does not name. Say who acts there — a run ' +
        '(`attendedAsActingRun` of the acting run’s hot state), a person (the request’s ' +
        'credential) or nothing (`false`) — and add it to ACTIVATION_WRITERS with its reason.',
    ).toEqual([]);
    expect(gone, 'A listed write no longer exists; drop it from ACTIVATION_WRITERS.').toEqual([]);
  });

  it('names every resume that states no value, as many times as it does', async () => {
    const found = await unstatedResumesInTrees();
    const listed = new Map(
      RESUMES_STATING_NOTHING.map((r) => [`${r.file} | ${r.call}`, r.times ?? 1]),
    );
    const unlisted = [...found].filter(([key, n]) => listed.get(key) !== n);
    const gone = [...listed].filter(([key]) => !found.has(key));
    expect(
      unlisted.map(([key, n]) => `${key} (×${String(n)})`),
      'A resume that states no activatedByPerson, so the session keeps whatever it was. ' +
        'State who acts there, or — only where the resume knows nothing of who is present — ' +
        'add it to RESUMES_STATING_NOTHING with its reason.',
    ).toEqual([]);
    expect(gone, 'A listed resume now states a value or is gone; drop it.').toEqual([]);
  });

  it('finds the resumes it guards', () => {
    expect(
      unstatedResumesIn(
        "await addControlMessage(redis, { type: 'resume_run', runId });\n" +
          "await addControlMessage(redis, { type: 'cancel_run', runId });\n" +
          'const resume = { runId, activatedByPerson: false };\n' +
          'await dispatchResume(db, redis, resume);\n' +
          'await deps.sessionService.resumeSession({ sessionId });\n' +
          'export async function dispatchResume(db, redis, request) {}\n',
      ),
    ).toEqual(['addControlMessage', 'resumeSession']);
  });

  it('writes a literal only where nothing acts, and `true` nowhere', () => {
    const literal = ACTIVATION_WRITERS.filter((w) =>
      /^activatedByPerson(: | = )(true|false)$/.test(w.write),
    );
    expect(literal.filter((w) => w.write.endsWith('true'))).toEqual([]);
    expect(literal.filter((w) => w.acts !== 'nothing').map(keyOf)).toEqual([]);
    expect(
      ACTIVATION_WRITERS.filter((w) => w.acts === 'nothing' && !w.write.endsWith(': false')).map(
        keyOf,
      ),
    ).toEqual([]);
  });

  it('decides a run-to-run site from the acting run, and a person’s from the credential', () => {
    const bindsThroughHelper = new Set(
      ACTIVATION_WRITERS.filter((w) =>
        w.write.startsWith('activatedByPerson = attendedAsActingRun('),
      ).map((w) => w.file),
    );
    const runSites = ACTIVATION_WRITERS.filter((w) => w.acts === 'run');
    expect(
      runSites
        .filter(
          (w) =>
            !w.write.includes('attendedAsActingRun(') &&
            !(w.write === 'activatedByPerson' && bindsThroughHelper.has(w.file)),
        )
        .map(keyOf),
    ).toEqual([]);
    const personSites = ACTIVATION_WRITERS.filter((w) => w.acts === 'person');
    expect(
      personSites
        .filter(
          (w) =>
            !/isInteractive(User|Actor)\(|actorIsInteractiveUser|interactiveUser$|^activatedByPerson$/.test(
              w.write,
            ),
        )
        .map(keyOf),
    ).toEqual([]);
  });
});
