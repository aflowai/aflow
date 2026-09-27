/**
 * Rung 1.5 — a response handler written as code.
 *
 * The declarative effect cannot compute, and every case that needs arithmetic
 * or a conditional either reaches a model for it or leaves the world wrong. A
 * function closes that without a grammar to grow.
 *
 * What makes it safe is the SHAPE rather than a sandbox: pure, synchronous, no
 * I/O. The host materializes the collections the handler declared — through the
 * same persona-scoped read every other rung uses — runs the function, and
 * applies what it returns through the same commit boundary. A handler therefore
 * cannot see or write another persona's rows however it is written.
 *
 * Determinism is a property of the runtime, not a rule the author keeps: the
 * nondeterministic globals are absent, so `Date.now()` and `Math.random()` are
 * `undefined` rather than discouraged. The virtual clock arrives as `now`, and
 * ids for a create are minted by the host from the run seed.
 */
import { getQuickJS, type QuickJSWASMModule } from 'quickjs-emscripten';
import { CodeHandlerResultSchema, type CodeHandlerResult } from '@aflow/schemas';

/** A handler that would not compile, would not finish, or answered off-contract. */
export class CodeHandlerError extends Error {
  constructor(
    readonly endpointId: string,
    readonly detail: string,
  ) {
    super(`Code handler for endpoint "${endpointId}" ${detail}`);
    this.name = 'CodeHandlerError';
  }
}

/**
 * The module is a WASM compile — expensive once, trivial thereafter, and the
 * same across every call in the process. Each RUN still gets its own fresh
 * context, so nothing carries between calls.
 */
let modulePromise: Promise<QuickJSWASMModule> | undefined;
function quickJs(): Promise<QuickJSWASMModule> {
  modulePromise ??= getQuickJS();
  return modulePromise;
}

export interface CodeHandlerInput {
  endpointId: string;
  code: string;
  timeoutMs: number;
  /**
   * Mints an entity id for a create, deterministically.
   *
   * A host function rather than a value, because a handler answering with the
   * row it created has to put the SAME id in the response body and in the
   * mutation. Minting only on the way out left the handler unable to name what
   * it was creating, and an endpoint whose response schema requires the id then
   * fails its own contract.
   *
   * Deterministic and therefore replay-stable: derived from the run seed, the
   * call, the collection and how many ids this run of the handler has already
   * taken.
   */
  mintId: (collection: string) => string;
  /** The request as the handler sees it — the same shape a rule matches on. */
  request: { method: string; url: string; params: Record<string, unknown>; body: unknown };
  /** Who the run acts as. `null` is the unauthenticated caller. */
  caller: { personaId: string } | null;
  /** Virtual clock, never wall-clock. */
  now: number;
  /** Declared collections, already narrowed to the acting persona. */
  world: Record<string, Array<Record<string, unknown>>>;
}

/** Collection and id together: the same id in two collections is two entities. */
function mintKey(collection: string, entityId: string): string {
  return `${collection}\u0000${entityId}`;
}

export async function runCodeHandler(input: CodeHandlerInput): Promise<CodeHandlerResult> {
  const QuickJS = await quickJs();
  const runtime = QuickJS.newRuntime();
  // A handler that loops forever must not take the executor with it. The
  // deadline is wall-clock ONLY as a kill switch — nothing the handler can read.
  runtime.setInterruptHandler(deadline(input.timeoutMs));
  runtime.setMemoryLimit(64 * 1024 * 1024);

  const context = runtime.newContext();
  try {
    // Everything the handler is given, as one JSON literal. Passing data rather
    // than host functions is what keeps the call synchronous and the isolate
    // free of any bridge to reach back through.
    const args = JSON.stringify({
      request: input.request,
      caller: input.caller,
      now: input.now,
      world: input.world,
    });

    const program = `
      (function () {
        "use strict";
        var __args = ${args};
        // \`Date\` is FROZEN to the virtual clock, not removed. Deleting it made
        // the runtime deterministic and unusable in the same stroke: collection
        // schemas are full of ISO strings, and a handler given milliseconds had
        // no way to produce one. So parsing and formatting stay, and only the
        // reading of NOW is replaced — \`Date.now()\` and \`new Date()\` answer
        // with the run's instant. Entropy has no such honest form, so
        // \`Math.random\` is simply gone.
        (function () {
          var RealDate = Date;
          var frozen = __args.now;
          globalThis.Date = new Proxy(RealDate, {
            construct: function (target, argv) {
              return argv.length === 0 ? new target(frozen) : new target(...argv);
            },
            // Called WITHOUT new, \`Date()\` returns a wall-clock string and
            // never reaches the construct trap — a hole wide enough to make a
            // handler's output differ between two replays of one call.
            apply: function () {
              return new RealDate(frozen).toUTCString();
            },
            get: function (target, prop, receiver) {
              return prop === 'now'
                ? function () { return frozen; }
                : Reflect.get(target, prop, receiver);
            },
          });
          // The proxy is not the only way to reach the constructor: \`Date.prototype\`
          // forwards through the \`get\` trap to the real prototype, whose
          // \`constructor\` is the unproxied original — so \`new
          // (Date.prototype.constructor)()\` and \`new (someDate.constructor)()\`
          // both read wall-clock. Repointing it closes both, and every instance
          // with it, since instances resolve \`constructor\` through this object.
          RealDate.prototype.constructor = globalThis.Date;

          // The world's clock is UTC. QuickJS takes its zone from the host, so
          // a handler calling \`getHours\` or \`toString\` would answer differently
          // on a developer's laptop than on the executor — the same replay
          // divergence as reading wall-clock, arriving by a slower route.
          var proto = RealDate.prototype;
          var localToUtc = [
            'FullYear', 'Month', 'Date', 'Day', 'Hours',
            'Minutes', 'Seconds', 'Milliseconds',
          ];
          for (var i = 0; i < localToUtc.length; i++) {
            proto['get' + localToUtc[i]] = proto['getUTC' + localToUtc[i]];
          }
          proto.getTimezoneOffset = function () { return 0; };
          proto.toString = proto.toUTCString;
          proto.toDateString = function () { return this.toUTCString().slice(0, 16); };
          proto.toTimeString = function () { return this.toUTCString().slice(17); };
          proto.toLocaleString = proto.toUTCString;
          proto.toLocaleDateString = proto.toDateString;
          proto.toLocaleTimeString = proto.toTimeString;

          delete globalThis.performance;
          Math.random = undefined;
        })();
        var newId = globalThis.__mintId;
        delete globalThis.__mintId;
        var handler = function (request, caller, now, world, newId) {
${input.code}
        };
        var result = handler(__args.request, __args.caller, __args.now, __args.world, newId);
        return JSON.stringify(result === undefined ? null : result);
      })()
    `;

    // The one host function. Synchronous and deterministic, so the isolate
    // stays a pure function of what it was given.
    //
    // What it handed out is recorded, because minting here is only half the
    // guarantee: a handler that returns an id it made up instead of one it was
    // given is not replayable, and a constant id would have every call to the
    // endpoint write the same row.
    const minted = new Set<string>();
    const mintFn = context.newFunction('__mintId', (handle) => {
      const collection = context.getString(handle);
      const id = input.mintId(collection);
      minted.add(mintKey(collection, id));
      return context.newString(id);
    });
    context.setProp(context.global, '__mintId', mintFn);
    mintFn.dispose();

    const evaluated = context.evalCode(program);
    if (evaluated.error) {
      const detail = context.dump(evaluated.error) as unknown;
      evaluated.error.dispose();
      throw new CodeHandlerError(input.endpointId, `threw: ${describe(detail)}`);
    }
    const raw = context.getString(evaluated.value);
    evaluated.value.dispose();

    const parsed: unknown = JSON.parse(raw);
    const checked = CodeHandlerResultSchema.safeParse(parsed);
    if (!checked.success) {
      throw new CodeHandlerError(
        input.endpointId,
        `returned something the contract rejects — it must return { status, body, mutations? }: ${checked.error.issues
          .slice(0, 4)
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    for (const mutation of checked.data.mutations) {
      if (mutation.op !== 'create') continue;
      // Only creates. An update or a delete names a row the handler was shown,
      // whose id came from the world rather than from here.
      if (minted.has(mintKey(mutation.collection, mutation.entityId))) continue;
      throw new CodeHandlerError(
        input.endpointId,
        `creates "${mutation.collection}/${mutation.entityId}" with an id it was not given. Entity ids come from \`newId(collection)\` — an id the handler chooses cannot be replayed, and a fixed one would have every call write the same row.`,
      );
    }

    return checked.data;
  } finally {
    context.dispose();
    runtime.dispose();
  }
}

/**
 * A wall-clock kill switch, not a clock the handler can read.
 *
 * Reading time to decide WHEN to stop is not the same as exposing it: the
 * handler still has no `Date`, so nothing it computes can vary with it.
 */
function deadline(timeoutMs: number): () => boolean {
  const stopAt = Date.now() + timeoutMs;
  return () => Date.now() > stopAt;
}

function describe(value: unknown): string {
  if (value !== null && typeof value === 'object' && 'message' in value) {
    return String((value as { message: unknown }).message);
  }
  return String(value);
}
