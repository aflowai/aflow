/**
 * Plan 320 D18 — a connected folder's preview is set by a person, never by an
 * operation, and a port this stack serves on is refused for it in one set of
 * words wherever it is declared.
 *
 * The guard reads every registered operation's input as JSON Schema. It is
 * shaped so `preview: true` — the boolean a harness run takes to ask for the
 * declared preview (P6.b) — passes, while anything that could carry a
 * declaration fails: a `preview` that is an object, a `uiPaths` or a
 * `readyPath` anywhere, or an object naming a `command` beside either. The
 * positive controls run the same detector over the declaration's own schema.
 */
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_API_PORT,
  DEFAULT_WEB_PORT,
  describeStackPortOwner,
  STACK_SERVICES,
  stackOwnPorts,
} from '@aflow/lib';

import { getAllOperations } from '../../catalog/registry.js';
import { toJsonSchemaSync } from '../../utils/jsonSchema.js';
import { browserStackPortRefusal, folderPreviewStackPortRefusal } from '../browserProfile.js';
import { HostFolderPreviewSchema } from '../hostFolderPreview.js';

type JsonSchema = Record<string, unknown>;

function isObjectSchema(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null) return false;
  const node = schema as JsonSchema;
  if (node['type'] === 'object' || (Array.isArray(node['type']) && node['type'].includes('object')))
    return true;
  if (typeof node['properties'] === 'object' && node['properties'] !== null) return true;
  return ['anyOf', 'oneOf', 'allOf'].some(
    (key) => Array.isArray(node[key]) && (node[key] as unknown[]).some(isObjectSchema),
  );
}

/** Where a schema could carry a preview declaration, by path. */
function declarationCarriers(schema: unknown, at = '$', into: string[] = []): string[] {
  if (Array.isArray(schema)) {
    schema.forEach((item, index) => declarationCarriers(item, `${at}[${String(index)}]`, into));
    return into;
  }
  if (typeof schema !== 'object' || schema === null) return into;
  const properties = (schema as JsonSchema)['properties'];
  if (typeof properties === 'object' && properties !== null) {
    const declared = properties as Record<string, unknown>;
    const names = Object.keys(declared);
    if (isObjectSchema(declared['preview'])) into.push(`${at}.preview is an object`);
    for (const name of ['uiPaths', 'readyPath', 'readyWithinSeconds']) {
      if (names.includes(name)) into.push(`${at}.${name}`);
    }
    if (names.includes('command') && (names.includes('uiPaths') || names.includes('readyPath'))) {
      into.push(`${at} pairs a command with uiPaths or readyPath`);
    }
  }
  for (const [key, value] of Object.entries(schema))
    declarationCarriers(value, `${at}.${key}`, into);
  return into;
}

const json = (schema: z.ZodTypeAny): unknown =>
  toJsonSchemaSync(schema, { draft: 'draft-2020-12' });

describe('a folder’s preview (Plan 320 D18)', () => {
  it('is set by no operation: no input carries a preview declaration', () => {
    const reaching: string[] = [];
    for (const op of getAllOperations().values()) {
      const found = declarationCarriers([
        json(op.inputZod),
        ...(op.stepConfigZod ? [json(op.stepConfigZod)] : []),
      ]);
      for (const where of found) reaching.push(`${op.operationId}: ${where}`);
    }
    expect(reaching).toEqual([]);
  });

  it('is what the guard looks for: the declaration itself, and an input that would carry it, are caught', () => {
    expect(declarationCarriers(json(HostFolderPreviewSchema))).toEqual(
      expect.arrayContaining([
        '$.readyPath',
        '$.readyWithinSeconds',
        '$.uiPaths',
        '$ pairs a command with uiPaths or readyPath',
      ]),
    );
    expect(
      declarationCarriers(json(z.object({ folder: z.string(), preview: HostFolderPreviewSchema }))),
    ).toContain('$.preview is an object');
    expect(
      declarationCarriers(json(z.object({ preview: HostFolderPreviewSchema.optional() }))),
    ).toContain('$.preview is an object');
  });

  it('lets a run ask for the declared preview with a boolean', () => {
    expect(
      declarationCarriers(json(z.object({ command: z.string(), preview: z.boolean().optional() }))),
    ).toEqual([]);
  });
});

describe('the refusal of a preview on a port this stack serves on', () => {
  it('names the port, whose it is and why, for every service, in words of its own', () => {
    const ports = stackOwnPorts({});
    const services = new Set<string>();
    for (const [port, owner] of ports) {
      services.add(owner.service);
      const refusal = folderPreviewStackPortRefusal(port, describeStackPortOwner(owner));
      expect(refusal).toContain(`Port ${String(port)} is this stack's own — `);
      expect(refusal).toContain(describeStackPortOwner(owner));
      expect(refusal).toContain("a page from it could approve the agent's requests");
      expect(refusal).toContain("so no folder's preview is declared on it");
      expect(refusal).not.toContain('browser profile');
      expect(refusal).not.toBe(browserStackPortRefusal(port, describeStackPortOwner(owner)));
    }
    expect([...services].sort()).toEqual([...STACK_SERVICES].sort());
    expect(ports.has(DEFAULT_WEB_PORT) && ports.has(DEFAULT_API_PORT)).toBe(true);
  });

  it('follows a port moved by its variable', () => {
    const owner = stackOwnPorts({ WEB_DEV_PORT: '4400' }).get(4400);
    expect(owner).toEqual({ service: 'web', from: 'WEB_DEV_PORT' });
    if (owner === undefined) return;
    expect(folderPreviewStackPortRefusal(4400, describeStackPortOwner(owner))).toBe(
      "Port 4400 is this stack's own — the web application, as WEB_DEV_PORT sets it — and a " +
        "page from it could approve the agent's requests, so no folder's preview is declared " +
        "on it. Leave the port out and each run takes a free one, or fix one this stack doesn't serve on.",
    );
  });
});

describe('a preview’s ready path', () => {
  const declared = (readyPath: string): boolean =>
    HostFolderPreviewSchema.safeParse({ command: 'yarn dev --port {port}', readyPath }).success;

  it('is a path on the preview itself', () => {
    for (const path of ['/', '/health', '/api/ready?full=1', '/a/b.html#top']) {
      expect(declared(path), path).toBe(true);
    }
  });

  it('refuses whatever would name another host, or a path a person did not mean', () => {
    for (const path of [
      '//evil.example/health',
      '/\\evil.example',
      '/\\x',
      '/a\\b',
      '/health check',
      '/health\tcheck',
      '/health\n',
      '/\u0000',
      '/\u007f',
      'health',
    ]) {
      expect(declared(path), JSON.stringify(path)).toBe(false);
    }
  });

  it('names the default in its description as the path itself', () => {
    const description = HostFolderPreviewSchema.innerType().shape.readyPath.description ?? '';
    expect(description).toContain('Absent, `/`.');
    expect(description).not.toContain('FOLDER_PREVIEW_READY_PATH_DEFAULT');
  });
});
