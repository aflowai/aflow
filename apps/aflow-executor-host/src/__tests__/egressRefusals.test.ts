import { describe, expect, it } from 'vitest';

import {
  createChatterStripper,
  describeRefusals,
  extractEgressRefusals,
  stripSandboxChatter,
} from '../egressRefusals.js';

describe('egress refusals', () => {
  it('names the host the boundary refused, which is the whole diagnosis', () => {
    const { refusals } = extractEgressRefusals(
      '[SandboxDebug] Connection blocked to api.anthropic.com:443\n',
    );
    expect(refusals).toEqual([{ host: 'api.anthropic.com', port: 443 }]);
  });

  it('keeps the harness own output and drops the sandbox chatter', () => {
    const { text } = extractEgressRefusals(
      [
        '[SandboxDebug] starting proxy on 41234',
        'harness: reading src/index.ts',
        '[SandboxDebug] Connection blocked to api.example.com:443',
        'harness: giving up',
      ].join('\n'),
    );
    expect(text).toBe('harness: reading src/index.ts\nharness: giving up');
    expect(text).not.toContain('SandboxDebug');
  });

  it('reports a repeatedly retried host once', () => {
    const line = '[SandboxDebug] Connection blocked to api.example.com:443';
    const { refusals } = extractEgressRefusals([line, line, line].join('\n'));
    expect(refusals).toHaveLength(1);
  });

  it('distinguishes two ports on one host, since a grant is per host and port', () => {
    const { refusals } = extractEgressRefusals(
      '[SandboxDebug] Connection blocked to h.example:443\n[SandboxDebug] Connection blocked to h.example:8443',
    );
    expect(refusals.map((r) => r.port)).toEqual([443, 8443]);
  });

  it('says nothing when nothing was refused', () => {
    const { refusals, text } = extractEgressRefusals('all fine\n');
    expect(refusals).toEqual([]);
    expect(describeRefusals(refusals, 'produced_nothing')).toBeUndefined();
    expect(describeRefusals(refusals, 'reached_result')).toBeUndefined();
    expect(text).toBe('all fine\n');
  });

  it('tells the operator what to add, in the words of the thing they edit', () => {
    const note = describeRefusals(
      [
        { host: 'api.anthropic.com', port: 443 },
        { host: 'statsig.anthropic.com', port: 443 },
      ],
      'produced_nothing',
    );
    expect(note).toContain('api.anthropic.com');
    expect(note).toContain('statsig.anthropic.com');
    expect(note).toContain('allowed domains');
  });

  it('says who can widen it, and with which words', () => {
    // Naming the host is half an answer. An agent reading it knows something was
    // blocked and can do nothing: allowed domains live in the machine's own
    // profile, which nothing on the appliance side can write. Left there, it
    // either reports a dead end or invents a remedy.
    const note = describeRefusals([{ host: 'pypi.org', port: 443 }], 'produced_nothing', 'claude');
    expect(note).toContain('Only the operator');
    expect(note).toContain('harness add claude --domain pypi.org');
    // And it must not invite a retry: a refusal is a decision, so retrying is
    // the one thing guaranteed not to help.
    expect(note).toMatch(/do not retry/i);
  });

  it('does not tell a run that finished that its outcome did not happen', () => {
    // The same refused hosts on a run that exited 0 with a complete result. The
    // blocking wording read as "nothing happened, and do not try again" beside a
    // diff that was right there, so the reader was told to wait for the operator
    // instead of using an answer it already had.
    const note = describeRefusals([{ host: 'pypi.org', port: 443 }], 'reached_result', 'claude');
    expect(note).toContain('pypi.org');
    expect(note).toContain('anything needing it did not happen');
    expect(note).toContain('reached its result');
    expect(note).not.toMatch(/do not retry/i);
    expect(note).not.toContain('ask again');
    // The remedy is still the operator's and still one command, for the case
    // where the result IS missing something.
    expect(note).toContain('harness add claude --domain pypi.org');
  });

  it('does not mistake a harness line that merely mentions the phrase', () => {
    const { refusals, text } = extractEgressRefusals(
      'harness: the docs say "Connection blocked to foo:443" is common\n',
    );
    expect(refusals).toEqual([]);
    expect(text).toContain('the docs say');
  });
});

describe('chatter that lands inside a sentence', () => {
  it('is removed, and its host still counted', () => {
    // Real output from a harness run. The proxy and the harness write to the
    // same descriptor, so a debug message arrives mid-sentence rather than on a
    // line of its own — which is why matching only line starts left this in.
    const raw =
      'Verified: the demo runs, the doctests Allowed by config rule: api.anthropic.com:443 ' +
      '[SandboxDebug] pass (2/2), and git status shows only the new file.\n' +
      '[SandboxDebug] No matching config rule, denying: pypi.org:443\n';

    const { text, refusals } = extractEgressRefusals(raw);

    expect(text).toContain('the doctests pass (2/2)');
    expect(text).not.toContain('SandboxDebug');
    expect(text).not.toContain('api.anthropic.com:443');
    expect(refusals).toEqual([{ host: 'pypi.org', port: 443 }]);
  });

  it('leaves what the harness actually wrote alone', () => {
    // The risk of matching anywhere is deleting a harness's own words. Only
    // this adapter's known wording goes.
    const raw = 'Created reverse_string.py. Connection pooling is unchanged.\n';
    expect(stripSandboxChatter(raw)).toBe(raw);
  });

  it('says nothing at all for a chunk that was only chatter', () => {
    // What the live stream does with it: nothing is emitted, so a working run
    // does not look like a stuck one scrolling refusals past the operator.
    const only = '[SandboxDebug] Connection blocked to pypi.org:443\n';
    expect(stripSandboxChatter(only).trim()).toBe('');
  });
});

describe('the sandbox startup dump', () => {
  // What the adapter writes before the workload says anything, with SRT_DEBUG
  // set — which this lane sets so the proxy will name what it refused. Only the
  // first line of a multi-line message carries the prefix, because the newlines
  // are inside one message.
  const dump = [
    `[SandboxDebug] Original command: claude -p 'Review this. {"type":"object"}' --print`,
    '[SandboxDebug] {',
    '  "allowedHosts": [',
    '    "api.anthropic.com"',
    '  ]',
    '}',
    '[SandboxDebug] [Sandbox macOS] Applied restrictions - network: true, read: allowAllExcept',
    '[SandboxDebug] mux: HTTP backend listening on 127.0.0.1:53123',
    '[SandboxDebug] No matching config rule, denying: repo.yarnpkg.com:443',
    'harness: could not install dependencies',
    '[SandboxDebug] mux: client socket error: read ECONNRESET',
    '',
  ].join('\n');

  it('leaves the harness own sentence and nothing else', () => {
    expect(stripSandboxChatter(dump)).toBe('harness: could not install dependencies\n');
  });

  it('does not carry the task back out in the echoed command line', () => {
    expect(stripSandboxChatter(dump)).not.toContain('Review this.');
  });

  it('still names the host that was refused, read before anything is removed', () => {
    const { text, refusals } = extractEgressRefusals(dump);
    expect(refusals).toEqual([{ host: 'repo.yarnpkg.com', port: 443 }]);
    expect(text).toBe('harness: could not install dependencies\n');
  });

  it('takes the adapter own words out of a line it landed inside', () => {
    expect(
      stripSandboxChatter('building [SandboxDebug] mux: client socket error: read ECONNRESET'),
    ).toBe('building');
    expect(
      stripSandboxChatter('building [SandboxDebug] [Sandbox macOS] Applied restrictions - net'),
    ).toBe('building');
  });

  it('leaves a workload that writes a JSON object of its own alone', () => {
    // The block rule is entered only by a prefixed line that is nothing but an
    // opening brace. A workload printing JSON is printing its answer.
    const answer = '{\n  "verdict": "sound"\n}\n';
    expect(stripSandboxChatter(answer)).toBe(answer);
  });
});

describe('a stream does not arrive in lines', () => {
  it('strips a rule whose line was split across two reads', () => {
    const stripper = createChatterStripper();
    const first = stripper.push('[SandboxDeb');
    const second = stripper.push('ug] Connection blocked to pypi.org:443\nharness: done\n');
    expect(first + second + stripper.flush()).toBe('harness: done\n');
  });

  it('strips a dump whose block was split across two reads', () => {
    const stripper = createChatterStripper();
    const first = stripper.push('[SandboxDebug] {\n  "allowedHo');
    const second = stripper.push('sts": []\n}\nharness: working\n');
    expect(first + second + stripper.flush()).toBe('harness: working\n');
  });

  it('passes a workload own text through, and releases a last line with no newline', () => {
    const stripper = createChatterStripper();
    const held = stripper.push('Created reverse_string.py. Connection pooling is unchanged.');
    expect(held).toBe('');
    expect(stripper.flush()).toBe('Created reverse_string.py. Connection pooling is unchanged.');
  });
});
