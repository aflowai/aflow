/**
 * `yarn start` says when no orchestrator is consuming, and when one is back —
 * the forty minutes in which every stream on the machine stopped without a
 * line anywhere are what this exists to end.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  ABSENT_READINGS_TO_REPORT,
  INITIAL_ORCHESTRATOR_WATCH,
  ORCHESTRATOR_HEALTH_PATH,
  nextOrchestratorReport,
  readOrchestratorHealth,
} from './orchestratorHealth.mjs';

const NOTICE =
  'No orchestrator is running: messages, step results and cancellations wait until one starts.';
const ALIVE = { alive: true, notice: null, lastHeartbeat: '2026-10-05T12:00:00.000Z' };
const ABSENT = { alive: false, notice: NOTICE, lastHeartbeat: '2026-10-05T11:20:00.000Z' };

/** The lines a run of readings produces, from a fresh watch. */
function linesFor(readings) {
  let watch = INITIAL_ORCHESTRATOR_WATCH;
  const lines = [];
  for (const reading of readings) {
    const report = nextOrchestratorReport(watch, reading);
    watch = report.watch;
    if (report.line !== undefined) lines.push(report.line);
  }
  return lines;
}

describe('the orchestrator watch', () => {
  it('says once that an orchestrator is consuming, and then nothing while it stays', () => {
    expect(linesFor([ALIVE, ALIVE, ALIVE])).toEqual([
      { level: 'info', text: 'an orchestrator is consuming the control, result and timer streams' },
    ]);
  });

  it('warns once an absence has held, with the notice and the last beat, and once only', () => {
    const lines = linesFor([ALIVE, ...Array(ABSENT_READINGS_TO_REPORT + 3).fill(ABSENT)]);

    expect(lines).toHaveLength(2);
    expect(lines[1]?.level).toBe('warn');
    expect(lines[1]?.text).toMatch(new RegExp(`^${NOTICE} The last heartbeat was at `));
  });

  it('says nothing of an absence shorter than that, as a restart or a slow first start is', () => {
    expect(linesFor([ABSENT, ALIVE])).toEqual([
      { level: 'info', text: 'an orchestrator is consuming the control, result and timer streams' },
    ]);
    expect(linesFor([ALIVE, ABSENT, ALIVE])).toHaveLength(1);
  });

  it('says when one is consuming again', () => {
    const lines = linesFor([ALIVE, ABSENT, ABSENT, ALIVE]);
    expect(lines.at(-1)).toEqual({ level: 'info', text: 'an orchestrator is consuming again' });
  });

  it('warns of an orchestrator that never registered, from the first readings', () => {
    const never = { alive: false, notice: NOTICE, lastHeartbeat: null };
    expect(linesFor([never, never])).toEqual([
      { level: 'warn', text: `${NOTICE} No orchestrator heartbeat is on record.` },
    ]);
  });

  it('takes an API that did not answer as no reading, not as an absence', () => {
    expect(linesFor([ALIVE, undefined, undefined, undefined])).toHaveLength(1);
  });
});

describe('reading the API', () => {
  it('asks the orchestrator route and keeps what the watch reads', async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({ ...ABSENT, heartbeatAgeMs: 2_400_000 }, { status: 200 }),
    );

    expect(await readOrchestratorHealth('http://localhost:3000', fetchFn)).toEqual(ABSENT);
    expect(fetchFn).toHaveBeenCalledWith(
      `http://localhost:3000${ORCHESTRATOR_HEALTH_PATH}`,
      expect.anything(),
    );
  });

  it('gives no reading for a refusal, a failure or a body it does not recognise', async () => {
    const api = 'http://localhost:3000';
    expect(await readOrchestratorHealth(api, async () => Response.json({}, { status: 503 }))).toBe(
      undefined,
    );
    expect(
      await readOrchestratorHealth(api, async () => {
        throw new TypeError('fetch failed');
      }),
    ).toBe(undefined);
    expect(await readOrchestratorHealth(api, async () => Response.json({ ok: true }))).toBe(
      undefined,
    );
  });
});
