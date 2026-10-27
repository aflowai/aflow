import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { codingLoopReadiness } from './codingLoopReadiness.js';

const ready = { machine: true, folder: true, github: true, schedule: true, agent: true };

describe('coding loop readiness', () => {
  it('sends every setup action to a route declared for the local edition', () => {
    const manifest = readFileSync(
      new URL('../../../web-product/src/ui/routeManifest.ts', import.meta.url),
      'utf8',
    );
    const result = codingLoopReadiness({
      agent: false,
      machine: false,
      folder: false,
      github: false,
      schedule: false,
      preview: false,
    });
    for (const task of result.tasks) {
      if (task.kind !== 'coding_loop_setup') continue;
      expect(manifest).toContain(
        's/[space]' + (task.step === 'agent' ? '/store/[catalogId]' : task.path),
      );
    }
  });

  it('names each required setup action before anything fails', () => {
    const result = codingLoopReadiness({
      agent: false,
      machine: false,
      folder: false,
      github: false,
      schedule: false,
    });
    expect(result.status).toBe('needs_setup');
    expect(result.tasks.map((task) => task.kind === 'coding_loop_setup' && task.step)).toEqual([
      'machine',
      'folder',
      'agent',
      'github',
      'schedule',
    ]);
    expect(result.tasks[1]?.description).toContain('branch prefix');
    expect(result.tasks[1]?.description).toContain('merge-posture');
    expect(result.tasks[3]?.description).toContain('Checks and Actions read');
    expect(result.tasks[3]?.description).toContain('Enable the github connection');
    expect(result.tasks[4]?.description).toContain(
      '{ "input": "tend", "config": { "scheduleId": { "$schedule": "id" } } }',
    );
  });

  it('removes completed setup and distinguishes failure from missing setup', () => {
    expect(codingLoopReadiness(ready)).toEqual({ status: 'ready', tasks: [] });
    expect(codingLoopReadiness({ ...ready, schedule: false }).status).toBe('needs_setup');
    expect(codingLoopReadiness({ ...ready, failure: 'GitHub refused the credential' }).status).toBe(
      'broken',
    );
  });

  it('retains the agent task after a folder is connected until repair creates it', () => {
    expect(codingLoopReadiness({ ...ready, agent: false, schedule: false }).tasks).toMatchObject([
      {
        step: 'agent',
        path: '/store/coding-loop',
        description: expect.stringContaining('Repair installation'),
      },
      { step: 'schedule' },
    ]);
    expect(codingLoopReadiness({ ...ready, schedule: false }).tasks).toMatchObject([
      { step: 'schedule' },
    ]);
  });

  it('directs an archived shepherd to restoration rather than reinstall', () => {
    const result = codingLoopReadiness({
      ...ready,
      agent: false,
      archivedAgent: true,
      schedule: false,
    });
    expect(result).toMatchObject({
      status: 'needs_setup',
      tasks: [
        {
          step: 'agent',
          path: '/agents',
          description: expect.stringContaining('Restore the archived'),
        },
        { step: 'schedule' },
      ],
    });
  });

  it('withholds preview until its declaration lands', () => {
    expect(codingLoopReadiness(ready).tasks).toEqual([]);
    expect(codingLoopReadiness({ ...ready, preview: false }).tasks).toMatchObject([
      { step: 'preview' },
    ]);
    expect(codingLoopReadiness({ ...ready, preview: true }).tasks).toEqual([]);
  });
});
