/**
 * What a coding harness is doing while a step runs, one line at a time.
 *
 * A harness works for minutes at a stretch and says nothing until it is done.
 * The activity feed is that wait made legible: the tools it reaches for, the
 * narration between them, how each call came back. It is a live value, not a
 * record — superseded by the step's own result, never replayed from a cursor —
 * so a line is shaped for reading rather than for storage.
 *
 * It is not the harness's answer. The answer is the step result; these lines
 * are what happened on the way to it, and an interface that renders them as
 * the agent's message would put the executor's view of a run where the run's
 * own words belong.
 */
import { z } from 'zod';

/**
 * Room for a model-authored paragraph. A tool's own output is summarised long
 * before it gets here, so nothing legitimate approaches this; it is a ceiling
 * on what the live buffer will carry, not a shape for the text.
 */
const ACTIVITY_TEXT_MAX = 8_000;

const at = z
  .number()
  .int()
  .nonnegative()
  .describe(
    'Milliseconds since the run started, so a reader can see how long a step sat on one tool ' +
      'without holding a clock of its own.',
  );

export const HarnessActivityLineSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('status'),
    at,
    text: z
      .string()
      .max(ACTIVITY_TEXT_MAX)
      .describe(
        'A fact about the run rather than about the work: which model is answering, and what ' +
          'the run cost in turns, time and money when it ends.',
      ),
  }),
  z.object({
    kind: z.literal('thought'),
    at,
    text: z
      .string()
      .max(ACTIVITY_TEXT_MAX)
      .describe("The harness's own narration between tool calls, in its words."),
  }),
  z.object({
    kind: z.literal('tool'),
    at,
    tool: z
      .string()
      .max(200)
      .describe('The tool as the harness names it — `Read`, `Bash`, `Grep`.'),
    text: z
      .string()
      .max(ACTIVITY_TEXT_MAX)
      .describe(
        'One line naming the tool and the most telling thing it was given — the file, the ' +
          'command, the pattern — so a reader sees what is being done, not that something is.',
      ),
  }),
  z.object({
    kind: z.literal('tool_result'),
    at,
    tool: z.string().max(200).describe('The tool this answers, as the call named it.'),
    ok: z
      .boolean()
      .describe(
        'False when the tool itself reported an error. A failed tool call is ordinary — the ' +
          'harness reads it and carries on — so it is a property of the line, never of the step.',
      ),
    text: z
      .string()
      .max(ACTIVITY_TEXT_MAX)
      .describe(
        'A short summary of what came back: the first line, and how many more there were. ' +
          'The whole output is for the harness to read, not for the feed to carry.',
      ),
  }),
]);
export type HarnessActivityLine = z.infer<typeof HarnessActivityLineSchema>;
