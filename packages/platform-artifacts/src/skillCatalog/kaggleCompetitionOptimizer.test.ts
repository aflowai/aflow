import { describe, it, expect } from 'vitest';
import { KAGGLE_OPTIMIZER_EXECUTE_PROMPT } from './kaggleCompetitionOptimizerProse.js';

describe('Kaggle skill uses the workspace model', () => {
  it('execute prompt declares the workspace contract (inputs/outputs), not the legacy dance', () => {
    const p = KAGGLE_OPTIMIZER_EXECUTE_PROMPT;
    expect(p).toContain('workspace: { inputs:');
    expect(p).toContain('outputs:');
    expect(p).toContain('submission.csv');
    expect(p).not.toContain('inputPaths: [<dataRootPath>]');
    expect(p).not.toMatch(/Writes \/tmp\/output/);
    expect(p.toLowerCase()).not.toContain('legacy');
    // The submission is handed off by Memory path, not inline content.
    expect(p).toContain('submissionPayload.filePath');
    expect(p).not.toContain('submissionPayload.fileContent');
  });

  it('execute prompt carries the checkpoint protocol: per-fold state under checkpoints/, manifest-gated resume', () => {
    const p = KAGGLE_OPTIMIZER_EXECUTE_PROMPT;
    expect(p).toContain('<dataRootPath>checkpoints/');
    expect(p).toContain('one file per fold');
    expect(p).toContain(
      'manifest carrying the seed, a hash of the model config, and the folds completed so far',
    );
    // Resume trusts only manifest-listed folds — a flushed-then-superseded checkpoint
    // file can rehydrate under a matching manifest, so listing is the freshness gate.
    expect(p).toContain('skip only the folds the manifest lists');
    expect(p).toContain('overwriting any checkpoint file the manifest does not list');
    expect(p).toContain('never resume onto a different config');
    // The checkpoints dir is a declared workspace output so it persists.
    expect(p).toContain('"<dataRootPath>checkpoints/"');
  });

  it('execute prompt carries the ratified CV-LB guidance (registry is not behind the space doc)', () => {
    const p = KAGGLE_OPTIMIZER_EXECUTE_PROMPT;
    expect(p).toContain('**CV-LB divergence diagnostic:**');
    expect(p).toContain('REVERT to the prior feature set');
    expect(p).toContain('**Gap-widening rate:**');
    expect(p).toContain('more than doubles in a single iteration');
    expect(p).toContain('**Interaction OOF on small datasets:**');
    // The corrected guidance replaced the misleading noise-sensitivity diagnosis.
    expect(p).not.toContain('noise sensitivity');
  });
});
