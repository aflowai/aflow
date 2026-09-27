/**
 * The step budget must contain the poll budget. When it did not, the executor
 * reaped video steps at 120s while the handler polled for 300s — after the
 * provider had been paid.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';
import { AiHandler } from '../AiHandler.js';
import {
  resolveVideoBudget,
  ASYNC_JOB_LIFECYCLE_OPERATIONS,
  VIDEO_POLL_INTERVAL_MS,
} from './mediaBudget.js';

const handler = new AiHandler({ payloadStore: {} as never });

const HANDLERS_DIR = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * Which exported handler each AI operation is wired to, read out of the
 * registration itself. Deriving it from a second list here would reproduce the
 * drift the registry-backed set exists to remove.
 */
function operationHandlerNames(): Map<string, string> {
  const aiHandler = source(join(HANDLERS_DIR, '..', 'AiHandler.ts'));
  const mapStart = aiHandler.indexOf('this.operations = {');
  expect(
    mapStart,
    'AiHandler no longer registers operations as `this.operations = {`',
  ).toBeGreaterThan(-1);
  const mapEnd = aiHandler.indexOf('\n    };', mapStart);
  const body = aiHandler.slice(mapStart, mapEnd);

  const aliased = new Map<string, string>();
  for (const match of aiHandler
    .slice(0, mapStart)
    .matchAll(/const (\w+) = \{[\s\S]{0,400}?handler:[\s\S]{0,300}?(handle[A-Z]\w*)\(/g)) {
    aliased.set(match[1] as string, match[2] as string);
  }

  const keys = Array.from(body.matchAll(/'([a-z]\w*(?:\.\w+)+)':/g));
  const names = new Map<string, string>();
  keys.forEach((match, index) => {
    const operationId = match[1] as string;
    const from = (match.index ?? 0) + match[0].length;
    const to = index + 1 < keys.length ? (keys[index + 1]?.index ?? body.length) : body.length;
    const segment = body.slice(from, to);
    const inline = /handle[A-Z]\w*/.exec(segment);
    const aliasMatch = /^\s*(\w+),/.exec(segment);
    const handlerName = inline ? inline[0] : aliased.get(aliasMatch?.[1] ?? '');
    expect(handlerName, `no handler resolved for "${operationId}"`).toBeDefined();
    names.set(operationId, handlerName as string);
  });
  return names;
}

/** Which exported handler lives in which module, read out of the barrel. */
function handlerModulePaths(): Map<string, string> {
  const barrel = source(join(HANDLERS_DIR, 'index.ts'));
  const paths = new Map<string, string>();
  for (const match of barrel.matchAll(/export \{ (\w+) \} from '\.\/([\w.]+)\.js';/g)) {
    paths.set(match[1] as string, join(HANDLERS_DIR, `${match[2] as string}.ts`));
  }
  return paths;
}

/** The operations that actually drive a provider job past the end of the request. */
function operationsDrivingTheVideoJobRunner(): Set<string> {
  const modules = handlerModulePaths();
  const driving = new Set<string>();
  for (const [operationId, handlerName] of operationHandlerNames()) {
    const modulePath = modules.get(handlerName);
    expect(modulePath, `handler "${handlerName}" is not exported from the barrel`).toBeDefined();
    if (/\brunVideoJob\s*\(/.test(source(modulePath as string))) {
      driving.add(operationId);
    }
  }
  return driving;
}

function ctx(operationId: string, executionTimeoutMs?: number): ExecutorContext {
  return {
    operationId,
    stepDefinition:
      executionTimeoutMs !== undefined ? { timeout: { executionTimeoutMs } } : undefined,
  } as unknown as ExecutorContext;
}

describe('video step budget vs poll budget', () => {
  it('leaves room outside the poll loop for the submit and the download', () => {
    const budget = resolveVideoBudget();
    expect(budget.pollBudgetMs).toBeLessThan(budget.stepBudgetMs);
    expect(budget.pollBudgetMs).toBeGreaterThanOrEqual(VIDEO_POLL_INTERVAL_MS);
  });

  it('caps the poll budget under any operator step timeout', () => {
    for (const stepTimeoutMs of [30_000, 120_000, 300_000, 900_000, 3_600_000]) {
      const budget = resolveVideoBudget(stepTimeoutMs);
      expect(budget.stepBudgetMs).toBe(stepTimeoutMs);
      expect(budget.pollBudgetMs).toBeLessThan(stepTimeoutMs);
    }
  });

  it('gives every lifecycle operation a step timeout that covers its poll budget', async () => {
    for (const operationId of ASYNC_JOB_LIFECYCLE_OPERATIONS) {
      const resolved = await handler.resolveTimeoutMs(ctx(operationId));
      expect(typeof resolved).toBe('number');
      expect(resolved).toBe(resolveVideoBudget().stepBudgetMs);
      expect(resolved as number).toBeGreaterThan(resolveVideoBudget().pollBudgetMs);
    }
  });

  it('yields to an explicit step timeout, which then caps the poll budget instead', async () => {
    for (const operationId of ASYNC_JOB_LIFECYCLE_OPERATIONS) {
      expect(await handler.resolveTimeoutMs(ctx(operationId, 240_000))).toBeUndefined();
      expect(resolveVideoBudget(240_000).pollBudgetMs).toBeLessThan(240_000);
    }
  });
});

describe('the lifecycle set covers every operation that polls a provider', () => {
  it('finds the wiring it claims to read', () => {
    const wired = operationHandlerNames();
    expect(wired.get('ai.media.video')).toBe('handleVideoGenerate');
    expect(wired.get('ai.media.animate')).toBe('handleVideoFromImage');
    expect(wired.get('ai.text.generate')).toBe('handleGenerate');
  });

  it('matches the operations whose handler reaches the video job runner', () => {
    const driving = operationsDrivingTheVideoJobRunner();
    expect(driving.size).toBeGreaterThan(0);
    expect([...ASYNC_JOB_LIFECYCLE_OPERATIONS].sort()).toEqual([...driving].sort());
  });

  it('gives a long budget to exactly those operations and no others', async () => {
    const driving = operationsDrivingTheVideoJobRunner();
    for (const operationId of operationHandlerNames().keys()) {
      const resolved = await handler.resolveTimeoutMs(ctx(operationId));
      if (driving.has(operationId)) {
        expect(resolved, operationId).toBe(resolveVideoBudget().stepBudgetMs);
      } else if (operationId !== 'ai.agent.turn') {
        expect(resolved, operationId).toBeUndefined();
      }
    }
  });
});
