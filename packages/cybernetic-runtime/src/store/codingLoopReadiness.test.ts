import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { codingLoopReadiness } from './codingLoopReadiness.js';

const ready = { machine: true, folder: true, github: true, schedule: true };

describe('coding loop readiness', () => {
  it('sends every setup action to a route declared for the local edition', () => {
    const manifest = readFileSync(
      new URL('../../../web-product/src/ui/routeManifest.ts', import.meta.url),
      'utf8',
    );
    const result = codingLoopReadiness({
      machine: false,
      folder: false,
      github: false,
      schedule: false,
      preview: false,
    });
    for (const task of result.tasks) {
      if (task.kind !== 'coding_loop_setup') continue;
      expect(manifest).toContain('s/[space]' + task.path);
    }
  });

  it('names each required setup action before anything fails', () => {
    const result = codingLoopReadiness({
      machine: false,
      folder: false,
      github: false,
      schedule: false,
    });
    expect(result.status).toBe('needs_setup');
    expect(result.tasks.map((task) => task.kind === 'coding_loop_setup' && task.step)).toEqual([
      'machine',
      'folder',
      'github',
      'schedule',
    ]);
    expect(result.tasks[1]?.description).toContain('branch prefix');
    expect(result.tasks[1]?.description).toContain('merge-posture');
    expect(result.tasks[2]?.description).toContain('Checks and Actions read');
    expect(result.tasks[2]?.description).toContain('Enable the github connection');
    expect(result.tasks[3]?.description).toContain('"$schedule": "id"');
  });

  it('removes completed setup and distinguishes failure from missing setup', () => {
    expect(codingLoopReadiness(ready)).toEqual({ status: 'ready', tasks: [] });
    expect(codingLoopReadiness({ ...ready, schedule: false }).status).toBe('needs_setup');
    expect(codingLoopReadiness({ ...ready, failure: 'GitHub refused the credential' }).status).toBe(
      'broken',
    );
  });

  it('withholds preview until its declaration lands', () => {
    expect(codingLoopReadiness(ready).tasks).toEqual([]);
    expect(codingLoopReadiness({ ...ready, preview: false }).tasks).toMatchObject([
      { step: 'preview' },
    ]);
    expect(codingLoopReadiness({ ...ready, preview: true }).tasks).toEqual([]);
  });
});
