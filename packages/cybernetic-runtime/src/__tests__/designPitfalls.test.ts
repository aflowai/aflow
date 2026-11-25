import { describe, expect, it } from 'vitest';
import { getSkillBundleEntry, getSkillCatalogEntry } from '@aflow/platform-artifacts';
import type { SkillCampaignContract, WorkflowTask } from '@aflow/schemas';
import { materializeAndValidateSkillConfig } from '../skillValidity/skillValidity.js';
import { danglingApiDefinitionWarnings } from '../operationTaskApiRefs.js';

/**
 * Each design pitfall, composed as a small skill that commits it. The check
 * must fire, and it must leave the skill valid: a pitfall is a warning.
 */

const task = (t: Record<string, unknown>): WorkflowTask => t as unknown as WorkflowTask;

function compose(
  tasks: WorkflowTask[],
  campaign?: { contract?: SkillCampaignContract; previousContract?: SkillCampaignContract },
) {
  return materializeAndValidateSkillConfig({ tasks, ...(campaign ? { campaign } : {}) }).validity;
}

function codes(validity: ReturnType<typeof compose>, code: string) {
  return validity.advisories.filter((d) => d.code === code);
}

const OBJECT_OUT = (properties: Record<string, unknown>) => ({
  schema: { type: 'object', required: Object.keys(properties), properties },
});

describe('model_copy_task', () => {
  it('flags an agent asked to copy documents, and stays a warning', () => {
    const validity = compose([
      task({
        taskId: 'read-day',
        type: 'agent',
        goal: 'Gather the day. Copy each cycle doc whole into your output. Form no view, and judge nothing.',
        outputContract: OBJECT_OUT({ cycles: { type: 'array' } }),
      }),
    ]);
    expect(validity.status).toBe('valid');
    expect(codes(validity, 'model_copy_task')).toEqual([
      expect.objectContaining({ taskId: 'read-day', severity: 'advisory' }),
    ]);
  });

  it('flags an agent whose output mirrors its inputs one to one', () => {
    const validity = compose([
      task({ taskId: 'read', type: 'operation', operation: 'memory.store.get' }),
      task({
        taskId: 'echo',
        type: 'agent',
        goal: 'Return the note.',
        inputBindings: { note: { kind: 'task_output', taskId: 'read' } },
        outputContract: OBJECT_OUT({ note: { type: 'object' } }),
      }),
    ]);
    expect(codes(validity, 'model_copy_task').map((d) => d.taskId)).toEqual(['echo']);
  });

  it('leaves an agent that copies and then judges', () => {
    const validity = compose([
      task({
        taskId: 'review',
        type: 'agent',
        goal: 'Copy the candidate list into your output. Then decide which candidate to trade.',
        outputContract: OBJECT_OUT({ chosen: { type: 'string' } }),
      }),
    ]);
    expect(codes(validity, 'model_copy_task')).toEqual([]);
  });
});

describe('write_parent_unproduced', () => {
  const memo = (extra: Record<string, unknown>) =>
    task({
      taskId: 'write-folder-memo',
      type: 'operation',
      operation: 'host.file.put',
      inputBindings: { tradingDay: { kind: 'run_input', path: 'tradingDay' } },
      inputTemplate: {
        bindingId: 'hb',
        path: { $concat: ['research/', { $bind: 'tradingDay' }, '/memo.md'] },
        content: 'memo',
        ...extra,
      },
    });

  it('flags a folder write under a directory no task creates', () => {
    const validity = compose([memo({})]);
    expect(validity.status).toBe('valid');
    expect(codes(validity, 'write_parent_unproduced')).toEqual([
      expect.objectContaining({
        taskId: 'write-folder-memo',
        operationId: 'host.file.put',
        severity: 'advisory',
      }),
    ]);
  });

  it('leaves a write that creates its parents', () => {
    expect(codes(compose([memo({ createParents: true })]), 'write_parent_unproduced')).toEqual([]);
  });

  it('leaves a write whose directory an earlier write created', () => {
    const first = task({
      taskId: 'write-index',
      type: 'operation',
      operation: 'host.file.put',
      inputBindings: { tradingDay: { kind: 'run_input', path: 'tradingDay' } },
      inputTemplate: {
        bindingId: 'hb',
        path: { $concat: ['research/', { $bind: 'tradingDay' }, '/index.md'] },
        content: 'index',
        createParents: true,
      },
    });
    const second = { ...memo({}), dependsOn: ['write-index'] } as WorkflowTask;
    expect(codes(compose([first, second]), 'write_parent_unproduced')).toEqual([]);
  });

  it('leaves a memory write, which creates its own parents', () => {
    const validity = compose([
      task({
        taskId: 'write-doc',
        type: 'operation',
        operation: 'memory.store.put',
        inputTemplate: { path: '/research/day/memo.json', content: { inlineText: 'x' } },
      }),
    ]);
    expect(codes(validity, 'write_parent_unproduced')).toEqual([]);
  });
});

describe('record_reads_superseded_state', () => {
  const ingest = task({
    taskId: 'ingest-positions',
    type: 'operation',
    operation: 'api.http.call',
    inputTemplate: { apiId: 'acme-account-read', endpointId: 'get_positions' },
  });
  const execute = task({
    taskId: 'execute-orders',
    type: 'agent',
    goal: 'Decide and submit the orders.',
    dependsOn: ['ingest-positions'],
    context: {
      capabilities: {
        integrations: [
          {
            sourceKind: 'api',
            integrationId: 'acme-orders-write',
            toolNames: [{ toolName: 'post_orders' }],
          },
        ],
      },
    },
  });
  const record = (goal: string) =>
    task({
      taskId: 'record',
      type: 'agent',
      goal,
      dependsOn: ['execute-orders'],
      inputBindings: {
        positions: { kind: 'task_output', taskId: 'ingest-positions', path: 'positions' },
      },
    });

  it('flags a record that reads state a write in the same run changed', () => {
    const validity = compose([
      ingest,
      execute,
      record('Write the cycle snapshot of the positions.'),
    ]);
    expect(validity.status).toBe('valid');
    expect(codes(validity, 'record_reads_superseded_state')).toEqual([
      expect.objectContaining({
        taskId: 'record',
        producerTaskId: 'ingest-positions',
        severity: 'advisory',
      }),
    ]);
  });

  it('leaves a record whose prose labels its vantage', () => {
    const validity = compose([
      ingest,
      execute,
      record('Write the snapshot. `positions` is ingest-positions as read before the orders.'),
    ]);
    expect(codes(validity, 'record_reads_superseded_state')).toEqual([]);
  });

  it('leaves a read of a service the run never writes', () => {
    const calendar = task({
      taskId: 'ingest-positions',
      type: 'operation',
      operation: 'api.http.call',
      inputTemplate: { apiId: 'market-calendar', endpointId: 'get_day' },
    });
    const validity = compose([calendar, execute, record('Write the cycle snapshot.')]);
    expect(codes(validity, 'record_reads_superseded_state')).toEqual([]);
  });
});

describe('nullable_input_reading_unstated', () => {
  const config = task({
    taskId: 'ingest-account-config',
    type: 'operation',
    operation: 'api.http.call',
    inputTemplate: { apiId: 'acme-account-read', endpointId: 'get_config' },
    outputProjection: { fractionalTrading: { path: 'data.fractional', onMissing: 'null' } },
  });
  const sizer = (goal: string) =>
    task({
      taskId: 'size-entries',
      type: 'agent',
      goal,
      dependsOn: ['ingest-account-config'],
      inputBindings: {
        fractionalTrading: {
          kind: 'task_output',
          taskId: 'ingest-account-config',
          path: 'fractionalTrading',
        },
      },
    });

  it('flags a nullable input whose null reading the prose never states', () => {
    const validity = compose([config, sizer('Size each entry. Use `fractionalTrading` to pick.')]);
    expect(validity.status).toBe('valid');
    expect(codes(validity, 'nullable_input_reading_unstated')).toEqual([
      expect.objectContaining({
        taskId: 'size-entries',
        field: 'fractionalTrading',
        producerTaskId: 'ingest-account-config',
        severity: 'advisory',
      }),
    ]);
  });

  it('leaves an input whose line states the null reading', () => {
    const goal =
      'Size each entry.\n- `fractionalTrading` — null where the account omits it: size in whole shares.';
    expect(codes(compose([config, sizer(goal)]), 'nullable_input_reading_unstated')).toEqual([]);
  });
});

describe('dropped_config_field_named', () => {
  const contract = (fields: string[]): SkillCampaignContract =>
    ({
      fields: Object.fromEntries(fields.map((f) => [f, { schema: { type: 'number' } }])),
    }) as unknown as SkillCampaignContract;
  const decide = (goal: string) => task({ taskId: 'decide', type: 'agent', goal });

  it('flags prose that still names a field the new version dropped', () => {
    const validity = compose([decide('Open no more than maxThesesPerDay theses.')], {
      contract: contract(['universe']),
      previousContract: contract(['universe', 'maxThesesPerDay']),
    });
    expect(validity.status).toBe('valid');
    expect(codes(validity, 'dropped_config_field_named')).toEqual([
      expect.objectContaining({ taskId: 'decide', field: 'maxThesesPerDay' }),
    ]);
  });

  it('leaves a mention marked inert, and a field the version kept', () => {
    const validity = compose(
      [decide('An older doc may name maxThesesPerDay. It is inert.\nRead universe.')],
      {
        contract: contract(['universe']),
        previousContract: contract(['universe', 'maxThesesPerDay']),
      },
    );
    expect(codes(validity, 'dropped_config_field_named')).toEqual([]);
  });

  it('runs only where a caller holds the previous contract', () => {
    const validity = compose([decide('Open no more than maxThesesPerDay theses.')], {
      contract: contract(['universe']),
    });
    expect(codes(validity, 'dropped_config_field_named')).toEqual([]);
  });
});

describe('dangling API definition at install', () => {
  it('warns on a skill naming a definition the space does not hold', () => {
    const warnings = danglingApiDefinitionWarnings(
      [
        {
          slug: 'calendar-reader',
          tasks: [
            {
              taskId: 'ingest-calendar',
              operation: 'api.http.call',
              optional: true,
              inputTemplate: { apiId: 'market-calendar', endpointId: 'get_day' },
            },
          ],
        },
      ],
      new Set(['acme-account-read']),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("'market-calendar'");
    expect(warnings[0]).toContain("'ingest-calendar'");
  });

  it('warns on an integration grant as well as an operation task', () => {
    const warnings = danglingApiDefinitionWarnings(
      [
        {
          slug: 'orders',
          tasks: [
            {
              taskId: 'execute',
              context: {
                capabilities: {
                  integrations: [{ sourceKind: 'api', integrationId: 'acme-orders-write' }],
                },
              },
            },
          ],
        },
      ],
      new Set(),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("'acme-orders-write'");
  });

  it('finds the calendar source the Alpaca bundle names and ships no definition for', () => {
    const bundle = getSkillBundleEntry('alpaca-thesis-trading');
    if (!bundle) throw new Error('alpaca-thesis-trading must be in the bundle catalog');
    const shipped = new Set(bundle.apiDefinitions.map((d) => d.apiId));
    const skills = bundle.skillCatalogIds.flatMap((id) => {
      const entry = getSkillCatalogEntry(id);
      return entry
        ? [{ slug: entry.bundle.workflow.slug, tasks: entry.bundle.workflow.tasks }]
        : [];
    });
    const warnings = danglingApiDefinitionWarnings(skills, shipped);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.every((w) => w.includes("'market-calendar'"))).toBe(true);
  });
});
