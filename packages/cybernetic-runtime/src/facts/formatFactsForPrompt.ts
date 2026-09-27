import type { CoachReviewFacts } from '@aflow/schemas';

/**
 * Render a markdown block summarizing the deterministic facts. Empty
 * categories are omitted to keep the brief compact. Returns the empty
 * string when the facts record is essentially empty (nothing to teach
 * the Coach beyond the digest).
 */
export function formatCoachFactsForPrompt(facts: CoachReviewFacts): string {
  const sections: string[] = [];

  if (facts.taskFailures.length > 0) {
    const lines = facts.taskFailures.slice(0, 10).map((f) => {
      const repeat = f.repeatedShapeCount > 1 ? ` (×${String(f.repeatedShapeCount)} this run)` : '';
      return `- ${f.taskId} attempt ${String(f.attempt)} — ${f.errorCategory}${repeat}: ${f.errorMessage.slice(0, 200)}`;
    });
    sections.push(['### Task failures', ...lines].join('\n'));
  }

  if (facts.missingInputs.length > 0) {
    const lines = facts.missingInputs
      .slice(0, 10)
      .map((m) => `- ${m.taskId} missing input \`${m.inputKey}\` (${m.source})`);
    sections.push(['### Missing inputs (runner reflection)', ...lines].join('\n'));
  }

  if (facts.missingTools.length > 0) {
    const lines = facts.missingTools
      .slice(0, 10)
      .map((m) => `- ${m.taskId} asked for tool \`${m.toolName}\` (${m.source})`);
    sections.push(['### Missing tools (runner reflection)', ...lines].join('\n'));
  }

  if (facts.contractViolations.length > 0) {
    const lines = facts.contractViolations
      .slice(0, 10)
      .map((v) => `- ${v.taskId} — ${v.kind}: ${v.detail.slice(0, 200)}`);
    sections.push(['### Contract violations', ...lines].join('\n'));
  }

  if (facts.platformEnvironmentSignals.length > 0) {
    const lines = facts.platformEnvironmentSignals.map(
      (s) => `- ${s.kind} ×${String(s.count)}: ${s.detail.slice(0, 200)}`,
    );
    sections.push(['### Platform / environment signals', ...lines].join('\n'));
  }

  if (facts.costLatencyAnomalies.length > 0) {
    const lines = facts.costLatencyAnomalies.slice(0, 10).map((a) => {
      const baseline =
        a.baselineMedian !== undefined ? ` (baseline median ${String(a.baselineMedian)})` : '';
      const dev =
        a.stddevsAboveBaseline !== undefined
          ? `, ${a.stddevsAboveBaseline.toFixed(1)} MADs above`
          : '';
      return `- ${a.taskId ?? 'run'} ${a.metric}=${String(a.value)}${baseline}${dev}`;
    });
    sections.push(['### Cost / latency anomalies', ...lines].join('\n'));
  }

  if (facts.repeatedToolShapes.length > 0) {
    const lines = facts.repeatedToolShapes.slice(0, 10).map((r) => {
      const base = `- ${r.operationId} repeated ×${String(r.count)} (allSucceeded=${String(r.allSucceeded)})`;
      return r.detail ? `${base} — ${r.detail}` : base;
    });
    sections.push(['### Repeated tool-call shapes', ...lines].join('\n'));
  }

  if (facts.dataflowBreaks.length > 0) {
    const lines = facts.dataflowBreaks.slice(0, 10).map((d) => {
      const arrow = d.toTaskId ? `${d.fromTaskId} → ${d.toTaskId}` : `${d.fromTaskId} → ?`;
      return `- ${arrow}: ${d.detail.slice(0, 200)}`;
    });
    sections.push(['### Dataflow breaks', ...lines].join('\n'));
  }

  if (facts.scopeSignal) {
    sections.push(
      `### Scope signal\n- ${facts.scopeSignal.kind}: ${facts.scopeSignal.detail.slice(0, 300)}`,
    );
  }

  if (facts.evalDeltas) {
    const overall =
      facts.evalDeltas.overall !== undefined
        ? `overall Δ=${facts.evalDeltas.overall.toFixed(3)}`
        : 'overall Δ=n/a';
    const regression = facts.evalDeltas.regressionConfirmed ? ' (regression confirmed)' : '';
    sections.push(`### Eval deltas\n- ${overall}${regression}`);
  }

  if (facts.priorObservationRollup.length > 0) {
    const lines = facts.priorObservationRollup.map((r) => {
      const span =
        r.firstSeen === r.lastSeen
          ? `at ${r.lastSeen.slice(0, 10)}`
          : `${r.firstSeen.slice(0, 10)}…${r.lastSeen.slice(0, 10)}`;
      return `- ${r.reason} ×${String(r.count)} (${span})`;
    });
    sections.push(['### Prior observation rollup', ...lines].join('\n'));
  }

  if (facts.priorProposalHistory.length > 0) {
    const lines = facts.priorProposalHistory
      .slice(0, 10)
      .map((p) => `- ${p.status.toUpperCase()} ${p.at.slice(0, 10)} — ${p.summary.slice(0, 160)}`);
    sections.push(['### Prior proposal history', ...lines].join('\n'));
  }

  if (sections.length === 0) return '';

  return [
    '## Facts (deterministic — trust these over the digest narrative on conflict)',
    '',
    ...sections,
  ].join('\n\n');
}
