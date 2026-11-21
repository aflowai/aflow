import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { lookupValidator } from '@aflow/schemas';
import { getSkillCatalogEntry } from '@aflow/platform-artifacts';
import {
  TRADING_APPROVED_THESES_VALIDATOR_REF,
  readApprovedSet,
} from '../scheduling/tradingApprovedThesesValidator.js';

/** Each query the loader builds, as it built it, answered with the next scripted rows. */
interface RecordedQuery {
  fields: Record<string, unknown>;
  joins: SQL[];
  where?: SQL;
  limit?: number;
}

const tenancy = vi.hoisted(() => ({
  answers: [] as unknown[][],
  queries: [] as RecordedQuery[],
  failure: undefined as Error | undefined,
}));

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  const tx = {
    select(fields: Record<string, unknown>) {
      const query: RecordedQuery = { fields, joins: [] };
      const rows = tenancy.answers[tenancy.queries.length] ?? [];
      tenancy.queries.push(query);
      const chain = {
        from: () => chain,
        leftJoin: (_table: unknown, on: SQL) => {
          query.joins.push(on);
          return chain;
        },
        where: (condition: SQL) => {
          query.where = condition;
          return chain;
        },
        limit: (n: number) => {
          query.limit = n;
          return Promise.resolve(rows);
        },
      };
      return chain;
    },
  };
  return {
    ...actual,
    withTenantSchema: (_db: unknown, _tenant: unknown, fn: (t: typeof tx) => unknown) => {
      if (tenancy.failure) return Promise.reject(tenancy.failure);
      return fn(tx);
    },
  };
});

const SPACE = '0b7c6f1e-58b6-4cf3-9a8f-1e2d3c4b5a69';
const SET_PATH = '/research/2026-07-14/approved-theses.json';
const ctx = { tenantId: '5d1e2a4b-7c3f-4e8a-9b6d-0f1e2d3c4b5a', spaceId: SPACE, db: {} };
const dialect = new PgDialect();
const render = (condition: SQL | undefined) => dialect.sqlToQuery(condition!);

const ENTRY = {
  approvedId: 'aapl-breakout-1',
  instrument: 'AAPL',
  direction: 'long',
  entryLevel: 187.4,
  invalidationLevel: 184,
  confirmationLevel: 195,
  maxSizePct: 5,
  horizonTradingDays: 3,
  reviewerVerdict: 'approved',
  reviewRunId: 'run-review-0714',
};
const SET = { tradingDay: '2026-07-14', slots: { open: [ENTRY] } };
const THESIS = {
  thesisId: 'aapl-2',
  approvedId: 'aapl-breakout-1',
  reviewRunId: 'run-review-0714',
  instrument: 'AAPL',
  direction: 'long',
  sizePct: 5,
  deadlineTradingDays: 3,
};

function decision(theses: unknown[]) {
  return {
    tradingDay: '2026-07-14',
    slot: 'open',
    slotIndex: null,
    theses,
    projectedGrossExposurePct: 0,
    decisionRationale: 'Breakout setup on AAPL.',
  };
}

/** The current version row the document query answers with. */
function version(overrides: Record<string, unknown> = {}) {
  return { version: 2, content: JSON.stringify(SET), sessionId: null, actor: 'api', ...overrides };
}

function runtimeValidator() {
  const v = lookupValidator(TRADING_APPROVED_THESES_VALIDATOR_REF);
  if (v?.kind !== 'runtime')
    throw new Error('approved-theses validator is not a runtime validator');
  return v.fn;
}

beforeEach(() => {
  tenancy.answers = [];
  tenancy.queries = [];
  tenancy.failure = undefined;
});

describe('trading.approved-theses runtime validator', () => {
  it('is the ref the daily-trading-cycle decide contract names', () => {
    const decide = getSkillCatalogEntry('daily-trading-cycle')?.bundle.workflow.tasks.find(
      (t) => t.taskId === 'decide',
    );
    expect(decide?.outputContract?.validatorRefs).toContain(TRADING_APPROVED_THESES_VALIDATOR_REF);
  });

  it('reads a found, well-formed set from its current version and approves its entries', async () => {
    tenancy.answers = [[version()]];
    expect(await readApprovedSet(ctx, SET_PATH)).toEqual({
      status: 'found',
      content: SET,
      writer: { kind: 'operator', actor: 'api' },
    });
    // One live document of this space at this path, joined to its current version.
    const [doc] = tenancy.queries;
    expect(tenancy.queries).toHaveLength(1);
    expect(Object.keys(doc!.fields).sort()).toEqual(['actor', 'content', 'sessionId', 'version']);
    const where = render(doc!.where);
    expect(where.sql).toBe(
      '("memory_docs"."space_id" = $1 and "memory_docs"."path" = $2 and "memory_docs"."deleted_at" is null)',
    );
    expect(where.params).toEqual([SPACE, SET_PATH]);
    expect(render(doc!.joins[0]).sql).toBe(
      '("memory_doc_versions"."doc_id" = "memory_docs"."id" and "memory_doc_versions"."version" = "memory_docs"."current_version")',
    );
    expect(doc!.limit).toBe(1);

    tenancy.queries = [];
    tenancy.answers = [[version()]];
    expect(await runtimeValidator()(decision([THESIS]), ctx)).toEqual([]);
  });

  it('refuses a set the decide session wrote for itself, traced through the run records', async () => {
    tenancy.answers = [
      [version({ sessionId: 'decide-session', actor: 'executor' })],
      [
        {
          runId: 'run-cycle-0714',
          workflowSlug: 'daily-trading-cycle',
          status: 'running',
          spaceId: SPACE,
        },
      ],
    ];
    const issues = await runtimeValidator()(decision([THESIS]), ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'custom', path: [] });
    expect(issues[0]!.message).toContain('A cycle cannot approve its own theses');
    // The writer's session is looked up as the run's own session and as any task's.
    const runs = render(tenancy.queries[1]!.where);
    expect(runs.sql).toBe(
      '("workflow_runs"."session_id" = $1 or "workflow_run_tasks"."worker_session_id" = $2 or "workflow_run_tasks"."session_id" = $3)',
    );
    expect(runs.params).toEqual(['decide-session', 'decide-session', 'decide-session']);
    expect(render(tenancy.queries[1]!.joins[0]).sql).toBe(
      '"workflow_run_tasks"."run_id" = "workflow_runs"."run_id"',
    );
  });

  it('accepts a set a completed review run of another skill wrote', async () => {
    tenancy.answers = [
      [version({ sessionId: 'review-session', actor: 'executor' })],
      [
        {
          runId: 'run-review-0714',
          workflowSlug: 'strategy-desk',
          status: 'completed',
          spaceId: SPACE,
        },
      ],
    ];
    expect(await runtimeValidator()(decision([THESIS]), ctx)).toEqual([]);
  });

  it('a missing set is resolve-only: an empty decision passes and a thesis is refused', async () => {
    tenancy.answers = [[]];
    expect(await readApprovedSet(ctx, SET_PATH)).toEqual({ status: 'missing' });
    tenancy.answers = [[]];
    expect(await runtimeValidator()(decision([]), ctx)).toEqual([]);
    tenancy.queries = [];
    tenancy.answers = [[]];
    const [issue] = await runtimeValidator()(decision([THESIS]), ctx);
    expect(issue!.message).toContain('resolve-only');
  });

  it.each([
    [
      'the database fails',
      () => (tenancy.failure = new Error('connection reset')),
      'connection reset',
    ],
    [
      'the content is not JSON',
      () => (tenancy.answers = [[version({ content: '{"tradingDay":' })]]),
      'not JSON',
    ],
    [
      'the current version is not recorded',
      () => (tenancy.answers = [[version({ version: null, content: null })]]),
      'not recorded',
    ],
    [
      'no writer is recorded',
      () => (tenancy.answers = [[version({ actor: null })]]),
      'records no writer',
    ],
  ])(
    'fails the submission visibly when %s, even with no theses',
    async (_label, arrange, reason) => {
      arrange();
      const issues = await runtimeValidator()(decision([]), ctx);
      expect(issues).toHaveLength(1);
      expect(issues[0]!.message).toContain('cannot be read');
      expect(issues[0]!.message).toContain(reason);
      expect(issues[0]!.message).toContain('blocked-signal');
    },
  );
});
