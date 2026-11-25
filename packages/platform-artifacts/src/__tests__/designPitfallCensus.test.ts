import { describe, expect, it } from 'vitest';
import { materializeAndValidateSkillConfig } from '@aflow/cybernetic-runtime';
import { SKILL_CATALOG } from '../skillCatalog.js';

/**
 * Every design pitfall the catalog's own skills still carry. Each check is a
 * warning, so none of these blocks a skill. The list is the open work: a fix
 * removes its line, and a new pitfall fails here until it is fixed or added
 * on purpose. The evidence for each check is in
 * `.claude/skills/cybernetic-skill-authoring/SKILL.md`, under Pitfalls.
 */
const KNOWN_PITFALLS = [
  'campaign-successor model_copy_task read-boundary-ledger',
  'campaign-successor nullable_input_reading_unstated read-boundary-ledger.campaign',
  'daily-trading-cycle nullable_input_reading_unstated decide.fractionalTrading',
  'daily-trading-cycle nullable_input_reading_unstated execute-orders.slotIndex',
  'daily-trading-cycle nullable_input_reading_unstated reflect.cycleDoc',
  'daily-trading-cycle nullable_input_reading_unstated reflect.snapshot',
  'daily-trading-cycle record_reads_superseded_state record<-ingest-account',
  'daily-trading-cycle record_reads_superseded_state record<-ingest-positions',
  'strategy-desk model_copy_task read-ledger',
  'strategy-desk nullable_input_reading_unstated read-ledger.hypotheses',
  'strategy-desk nullable_input_reading_unstated read-ledger.universe',
  'trading-reflection model_copy_task read-day',
];

const PITFALL_CODES = new Set([
  'model_copy_task',
  'write_parent_unproduced',
  'record_reads_superseded_state',
  'nullable_input_reading_unstated',
  'dropped_config_field_named',
]);

describe('design pitfalls the catalog carries', () => {
  it('are the known ones, every one a warning', () => {
    const found = SKILL_CATALOG.flatMap((entry) => {
      const wf = entry.bundle.workflow;
      const { validity } = materializeAndValidateSkillConfig({
        tasks: wf.tasks,
        runInputs: wf.runInputs,
      });
      expect(validity.diagnostics.filter((d) => PITFALL_CODES.has(d.code))).toEqual([]);
      return validity.advisories
        .filter((d) => PITFALL_CODES.has(d.code))
        .map((d) => {
          const at = d.field
            ? `${d.taskId ?? ''}.${d.field}`
            : d.producerTaskId
              ? `${d.taskId ?? ''}<-${d.producerTaskId}`
              : (d.taskId ?? '');
          return `${entry.catalogId} ${d.code} ${at}`;
        });
    }).sort();
    expect(found).toEqual(KNOWN_PITFALLS);
  });
});
