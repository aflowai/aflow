/**
 * The file half of the host lane. No process is spawned here, which is what
 * lets a folder be connected without granting a shell.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import {
  successWithData,
  failureWithError,
  permissionError,
  validationError,
  notFoundError,
  internalError,
} from '@aflow/executor-runtime';
import {
  HostFileGetInputSchema,
  HostFileListInputSchema,
  HostFilePutInputSchema,
} from '@aflow/schemas';

import {
  HostBindingError,
  loadHostPolicy,
  requireBinding,
  requireSpace,
  requireDirectory,
  requireWritable,
  resolveWithin,
  type HostBinding,
} from '../bindings.js';

/** The revision `get` returns and `put` requires: content, not a clock. */
function revisionOf(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** A NUL byte is the cheap, boring test, and it is the one editors use. */
function looksBinary(bytes: Buffer): boolean {
  return bytes.includes(0);
}

/**
 * A binding refusal is a permission answer, not a transient one: retrying
 * reaches the same boundary, and the next useful move is to ask the operator
 * rather than to try again.
 */
/** A body the agent can fix, as opposed to a boundary it cannot. */
class HostInputError extends Error {}

async function failure(ctx: ExecutorContext, error: unknown): Promise<StepResult> {
  if (error instanceof HostInputError) {
    return await failureWithError(ctx, validationError(error.message));
  }
  if (error instanceof HostBindingError) {
    switch (error.kind) {
      case 'unknown_binding':
        return await failureWithError(ctx, notFoundError(error.message));
      case 'policy':
        return await failureWithError(ctx, internalError(error.message));
      // `wrong_space` is a permission answer, not a not-found one: reporting a
      // binding that exists as absent would still confirm the id, by how it
      // differs from an id that genuinely does not exist.
      case 'outside_root':
      case 'read_only':
      case 'not_a_directory':
      case 'no_execution':
      case 'push_refused':
      case 'wrong_space':
        return await failureWithError(ctx, permissionError(error.message));
    }
  }
  // Node's fs errors embed the absolute host path, which the relative-path
  // binding otherwise never reveals. Report the code, not the message.
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : 'unknown';
  ctx.log.error('host file operation failed', { code, error });
  return await failureWithError(
    ctx,
    internalError(`The host could not complete this operation (${code}).`),
  );
}

async function bindingFor(
  policyPath: string,
  bindingId: string,
  spaceId: string | undefined,
): Promise<HostBinding> {
  const binding = requireBinding((await loadHostPolicy(policyPath)).bindings, bindingId);
  requireSpace(binding, spaceId);
  return binding;
}

async function inputOf<T>(
  ctx: ExecutorContext,
  schema: {
    safeParse: (v: unknown) => { success: boolean; data?: T; error?: { message: string } };
  },
): Promise<T> {
  const raw = await ctx.readPayload(ctx.job.inputRef);
  const parsed = schema.safeParse(raw);
  if (!parsed.success || parsed.data === undefined) {
    throw new HostInputError(parsed.error?.message ?? 'Invalid input');
  }
  return parsed.data;
}

async function listFiles(ctx: ExecutorContext, policyPath: string): Promise<StepResult> {
  try {
    const input = await inputOf(ctx, HostFileListInputSchema);
    const binding = await bindingFor(policyPath, input.bindingId, ctx.spaceId);
    requireDirectory(binding);
    // Two different roots: the directory being walked, and the one every
    // returned path is relative to. `host.file.get` resolves against the
    // binding root, so listing `src` has to yield `src/index.ts` — a bare
    // `index.ts` reads fine and then fails to open.
    const bindingRoot = await resolveWithin(binding, '.', true);
    const root = await resolveWithin(binding, input.path, true);

    const entries: Array<Record<string, unknown>> = [];
    let truncated = false;
    const walk = async (dir: string): Promise<void> => {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        if (entries.length >= input.limit) {
          truncated = true;
          return;
        }
        // The resolver refuses a path inside `.git`; walking into it here made
        // that refusal partial. Contents stayed unreadable, but the paths came
        // back — and on a repository they are nearly all of them: a listing of
        // a fresh checkout returned 27 git internals for one real file.
        // Case-insensitively, because the filesystem this lane targets folds.
        if (item.name.toLowerCase() === '.git') continue;
        const full = join(dir, item.name);
        const kind = item.isDirectory()
          ? 'directory'
          : item.isSymbolicLink()
            ? 'symlink'
            : item.isFile()
              ? 'file'
              : 'other';
        const info = kind === 'file' ? await stat(full).catch(() => null) : null;
        entries.push({
          path: relative(bindingRoot, full),
          kind,
          ...(info ? { sizeBytes: info.size, modifiedAt: info.mtime.toISOString() } : {}),
        });
        if (input.recursive && item.isDirectory()) await walk(full);
      }
    };
    await walk(root);

    return await successWithData(ctx, { entries, truncated });
  } catch (error) {
    return await failure(ctx, error);
  }
}

/**
 * Open a verified path without following a symlink at its final component.
 *
 * `resolveWithin` checks a pathname; the read happens later, in a process with
 * no sandbox around it. Between the two, anything able to write in the binding
 * — a command this lane is running, or the operator's own editor — can replace
 * the file with a link and redirect the read outside. `O_NOFOLLOW` refuses that
 * at the open, so the check and the use agree about the final component.
 *
 * It does not close an ancestor being swapped for a link between the check and
 * the open: that needs descriptor-relative traversal Node does not expose, and
 * saying so is better than implying this is the whole of it.
 */
async function openVerified(path: string): Promise<FileHandle> {
  return await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
}

function isFsErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function symlinkRace(path: string): HostBindingError {
  return new HostBindingError(
    `\`${path}\` became a symlink before it could be opened, so the write was refused.`,
    'outside_root',
  );
}

async function openForCreate(path: string, requestedPath: string): Promise<FileHandle> {
  try {
    return await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (isFsErrorCode(error, 'ELOOP')) throw symlinkRace(requestedPath);
    throw error;
  }
}

async function openForReplace(path: string, requestedPath: string): Promise<FileHandle> {
  try {
    return await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
  } catch (error) {
    if (isFsErrorCode(error, 'ELOOP')) throw symlinkRace(requestedPath);
    throw error;
  }
}

async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (bytesWritten === 0) {
      throw new Error('The host stopped accepting bytes before the write completed.');
    }
    offset += bytesWritten;
  }
}

async function readAll(handle: FileHandle): Promise<Buffer> {
  const info = await handle.stat();
  const bytes = Buffer.alloc(info.size);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (bytesRead === 0) {
      throw new Error('The host stopped producing bytes before the read completed.');
    }
    offset += bytesRead;
  }
  return bytes;
}

async function requireExistingParent(binding: HostBinding, path: string): Promise<string> {
  return await resolveWithin(binding, dirname(path), true);
}

async function readFileOp(ctx: ExecutorContext, policyPath: string): Promise<StepResult> {
  try {
    const input = await inputOf(ctx, HostFileGetInputSchema);
    const binding = await bindingFor(policyPath, input.bindingId, ctx.spaceId);
    const path = await resolveWithin(binding, input.path, true);

    const handle = await openVerified(path);
    let info;
    let bytes;
    try {
      info = await handle.stat();
      if (info.size > input.maxBytes) {
        return await failureWithError(
          ctx,
          validationError(
            `\`${input.path}\` is ${String(info.size)} bytes, over the ` +
              `${String(input.maxBytes)} byte cap. Raise maxBytes deliberately rather than ` +
              'reading a prefix.',
          ),
        );
      }

      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    const binary = looksBinary(bytes);
    return await successWithData(ctx, {
      path: input.path,
      revision: revisionOf(bytes),
      encoding: binary ? 'base64' : 'utf8',
      content: binary ? bytes.toString('base64') : bytes.toString('utf8'),
      sizeBytes: info.size,
    });
  } catch (error) {
    return await failure(ctx, error);
  }
}

/**
 * `Buffer.from(s, 'base64')` never fails. It skips what it cannot read and
 * returns the rest, so a truncated or corrupted body decodes to a shorter one
 * and the write reports success — the file now holds bytes the caller did not
 * send, with a revision that makes them look authoritative. Re-encoding is the
 * cheap check: only a canonical string survives the round trip.
 */
function decodeContent(content: string, encoding: 'utf8' | 'base64'): Buffer | null {
  if (encoding !== 'base64') return Buffer.from(content, encoding);
  const bytes = Buffer.from(content, 'base64');
  const canonical = bytes.toString('base64');
  const supplied = content.trim().replace(/\s+/g, '');
  return canonical === supplied ? bytes : null;
}

async function writeFileOp(ctx: ExecutorContext, policyPath: string): Promise<StepResult> {
  try {
    const input = await inputOf(ctx, HostFilePutInputSchema);
    const binding = await bindingFor(policyPath, input.bindingId, ctx.spaceId);
    requireWritable(binding);
    const path = await resolveWithin(binding, input.path, false);
    const bytes = decodeContent(input.content, input.encoding);
    if (bytes === null) {
      return await failureWithError(
        ctx,
        validationError(
          'The content is not valid base64. Node decodes a malformed string to whatever it can ' +
            'read and discards the rest, so writing it would report success over bytes nobody ' +
            'sent.',
        ),
      );
    }
    await requireExistingParent(binding, input.path);

    if (input.expectedRevision === undefined) {
      let handle: FileHandle | undefined;
      try {
        handle = await openForCreate(path, input.path);
      } catch (error) {
        if (isFsErrorCode(error, 'EEXIST') || isFsErrorCode(error, 'EISDIR')) {
          return await failureWithError(
            ctx,
            validationError(
              `\`${input.path}\` already exists. Read it first and pass its revision to replace ` +
                'it; omitting the revision means create-only.',
            ),
          );
        }
        throw error;
      }
      try {
        await writeAll(handle, bytes);
      } finally {
        await handle.close();
      }

      return await successWithData(ctx, {
        path: input.path,
        revision: revisionOf(bytes),
        created: true,
        bytesWritten: bytes.byteLength,
      });
    }

    let handle: FileHandle | undefined;
    try {
      handle = await openForReplace(path, input.path);
    } catch (error) {
      if (isFsErrorCode(error, 'ENOENT')) {
        return await failureWithError(
          ctx,
          notFoundError(`\`${input.path}\` no longer exists, so there is nothing to replace.`),
        );
      }
      throw error;
    }
    try {
      const existing = await readAll(handle);
      if (revisionOf(existing) !== input.expectedRevision) {
        return await failureWithError(
          ctx,
          validationError(
            `\`${input.path}\` changed since it was read. Nothing was written. Read it again ` +
              'and decide against the current contents.',
          ),
        );
      }
      try {
        await writeAll(handle, bytes);
        await handle.truncate(bytes.length);
        await handle.sync();
      } catch (error) {
        const originalError = error instanceof Error ? error : new Error(String(error));
        try {
          await handle.truncate(0);
          await writeAll(handle, existing);
          await handle.truncate(existing.length);
          await handle.sync();
        } catch (rollbackError) {
          throw new AggregateError([rollbackError], originalError.message, {
            cause: originalError,
          });
        }
        throw originalError;
      }
    } finally {
      await handle.close();
    }

    return await successWithData(ctx, {
      path: input.path,
      revision: revisionOf(bytes),
      created: false,
      bytesWritten: bytes.byteLength,
    });
  } catch (error) {
    return await failure(ctx, error);
  }
}

/** The file half. Reached only for `host.file.*`, so it never spawns anything. */
export function createHostFileHandler(policyPath: string): {
  execute: (ctx: ExecutorContext) => Promise<StepResult>;
} {
  return {
    async execute(ctx: ExecutorContext): Promise<StepResult> {
      switch (ctx.operationId) {
        case 'host.file.list':
          return listFiles(ctx, policyPath);
        case 'host.file.get':
          return readFileOp(ctx, policyPath);
        case 'host.file.put':
          return writeFileOp(ctx, policyPath);
        default:
          return failureWithError(
            ctx,
            validationError(`The host lane does not serve \`${ctx.operationId}\`.`),
          );
      }
    },
  };
}
