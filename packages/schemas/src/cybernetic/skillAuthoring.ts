import { z } from 'zod';

import { WorkflowSchema } from '../operations/workflow.js';
import { SkillManifestSchema } from './skill.js';
import { CyberneticEvalSuiteSchema } from './eval.js';

/**
 * Per-artifact version tokens an authoring save preconditions on, so a partial
 * edit merges against the exact docs the editor saw — and a concurrent change
 * to an artifact the editor never touched is detected, not clobbered.
 *
 * The workflow doc carries a real monotonic `revision` (and the activation
 * subtree lives inside it, so the revision guards activation too). The manifest
 * and eval suite have no native version, so their tokens are canonical content
 * hashes — `manifestHash` over the operator-editable surface (goal + campaign
 * contract), `evalSuiteHash` over the whole suite.
 */
export const SkillAuthoringTokensSchema = z.object({
  workflowRevision: z.number().int().nonnegative(),
  manifestHash: z.string().nullable(),
  evalSuiteHash: z.string().nullable(),
});
export type SkillAuthoringTokens = z.infer<typeof SkillAuthoringTokensSchema>;

/**
 * The full skill, server-assembled, for the designer to edit losslessly. Every
 * artifact a surface might preserve is present (workflow incl. activation,
 * manifest goal + campaign contract, eval suite) plus the tokens the save pins.
 */
export const SkillAuthoringSnapshotSchema = z.object({
  workflow: WorkflowSchema,
  manifest: SkillManifestSchema.nullable(),
  evalSuite: CyberneticEvalSuiteSchema.nullable(),
  tokens: SkillAuthoringTokensSchema,
});
export type SkillAuthoringSnapshot = z.infer<typeof SkillAuthoringSnapshotSchema>;
