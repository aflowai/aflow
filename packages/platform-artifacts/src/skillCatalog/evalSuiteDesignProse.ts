/**
 * Prompt prose for the eval-suite design task.
 *
 * What lives here is the part no schema can carry: which cases are worth
 * writing and what to call them. Everything mechanical — that a check can
 * fail, that a claim names a declared requirement, that the reference run is
 * satisfiable — is enforced at ratification and deliberately absent from this
 * prose.
 */

export const EVAL_SUITE_DESIGN_PROMPT = `Design the golden eval suite for the target skill: the set of cases that, replayed against its simulated world, would catch it regressing.

Start by reading both documents this depends on. \`workflow.manage.get\` on the target skill gives its contract — what it undertook to achieve and the tasks it runs.

The simulation is large, and reading it whole is the mistake that ends this run badly. What a case needs from it is small: the names of the collections, the field that identifies a row, and the rule ids. Read it as an outline first — \`memory.store.get\` with \`view: "outline"\` on the result path the tool reports — and drill into a single collection with \`jsonPath\` only when a check depends on its shape. Loading the whole document spends the turn's budget on JSON that no case quotes, and leaves none for the cases themselves.

Cases are grounded in those two documents, so neither read is optional: a check naming a collection the simulation does not have is not a stricter case, it is a broken one.

**A case names the world it runs against.** Each case's fixture binds the integrations the skill calls, and a \`stub\` binding carries the \`simulationId\` that fulfills it — the simulation named in this run's inputs. A binding without it is refused, because a stub with no world behind it has nothing to answer from.

**Coverage decides what the suite is worth.** The suite is a stratified sample, not a pile of examples. Each case names its stratum: the scenario (the situation the world presents), the direction, and the tier, which is always \`capability\` here — regression tier records a behaviour a real run already showed, so it is reached by promoting a run, never by drafting. The direction is the run's terminal state, not the tone of the answer: \`should_succeed\` where the run completes, \`should_pause\` where it stops and waits for a person, \`should_block\` where it refuses to proceed. A skill that answers and ends is \`should_succeed\` even when the right answer is a refusal — the refusal is graded by the checks, not by the direction. Sample the directions the contract can actually reach: where a skill can pause, a suite that never expects one says nothing about whether it knows when to stop. The cases that earn their place are the ones where the wrong move is plausible: the ambiguous request, the record that is missing, the customer asking for what the policy refuses, the second request that arrives before the first is finished.

**A title states the situation, not the verdict.** "A refund is overdue from the merchant" names what arrived. "Agent correctly opens no case" names the answer, reads as a checkbox, and goes stale the moment the expected behaviour changes. Titles that describe the world survive revisions of the skill; titles that describe the outcome do not.

**Requirements come before checks, and stand without them.** A requirement states what the skill must do or must not do in this situation, in the operator's language: "Opens no handover case", "Quotes the merchant's stated refund window", "Asks before issuing credit above the limit". It is a claim about behaviour, not about detection — it reads the same whether or not anything observes it. Checks are written afterwards and each names the requirements it detects. In this order a deleted check leaves a requirement visibly uncovered; in the reverse order the suite quietly measures whatever happened to be easy to observe, and reports full coverage while doing it.

**Evidence is the world the run left behind.** A check reads the simulation's collections and the rules the run matched: a case opened or not opened, a refund row written with a particular status, a rule the conversation was supposed to trigger. Rubrics carry what only a reader can judge — tone, whether the explanation is honest about what went wrong, whether the answer is responsive to the question actually asked. Both kinds belong in a suite; a suite made only of rubrics cannot say what changed, and a suite made only of collection checks cannot say whether the answer was any good.

**A case that cannot fail is not a case, and a check that fails the wrong way is worse.** Every check has a polarity: it must come out one way on the reference behaviour and the other way on the mistake it is meant to catch. Polarity has to agree with the requirement claimed. A \`must_not_do\` requirement is covered by a check asserting ABSENCE — no row written, the phrase not present — because a check asserting the thing is there passes exactly when the skill misbehaves and fails when it behaves. Ratification re-runs that test and refuses a case whose checks pass no matter what the skill does, so a check written to be safe is a check that gets rejected.

Return the drafted cases and a rationale an operator can read: what the suite covers, which strata were deliberately left out, and what the suite would fail to notice.`;
