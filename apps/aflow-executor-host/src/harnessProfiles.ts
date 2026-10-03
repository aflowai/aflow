/**
 * Harness profiles — which coding agents this machine will run, and under what
 * widening of the standing boundary.
 *
 * A profile lives in the machine's half of the policy for the same reason the
 * execution grant does: the executable path is the thing that runs, so letting
 * the appliance name it would make "run a command" mean "run any command". The
 * server addresses a profile by id and cannot introduce one.
 *
 * A harness needs two things the default boundary refuses, and both are the
 * operator's to grant rather than the platform's to assume: read access to the
 * credential it already holds under home, and egress to whatever backs it.
 * Neither is inferred from the harness's name — a domain list written from
 * memory is a constant nobody measured, and it fails closed in a way that looks
 * like the harness is broken. Instead the boundary refuses, the refusal names
 * the host it refused, and the operator adds that host.
 */
import { z } from 'zod';

/**
 * What this harness will print, so the executor knows how to read it.
 *
 * It travels with the flags rather than with the id: an event stream is a
 * property of how the CLI was started, and a profile whose arguments were
 * edited apart from this field would have its output read the wrong way with
 * no error anywhere. `text` is the default because it is what a CLI prints
 * when nobody asked for anything else.
 */
export const HarnessOutputFormatSchema = z.enum(['claude-stream-json', 'text']);
export type HarnessOutputFormat = z.infer<typeof HarnessOutputFormatSchema>;

export const HarnessProfileSchema = z.object({
  id: z.string().min(1).describe('How a run addresses this harness.'),
  /**
   * What an operator would call this harness. The id is the wire spelling and is
   * not a name, so a surface with only the id has to show `claude` where a
   * person expects `Claude Code`. Optional: a hand-written profile need not
   * carry one, and a missing name reads better than one invented from the id.
   */
  label: z.string().min(1).optional(),
  executable: z
    .string()
    .min(1)
    .describe('Absolute path, or a name resolved against PATH on this machine.'),
  /** Fixed arguments before the prompt — subcommand, flags. */
  args: z.array(z.string()).default([]),
  /** The shape of what those arguments make it print. */
  output: HarnessOutputFormatSchema.default('text'),
  /**
   * How the task text is passed. Exactly one element must be the placeholder
   * `{prompt}`, which is replaced with the task; the argv is never assembled by
   * string interpolation, so a prompt cannot become an argument.
   */
  promptArgs: z.array(z.string()).default(['{prompt}']),
  /**
   * Paths under the denied home region this harness may read — its credential
   * and its configuration. Nothing is granted by default.
   */
  authPaths: z.array(z.string()).default([]),
  /**
   * Paths outside the worktree this harness writes to run at all — its own
   * scratch area. Declared rather than assumed: a harness that sandboxes its
   * own shell needs somewhere to build that sandbox, and where it puts it is
   * the harness's business, not something this platform should know.
   */
  writePaths: z.array(z.string()).default([]),
  /**
   * How this harness is told to name a new conversation, and to pick one back
   * up. Both carry `{session}` where the conversation id goes. A harness that
   * declares neither cannot be continued — which is a fact about the harness,
   * so it is recorded here rather than assumed either way.
   */
  sessionArgs: z.array(z.string()).default([]),
  resumeArgs: z.array(z.string()).default([]),
  /**
   * How this harness is told how many turns it may take, carrying `{turns}`
   * where the number goes. Empty means the CLI has no such flag, and a run
   * asking for a budget is refused rather than run without one — a budget
   * silently dropped is the failure the caller asked for it to prevent.
   */
  turnsArgs: z.array(z.string()).default([]),
  /**
   * How this harness is told which model to run, carrying `{model}` where the
   * name goes. Empty means the CLI takes no such argument, and a run naming a
   * model is refused rather than run on whatever the harness would have chosen —
   * a comparison silently run on the wrong model answers a different question
   * than the one asked.
   */
  modelArgs: z.array(z.string()).default([]),
  /**
   * The model a run gets when it names none, spelled as the harness names it.
   * Passed through `modelArgs` exactly as a run's own model would be, so a
   * profile without them refuses every run rather than quietly running the
   * harness's default in its place. Absent means the harness's own default.
   */
  model: z.string().min(1).optional(),
  /**
   * How this harness is handed an MCP configuration file, carrying
   * `{mcpConfig}` where its path goes. A run asking for a browser gets it this
   * way, as a server the executor answers; empty means the harness cannot be
   * handed one, and such a run is refused rather than run without the browser
   * it asked for.
   */
  mcpArgs: z.array(z.string()).default([]),
  /**
   * An environment variable that should receive a fresh, writable configuration
   * directory for the run. A harness given one keeps its state there instead of
   * under the operator's home, which means the standing denial of home survives
   * intact — nothing has to be carved out of it for the harness to work.
   */
  configDirEnv: z.string().min(1).optional(),
  /** Hosts this harness may reach. Empty means the run has no egress at all. */
  allowedDomains: z.array(z.string()).default([]),
  /**
   * How to obtain the credential the harness already holds, for the case where
   * it does not hold it in a file. On macOS a signed-in coding agent typically
   * keeps its token in the Keychain, which the boundary cannot reach — reaching
   * it needs a Unix socket, and that grant is all-or-nothing, so permitting the
   * Keychain would also permit the SSH agent and the Docker socket.
   *
   * So the executor fetches it outside the boundary, as the operator, and hands
   * the harness the result through the environment. The command is the
   * operator's own, in the file that already names what runs; the platform
   * hardcodes no credential store and reads nothing it was not pointed at.
   */
  credential: z
    .object({
      /** Prints the credential on stdout. Runs unconfined, as the operator. */
      command: z.array(z.string().min(1)).min(1),
      /** Field to take when the command prints JSON — dotted, e.g. `a.b.token`. */
      jsonPath: z.string().optional(),
      /** Environment variable the harness reads the credential from. */
      env: z.string().min(1),
    })
    .optional(),
});
export type HarnessProfile = z.infer<typeof HarnessProfileSchema>;

export const PROMPT_PLACEHOLDER = '{prompt}';
export const SESSION_PLACEHOLDER = '{session}';
export const TURNS_PLACEHOLDER = '{turns}';
export const MODEL_PLACEHOLDER = '{model}';
export const MCP_CONFIG_PLACEHOLDER = '{mcpConfig}';

export class HarnessProfileError extends Error {
  constructor(
    message: string,
    readonly kind: 'unknown_profile' | 'malformed_profile' | 'unsupported_request',
  ) {
    super(message);
    this.name = 'HarnessProfileError';
  }
}

export function requireProfile(
  profiles: ReadonlyMap<string, HarnessProfile>,
  profileId: string,
): HarnessProfile {
  const profile = profiles.get(profileId);
  if (!profile) {
    const known = [...profiles.keys()].sort();
    throw new HarnessProfileError(
      known.length === 0
        ? `No coding harness is configured on this machine. Add one to the host policy before running '${profileId}'.`
        : `Unknown harness '${profileId}' on this machine. Configured: ${known.join(', ')}.`,
      'unknown_profile',
    );
  }
  return profile;
}

/**
 * Fill a one-slot argument template, the shape every substituted template in a
 * profile shares: the value occupies its own element, so nothing is quoted, and
 * a template with no slot or two is a profile that would silently drop or
 * duplicate the value.
 */
function fillTemplate(
  profile: HarnessProfile,
  template: readonly string[],
  field: string,
  placeholder: string,
  value: string,
): string[] {
  const slots = template.filter((arg) => arg === placeholder).length;
  if (slots !== 1) {
    throw new HarnessProfileError(
      `Harness '${profile.id}' must carry exactly one ${placeholder} in ${field}; found ${String(slots)}.`,
      'malformed_profile',
    );
  }
  return template.map((arg) => (arg === placeholder ? value : arg));
}

/**
 * The turn-budget arguments for a run, or none when the run asked for no
 * budget. A harness whose profile declares no `turnsArgs` cannot take one, so
 * the request is refused with the harness named: resending without the budget
 * is the remedy, which is why it is an unsupported request rather than a
 * malformed profile.
 */
function buildTurnsArgs(profile: HarnessProfile, maxTurns: number | undefined): string[] {
  if (maxTurns === undefined) return [];
  if (profile.turnsArgs.length === 0) {
    throw new HarnessProfileError(
      `Harness '${profile.id}' takes no turn budget on this machine, so \`maxTurns\` cannot be ` +
        'applied. Send the task without it, or bound the run with `timeoutMs`.',
      'unsupported_request',
    );
  }
  return fillTemplate(profile, profile.turnsArgs, 'turnsArgs', TURNS_PLACEHOLDER, String(maxTurns));
}

/**
 * The model arguments for a run: the run's own model, else the profile's, else
 * none. Refused the same way a turn budget is: a harness that cannot be told
 * which model to run would answer on its default, and a run or profile that
 * pinned a model did so because the default was not the question.
 */
function buildModelArgs(profile: HarnessProfile, runModel: string | undefined): string[] {
  const model = runModel ?? profile.model;
  if (model === undefined) return [];
  if (profile.modelArgs.length === 0) {
    throw new HarnessProfileError(
      runModel !== undefined
        ? `Harness '${profile.id}' takes no model argument on this machine, so \`model\` cannot be ` +
            'applied. Send the task without it and the harness runs its own default.'
        : `Harness '${profile.id}' takes no model argument on this machine, so its configured ` +
            `model '${model}' cannot be applied. Clear it on this machine: ` +
            `aflow harness model ${profile.id} --clear`,
      'unsupported_request',
    );
  }
  return fillTemplate(profile, profile.modelArgs, 'modelArgs', MODEL_PLACEHOLDER, model);
}

/** The command on the machine that gives an existing harness profile its `mcpArgs`. */
export function setMcpArgsCommand(profileId: string): string {
  return `aflow harness browser ${profileId}`;
}

/**
 * Refuses a run that asks for a browser when the profile has no way to hand
 * the harness an MCP configuration. Asked before any checkout is made.
 */
export function assertTakesMcpConfig(profile: HarnessProfile): void {
  if (profile.mcpArgs.length > 0) return;
  throw new HarnessProfileError(
    `Harness '${profile.id}' has no \`mcpArgs\` on this machine, so it cannot be handed a ` +
      'browser. Send the task without `browser`, or have the operator set them on the machine: ' +
      setMcpArgsCommand(profile.id),
    'unsupported_request',
  );
}

function buildMcpArgs(profile: HarnessProfile, mcpConfig: string | undefined): string[] {
  if (mcpConfig === undefined) return [];
  assertTakesMcpConfig(profile);
  return fillTemplate(profile, profile.mcpArgs, 'mcpArgs', MCP_CONFIG_PLACEHOLDER, mcpConfig);
}

/**
 * Build the harness argv. The prompt occupies its own element, so no quoting,
 * escaping or shell parsing stands between the task text and the harness.
 */
export function buildHarnessArgv(
  profile: HarnessProfile,
  prompt: string,
  sessionArgs: string[] = [],
  maxTurns?: number,
  model?: string,
  mcpConfig?: string,
): string[] {
  // Filled before anything else so a profile that cannot take the task at all
  // says so, rather than reporting a dial the run could simply drop.
  const promptArgs = fillTemplate(
    profile,
    profile.promptArgs,
    'promptArgs',
    PROMPT_PLACEHOLDER,
    prompt,
  );
  return [
    profile.executable,
    ...profile.args,
    ...sessionArgs,
    ...buildTurnsArgs(profile, maxTurns),
    ...buildModelArgs(profile, model),
    ...buildMcpArgs(profile, mcpConfig),
    ...promptArgs,
  ];
}

/** Pick a dotted field out of parsed JSON, refusing anything that is not a string. */
function pluck(value: unknown, path: string): string | undefined {
  let cursor: unknown = value;
  for (const segment of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === 'string' ? cursor : undefined;
}

/**
 * The credential as the harness will receive it. Kept separate from the run so
 * the value has one short-lived home and never passes through a result, a log
 * line or a payload.
 */
export function readCredentialFromOutput(profile: HarnessProfile, stdout: string): string {
  const spec = profile.credential;
  if (!spec) {
    throw new HarnessProfileError(
      `Harness '${profile.id}' declares no credential source.`,
      'malformed_profile',
    );
  }
  if (spec.jsonPath === undefined) {
    const value = stdout.trim();
    if (value === '') {
      throw new HarnessProfileError(
        `The credential command for '${profile.id}' produced nothing.`,
        'malformed_profile',
      );
    }
    return value;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new HarnessProfileError(
      `The credential command for '${profile.id}' did not print JSON, but a jsonPath was configured.`,
      'malformed_profile',
    );
  }
  const value = pluck(parsed, spec.jsonPath);
  if (value === undefined || value === '') {
    throw new HarnessProfileError(
      `The credential command for '${profile.id}' printed JSON with no string at '${spec.jsonPath}'.`,
      'malformed_profile',
    );
  }
  return value;
}

/** True when this harness told us how to pick a conversation back up. */
export function supportsContinuation(profile: HarnessProfile): boolean {
  return profile.resumeArgs.length > 0;
}

/**
 * The conversation arguments for a run: naming a new one, or resuming it.
 * Substituted the same way the prompt is — the id occupies its own element, so
 * nothing has to be quoted.
 */
export function buildSessionArgs(
  profile: HarnessProfile,
  conversationId: string,
  resuming: boolean,
): string[] {
  const template = resuming ? profile.resumeArgs : profile.sessionArgs;
  if (template.length === 0) return [];
  return fillTemplate(
    profile,
    template,
    resuming ? 'resumeArgs' : 'sessionArgs',
    SESSION_PLACEHOLDER,
    conversationId,
  );
}
