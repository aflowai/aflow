import { describe, expect, it } from 'vitest';
import { buildToolRepairPrompt } from './ai/handlers/agentTurn.js';

/**
 * The observed loop: a draft_patch call was refused with
 * "/operations: must be array", the model was told to "call the tool again with
 * EVERY required argument populated", and it answered by re-sending the call it
 * had already applied — reasoning "rejected — likely serialization issue".
 * Nothing had been missing; only the encoding was wrong.
 */
const ENCODING = {
  reason: 'Agent tool "draft_patch" arguments invalid: /operations: must be array',
  code: 'tool_args_invalid',
};
const MISSING = {
  reason: 'Agent tool "draft_patch" arguments invalid: must have required property mutationId',
  code: 'tool_args_invalid',
};

describe('a refused tool call is explained by what went wrong', () => {
  // The refused call never ran, so it is not in the transcript. "Your previous
  // tool call was rejected" therefore pointed at the last call the model could
  // see — which had SUCCEEDED — and it re-sent that one's four cases.
  it.each([ENCODING, MISSING])(
    'says which call was refused, and that it is not above',
    (reject) => {
      const prompt = buildToolRepairPrompt(reject);
      expect(prompt).toContain('does NOT appear in the conversation above');
      expect(prompt).toContain('still true');
      expect(prompt).toContain('Do not re-send it');
    },
  );

  it('never calls the refused one "your previous tool call"', () => {
    // That phrase is what aimed the model at its own successful work.
    for (const reject of [ENCODING, MISSING]) {
      expect(buildToolRepairPrompt(reject)).not.toContain('previous tool call');
    }
  });

  it('tells an encoding error the intent was fine and to keep the plan', () => {
    const prompt = buildToolRepairPrompt(ENCODING);
    expect(prompt).toContain('Only the ENCODING');
    expect(prompt).toContain('not as a quoted string containing JSON');
    expect(prompt).toContain('Keep your plan');
  });

  it('does not tell an encoding error to populate every required argument', () => {
    // That instruction is for a different failure and is what invited the repeat.
    expect(buildToolRepairPrompt(ENCODING)).not.toContain('EVERY required argument');
  });

  it('still tells a missing argument to populate it', () => {
    const prompt = buildToolRepairPrompt(MISSING);
    expect(prompt).toContain('EVERY required argument');
    expect(prompt).not.toContain('Only the ENCODING');
  });

  it.each([
    'must be array',
    'must be an array',
    'must be object',
    'must be string',
    'must be integer',
  ])('recognises "%s" as an encoding error', (fragment) => {
    const prompt = buildToolRepairPrompt({ reason: `/x: ${fragment}`, code: 'tool_args_invalid' });
    expect(prompt).toContain('Only the ENCODING');
  });

  it('carries the platform reason through either way, so the model sees the specifics', () => {
    expect(buildToolRepairPrompt(ENCODING)).toContain('/operations: must be array');
    expect(buildToolRepairPrompt(MISSING)).toContain('required property mutationId');
  });
});

describe('a call cut off mid-argument is not a malformed call', () => {
  // The raw arguments of one run ended at `{"mutationId": "draft-2",
  // "operations": `. Nothing was mis-encoded — the response ran out of output
  // budget, which reasoning is paid from too. Resending the same call would
  // truncate in the same place.
  const truncatedReject = {
    reason: 'Agent tool "draft_patch" arguments invalid: /operations: must be array',
    code: 'tool_args_invalid',
  };

  it('asks for fewer items rather than the same call again', () => {
    const prompt = buildToolRepairPrompt(truncatedReject, true);
    expect(prompt).toContain('cut off partway through');
    expect(prompt).toContain('FEWER items');
    expect(prompt).not.toContain('Only the ENCODING');
  });

  it('says the call was not wrong, so the model does not change its plan', () => {
    expect(buildToolRepairPrompt(truncatedReject, true)).toContain(
      'Nothing about the call was wrong',
    );
  });

  it('still names which call, so it is not read as the last successful one', () => {
    expect(buildToolRepairPrompt(truncatedReject, true)).toContain(
      'does NOT appear in the conversation above',
    );
  });

  it('falls back to the encoding advice when the response was not truncated', () => {
    expect(buildToolRepairPrompt(truncatedReject, false)).toContain('Only the ENCODING');
  });
});
