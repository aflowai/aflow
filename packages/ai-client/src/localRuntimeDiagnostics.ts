/**
 * One diagnosis of a space's runtime on this computer (Plan 323 D15), from
 * what the runtime reports, the connection, the catalog and the machine.
 * Pure: the observation is taken by the caller, so readiness, the models
 * surface and Helmsman can each read the runtime once and describe it the
 * same way.
 */
import type {
  LocalModelDiagnosis,
  LocalModelPull,
  LocalModelRole,
  LocalRuntimeDiagnostics,
  LocalRuntimeIssue,
} from '@aflow/schemas';
import { contextWindowForModel } from './client.js';
import { footprintBytes, localModelFit, MIN_USEFUL_WINDOW_TOKENS } from './localModelFit.js';
import {
  sameLocalTag,
  type InstalledLocalModel,
  type LoadedLocalModel,
} from './providers/ollamaRuntime.js';
import type { ModelDefinition, ProviderConfig } from './types.js';

export interface LocalRuntimeObservation {
  baseUrl: string;
  /** Null when the runtime does not answer. */
  version: string | null;
  installed: InstalledLocalModel[] | null;
  loaded: LoadedLocalModel[] | null;
}

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;
const k = (tokens: number): string => `${Math.round(tokens / 1024)}K`;

const START_OLLAMA =
  'Start Ollama: open the Ollama app, or run `ollama serve` (`brew services start ollama` where Homebrew installed it). ' +
  'If it is not installed, get it from https://ollama.com/download.';

function tagOf(model: ModelDefinition): string {
  return model.providerModelId ?? model.id;
}

export function diagnoseLocalRuntime(input: {
  observation: LocalRuntimeObservation;
  connection: ProviderConfig;
  /** The local models the catalog carries, and any model a role is assigned. */
  models: readonly ModelDefinition[];
  roles: Partial<Record<LocalModelRole, string>>;
  freeDiskBytes?: number | undefined;
  pulls?: Readonly<Record<string, LocalModelPull>> | undefined;
  /** Whether this machine's paired executor can start the runtime, which only it can reach. */
  startable?: boolean | undefined;
}): LocalRuntimeDiagnostics {
  const { observation, connection } = input;
  const reachable = observation.version !== null;
  const machine = connection.machine;
  const parallel = connection.parallel ?? 1;

  const models: LocalModelDiagnosis[] = input.models.map((model) => {
    const tag = tagOf(model);
    const installed = observation.installed?.find((m) => sameLocalTag(m.tag, tag));
    const held = observation.loaded?.find((m) => sameLocalTag(m.tag, tag));
    const fit = localModelFit({
      footprint: model.local?.footprint,
      machine,
      catalogWindow: model.contextWindow,
      parallel,
      window: contextWindowForModel(model, connection),
    });
    return {
      model: model.id,
      ref: model.aliases?.[0] ?? model.id,
      tag,
      displayName: model.displayName,
      installed: installed !== undefined,
      downloadBytes: installed?.sizeBytes ?? model.local?.downloadBytes ?? null,
      roles: (Object.entries(input.roles) as Array<[LocalModelRole, string]>)
        .filter(([, assigned]) => assigned === model.id)
        .map(([role]) => role),
      fit: {
        status: fit.status,
        window: fit.window,
        largestFittingWindow: fit.largestFittingWindow ?? null,
        bytesAtWindow: fit.bytesAtWindow ?? null,
      },
      loaded: held
        ? {
            sizeBytes: held.sizeBytes,
            gpuBytes: held.gpuBytes,
            contextLength: held.contextLength,
            expiresAt: held.expiresAt,
          }
        : null,
      build: !installed
        ? 'unmeasured'
        : installed.digest === model.local?.digest
          ? 'verified'
          : 'unverified',
      pull: input.pulls?.[model.id] ?? null,
    };
  });

  return {
    runtime: { baseUrl: observation.baseUrl, reachable, version: observation.version },
    machine: machine
      ? {
          totalMemoryBytes: machine.totalMemoryBytes,
          gpuWorkingSetBytes: machine.gpuWorkingSetBytes ?? null,
          freeDiskBytes: input.freeDiskBytes ?? null,
        }
      : null,
    connection: {
      contextTokens: connection.contextTokens ?? null,
      keepAlive: connection.keepAlive ?? null,
      parallel,
    },
    models,
    issues: reachable
      ? issuesFor(models, input.models, connection)
      : [
          {
            code: 'runtime_unreachable',
            severity: 'error',
            cause: `Ollama is not answering at ${observation.baseUrl}.`,
            remedy: input.startable
              ? { kind: 'action', action: { action: 'start_runtime' }, label: 'Start Ollama' }
              : { kind: 'instruction', text: START_OLLAMA },
          },
        ],
  };
}

function issuesFor(
  models: readonly LocalModelDiagnosis[],
  definitions: readonly ModelDefinition[],
  connection: ProviderConfig,
): LocalRuntimeIssue[] {
  const issues: LocalRuntimeIssue[] = [];
  const gpu = connection.machine?.gpuWorkingSetBytes;
  const used = models.filter((m) => m.roles.length > 0);
  // A window the operator set that is larger than the machine fits is the one
  // remedy Aflow can apply itself: hand the choice back to the machine.
  const automaticWindow = (m: LocalModelDiagnosis): LocalRuntimeIssue['remedy'] | null =>
    connection.contextTokens !== undefined &&
    m.fit.largestFittingWindow !== null &&
    m.fit.largestFittingWindow >= MIN_USEFUL_WINDOW_TOKENS &&
    m.fit.largestFittingWindow < m.fit.window
      ? {
          kind: 'action',
          action: { action: 'set_context', contextTokens: null },
          label: `Use the largest window that fits (${k(m.fit.largestFittingWindow)})`,
        }
      : null;

  for (const m of used) {
    if (!m.installed) {
      issues.push({
        code: 'model_not_installed',
        severity: 'error',
        model: m.model,
        cause:
          m.pull?.status === 'downloading'
            ? `${m.displayName} is still downloading${
                m.pull.totalBytes
                  ? ` (${Math.floor((100 * m.pull.completedBytes) / m.pull.totalBytes)}%)`
                  : ''
              }; ${m.roles.join(', ')} cannot run until it is done.`
            : `${m.roles.join(', ')} ${m.roles.length === 1 ? 'is' : 'are'} assigned ${m.displayName}, which this computer has not downloaded.`,
        remedy: {
          kind: 'action',
          action: { action: 'pull', model: m.model },
          label: `Download ${m.displayName}${m.downloadBytes ? ` (${gb(m.downloadBytes)})` : ''}`,
        },
      });
      continue;
    }

    if (m.build === 'unverified') {
      issues.push({
        code: 'build_unverified',
        severity: 'warning',
        model: m.model,
        cause: `The downloaded ${m.tag} is a different build from the one Aflow measured, so its tool calling and memory figures are unverified.`,
        remedy: {
          kind: 'instruction',
          text: `Measure it with \`yarn models:verify-local ${m.tag}\`, or download the measured build again.`,
        },
      });
    }

    if (m.loaded) {
      const onCpu = m.loaded.gpuBytes !== null ? m.loaded.sizeBytes - m.loaded.gpuBytes : 0;
      if (onCpu > 0) {
        issues.push({
          code: 'model_partly_on_cpu',
          severity: 'warning',
          model: m.model,
          cause: `${gb(onCpu)} of ${m.displayName}'s ${gb(m.loaded.sizeBytes)} runs on the CPU${
            m.loaded.contextLength ? ` at a ${k(m.loaded.contextLength)} window` : ''
          }, which is what makes it slow.`,
          remedy: automaticWindow(m) ?? {
            kind: 'action',
            action: { action: 'unload', model: m.model },
            label: `Unload ${m.displayName}`,
          },
        });
        continue;
      }
      if (gpu !== undefined && m.loaded.sizeBytes > gpu) {
        issues.push({
          code: 'model_spilling',
          severity: 'warning',
          model: m.model,
          cause: `${m.displayName} is loaded at ${gb(m.loaded.sizeBytes)}, past the ${gb(gpu)} the GPU allows: it holds the cache of every conversation it has read, and is spilling.`,
          remedy: {
            kind: 'action',
            action: { action: 'unload', model: m.model },
            label: `Unload ${m.displayName} to free it`,
          },
        });
        continue;
      }
    }

    if (m.fit.status === 'does_not_fit') {
      const smaller = models.find(
        (other) =>
          other.model !== m.model &&
          other.fit.status === 'fits' &&
          other.fit.window >= MIN_USEFUL_WINDOW_TOKENS,
      );
      issues.push({
        code: 'window_does_not_fit',
        severity: 'warning',
        model: m.model,
        cause:
          m.fit.largestFittingWindow !== null &&
          m.fit.largestFittingWindow >= MIN_USEFUL_WINDOW_TOKENS
            ? `At a ${k(m.fit.window)} window ${m.displayName} takes ${gb(m.fit.bytesAtWindow ?? 0)}, past the ${gb(gpu ?? 0)} the GPU allows; it fits ${k(m.fit.largestFittingWindow)}.`
            : `${m.displayName} takes ${gb(m.fit.bytesAtWindow ?? 0)} at the ${k(m.fit.window)} window the agents need, past the ${gb(gpu ?? 0)} this computer's GPU allows, so it will spill and run slowly as its conversations fill the window.`,
        remedy:
          automaticWindow(m) ??
          (smaller
            ? {
                kind: 'action',
                action: { action: 'use_for_every_role', model: smaller.model },
                label: `Use ${smaller.displayName}, which fits`,
              }
            : {
                kind: 'instruction',
                text: 'A smaller model, or a machine with more memory, runs it without spilling.',
              }),
      });
    } else if (m.fit.status === 'tight') {
      issues.push({
        code: 'window_tight',
        severity: 'info',
        model: m.model,
        cause: `${m.displayName} fits the GPU at ${gb(m.fit.bytesAtWindow ?? 0)}, but with the system and other apps it outgrows this computer's ${gb(connection.machine?.totalMemoryBytes ?? 0)}, so it slows down whenever they need memory.`,
        remedy: { kind: 'instruction', text: 'Close other large apps while it runs.' },
      });
    }
  }

  if (used.length > 1) {
    const primary = [...used].sort((a, b) => b.roles.length - a.roles.length)[0]!;
    const combined = used.reduce((sum, m) => {
      const def = definitions.find((d) => d.id === m.model);
      return (
        sum +
        (def?.local?.footprint
          ? footprintBytes(def.local.footprint, m.fit.window, connection.parallel ?? 1)
          : 0)
      );
    }, 0);
    issues.push({
      code: 'mixed_local_models',
      severity: 'info',
      cause: `Roles use ${used.map((m) => `${m.displayName} (${m.roles.join(', ')})`).join(' and ')}. ${
        combined > 0 ? `Holding them together takes ${gb(combined)}; otherwise ` : ''
      }each switch between them loads a model, a pause of up to a minute.`,
      remedy: {
        kind: 'action',
        action: { action: 'use_for_every_role', model: primary.model },
        label: `Use ${primary.displayName} for every role`,
      },
    });
  }

  return issues;
}
