# Security policy

## Reporting a vulnerability

Report privately to **support@aflow.ai**. Do not open a public issue, pull request, or
discussion for a suspected vulnerability — a public report is disclosure, and it happens
before there is a fix to point anyone at.

Use GitHub's private vulnerability reporting on this repository where it is available; it
reaches the same place and keeps the thread attached to the code.

### What to include

A report that can be reproduced is acted on far faster than one that has to be
reconstructed. Where possible:

- what an attacker gains, in one sentence — read another workspace's data, run code on the
  host, escalate from a run to the operator's authority;
- the version or commit, and which edition (local appliance, or a hosted deployment);
- the smallest sequence that reproduces it, including whether it needs an authenticated
  session, a paired machine, or an installed integration;
- what you observed versus what you expected;
- any logs or payloads, with credentials removed.

Never include a live credential, an access token, or another person's data in a report.
If a reproduction seems to need one, say so and it will be arranged privately.

### What to expect

| Stage                                                             | Target                |
| ----------------------------------------------------------------- | --------------------- |
| Acknowledgement that a human has read it                          | 3 working days        |
| First assessment — severity, whether it reproduces, likely remedy | 10 working days       |
| Progress updates while it is open                                 | every 10 working days |

These are targets for a small maintainer team, not a contractual SLA. A report that turns
out to be critical is worked on ahead of whatever else is in flight.

## Coordinated disclosure

Please give 90 days from acknowledgement before publishing, or until a fix is released,
whichever comes first. If the 90 days pass without a fix, say what you intend to publish
and when — an unfixed report going public is sometimes the right outcome, and it should not
be a surprise to either side.

Credit is given in the advisory by whatever name and link you ask for, or withheld if you
prefer.

## Safe harbour

Research conducted in good faith under this policy is welcome, and no legal action will be
pursued over it. Good faith means, concretely:

- testing only against **your own** instance — a local appliance you installed, or an
  account you own on a hosted deployment;
- not accessing, modifying, or retaining data belonging to anyone else;
- not degrading service for others: no denial-of-service, no load testing, no spam;
- not using social engineering, physical access, or attacks on third-party providers that
  this software talks to;
- stopping at the point where a vulnerability is demonstrated, rather than exploring how
  much further it reaches.

This language has not yet been reviewed by counsel. Until it has, treat it as a statement
of intent rather than a legal instrument, and ask if anything about a planned test is
unclear.

## Supported versions

| Version               | Security fixes                                           |
| --------------------- | -------------------------------------------------------- |
| Current stable minor  | Yes                                                      |
| Previous stable minor | Critical and high severity only, for a documented window |
| Beta and nightly      | No; fixes land in the next release                       |

Database downgrade is not supported unless a release says otherwise, so a rollback across a
migration is not a remedy available to you. Advisories state which versions are affected and
what upgrade path is safe.

The public core fix and the commercial distribution's fix are the same fix. Paid support may
change how quickly someone helps you deploy it; it does not gate the patch.

## What is a security issue here

A security issue is anything that crosses a boundary the system is supposed to hold:

- reading or writing data across a workspace boundary, or as another user;
- a run gaining authority its grant does not carry — reaching a folder outside its
  binding, executing where execution was not granted, or approving its own write;
- escaping the compute sandbox, or reaching the host from inside it;
- recovering a stored credential, or causing one to be sent anywhere it does not belong;
- bypassing local instance authentication, or reaching the API from outside loopback on a
  default appliance install;
- a dependency or image vulnerability that is reachable in how this software uses it.

The following are ordinary bugs, and belong in a public issue:

- a missing UI confirmation on an action the API correctly authorises;
- a capability refusal the operator finds too strict, or a permission they want widened;
- a scanner finding on a dependency that no code path reaches — say so and it will be
  triaged, but it is not embargoed;
- rate limiting that is looser than you would prefer on a single-user appliance.

If you cannot tell which one you have, report it privately. Getting that wrong in the
cautious direction costs nothing.
