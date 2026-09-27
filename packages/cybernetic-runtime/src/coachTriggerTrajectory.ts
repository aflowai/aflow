import type { EntityDirectives } from '@aflow/schemas';
import { detectTrajectoryRegression } from './promotion.js';

export interface TrajectoryCoachActivation {
  activate: true;
  source: 'trajectory_signal';
  reason: string;
}

export function checkTrajectoryCoachActivation(params: {
  trajectory: { direction: 'maximize' | 'minimize'; series: number[] };
  policy: EntityDirectives['learningPolicy'] | undefined;
}): TrajectoryCoachActivation | null {
  const { trajectory, policy } = params;
  const k = policy?.coachTrajectoryRegressionK ?? 2;
  const reg = detectTrajectoryRegression(trajectory.series, trajectory.direction, {
    k,
    minRuns: policy?.coachTrajectoryMinRuns ?? 6,
    recentWindow: policy?.coachTrajectoryRecentWindow ?? 3,
  });
  if (!reg?.regressed) {
    return null;
  }
  const nSigma = Number.isFinite(reg.nSigma) ? reg.nSigma.toFixed(1) : '∞';
  return {
    activate: true,
    source: 'trajectory_signal',
    reason: `trajectory regression: recent mean ${reg.recentMean} is ${nSigma}σ below peak ${reg.peak} (σ=${reg.sigma} over ${String(reg.baselineCount)} baseline runs, k=${String(k)})`,
  };
}
