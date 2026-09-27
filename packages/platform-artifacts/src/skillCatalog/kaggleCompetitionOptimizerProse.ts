export const KAGGLE_OPTIMIZER_EXECUTE_PROMPT = `Choose a strategy, train a model in the sandbox, and decide whether to submit.

Inputs (already in your task context):
- \`competitionSlug\` — competition slug.
- \`metricName\` — the evaluation metric name (display/context only; nothing gates on it).
- \`metricDirection\` — \`'minimize'\` | \`'maximize'\`; tells you which way improvement points. The authoritative outcome is the leaderboard score itself.
- \`dataRootPath\` — memory prefix containing train.csv, test.csv, and the submission template file.
- \`submissionTemplateFile\` — the actual submission template file name (e.g. \`sample_submission.csv\` or \`gender_submission.csv\` on Titanic). Mirror its column layout when writing your own submission.csv.
- Prior learnings from past runs of this skill — auto-injected by the platform. Read them; they tell you what's worked and what to avoid.

Steps:

1. Pick a strategy. If prior learnings exist, build on what worked and avoid what failed. If this is the first run, start with a sensible baseline for the competition type (e.g., gradient boosting on tabular).

2. Write a single Python script that:
   - Reads \`train.csv\` and \`test.csv\` under \`dataRootPath\`.
   - Trains a model with a clear validation split (k-fold or stratified). Seed = 42.
   - Checkpoints as it goes: as each fold completes, writes that fold's OOF predictions + fold metric under \`<dataRootPath>checkpoints/\` (one file per fold), plus a manifest carrying the seed, a hash of the model config, and the folds completed so far. Checkpoints survive interruption — a killed run costs one fold, not the whole training.
   - Predicts on test.
   - Writes a submission to \`<dataRootPath>submission.csv\`, matching the column layout of the file named \`submissionTemplateFile\` (read its header to know the exact column names and order).
   - Prints one JSON line to stdout, e.g. \`{"validationScore": 0.812, "approach": "xgboost + age*class interaction + median age fill"}\`.

3. Run via \`compute.sandbox.exec\` with \`runtime: 'python3-ml'\`, \`workspace: { inputs: ["<dataRootPath>"], outputs: ["<dataRootPath>submission.csv", "<dataRootPath>checkpoints/"] }\`. Network is off.

4. If the script fails: read stderr, fix the specific problem, re-run. On a retry after a timeout, read the checkpoint manifest first — if its seed and config hash match yours, skip only the folds the manifest lists and train the rest, overwriting any checkpoint file the manifest does not list (an unlisted file is stale — never read it); if they do not match, start clean: write a fresh manifest and retrain every fold, overwriting old checkpoint files (never resume onto a different config). Hard cap of 3 sandbox attempts. If all fail, set \`validationScore: null\` and continue to step 7 with \`submit: false\`.

5. Decide whether to submit. **Default = submit.** CV is a noisy proxy for LB; a CV regression that comes from better regularization often improves LB, and you NEED the LB observation to confirm or refute. Do NOT auto-skip on a CV regression alone. Skip ONLY when (a) all sandbox attempts failed (no submission to make), or (b) the candidate is structurally identical to a prior submitted run (same model family + same hyperparams + same features) and wouldn't produce new LB signal. The operator gates every submission via approve-submit (HITL), so default-permissive at the skill level is safe — the operator can reject if they want to conserve daily quota.

6. If submitting: build a short submission message like \`"iteration N — <one-line approach>"\`. Set \`submissionPayload.filePath\` to your submission's Memory path — \`"<dataRootPath>submission.csv"\`.

7. Submit your output.

Guidance worth remembering:
- **CV-LB divergence diagnostic:** When CV improves but LB regresses from a prior iteration, this is a strong fold overfitting signal — features captured fold-specific noise, not generalizable signal. Especially on small datasets (≤1500 rows) where high-cardinality interaction encodings are prone to fold overfitting. REVERT to the prior feature set and pivot to a different lever (e.g. model stacking, regularization tuning). Do NOT continue adding more of the same feature type.
- **Gap-widening rate:** Track the CV-LB gap across iterations. If the gap more than doubles in a single iteration alongside LB regression, treat it as fold overfitting regardless of the absolute gap value — even if still under 1.5pt.
- **Interaction OOF on small datasets:** Interaction-term OOF target encodings that work on larger datasets (~8000 rows) can regress LB on small datasets (~1500 rows) by capturing fold noise. Be cautious with interaction OOF on small training sets.
- Be specific in your \`approach\` field. "Added regularization" is worth nothing to the next iteration; "added L2=0.1 on logistic regression; CV improved from 0.78 to 0.81" is useful.

Output (submit_output):
{
  approachSummary: string,            // 1-2 sentence summary of the strategy you tried
  validationScore: number | null,     // null if all sandbox attempts failed
  submit: boolean,
  decisionRationale: string,          // why you chose to submit or skip, max 500 chars
  submissionPayload: {                // present ONLY when submit=true; absent when false
    filePath: string,                 // Memory path of your submission.csv (the path you declared in workspace.outputs), e.g. "<dataRootPath>submission.csv"
    message: string                   // short message for Kaggle's submission note
  } | null
}

If you cannot proceed (data missing, all sandbox attempts failed for the same root cause, etc.), submit your output with \`submit: false\` and a short \`decisionRationale\` explaining why. Do not loop or try ad-hoc workarounds outside the steps above.

Your tools are listed by the platform — do not narrate failures of tools you didn't actually call. If \`workflow.learn\`, \`workflow.run.*\`, or any other op isn't in your toolbox, it does not exist for you. The platform persists learnings via a downstream task; you don't write to the ledger yourself.`;

export const KAGGLE_OPTIMIZER_EXTRACT_LEARNINGS_PROMPT = `Summarize this iteration and produce 1-3 specific learnings the next iteration will read.

Inputs (already in your task context):
- \`approachSummary\` — what was tried (from execute).
- \`validationScore\` — null if execution failed (from execute).
- \`submit\`, \`decisionRationale\` — whether you submitted, and why (from execute).
- \`lbValue\` — the actual Kaggle public LB score (from poll-lb). null whenever scoring did not complete.
- \`lbStatus\` — the raw Kaggle submission status (lowercase): \`'complete'\` when scored, \`'error'\` when Kaggle rejected the file, or a not-yet-scored status (\`'pending'\` | \`'queued'\` | \`'evaluating'\`) if scoring was still running when the poll window closed. Determines how trustworthy lbValue is and how to frame learnings.
- Prior learnings — auto-injected by the platform.

Signal hierarchy:
- When \`lbStatus === 'complete'\`, lbValue is the primary signal — it's the actual generalization score on Kaggle's test set. Treat CV (validationScore) as a secondary, often-noisy indicator. The CV-LB gap is itself a learning worth recording (e.g. "CV=0.8372 → LB=0.751 — model overfits feature interactions; smaller depth or fewer features next iteration").
- When \`lbStatus === 'error'\`, the file was rejected by Kaggle (wrong columns, format error, etc.). Record the failure detail and the lesson for the next submission shape.
- When lbStatus is any not-yet-scored status (\`'pending'\`, \`'queued'\`, \`'evaluating'\`), we never got the LB number — scoring was still running when the poll window closed. Rely on validationScore for the run-quality narrative but note that the LB result is unresolved — future iterations cannot compare against this run's true generalization.

Base learnings on what actually happened (approachSummary, the scores, the decision). Do not invent platform failures — if execute didn't say something failed, it didn't. Workflow-adjustment learnings should only fire when you have a concrete platform observation, not when you're guessing what the agent might have tried.

This task runs in BOTH branches:
- submit-yes path: you submitted; learnings should be about the approach and the validation outcome AND the LB outcome (if available).
- submit-no / reject path: you skipped (quota, regression, or operator rejected). The skip rationale IS the signal — record it.

Be specific. Name the model family, the hyperparameter, the feature engineering step. "Regularization helped" is useless; "L2=0.1 on logistic regression improved CV from 0.78 to 0.81" is useful. Pick the 1-3 most useful learnings — not 5 vague ones.

Submit your output via \`submit_output\` with this exact shape:

{
  runSummary: string,                   // max 500 chars — 2-3 sentences naming the approach + outcome
  learnings: [                          // 1-3 entries (NOT 5 — be selective)
    {
      id: string,                       // unique kebab-case slug within this run, e.g. "added-l2-1"
      category: 'worked' | 'failed' | 'discovered' | 'hypothesis' | 'workflow_adjustment',
      observation: string,              // max 300 — the specific fact
      interpretation?: string,          // max 200 — what it implies
      recommendation?: string,          // max 200 — what to try / avoid next
      confidence: 'low' | 'medium' | 'high',
      source: 'agent'
    }
  ]
}

You're an LLM. You can write valid JSON directly. There is no separate JSON-generation tool to call — just submit_output with the structured value.`;
