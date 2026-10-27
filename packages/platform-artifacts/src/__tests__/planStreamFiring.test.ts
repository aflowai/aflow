/**
 * Plan 322 P2b — a stream continues on a schedule. The firing reads the rounds
 * of the catalog's commission and publication by their slugs, so those must
 * be the skills' own; the schedule's message names the stream and its budget
 * and nothing else; and the operation it asks first is the Helmsman's to
 * find, not a tool on every turn.
 */
import { describe, expect, it } from 'vitest';
import {
  FlowScheduleCreateInputSchema,
  getOperation,
  harnessPostureFor,
  isPlanResidentSchedule,
  PLAN_RESIDENT_SCHEDULE_CRON,
  PLAN_RESIDENT_SCHEDULE_VARIABLE,
  planResidentScheduleInput,
  resolveInputTemplate,
  PLAN_NODE_NEXT_OPERATION_ID,
  PLAN_STREAM_ATTEMPTS_DEFAULT,
  PLAN_STREAM_COMMISSION_SLUG,
  PLAN_STREAM_PUBLICATION_SLUG,
  PLAN_STREAM_SCHEDULE_TARGET,
  planStreamScheduleInput,
} from '@aflow/schemas';
import { CYBERNETIC_AGENTS, HELMSMAN_DISCOVERY_PRESET } from '../cyberneticAgents.js';
import { COMMISSION_CHANGE } from '../skillCatalog/commissionChange.js';
import { PUBLISH_LOCAL_CHANGES } from '../skillCatalog/publishLocalChanges.js';

const ROOT = '5e1d0000-0000-4000-8000-000000000322';

function helmsmanCoreOperations(): string[] {
  const agent = CYBERNETIC_AGENTS.find((a) => a.flowId === PLAN_STREAM_SCHEDULE_TARGET.systemRole);
  const step = (agent?.steps as Array<Record<string, unknown>> | undefined)?.find(
    (s) => s['stepId'] === 'agent',
  );
  const catalog = (step?.['config'] as Record<string, unknown> | undefined)?.['catalog'] as
    { coreOperations?: string[] } | undefined;
  return catalog?.coreOperations ?? [];
}

describe('a stream’s schedule (Plan 322 P2b)', () => {
  it('reads the rounds of the catalog’s own commission and publication', () => {
    expect(COMMISSION_CHANGE.bundle.workflow.slug).toBe(PLAN_STREAM_COMMISSION_SLUG);
    expect(PUBLISH_LOCAL_CHANGES.bundle.workflow.slug).toBe(PLAN_STREAM_PUBLICATION_SLUG);
  });

  it('starts the Helmsman with a message naming only the root and the budget', () => {
    const input = planStreamScheduleInput(ROOT);
    const schedule = FlowScheduleCreateInputSchema.safeParse({
      name: 'Continue Plan 322',
      action: 'start_run',
      target: PLAN_STREAM_SCHEDULE_TARGET,
      cron: '*/15 * * * *',
      input,
    });
    expect(schedule.success).toBe(true);
    expect(input.input).toContain(PLAN_NODE_NEXT_OPERATION_ID);
    expect(input.input).toContain(
      JSON.stringify({ rootNodeId: ROOT, attempts: PLAN_STREAM_ATTEMPTS_DEFAULT }),
    );
    expect(CYBERNETIC_AGENTS.some((a) => a.flowId === PLAN_STREAM_SCHEDULE_TARGET.systemRole)).toBe(
      true,
    );
  });

  it('leaves plan.node.next discoverable on the Helmsman, never pinned on every turn', () => {
    expect(HELMSMAN_DISCOVERY_PRESET).toContain(PLAN_NODE_NEXT_OPERATION_ID);
    expect(helmsmanCoreOperations()).not.toContain(PLAN_NODE_NEXT_OPERATION_ID);
    const op = getOperation(PLAN_NODE_NEXT_OPERATION_ID);
    expect(op).toMatchObject({ agentTool: true, mutates: false, accessMode: 'read' });
  });
});

describe('the resident schedule (Plan 331 D1)', () => {
  const helmsman = () =>
    CYBERNETIC_AGENTS.find((a) => a.flowId === PLAN_STREAM_SCHEDULE_TARGET.systemRole);

  it('is one agent.schedule.create the operator makes: the Helmsman, every fifteen minutes, naming no root', () => {
    const input = planResidentScheduleInput();
    const schedule = FlowScheduleCreateInputSchema.safeParse({
      name: 'Resident',
      action: 'start_run',
      target: PLAN_STREAM_SCHEDULE_TARGET,
      cron: PLAN_RESIDENT_SCHEDULE_CRON,
      input,
    });
    expect(schedule.success).toBe(true);
    expect(PLAN_RESIDENT_SCHEDULE_CRON).toBe('*/15 * * * *');
    expect(input.input).toContain(PLAN_NODE_NEXT_OPERATION_ID);
    expect(input.input).not.toContain('rootNodeId":');
    expect(
      isPlanResidentSchedule({
        targetKind: PLAN_STREAM_SCHEDULE_TARGET.kind,
        targetSystemRole: PLAN_STREAM_SCHEDULE_TARGET.systemRole,
        inputTemplate: input,
      }),
    ).toBe(true);
  });

  it('hands each wake its own schedule, a config the Helmsman declares, so the wake renews it', async () => {
    const resolved = await resolveInputTemplate(planResidentScheduleInput(), {
      schedule: { id: 'sched-1' },
    });
    expect(resolved).toMatchObject({ config: { [PLAN_RESIDENT_SCHEDULE_VARIABLE]: 'sched-1' } });
    const declared = helmsman()?.stateVariables.find(
      (v) => v.variableId === PLAN_RESIDENT_SCHEDULE_VARIABLE,
    );
    expect(declared).toMatchObject({ inputRole: 'config', lifecycle: { isInput: true } });
  });
});

describe('the resident’s commissions stay open (Plan 328 D6, Plan 331 §6)', () => {
  it('a commission a wake started compiles open on a trusted folder: a schedule’s exchange is no operator message', () => {
    const wake = { activatedByPerson: false };
    expect(harnessPostureFor('trusted', wake)).toBe('open');
    expect(harnessPostureFor('open', wake)).toBe('open');
    expect(harnessPostureFor('confined', wake)).toBe('confined');
    expect(harnessPostureFor('trusted', { activatedByPerson: true })).toBe('trusted');
  });
});
