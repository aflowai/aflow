import { describe, it, expect } from 'vitest';
import { ArtifactInspectOperationRegistrations } from './artifactInspect.js';

describe('artifact.inspect.* op metadata drift (Plan 201 §4.3)', () => {
  it('carries no evidence-tier gating / "brief is sufficient" language', () => {
    // The inspect tools are the default way the Coach reads the run — the
    // op guidance must not re-teach the deleted tier gate, or it will suppress
    // the run-reading behaviour the code now enables.
    const blob = JSON.stringify(ArtifactInspectOperationRegistrations);
    expect(blob).not.toMatch(/evidenceTier/);
    expect(blob).not.toMatch(/EVIDENCE_TIER_INSUFFICIENT/);
    expect(blob).not.toMatch(/escalation rate is monitored/i);
    expect(blob).not.toMatch(/brief is sufficient/i);
    expect(blob).not.toMatch(/deliberate/i);
  });
});
