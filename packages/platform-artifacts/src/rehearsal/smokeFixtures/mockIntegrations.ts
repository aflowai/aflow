import {
  collectMemoryDocumentsSync,
  MemoryCollectInputSchema,
  type WorkflowTask,
} from '@aflow/schemas';
import type { SmokeTaskAnswer, SmokeTaskContext } from '../mockRehearsalClient.js';

/**
 * The integrations every smoke fixture shares: a document store standing for
 * the space's memory store and the bound folder, and the campaign list. A
 * write keeps its content for the reads after it, so a run reads what an
 * earlier task or run of the smoke wrote. A memory.store.collect runs the
 * executor's own selection over the stored documents.
 */

interface StoredDocument {
  text: string;
  json: unknown;
  revision: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function targetPath(input: Record<string, unknown>): string | undefined {
  if (typeof input['path'] === 'string') return input['path'];
  const target = input['target'];
  return isRecord(target) && typeof target['path'] === 'string' ? target['path'] : undefined;
}

function contentOf(input: Record<string, unknown>): { text: string; json: unknown } {
  const content = input['content'];
  if (typeof content === 'string') return { text: content, json: undefined };
  if (isRecord(content)) {
    if ('inlineJson' in content) {
      return { text: JSON.stringify(content['inlineJson']), json: content['inlineJson'] };
    }
    if (typeof content['inlineText'] === 'string') {
      return { text: content['inlineText'], json: undefined };
    }
  }
  return { text: '', json: undefined };
}

export interface MockIntegrations {
  /** The answer to a task these integrations serve, or undefined for any other task. */
  answer(
    task: WorkflowTask,
    input: Record<string, unknown>,
    context: SmokeTaskContext,
  ): SmokeTaskAnswer | undefined;
}

export function createMockIntegrations(): MockIntegrations {
  const documents = new Map<string, StoredDocument>();
  let revisions = 0;
  const keyOf = (task: WorkflowTask, input: Record<string, unknown>, path: string) =>
    task.operation?.startsWith('host.file.')
      ? `folder:${typeof input['bindingId'] === 'string' ? input['bindingId'] : ''}:${path}`
      : `memory:${path}`;
  const write = (key: string, text: string, json: unknown) => {
    revisions += 1;
    const created = !documents.has(key);
    const revision = `smoke-rev-${String(revisions)}`;
    documents.set(key, { text, json, revision });
    return { created, revision };
  };

  return {
    answer(task, input, context) {
      const path = targetPath(input);
      if (task.operation === undefined) return undefined;
      switch (task.operation) {
        case 'memory.store.put':
        case 'host.file.put': {
          if (path === undefined) return { failure: `${task.taskId} names no path to write.` };
          const { text, json } = contentOf(input);
          const { created, revision } = write(keyOf(task, input, path), text, json);
          return { output: { path, revision, created, bytesWritten: text.length } };
        }
        case 'memory.store.get': {
          if (path === undefined) return { failure: `${task.taskId} names no path to read.` };
          const doc = documents.get(keyOf(task, input, path));
          if (doc === undefined) return { output: { found: false } };
          return {
            output: {
              stat: { path, revision: doc.revision },
              data: doc.text,
              ...(doc.json === undefined ? {} : { dataJson: doc.json }),
              range: { totalChars: doc.text.length, hasMore: false },
            },
          };
        }
        case 'memory.store.collect': {
          const parsed = MemoryCollectInputSchema.safeParse(input);
          if (!parsed.success) return { failure: `${task.taskId}: ${parsed.error.message}` };
          const output = collectMemoryDocumentsSync(parsed.data, {
            list: (prefix, max) =>
              [...documents.keys()]
                .filter((key) => key.startsWith(`memory:${prefix}`))
                .map((key) => key.slice('memory:'.length))
                .sort()
                .slice(0, max),
            read: (docPath) => {
              const doc = documents.get(`memory:${docPath}`);
              if (doc === undefined) return { ok: false, reason: 'No document at this path.' };
              return doc.json === undefined
                ? { ok: true, docType: 'markdown', content: doc.text }
                : { ok: true, docType: 'json', content: doc.json };
            },
          });
          return { output };
        }
        case 'host.file.get': {
          if (path === undefined) return { failure: `${task.taskId} names no path to read.` };
          const doc = documents.get(keyOf(task, input, path));
          return {
            output:
              doc === undefined
                ? { path, found: false }
                : { path, content: doc.text, revision: doc.revision },
          };
        }
        case 'workflow.campaign.list':
          return {
            output: {
              campaigns: Object.entries(context.campaigns)
                .filter(([slug]) => input['slug'] === undefined || input['slug'] === slug)
                .map(([slug, campaign]) => ({ campaign: { ...campaign, slug, status: 'active' } })),
            },
          };
        case 'workflow.learn':
          return { output: { recorded: 0 } };
        default:
          return undefined;
      }
    },
  };
}
