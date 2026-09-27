import { describe, expect, it } from 'vitest';
import type { EntityDirectives } from '@aflow/schemas';
import {
  assembleHelmsmanPrompt,
  assembleHelmsmanPromptSections,
  type HelmsmanCapabilities,
} from '../helmsmanPrompt.js';

const directives: EntityDirectives = {
  responsibility: 'General-purpose workspace for testing.',
  priorities: [],
  style: '',
} as unknown as EntityDirectives;

describe('assembleHelmsmanPrompt — Plan 156 §5.6 guidance', () => {
  it('names the human.chat.ask + human.action_center.focus tools', () => {
    const prompt = assembleHelmsmanPrompt({
      entityName: 'Test entity',
      spaceName: 'Test space',
      directives,
      selfModel: undefined,
    });
    expect(prompt).toMatch(/human\.chat\.ask/);
    expect(prompt).toMatch(/human\.action_center\.focus/);
  });

  it('frames the choice as a discriminator (does an Action Center item already exist?)', () => {
    // The whole point of the trimmed §5.6 section is one signal: do
    // you have an item from a listing op, or are you authoring from
    // scratch? If a future edit replaces the discriminator with a
    // long bullet list of when/when-not, the agent's selection
    // accuracy drops (we shipped the trim because the previous list
    // was being skimmed past). Pin both branches of the discriminator
    // and the "got it from a listing" signal that disambiguates them.
    const prompt = assembleHelmsmanPrompt({
      entityName: 'Test entity',
      spaceName: 'Test space',
      directives,
      selfModel: undefined,
    });
    expect(prompt).toMatch(/discriminator/i);
    expect(prompt).toMatch(/proposal\.list/);
    expect(prompt).toMatch(/never invent an id/i);
    expect(prompt).toMatch(/author the question/i);
  });

  it("tells the agent to read each tool's success result for next-step guidance", () => {
    // Finality + "end your turn and wait" used to live in the prompt
    // as standalone copy. They moved into the tool's success-side
    // `note` field (see `HumanActionCenterFocusOutputSchema` in
    // `packages/schemas/src/operations/human.ts`) so the guidance
    // arrives at the moment of use, not as background prose. The
    // prompt's only job here is to point the agent at where to read.
    const prompt = assembleHelmsmanPrompt({
      entityName: 'Test entity',
      spaceName: 'Test space',
      directives,
      selfModel: undefined,
    });
    expect(prompt).toMatch(/success result/i);
  });
});

describe('assembleHelmsmanPrompt — Plan 149 retry-mode + pause-contract guidance', () => {
  const prompt = assembleHelmsmanPrompt({
    entityName: 'Test entity',
    spaceName: 'Test space',
    directives,
    selfModel: undefined,
  });

  it('describes pausedTaskInputContract inline-read with all three resolution modes', () => {
    expect(prompt).toContain('pausedTaskInputContract');
    expect(prompt).toContain('provide_input');
    expect(prompt).toContain('replace_output');
    expect(prompt).toContain('acknowledge');
  });

  it('explains the retry_failed_task mode + suggestedAction branching', () => {
    expect(prompt).toContain('retry_failed_task');
    expect(prompt).toContain('suggestedAction');
    expect(prompt).toContain('preconditions');
  });

  it('warns about side-effectful tasks (retryability: unsafe / unknown)', () => {
    expect(prompt).toContain('Side effects may have occurred');
  });

  it('names the upstream-preserved win and the remediationNote hand-off', () => {
    expect(prompt.toLowerCase()).toContain('upstream');
    expect(prompt).toContain('remediationNote');
  });

  it('forbids substituting workflow.run.start when suggestedAction names workflow.run.resume', () => {
    // The single most expensive failure mode — wastes minutes of
    // upstream work. Pin the prohibition by phrase.
    expect(prompt).toMatch(/never substitute/i);
    expect(prompt).toContain('workflow.run.start');
    expect(prompt).toContain('workflow.run.resume');
  });

  it('defers the operator-resolves-vs-resume decision to the envelope pause.nextStep signal', () => {
    // The harness decides; the prompt must not re-derive it from pauseCause.
    expect(prompt).toContain('pause.nextStep');
    expect(prompt).toContain('operator_resolves_on_run_surface');
  });

  it('keeps both operator-resolves prohibitions and the end-turn instruction', () => {
    // These three read as one paragraph but are independent failure modes:
    // firing the call steals the decision, asking in chat duplicates a surface
    // the operator is already looking at, and continuing past the pause talks
    // over a run the harness will wake us for. Losing any one leaves a prompt
    // that still mentions the mode while permitting the wrong behaviour.
    expect(prompt).toMatch(/do NOT fire the call/);
    expect(prompt).toMatch(/do NOT ask via chat/);
    expect(prompt).toMatch(/End with a one-line pointer to the run/);
  });

  it('keeps all three steps of the re_execute unsafe-task gate', () => {
    // The gate is the three steps TOGETHER, and each is separately deletable:
    // without step 1 the agent cannot tell an unsafe task from a safe one,
    // without step 2 it self-certifies the side-effect check, and without step 3
    // it sets the flag before asking. Asserting only the error code would leave
    // a prompt that names the failure without teaching how to avoid it.
    expect(prompt).toMatch(/deliberately OMITS `remediationConfirmed`/);
    expect(prompt).toMatch(/read `pause\.pausedTaskInputContract\.schema`/);
    expect(prompt).toMatch(/confirm with the operator/);
    expect(prompt).toMatch(/ONLY THEN add `remediationConfirmed: true`/);
    expect(prompt).toContain('RE_EXECUTE_UNSAFE_TASK_REQUIRES_CONFIRMATION');
  });

  it('keeps acknowledge gated on the advertised mode list, and says why', () => {
    // Sending it unadvertised leaves the paused row looking in-flight and the
    // run silently stalls — no error surfaces to correct the agent, so the
    // consequence has to be in the prompt or the rule reads as arbitrary.
    expect(prompt).toMatch(/ONLY when `pause\.allowedResumeModes` lists it/);
    expect(prompt).toMatch(/in-flight and the run stalls/);
  });

  it('still distinguishes a terminal run from a retryable failed one', () => {
    expect(prompt).toMatch(/unconditional dead ends/);
    expect(prompt).toMatch(/on a terminal run is rejected/);
    // The exception is the half that earns the distinction: without it the
    // prompt reads as "failed means done" and the agent discards upstream work
    // that `retry_failed_task` would have preserved.
    expect(prompt).toMatch(/UNLESS a failed task row carries/);
    expect(prompt).toMatch(/`suggestedAction\.op === 'workflow\.run\.resume'`/);
  });

  it('attributes the handoff identity to resumedBy, not to the fixed nextStep literal', () => {
    // `handoffPayload.nextStep` is a `z.literal('released_do_not_poll')` and
    // carries no identity; `resumedBy`/`actorKind` do. Prose that points at
    // `nextStep` for "who took over" sends the agent to a constant.
    expect(prompt).toMatch(/`handoffPayload\.resumedBy`/);
    expect(prompt).not.toMatch(/`handoffPayload\.nextStep` says who/);
  });
});

describe('assembleHelmsmanPrompt — the operating-model section, composed per edition', () => {
  const everything: HelmsmanCapabilities = {
    canRenderInline: true,
    hasIntegrations: true,
    canLinkToRoutes: true,
    canCommissionHarness: true,
    canApplyDiff: true,
    canWriteFiles: true,
    canRunCommands: true,
  };

  const promptWith = (capabilities: HelmsmanCapabilities): string =>
    assembleHelmsmanPrompt({
      spaceName: 'Test space',
      directives,
      selfModel: undefined,
      capabilities,
    });

  const sectionWith = (capabilities: HelmsmanCapabilities): string =>
    assembleHelmsmanPromptSections({
      spaceName: 'Test space',
      directives,
      selfModel: undefined,
      capabilities,
    }).find((s) => s.name === 'operatingModel')?.text ?? '';

  it('carries the section once where a harness can be commissioned', () => {
    const prompt = promptWith(everything);
    expect(prompt.match(/## Operating model/g)).toHaveLength(1);
    expect(prompt).toContain('host.harness.run');
    expect(prompt).toMatch(/acceptance criteria/);
    expect(prompt).toMatch(/Never a draft/);
  });

  it('names every bounded check where all three direct operations are reachable', () => {
    const prompt = promptWith(everything);
    expect(prompt).toContain('bounded to one file read, one command, or one reviewed diff.');
    expect(prompt).toContain('4. Content the operator gave verbatim');
  });

  it('drops the diff clause, and nothing else, where a patch cannot be applied', () => {
    const prompt = promptWith({ ...everything, canApplyDiff: false });
    expect(prompt).toContain('bounded to one file read or one command.');
    expect(prompt).not.toContain('one reviewed diff');
    expect(prompt).toContain('4. Content the operator gave verbatim');
  });

  it('collapses the direct steps where the space can only read', () => {
    // A discovery ceiling that removes the write, patch and shell operations
    // leaves a section that would otherwise instruct what the surface refuses.
    const section = sectionWith({
      ...everything,
      canApplyDiff: false,
      canWriteFiles: false,
      canRunCommands: false,
    });
    expect(section).toContain('Your own checks are reads');
    expect(section).not.toContain('write it yourself');
    expect(section).not.toContain('one command');
    expect(section).not.toContain('one reviewed diff');
    // The steps stay consecutive: with nothing after step 3, there is no step 4.
    expect(section).not.toMatch(/^4\. /m);
  });

  it('withholds it where no harness exists to commission', () => {
    expect(promptWith({ ...everything, canCommissionHarness: false })).not.toContain(
      'Operating model',
    );
  });

  it('leaves the hosted prompt without it, with every other capability present', () => {
    // The hosted edition is exactly this case: everything else reachable, no
    // host lane. Its prompt must not gain a decision order about a machine it
    // has no way to reach.
    const prompt = promptWith({
      canRenderInline: true,
      hasIntegrations: true,
      canLinkToRoutes: true,
      canCommissionHarness: false,
      canApplyDiff: true,
      canWriteFiles: true,
      canRunCommands: true,
    });
    expect(prompt).not.toContain('Operating model');
    expect(prompt).toContain('ui.surface.visualize');
  });
});

describe('assembleHelmsmanPrompt — rendering rubric (lives in the live assembler, not the fallback)', () => {
  const prompt = assembleHelmsmanPrompt({
    spaceName: 'Test space',
    directives,
    selfModel: undefined,
  });

  it('names both ad-hoc render ops so the LLM picks the right one', () => {
    expect(prompt).toContain('ui.artifact.render');
    expect(prompt).toContain('ui.surface.visualize');
  });

  it('teaches restraint after render and the $ref affordance', () => {
    expect(prompt).toMatch(/rendered:\s*true/);
    expect(prompt.toLowerCase()).toContain('do not repeat');
    expect(prompt).toContain('"$ref"');
    expect(prompt).toContain('output.<previousToolCallId>');
  });

  it('includes the canonical worked example', () => {
    expect(prompt).toContain('memory.store.query');
    expect(prompt).toContain('AAPL');
  });
});
