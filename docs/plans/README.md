# Plans

A plan is a document written before the code, for a change large enough that the
approach is worth disagreeing with while disagreement is still cheap. Anything
that changes behaviour, a schema, an operation, persistence, security, or
architecture wants one. A failing test, a wrong error message, a broken link or a
dependency bump does not — open a pull request.

## Writing one

Number it from the highest number present, name it for the outcome rather than
the mechanism, and put it in this directory:

```
docs/plans/NNN-what-this-achieves.md
```

What a reviewer needs from it:

- **The problem**, stated as the thing that is currently wrong or missing, with
  whatever evidence you have. A plan whose problem statement is a proposed
  solution cannot be argued with.
- **The decisions**, and for each the alternative you rejected and why. This is
  the part that survives; it is what a reader in a year needs.
- **What it affects** — packages, contracts, stored data, existing behaviour.
- **Phases**, each one landable and reviewable on its own, each with an exit you
  could disagree about having been met.
- **How it is proven.** Name the case that would fail if the change were wrong.
  "Tests pass" is not that.

Keep it honest as it lands. A plan that says a phase is built when it is not is
worse than no plan, because the next reader trusts it. If a phase turns out to be
the wrong shape, change the plan rather than quietly diverging from it.

## What a plan is not

Not a log. Not a record of review conversations, dates, or who said what. Not a
place to narrate what you tried — that belongs in the pull request. A plan
describes the system as it is meant to be, and is edited as that understanding
changes.

## The earlier archive is not published

Several hundred numbered plans written before the engine was published record how
it came to be shaped this way. They are not in this repository: they carry cost
figures, commercial positioning, production identifiers and candid assessments of
unfinished work, none of which belongs in the documentation of a product somebody
is deciding whether to run.

So a reference to a `docs/plans/aflow/...` path in a source comment or a document
under `docs/dev/` points at something that is not here. That is deliberate rather
than a broken link. The invariant those references guard is always also expressed
in the code and in a test — that is the house rule for anything load-bearing,
precisely so the plan is never the only place a rule exists.

If a decision's rationale is genuinely missing and you need it, ask in an issue.
A plan that turns out to be worth publishing can be moved here.
