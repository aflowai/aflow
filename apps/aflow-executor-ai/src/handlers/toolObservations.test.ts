import { describe, expect, it, vi } from 'vitest';
import type { PayloadStore } from '@aflow/payload-store';
import {
  BROWSER_PAGE_OBSERVATION,
  MEMORY_READ_OPERATION_ID,
  estimateMessageTokens,
  textMessage,
  toolResultMessage,
  withoutObservedFields,
  type AiConversationStateV1,
  type AiMessageAtomV1,
  type AiMessageV1,
  type AiToolResultEnvelopeV1,
} from '@aflow/schemas';
import { aiMessageToChatMessage } from './ai/handlers/agentMessageConversion.js';
import { ConversationStateStore } from './conversationStateStore.js';
import { RETENTION_POLICY } from './retentionPolicy.js';
import { renderToolObservations } from './toolObservations.js';

const OBSERVED_FIELDS =
  BROWSER_PAGE_OBSERVATION.role === 'observes' ? BROWSER_PAGE_OBSERVATION.observedFields : [];

const REPLACED = (pageId: string) =>
  `A later browser.page result for ${pageId} replaced this one's observation; ` +
  'browser.page.snapshot returns the current state.';

/** Outline lines of the shape the browser driver returns, to `chars` characters. */
function outlineOf(chars: number): string {
  const rows = [
    '- banner [ref=e1]:',
    '  - link "Home" [ref=e2]',
    '  - navigation "Primary" [ref=e3]:',
    '    - link "Issues" [ref=e4]',
    '    - link "Pull requests" [ref=e5]',
    '- main [ref=e6]:',
    '  - heading "Pull requests" [level=1] [ref=e7]',
    '  - textbox "Search all pull requests" [ref=e8]',
    '  - button "Filters" [ref=e9]',
  ];
  for (let i = 10; rows.join('\n').length < chars; i += 3) {
    rows.push(
      `  - link "Fix the scheduler's retry window #${String(4000 + i)}" [ref=e${String(i)}]`,
    );
    rows.push(`  - button "Assign reviewer" [ref=e${String(i + 1)}]`);
    rows.push(
      `  - heading "Opened by someone ${String(i)} minutes ago" [level=3] [ref=e${String(i + 2)}]`,
    );
  }
  return rows.join('\n').slice(0, chars);
}

function actOutput(pageId: string, step: number, outline = outlineOf(600)) {
  return {
    outcome: 'performed',
    pageId,
    url: `https://example.com/pulls?page=${String(step)}`,
    title: 'Pull requests',
    outline,
    receipt: {
      action: 'click',
      ref: `e${String(10 + step)}`,
      element: { role: 'link', name: 'Next' },
      urlChanged: true,
      titleChanged: false,
      outlineChanged: true,
      outlineElements: 120,
      outlineCut: false,
      settled: true,
    },
  };
}

function envelopeFor(
  base: string,
  operationId: string,
  output: Record<string, unknown>,
  stamp: 'observes' | 'ends' | 'none',
): AiToolResultEnvelopeV1 {
  const pageId = output['pageId'] as string;
  return {
    kind: 'tool_result',
    toolCallId: `${base}_0`,
    toolName: operationId,
    operationId,
    status: 'SUCCEEDED',
    completedAtMs: 1_700_000_000_000,
    outputPath: `/run/outputs/${base}_0`,
    summary: JSON.stringify(output),
    ...(stamp === 'observes'
      ? {
          observation: {
            role: 'observes' as const,
            group: 'browser.page',
            key: pageId,
            receipt: JSON.stringify(withoutObservedFields(output, OBSERVED_FIELDS)),
            currentStateOperation: 'browser.page.snapshot',
          },
        }
      : stamp === 'ends'
        ? { observation: { role: 'ends' as const, group: 'browser.page', key: pageId } }
        : {}),
  };
}

function exchange(base: string, envelope: AiToolResultEnvelopeV1): [AiMessageV1, AiMessageV1] {
  return [
    {
      role: 'assistant',
      parts: [{ kind: 'json', json: { action: 'invoke_step', toolId: envelope.toolName } }],
      toolCalls: [{ toolCallId: `${base}_0`, name: envelope.toolName, argumentsJson: {} }],
    },
    toolResultMessage(envelope),
  ];
}

const act = (base: string, pageId: string, step: number) =>
  exchange(base, envelopeFor(base, 'browser.page.act', actOutput(pageId, step), 'observes'));

const close = (base: string, pageId: string) =>
  exchange(base, envelopeFor(base, 'browser.page.close', { pageId, state: 'closed' }, 'ends'));

function summaryOf(message: AiMessageV1): string | undefined {
  const part = message.parts[0];
  return part?.kind === 'json' ? (part.json as AiToolResultEnvelopeV1).summary : undefined;
}

function toolSummaries(messages: AiMessageV1[]): Array<string | undefined> {
  return messages.filter((m) => m.role === 'tool').map(summaryOf);
}

function isFull(summary: string | undefined): boolean {
  return summary?.startsWith('{') === true && summary.includes('"outline"');
}

describe('renderToolObservations', () => {
  it('shows the newest of three observations of a page in full, the first two as receipts', () => {
    const messages = [
      textMessage('user', 'Merge it'),
      ...act('a1', 'pg_1', 1),
      ...act('a2', 'pg_1', 2),
      ...act('a3', 'pg_1', 3),
    ];
    const stored = JSON.stringify(messages);
    const summaries = toolSummaries(renderToolObservations(messages));

    expect(summaries.map(isFull)).toEqual([false, false, true]);
    for (const [i, summary] of summaries.slice(0, 2).entries()) {
      const [line, receipt] = summary!.split('\n');
      expect(line).toBe(REPLACED('pg_1'));
      expect(JSON.parse(receipt!)).toEqual(
        withoutObservedFields(actOutput('pg_1', i + 1), OBSERVED_FIELDS),
      );
    }
    expect(summaries[2]).toBe(JSON.stringify(actOutput('pg_1', 3)));
    expect(JSON.stringify(renderToolObservations(messages))).not.toContain('"observation"');
    expect(JSON.stringify(messages)).toBe(stored);
  });

  it('keeps each page’s newest observation in full when two pages interleave', () => {
    const messages = [
      ...act('a1', 'pg_1', 1),
      ...act('b1', 'pg_2', 1),
      ...act('a2', 'pg_1', 2),
      ...act('b2', 'pg_2', 2),
    ];
    const summaries = toolSummaries(renderToolObservations(messages));
    expect(summaries.map(isFull)).toEqual([false, false, true, true]);
    expect(summaries[0]!.split('\n')[0]).toBe(REPLACED('pg_1'));
    expect(summaries[1]!.split('\n')[0]).toBe(REPLACED('pg_2'));
  });

  it('keeps no observation of a page in full once it is closed', () => {
    const messages = [...act('a1', 'pg_1', 1), ...act('a2', 'pg_1', 2), ...close('c1', 'pg_1')];
    const rendered = renderToolObservations(messages);
    const summaries = toolSummaries(rendered);
    expect(summaries[0]!.split('\n')[0]).toBe(REPLACED('pg_1'));
    expect(summaries[1]!.split('\n')[0]).toBe(
      'browser.page.close ended pg_1 after this result; its observation is not kept.',
    );
    expect(summaries[2]).toBe(JSON.stringify({ pageId: 'pg_1', state: 'closed' }));
    expect(JSON.stringify(rendered)).not.toContain('"observation"');
  });

  it('leaves a result whose operation declares nothing exactly as stored', () => {
    const undeclared = exchange(
      'h1',
      envelopeFor('h1', 'api.http.call', { pageId: 'pg_1', outline: outlineOf(300) }, 'none'),
    );
    const messages = [...act('a1', 'pg_1', 1), ...undeclared, ...act('a2', 'pg_1', 2)];
    const rendered = renderToolObservations(messages);
    expect(rendered[2]).toBe(messages[2]);
    expect(rendered[3]).toBe(messages[3]);
    expect(toolSummaries(rendered).map(isFull)).toEqual([false, true, true]);
  });

  it('keeps the tool call id and name of a reduced result, and none of its images', () => {
    const image = {
      ref: 'gs://aflow-payloads/x/body.json',
      contentType: 'image/png' as const,
      sizeBytes: 10,
      width: 10,
      height: 10,
    };
    const first = toolResultMessage({
      ...envelopeFor('a1', 'browser.page.act', actOutput('pg_1', 1), 'observes'),
      images: [image],
    });
    const rendered = renderToolObservations([first, ...act('a2', 'pg_1', 2)]);
    expect(first.parts.some((p) => p.kind === 'image')).toBe(true);
    expect(rendered[0]).toMatchObject({
      role: 'tool',
      toolCallId: 'a1_0',
      name: 'browser.page.act',
    });
    expect(rendered[0]!.parts.map((p) => p.kind)).toEqual(['json']);
    expect(JSON.stringify(rendered[0])).not.toContain('"images"');
  });
});

// ============================================================================
// Assembly
// ============================================================================

function atomsOf(turns: Array<{ turn: number; messages: AiMessageV1[] }>): AiMessageAtomV1[] {
  const atoms: AiMessageAtomV1[] = [];
  for (const { turn, messages } of turns) {
    for (const [i, message] of messages.entries()) {
      atoms.push({
        schemaVersion: 1,
        atomId: `atom-${String(turn)}-${String(i)}`,
        role: message.role,
        sourceId: message.toolCallId ?? `turn:${String(turn)}:${String(i)}`,
        sourceKind:
          message.role === 'tool'
            ? 'tool_result'
            : message.role === 'assistant'
              ? 'assistant_turn'
              : 'user_input',
        message,
        createdAtMs: turn * 1000 + i,
        turnNumber: turn,
      });
    }
  }
  return atoms;
}

function storeFor(atoms: AiMessageAtomV1[], turnNumber: number) {
  const state: AiConversationStateV1 = {
    schemaVersion: 1,
    conversationId: 'c1',
    turnNumber,
    context: {},
    seenSourceIds: {},
    history: {
      maxAtomsStructural: RETENTION_POLICY.maxAtomsStructural,
      atoms: atoms.map((a) => ({
        atomId: a.atomId,
        ref: 'batch:1',
        role: a.role,
        sourceKind: a.sourceKind,
        hash: 'h',
        createdAtMs: a.createdAtMs,
        turnNumber: a.turnNumber,
      })),
    },
  };
  const payloadStore = {
    retrieve: vi.fn().mockResolvedValue(atoms),
    store: vi.fn().mockResolvedValue('ref:new'),
  } as unknown as PayloadStore;
  return new ConversationStateStore(
    {
      payloadStore,
      tenantId: 'tenant-1',
      runId: 'run-1',
      stepId: 'agent',
      stepExecutionId: 'step-exec-uuid',
      attempt: 1,
    },
    state,
  );
}

async function assemble(
  turns: Array<{ turn: number; messages: AiMessageV1[] }>,
  turnNumber: number,
) {
  const store = storeFor(atomsOf(turns), turnNumber);
  return { store, request: await store.assembleRequest('sys', []) };
}

const opener = { turn: 0, messages: [textMessage('user', 'Merge the open pull request')] };

describe('ConversationStateStore.assembleRequest — observations', () => {
  it('sends turn N+1 the same bytes as turn N for every message before the newly reduced one', async () => {
    const turnN = [
      opener,
      { turn: 1, messages: act('a1', 'pg_1', 1) },
      { turn: 2, messages: act('a2', 'pg_1', 2) },
    ];
    const turnN1 = [...turnN, { turn: 3, messages: act('a3', 'pg_1', 3) }];
    const before = (await assemble(turnN, 3)).request.messages;
    const after = (await assemble(turnN1, 4)).request.messages;

    const newlyReduced = before.findIndex((m) => m.toolCallId === 'a2_0');
    expect(isFull(summaryOf(before[newlyReduced]!))).toBe(true);
    expect(isFull(summaryOf(after[newlyReduced]!))).toBe(false);
    expect(after.slice(0, newlyReduced).map((m) => JSON.stringify(m))).toEqual(
      before.slice(0, newlyReduced).map((m) => JSON.stringify(m)),
    );

    const turnN2 = [...turnN1, { turn: 4, messages: act('a4', 'pg_1', 4) }];
    const later = (await assemble(turnN2, 5)).request.messages;
    expect(JSON.stringify(later[newlyReduced])).toBe(JSON.stringify(after[newlyReduced]));
  });

  it('counts the reduced form in the history estimate', async () => {
    const turns = [
      opener,
      { turn: 1, messages: act('a1', 'pg_1', 1) },
      { turn: 2, messages: act('a2', 'pg_1', 2) },
    ];
    const { request } = await assemble(turns, 3);
    const sent = request.messages.filter((m) => m.role !== 'system');
    const stored = atomsOf(turns).map((a) => a.message);
    const estimate = (messages: AiMessageV1[]) =>
      messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

    expect(request.tokenBreakdown.history).toBe(estimate(sent));
    expect(request.tokenBreakdown.history).toBeLessThan(estimate(stored));
  });

  it('still clears a reduced observation under pressure, and the newest stays in full', async () => {
    const turns = [opener];
    for (const t of [1, 2, 3, 4, 5, 6, 7, 18]) {
      turns.push({ turn: t, messages: act(`ob${String(t).padStart(2, '0')}`, 'pg_1', t) });
    }
    const { store } = await assemble(turns, 20);
    const result = await store.clearUnderPressure({
      pressureTokens: 9_500,
      effectiveBudget: 10_000,
      availableReadOpId: MEMORY_READ_OPERATION_ID,
    });

    expect(store.getState().clearing?.clearedExchanges).toContain('ob01');
    expect(result?.clearedExchangeCount).toBeGreaterThan(0);
    const ids = new Set(store.getState().history.atoms.map((a) => a.atomId));
    expect(ids.has('atom-1-1')).toBe(false);
    expect(ids.has('atom-18-1')).toBe(true);
  });
});

describe('ten actions on one page with an 8,000-character outline', () => {
  it('reports the request before and after reduction', async () => {
    const outline = outlineOf(8_000);
    const turns = [opener];
    const unstamped = [opener];
    for (let t = 1; t <= 10; t += 1) {
      const base = `ten${String(t).padStart(2, '0')}`;
      const output = actOutput('pg_1', t, outline);
      turns.push({
        turn: t,
        messages: exchange(base, envelopeFor(base, 'browser.page.act', output, 'observes')),
      });
      unstamped.push({
        turn: t,
        messages: exchange(base, envelopeFor(base, 'browser.page.act', output, 'none')),
      });
    }
    const size = (messages: AiMessageV1[]) =>
      messages
        .map(aiMessageToChatMessage)
        .reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0);

    const before = (await assemble(unstamped, 11)).request;
    const after = (await assemble(turns, 11)).request;
    const report = {
      outlineChars: outline.length,
      beforeChars: size(before.messages),
      afterChars: size(after.messages),
      beforeHistoryTokens: before.tokenBreakdown.history,
      afterHistoryTokens: after.tokenBreakdown.history,
    };
    console.info('observation reduction', JSON.stringify(report));

    expect(toolSummaries(after.messages).map(isFull)).toEqual([...Array(9).fill(false), true]);
    expect(report.afterChars).toBeLessThan(report.beforeChars / 4);
  });
});
