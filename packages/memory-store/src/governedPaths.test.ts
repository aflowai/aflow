/**
 * What governance answers, for the path a caller wrote and for the row it lands
 * on. Both are the same question, because a document is addressed by its
 * canonical path and a directory removal takes every document beneath it.
 */
import { describe, it, expect } from 'vitest';
import { governedPathRefusal, governedSubtreeRefusal } from './governedPaths.js';

const RUN = '9c1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8';

describe('governedPathRefusal', () => {
  it.each([
    `/media/${RUN}/take-1-0`,
    `//media/${RUN}/take-1-0`,
    `/media/./${RUN}/take-1-0`,
    `/media/x/../${RUN}/take-1-0`,
    'media/r/take-1-0',
  ])('refuses a render however the caller spells its path: %s', (path) => {
    expect(governedPathRefusal(path)).toContain('blocked');
  });

  it.each(['/evals/skill-1/suite.json', '//evals/skill-1/suite.json', '/evals/./s/suite.json'])(
    'refuses an eval suite however the caller spells its path: %s',
    (path) => {
      expect(governedPathRefusal(path)).toContain('learner.propose.workflow_change');
    },
  );

  it.each(['/coach/evidence/2026/source-1.json', '//coach/evidence/2026/source-1.json'])(
    'refuses platform evidence however the caller spells its path: %s',
    (path) => {
      expect(governedPathRefusal(path)).toContain('platform-only');
    },
  );

  it('names the row the refusal is about, not the spelling that reached it', () => {
    expect(governedPathRefusal(`//media/${RUN}/take-1-0`)).toContain(`/media/${RUN}/take-1-0`);
  });

  it('lets the lane that owns the prefix write it, in any spelling', () => {
    expect(governedPathRefusal(`/media/${RUN}/take-1-0`, 'generated_media')).toBeNull();
    expect(governedPathRefusal(`//media/${RUN}/take-1-0`, 'generated_media')).toBeNull();
  });

  it.each([
    '/notes/shot-list.md',
    '/mediation/plan.md',
    '/evaluations/notes.md',
    '/evals/notes.md',
  ])('leaves a path of the caller’s own alone: %s', (path) => {
    expect(governedPathRefusal(path)).toBeNull();
  });

  it('answers nothing for an absent path', () => {
    expect(governedPathRefusal(undefined)).toBeNull();
    expect(governedPathRefusal(null)).toBeNull();
  });
});

describe('governedSubtreeRefusal', () => {
  it.each([
    `/media/${RUN}`,
    `//media/${RUN}`,
    `/media/./${RUN}`,
    `/media/x/../${RUN}`,
    `/media/${RUN}/`,
    '/evals/skill-1',
    '/coach/evidence/2026',
  ])('refuses a directory inside a governed prefix: %s', (path) => {
    expect(governedSubtreeRefusal(path)).toContain('the platform writes and owns');
  });

  it.each(['/media', '/evals', '/coach', '/coach/evidence', '/'])(
    'refuses a directory that holds a governed prefix: %s',
    (path) => {
      expect(governedSubtreeRefusal(path)).toContain('the platform writes and owns');
    },
  );

  it.each(['/notes/shots', '/mediation', '/evaluations', '/coaching'])(
    'leaves a directory of the caller’s own alone: %s',
    (path) => {
      expect(governedSubtreeRefusal(path)).toBeNull();
    },
  );

  it('answers nothing for an absent path', () => {
    expect(governedSubtreeRefusal(undefined)).toBeNull();
    expect(governedSubtreeRefusal(null)).toBeNull();
  });
});

describe('workflow definitions are changed through workflow.manage.patch and the operator', () => {
  it.each([
    '/workflows/lead-scoring/workflow.json',
    '/workflows/lead-scoring/activation.json',
    '/workflows/lead-scoring/revisions/3.json',
    '//workflows/./lead-scoring/workflow.json',
  ])('refuses a direct write to %s, naming the path that does it', (path) => {
    expect(governedPathRefusal(path)).toContain('workflow.manage.patch');
  });

  it('leaves a skill’s other documents under its folder writable', () => {
    expect(
      governedPathRefusal(
        '/workflows/kaggle-competition-optimizer/competitions/titanic/data/train.csv',
      ),
    ).toBeNull();
  });

  it.each(['/workflows', '/workflows/lead-scoring', '/workflows/lead-scoring/revisions'])(
    'refuses deleting %s, which removes a definition',
    (path) => {
      expect(governedSubtreeRefusal(path)).toContain('workflow definition');
    },
  );

  it('allows deleting a skill’s own cache folder', () => {
    expect(
      governedSubtreeRefusal('/workflows/kaggle-competition-optimizer/competitions/titanic'),
    ).toBeNull();
  });
});

describe('a skill manifest changes only through a ratified proposal', () => {
  it('refuses a direct write to the manifest', () => {
    expect(governedPathRefusal('/skills/lead-scoring/manifest.json')).toContain(
      'workflow.manage.patch',
    );
  });

  it('leaves other documents under a skill folder alone', () => {
    expect(governedPathRefusal('/skills/lead-scoring/notes.md')).toBeNull();
  });

  it('refuses deleting a skill folder, which takes the manifest with it', () => {
    expect(governedSubtreeRefusal('/skills/lead-scoring')).toContain('workflow definition');
  });
});
