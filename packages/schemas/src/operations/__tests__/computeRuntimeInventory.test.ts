/**
 * Contract: the python3-ml package inventory that agents read from the
 * `runtime` field description must match what docker/Dockerfile.python-ml
 * actually installs. A package added to the image without updating the
 * description leaves agents blind to it; an "absent" claim in the description
 * (tensorflow, keras) must stay true of the image.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ComputeExecInputSchema } from '../compute.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCKERFILE_PATH = join(__dirname, '../../../../..', 'docker/Dockerfile.python-ml');

const CLAIMED_ABSENT = ['tensorflow', 'keras'];

function unwrapEffects(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  while (current instanceof z.ZodEffects) {
    current = current._def.schema as z.ZodTypeAny;
  }
  return current;
}

function runtimeFieldDescription(): string {
  const shape = (unwrapEffects(ComputeExecInputSchema) as z.ZodObject<z.ZodRawShape>).shape;
  const runtimeField = shape['runtime'];
  if (!runtimeField) throw new Error('ComputeExecInputSchema has no `runtime` field');
  const description = runtimeField.description;
  if (!description) throw new Error('`runtime` field has no description');
  return description;
}

function pipInstalledPackages(dockerfile: string): string[] {
  const lines = dockerfile.split('\n');
  const packages: string[] = [];
  let inBlock = false;
  for (const raw of lines) {
    if (!inBlock && !raw.trimStart().startsWith('RUN pip install')) continue;
    inBlock = raw.trimEnd().endsWith('\\');
    const tokens = raw
      .replace(/\\\s*$/, '')
      .trim()
      .split(/\s+/);
    for (const token of tokens) {
      if (!token || token.startsWith('-') || token.includes('/')) continue;
      if (['RUN', 'pip', 'install'].includes(token)) continue;
      const name = token.split(/[=<>!~]/)[0];
      if (name) packages.push(name);
    }
  }
  if (packages.length === 0) {
    throw new Error(`No 'RUN pip install' block found in ${DOCKERFILE_PATH}`);
  }
  return packages;
}

describe('python3-ml runtime inventory contract', () => {
  const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf8');
  const installed = pipInstalledPackages(dockerfile);
  const description = runtimeFieldDescription();

  it('the Dockerfile pip block parses to a non-trivial package list', () => {
    expect(installed.length).toBeGreaterThanOrEqual(5);
    expect(installed).toContain('pandas');
  });

  it('every package the Dockerfile installs is named in the runtime field description', () => {
    const missing = installed.filter((pkg) => !description.includes(pkg));
    expect(missing).toEqual([]);
  });

  it('the packages the description claims absent are neither installed nor dropped from the description', () => {
    for (const claimed of CLAIMED_ABSENT) {
      expect(description).toContain(claimed);
      expect(installed.filter((pkg) => pkg.includes(claimed))).toEqual([]);
    }
  });
});
