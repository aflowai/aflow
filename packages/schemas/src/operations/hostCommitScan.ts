/**
 * `host.commit.scan`: what a push would add, read for secrets before it
 * leaves the machine, and what the scan answers.
 */
import { z } from 'zod';

import { HostBindingRef, HostCommitRangeSchema, HostScanReceiptSchema } from './host.js';

export const HostCommitScanInputSchema = z.object({
  bindingId: HostBindingRef,
  range: HostCommitRangeSchema.describe(
    'The commits to scan, `<baseSha>..<sha>`: every commit reachable from `sha` and not ' +
      'from `baseSha`.',
  ),
  texts: z
    .record(z.string().min(1).max(100), z.string())
    .optional()
    .describe(
      "Text that leaves the machine beside the commits — a pull request's title and body — " +
        'by a name for each. Each is read line by line under the same rules as a line a ' +
        'commit adds, and a finding in one is reported under its name.',
    ),
});

/**
 * Where a finding or an unscanned item is: a path, a commit's headers or
 * message, or a text passed beside the range.
 */
const HOST_COMMIT_SCAN_PLACE_DESCRIPTION =
  'Where the line is: for a line a commit adds, its path from the repository root; for a ' +
  "line of a commit's headers — author, committer, `mergetag` and any other — " +
  "`<sha> (headers)`; for a line of a commit's message, `<sha> (message)`; for a line of a " +
  "text passed in `texts`, that text's name.";

export const HostCommitScanFindingSchema = z.object({
  file: z.string().describe(HOST_COMMIT_SCAN_PLACE_DESCRIPTION),
  line: z
    .number()
    .int()
    .positive()
    .describe(
      'The line number there: in the file as the commit left it, in the message, or in the text.',
    ),
  pattern: z
    .string()
    .describe(
      'The name of the rule that matched. The matched value is never returned, logged or stored.',
    ),
});

export const HostCommitScanUnscannedReasonSchema = z
  .enum(['binary', 'nul-byte', 'too-large', 'line-too-long', 'lfs'])
  .describe(
    'Why a file was not read whole. `binary`: git prints no lines for it. `nul-byte`: a line it ' +
      'adds holds a NUL byte, and nothing after that line was read. `too-large`: it adds more ' +
      'than the scan reads of one file in one commit, and nothing past that point was read. ' +
      '`line-too-long`: a line it adds is longer than the scan reads of one line; that line was ' +
      'not read, the rest of the file was. `lfs`: what it adds is a Git LFS pointer, and the ' +
      "content the operator's git uploads on push is not in the commit to be read. A message " +
      'or a text is not read whole for the same reasons as a file, `binary` and `lfs` apart.',
  );

export const HostCommitScanUnscannedSchema = z.object({
  file: z.string().describe(HOST_COMMIT_SCAN_PLACE_DESCRIPTION),
  reason: HostCommitScanUnscannedReasonSchema,
});

export const HostCommitScanOutputSchema = z.object({
  clean: z
    .boolean()
    .describe(
      'True only when every file the range adds lines to, the headers and message of every ' +
        'one of its commits and ' +
        'every text in `texts` was read whole and no rule matched any line in them, marked ' +
        'allowed or not. A range with an entry in `unscanned` or a line in `allowed` is never ' +
        'clean, whatever else was found.',
    ),
  findings: z
    .array(HostCommitScanFindingSchema)
    .describe(
      'Where a rule matched, at most one finding per line and capped in number; `summary` ' +
        'says how many there were in all. A file in `unscanned` keeps the findings from the ' +
        'part of it that was read.',
    ),
  unscanned: z
    .array(HostCommitScanUnscannedSchema)
    .describe(
      'Every file, message or text the scan could not read whole, with why, capped in number ' +
        'as findings are. Nothing the scan did not read was cleared.',
    ),
  allowed: z
    .array(HostCommitScanFindingSchema)
    .describe(
      'Lines a rule matched that end in a comment carrying `aflow-scan: allow` — `//`, `#`, ' +
        '`--`, `/* … */` or `<!-- … -->`, the marker the last thing on the line. Reported ' +
        'here rather than in `findings`, and never cleared: whoever wrote the line could have ' +
        'written the comment, so a range with one is not `clean` and the operator reads it.',
    ),
  summary: z
    .string()
    .describe(
      'One paragraph for a person: every finding by where it is, line and rule, how many ' +
        'were left out past the cap, what was not read whole and why, and which lines were ' +
        'marked allowed.',
    ),
  unflaggedRange: z
    .string()
    .optional()
    .describe(
      'The range as two full shas, present when no line that was read — of a file, a ' +
        'message or a text — is in `findings`, whether or not everything was read whole or a ' +
        'line was marked allowed. A step that must stop on a finding reads this, so a range ' +
        'with a finding fails it.',
    ),
  clearedRange: z
    .string()
    .optional()
    .describe(
      'The range this scan cleared, as two full shas — present only when it is clean: every ' +
        'file, message and text read whole, nothing found and nothing marked allowed.',
    ),
  receipt: HostScanReceiptSchema.optional().describe(
    'What a push of the range must carry, present exactly when `unflaggedRange` is: it names ' +
      'the folder, the base and the last commit of the range, and whether the scan cleared ' +
      'it or the operator has to approve the push first. Valid on this executor only, and ' +
      'only for a day.',
  ),
});
