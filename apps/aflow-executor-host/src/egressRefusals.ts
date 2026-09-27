/**
 * Turning a blocked connection into something the operator can act on.
 *
 * The boundary grants no egress until a harness profile names a host, which
 * makes the first run of a new harness fail — correctly, and unhelpfully, since
 * a harness reports a refused connection as some generic network error. The
 * sandbox's proxy does know the exact host it refused, but only says so when
 * `SRT_DEBUG` is set, so the executor sets it and reads the answer back out.
 *
 * That debug channel is noisy and shares stderr with the harness's own output,
 * so the lines are extracted into a structured field and removed from the text
 * the operator reads.
 *
 * "Shares stderr" means more than alternating lines. Both write to the same
 * descriptor, so a debug message can land *inside* a harness sentence — `the
 * doctests Allowed by config rule: api.example.com:443 [SandboxDebug] pass
 * (2/2)`. A line beginning with the marker is the adapter's in its entirety and
 * goes whole; a marker further in means the writers interleaved, and only this
 * adapter's known wording is cut out of it. Removing the wording wherever it
 * appears is the obvious reading and is wrong: a harness printing "Connection
 * blocked to foo:443" — quoting a log, explaining itself — would lose its own
 * words and have a refusal invented for it. The refusal names the host to add; nobody has to guess a
 * domain list, and no such list is compiled into this platform.
 */

/** The proxy's own wording, from `logForDebugging` in the sandbox adapter. */
const DEBUG_PREFIX = '[SandboxDebug]';

/** Each entry is one message this adapter emits. Nothing else is ever removed. */
const CHATTER: readonly RegExp[] = [
  /\[SandboxDebug\]\s*/g,
  /Connection blocked to \S+?:\d+\s*/g,
  /No matching config rule, denying: \S+?:\d+\s*/g,
  /Allowed by config rule: \S+?:\d+\s*/g,
  // The adapter tags each platform's own messages with a bracketed component.
  // The startup line naming the restrictions it applied is the one an operator
  // reads as an error, because it arrives on stderr before anything works.
  /\[Sandbox [A-Za-z ]+\][^\n]*/g,
  // The multiplexing proxy narrating its own sockets. Anchored on the wordings
  // it emits rather than on `mux:`, so a workload quoting that word keeps its
  // own sentence.
  /mux: (?:HTTP (?:backend (?:dial failed|listening on)|dispatch before backend bound)|client socket error|first-byte timeout)[^\n]*/g,
  // The command line echoed back on start, which for a harness is the whole
  // task — prompt, inputs and output schema — quoted into one line.
  /(?:Original command|Command string mode \(-c\)): [^\n]*/g,
];

/**
 * Where a JSON object stands after this line, having started at `depth`.
 *
 * Counted rather than matched against a field name: the adapter dumps its
 * network configuration through the same channel, and which keys that object
 * carries is its business to change. String contents are skipped so a denied
 * host with a brace in it cannot unbalance the count.
 */
function jsonDepthAfter(line: string, depth: number): number {
  let current = depth;
  let inString = false;
  let escaped = false;
  for (const character of line) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{' || character === '[') current += 1;
    else if (character === '}' || character === ']') current -= 1;
  }
  return current;
}

/**
 * The rule, one line at a time, with the one piece of state a line cannot carry.
 *
 * A debug message holding a JSON object spans several lines and only the first
 * of them carries the prefix — the newlines are inside a single message. So the
 * block is entered on a prefixed line that is nothing but an opening brace, and
 * left when that object closes. Requiring the whole message to be the brace is
 * what keeps the echoed command line, which is full of braces from the task's
 * own schema, from swallowing everything after it.
 */
function createLineFilter(): (line: string) => string | null {
  let blockDepth = 0;
  return (line: string): string | null => {
    if (blockDepth > 0) {
      blockDepth = Math.max(0, jsonDepthAfter(line, blockDepth));
      return null;
    }
    if (line.startsWith(DEBUG_PREFIX)) {
      if (line.slice(DEBUG_PREFIX.length).trim() === '{') blockDepth = 1;
      return null;
    }
    if (!line.includes(DEBUG_PREFIX)) return line;
    let out = line;
    for (const pattern of CHATTER) out = out.replace(pattern, '');
    return out.replace(/[ \t]{2,}/g, ' ').trimEnd();
  };
}

const BLOCKED_ANYWHERE =
  /(?:Connection blocked to|No matching config rule, denying:) (\S+?):(\d+)/g;

/**
 * Remove the adapter's chatter from text that is whole.
 *
 * For the stored diagnostics, where every line has both its ends. Dozens of
 * "Connection blocked" lines scrolling past while a run works normally is
 * indistinguishable from a stuck one, and the first operator to see it
 * reasonably concluded it was looping. A stream is `createChatterStripper`.
 */
export function stripSandboxChatter(text: string): string {
  const keep = createLineFilter();
  return text
    .split('\n')
    .map(keep)
    .filter((line): line is string => line !== null)
    .join('\n');
}

/**
 * The same rule over a stream that arrives in chunks.
 *
 * The rules are per line, and a read boundary falls wherever the pipe happens
 * to flush — mid-word, mid-marker. Applying the pure function per chunk
 * therefore missed exactly the lines it was written for, and the sandbox's
 * startup dump reached a live viewer one fragment at a time. So a partial
 * trailing line is held until the chunk that completes it, or until `flush`
 * says nothing more is coming.
 *
 * Shaped like `createStreamScrubber`, which does the same job for a credential
 * split across reads and is applied to the same stream.
 */
export function createChatterStripper(): {
  push: (chunk: string) => string;
  flush: () => string;
} {
  const keep = createLineFilter();
  let carry = '';
  return {
    push(chunk: string): string {
      const lines = (carry + chunk).split('\n');
      carry = lines.pop() ?? '';
      const kept = lines.map(keep).filter((line): line is string => line !== null);
      return kept.length === 0 ? '' : `${kept.join('\n')}\n`;
    },
    flush(): string {
      if (carry === '') return '';
      const line = carry;
      carry = '';
      return keep(line) ?? '';
    },
  };
}

export interface EgressRefusal {
  readonly host: string;
  readonly port: number;
}

export interface ScrubbedOutput {
  /** Stderr with the sandbox's debug chatter removed. */
  readonly text: string;
  /** Distinct hosts the boundary refused, in the order first seen. */
  readonly refusals: EgressRefusal[];
}

export function extractEgressRefusals(stderr: string): ScrubbedOutput {
  const refusals: EgressRefusal[] = [];
  const seen = new Set<string>();

  // Read from the raw text, because the denials live inside the very lines the
  // strip takes away. Stripping first would leave `blockedDomains` empty and a
  // cut-off run indistinguishable from an unproductive one.
  for (const line of stderr.split('\n')) {
    if (!line.includes(DEBUG_PREFIX)) continue;
    for (const match of line.matchAll(BLOCKED_ANYWHERE)) {
      const host = match[1];
      const port = match[2];
      if (host === undefined || port === undefined) continue;
      const key = `${host}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refusals.push({ host, port: Number(port) });
    }
  }

  return { text: stripSandboxChatter(stderr), refusals };
}

/**
 * Whether the run this refusal came from reached its outcome.
 *
 * The same set of refused hosts means two different things, and the note has to
 * say which: a run that finished reached an answer without those hosts, and a run
 * that did not was stopped by them. Passed rather than defaulted, because the
 * blocking wording on a run that succeeded is the failure this exists to
 * prevent — an envelope telling the reader the outcome did not happen, beside
 * the outcome.
 */
export type RefusalOutcome = 'reached_result' | 'produced_nothing';

/**
 * What was refused, who can change it, and the words that change it.
 *
 * Naming the host was half an answer. An agent reading it knows something was
 * blocked and cannot do anything about it: allowed domains live in the machine's
 * own profile, which nothing on the appliance side can write. Without that said,
 * the agent either reports a dead end or invents a remedy — a settings page, a
 * retry — and the operator is left to work out that the fix is a command on
 * their own machine.
 *
 * So the result carries the command. It is the operator's decision to widen a
 * harness's reach, and the point of showing it is that they can make it in one
 * step rather than go looking.
 *
 * What changes with the outcome is the instruction. A blocked run must not be
 * retried, because a refusal is a decision and will not change on its own; a run
 * that reached its result has nothing to retry, and telling its reader to wait
 * for the operator discards an answer that already exists.
 */
export function describeRefusals(
  refusals: readonly EgressRefusal[],
  outcome: RefusalOutcome,
  harnessId?: string,
): string | undefined {
  if (refusals.length === 0) return undefined;
  const hosts = [...new Set(refusals.map((r) => r.host))];
  const plural = hosts.length > 1;
  const flags = hosts.map((host) => `--domain ${host}`).join(' ');
  const command = `  yarn workspace @aflow/aflow-executor-host harness add ${harnessId ?? '<harness>'} ${flags}\n`;
  const refused =
    `The boundary refused ${plural ? 'connections' : 'a connection'} to ${hosts.join(', ')}, ` +
    `so anything needing ${plural ? 'them' : 'it'} did not happen. `;
  const widening =
    "Only the operator can widen a harness's allowed domains, and only on their own machine";
  if (outcome === 'reached_result') {
    return (
      `${refused}The run reached its result anyway, so this is a note about what it could not ` +
      `reach rather than a reason it failed. ${widening} — if the result is missing something ` +
      `that needed one of those hosts, ask them to run there:\n${command}`
    );
  }
  return (
    `${refused}${widening} — ask them to run there:\n${command}` +
    'Then ask again. Do not retry until they say it is done: the refusal is a decision, not a ' +
    'failure, and it will not change on its own.'
  );
}
