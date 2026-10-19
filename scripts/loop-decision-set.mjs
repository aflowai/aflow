/**
 * The labelled set behind Plan 316 §7: the loop's own decisions, read back
 * from what it recorded, and how well each decider agrees with them.
 *
 * Pure: the records come in already read (`decisions-measure-loop.ts` reads them from
 * the stack's API and from GitHub), and nothing here reaches a model. A label
 * is what was done next, inferred from the records, unless the operator's
 * labels file says otherwise; a case nothing followed is left unlabelled
 * rather than guessed, and the report counts both.
 */

/** What a failing CI job's remedy was, as the PR's history shows it (Plan 321). */
export const CI_REMEDY_QUESTION_NAME = 'remedy';
export const CI_REMEDY_QUESTION = {
  type: 'choice',
  instructions:
    "A pull request's CI job failed, and this is the end of its log. What puts it right: running it again, a fix to the code, a bump of a dependency resolution, or merging the base branch in.",
  options: {
    rerun:
      'Nothing in the change failed: a flaky test, a runner or network fault, a timeout under load. The same commit passes when the job runs again.',
    code_fix:
      'The change itself fails the job — a test, a type check, a lint or a guard — and a commit to the code puts it right.',
    resolutions_bump:
      'A dependency audit or install failed on an advisory or a version: a bump of a resolution in package.json and the lockfile puts it right.',
    merge_round:
      'The branch is behind its base, and what fails is fixed there already or conflicts with it: merging the base in puts it right.',
  },
};

/**
 * Whether one review finding names a defect in the change's behaviour that its
 * evidence shows: asked of each finding, against whether a later publication
 * closed it.
 */
export const FINDING_QUESTION = {
  type: 'yes_no',
  instructions:
    "The finding names a defect in the change's behaviour, established by evidence shown.",
  criteria: {
    true: 'The claim is about what the changed code does — a wrong result, a crash, a race, a leak, a hole, a broken contract or a test that does not test what it says — and the evidence quoted shows it in this change.',
    false:
      'The claim is a preference, a name, a style or a wording; or a defect the evidence does not show; or about code this change did not touch.',
  },
};

/** How many times a read the stack rate-limited is tried before the collection stops. */
export const RATE_LIMIT_ATTEMPTS = 6;
const RATE_LIMIT_MAX_DELAY_MS = 60_000;

/**
 * How long to wait before trying a rate-limited read again: what the stack's
 * `Retry-After` asks, where it asks in seconds, else doubling from a second.
 */
export function retryDelayMs(attempt, retryAfter) {
  const asked = retryAfter === null || retryAfter === undefined ? Number.NaN : Number(retryAfter);
  const ms = Number.isFinite(asked) && asked >= 0 ? asked * 1000 : 1000 * 2 ** attempt;
  return Math.min(ms, RATE_LIMIT_MAX_DELAY_MS);
}

/** Whether `gh` failed because what it was asked for does not exist — a PR number with no pull request. */
export function isGhNotFound(error) {
  const text = `${String(error?.stderr ?? '')}\n${String(error?.message ?? '')}`;
  return text.includes('HTTP 404');
}

/** How many lines of a failing job's log a case carries: Plan 321 §P0 measured 300 as enough. */
export const CI_LOG_EXCERPT_LINES = 300;

/** The last `lines` lines of a log. */
export function logExcerpt(log, lines = CI_LOG_EXCERPT_LINES) {
  const all = log.split('\n');
  return all.slice(Math.max(0, all.length - lines)).join('\n');
}

/**
 * Failed checks, from the branch's publications in the order they started.
 * The label is what the next publication of the same branch did: a change
 * appended is a fix commissioned; the same head published as it stands is a
 * run of the checks again. Nothing the records hold says the operator put the
 * machine right before publishing again, so `operator_install_mismatch` is the
 * operator's label to give, never an inferred one.
 *
 * A publication: `{ runId, startedAt, branch, headSha, carriedChange,
 * checkFailed, checkAccount }`, `headSha` the commit it checked and
 * `carriedChange` whether it committed a change rather than publishing a
 * branch as it stands.
 */
export function checkFailureCases(publications) {
  const byBranch = new Map();
  for (const p of [...publications].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    const list = byBranch.get(p.branch) ?? [];
    list.push(p);
    byBranch.set(p.branch, list);
  }
  const cases = [];
  for (const list of byBranch.values()) {
    list.forEach((p, i) => {
      if (!p.checkFailed) return;
      const next = list[i + 1];
      let label = null;
      if (next !== undefined && next.carriedChange) label = 'fix_commission';
      else if (next !== undefined && next.headSha === p.headSha) label = 'recheck_on_timeout';
      cases.push({
        id: `check:${p.runId}`,
        kind: 'after_check',
        state: p.checkAccount,
        label,
        labelSource: label === null ? 'none' : 'inferred',
        followedBy: next?.runId ?? null,
      });
    });
  }
  return cases;
}

/** A finding's identity across a review and the publications that carry it on. */
export function findingKey(finding) {
  return `${finding.file}\u0000${finding.claim.trim().toLowerCase()}`;
}

/**
 * Reviews, each against the publications of its branch that
 * started after it. A later publication carrying a finding `closed` fixed it;
 * one carrying it `open` left it — accepted or dismissed, which the records do
 * not tell apart, so the yes/no label reads fixed as a defect and left as not
 * one, and an operator's label of `accepted` turns a left one back into a
 * defect. The round's label: a later publication that carried a change and
 * closed any of them is `fix_before_merge`; one that carried them all open is
 * `publish_as_is`; none carrying them leaves the round unlabelled, for the
 * operator's labels file to settle, as `operator_install_mismatch` is above.
 * An approving review of nits alone, or of nothing, makes no round case: the
 * publication settles it `publish_as_is` without asking, so the measurement
 * asks it nothing either. A review under any other verdict is asked whatever
 * it found, and makes one.
 *
 * A review: `{ runId, startedAt, branch, verdict, findings: [{ file, line?,
 * claim, evidence, severity }] }`; a publication as above with `findings: [{
 * file, claim, state }]`, the findings it was handed.
 */
export function reviewCases(reviews, publications) {
  const cases = [];
  for (const review of reviews) {
    const later = publications
      .filter((p) => p.branch === review.branch && p.startedAt > review.startedAt)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const states = new Map();
    let fixedInARound = false;
    let carried = false;
    for (const p of later) {
      for (const f of p.findings ?? []) {
        const key = findingKey(f);
        if (!review.findings.some((r) => findingKey(r) === key)) continue;
        carried = true;
        // The latest word on a finding is the one that stands.
        states.set(key, f.state);
        if (f.state === 'closed' && p.carriedChange) fixedInARound = true;
      }
    }
    review.findings.forEach((finding, i) => {
      const state = states.get(findingKey(finding));
      const label = state === undefined ? null : state === 'closed';
      cases.push({
        id: `finding:${review.runId}:${String(i)}`,
        kind: 'finding',
        state: { finding },
        label,
        labelSource: label === null ? 'none' : 'inferred',
      });
    });
    const settled =
      review.verdict === 'approve' &&
      review.findings.every((finding) => finding.severity === 'nit');
    if (settled) continue;
    const round = !carried ? null : fixedInARound ? 'fix_before_merge' : 'publish_as_is';
    cases.push({
      id: `round:${review.runId}`,
      kind: 'after_review',
      state: { verdict: review.verdict, findings: review.findings },
      label: round,
      labelSource: round === null ? 'none' : 'inferred',
    });
  }
  return cases;
}

/**
 * Failing CI jobs on a pull request, each labelled by what came next on it:
 * another attempt of the same workflow run with no commit between is a
 * re-run; otherwise the next commit says — a merge (two parents) is a merge
 * round, a commit touching only package.json and yarn.lock whose package.json
 * change is under `resolutions` is a resolutions bump, anything else a code
 * fix. A failure nothing followed is unlabelled.
 *
 * A pull request: `{ number, commits: [{ sha, parents, files: [{ filename,
 * patch? }] }], failures: [{ jobId, runId, attempt, headSha, log }],
 * attempts: [{ runId, attempt, headSha }] }`, commits in order.
 */
export function ciFailureCases(pr) {
  const order = new Map(pr.commits.map((c, i) => [c.sha, i]));
  return pr.failures.map((failure) => {
    const rerun = pr.attempts.some(
      (a) =>
        a.runId === failure.runId && a.attempt > failure.attempt && a.headSha === failure.headSha,
    );
    const at = order.get(failure.headSha);
    const next = at === undefined ? undefined : pr.commits[at + 1];
    let label = null;
    if (rerun) label = 'rerun';
    else if (next !== undefined) label = remedyOf(next);
    return {
      id: `ci:${String(pr.number)}:${String(failure.jobId)}:${String(failure.attempt)}`,
      kind: 'ci_remedy',
      state: logExcerpt(failure.log),
      label,
      labelSource: label === null ? 'none' : 'inferred',
    };
  });
}

function remedyOf(commit) {
  if (commit.parents.length > 1) return 'merge_round';
  const names = commit.files.map((f) => f.filename);
  const manifestOnly =
    names.length > 0 && names.every((n) => n === 'package.json' || n === 'yarn.lock');
  const manifest = commit.files.find((f) => f.filename === 'package.json');
  if (manifestOnly && manifest?.patch !== undefined && /"resolutions"/.test(manifest.patch)) {
    return 'resolutions_bump';
  }
  return 'code_fix';
}

/**
 * The operator's word over the inferred one: `{ [caseId]: label }`, where a
 * finding takes `fixed` or `accepted` (a defect) or `dismissed` (not one).
 */
export function applyOperatorLabels(cases, labels) {
  return cases.map((c) => {
    if (!Object.hasOwn(labels, c.id)) return c;
    const given = labels[c.id];
    const label =
      c.kind === 'finding' ? given === 'fixed' || given === 'accepted' || given === true : given;
    return { ...c, label, labelSource: 'operator' };
  });
}

/** The value a decider's answer is compared with the label as. */
function agrees(answer, label) {
  return answer.value === label;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i];
}

/**
 * One decider over the labelled cases of one kind, at one minConfidence:
 * agreement among the cases it decided, the share it abstained on, agreement
 * over every case with an abstention counted as not agreeing, and what a
 * decision took and cost. A decider that failed on a case is counted apart:
 * an error is neither an answer nor an abstention.
 *
 * A result: `{ caseId, value, confidence, latencyMs, costUsd, error? }`.
 */
export function score(cases, results, minConfidence) {
  const labelled = new Map(cases.filter((c) => c.label !== null).map((c) => [c.id, c]));
  let decided = 0;
  let agreed = 0;
  let abstained = 0;
  let errors = 0;
  const latencies = [];
  let cost = 0;
  let costed = 0;
  for (const r of results) {
    const c = labelled.get(r.caseId);
    if (c === undefined) continue;
    if (r.error !== undefined) {
      errors += 1;
      continue;
    }
    latencies.push(r.latencyMs);
    if (r.costUsd !== null && r.costUsd !== undefined) {
      cost += r.costUsd;
      costed += 1;
    }
    if (r.confidence < minConfidence) {
      abstained += 1;
      continue;
    }
    decided += 1;
    if (agrees(r, c.label)) agreed += 1;
  }
  const answered = decided + abstained;
  latencies.sort((a, b) => a - b);
  return {
    minConfidence,
    cases: answered + errors,
    errors,
    decided,
    agreement: decided === 0 ? null : agreed / decided,
    abstention: answered === 0 ? null : abstained / answered,
    agreementOverAll: answered === 0 ? null : agreed / answered,
    latencyMsP50: quantile(latencies, 0.5),
    latencyMsP95: quantile(latencies, 0.95),
    costUsdPerDecision: costed === 0 ? null : cost / costed,
  };
}

export const SWEEP = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95];

/** The same decider scored at every bar of the sweep, for choosing where it abstains. */
export function sweep(cases, results, bars = SWEEP) {
  return bars.map((bar) => score(cases, results, bar));
}

/**
 * The lowest bar at which the decider agrees with the operator at least as
 * often as `target` among what it decides, or null where none does: below it
 * the skill would act on answers it gets wrong more often than that.
 */
export function chooseMinConfidence(cases, results, target, bars = SWEEP) {
  for (const row of sweep(cases, results, bars)) {
    if (row.agreement !== null && row.decided > 0 && row.agreement >= target) {
      return row.minConfidence;
    }
  }
  return null;
}

function pct(x) {
  return x === null ? '—' : `${(x * 100).toFixed(1)}%`;
}

function num(x, digits = 0) {
  return x === null ? '—' : x.toFixed(digits);
}

/**
 * The tables Plan 316 §7 and the node's outcome carry: per question, the
 * labelled set's size and where its labels came from, then one row per decider
 * at the bar chosen for it.
 */
export function renderReport({ generatedAt, kinds }) {
  const lines = [`Measured ${generatedAt}.`, ''];
  for (const kind of kinds) {
    const labelled = kind.cases.filter((c) => c.label !== null);
    const bySource = (s) => labelled.filter((c) => c.labelSource === s).length;
    lines.push(
      `**${kind.title}** — ${String(labelled.length)} labelled of ${String(kind.cases.length)} (${String(bySource('operator'))} by the operator, ${String(bySource('inferred'))} inferred from what followed).`,
      '',
      '| Decider | minConfidence | Agreement (decided) | Abstention | Agreement (all) | Errors | p50 / p95 ms | Cost per decision |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const row of kind.rows) {
      const s = row.score;
      lines.push(
        `| ${row.decider} | ${num(s.minConfidence, 2)} | ${pct(s.agreement)} | ${pct(s.abstention)} | ${pct(s.agreementOverAll)} | ${String(s.errors)} | ${num(s.latencyMsP50)} / ${num(s.latencyMsP95)} | ${s.costUsdPerDecision === null ? '—' : `$${s.costUsdPerDecision.toFixed(5)}`} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}
