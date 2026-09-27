import { describe, it, expect } from 'vitest';
import {
  canonicalizeEmail,
  isUndeliverableAddress,
  linkLooksPublic,
  normalizeLinkInput,
  InviteRequestSubmissionSchema,
  USE_CASE_MAX_LENGTH,
} from '../identity/inviteRequest.js';

describe('isUndeliverableAddress', () => {
  it('catches the reserved names that can never hold a mailbox', () => {
    for (const address of [
      'ada@example.com',
      'ada@example.net',
      'ada@EXAMPLE.ORG',
      'ada@anything.test',
      'ada@host.invalid',
      'dev@phoenix.local',
      'ada@localhost',
      'not-an-address',
    ]) {
      expect(isUndeliverableAddress(address)).toBe(true);
    }
  });

  it('leaves a real address alone, including lookalike domains', () => {
    for (const address of [
      'ada@aflow.ai',
      'ada@gmail.com',
      // A registrable domain that merely ends in the reserved word is real mail.
      'ada@example.company',
      'ada@notexample.com',
    ]) {
      expect(isUndeliverableAddress(address)).toBe(false);
    }
  });
});

describe('canonicalizeEmail', () => {
  it('collapses the Gmail dot trick — the observed abuse — onto one key', () => {
    const expected = 'foobar@gmail.com';
    expect(canonicalizeEmail('f.o.o.b.a.r@gmail.com')).toBe(expected);
    expect(canonicalizeEmail('foo.bar@gmail.com')).toBe(expected);
    expect(canonicalizeEmail('FooBar@Gmail.com')).toBe(expected);
    expect(canonicalizeEmail('foobar@googlemail.com')).toBe('foobar@googlemail.com');
  });

  it('strips plus tags on every domain', () => {
    expect(canonicalizeEmail('ada+beta@example.com')).toBe('ada@example.com');
    expect(canonicalizeEmail('ada+one+two@gmail.com')).toBe('ada@gmail.com');
  });

  it('keeps dots significant outside the Google domains', () => {
    expect(canonicalizeEmail('a.b@example.com')).toBe('a.b@example.com');
    // A lookalike domain must not inherit Gmail's dot semantics.
    expect(canonicalizeEmail('a.b@gmail.com.evil.test')).toBe('a.b@gmail.com.evil.test');
  });

  it('leaves malformed input alone rather than inventing a key', () => {
    expect(canonicalizeEmail('not-an-email')).toBe('not-an-email');
    expect(canonicalizeEmail('@example.com')).toBe('@example.com');
    expect(canonicalizeEmail('ada@')).toBe('ada@');
    // Stripping would leave an empty local part, so the address stands.
    expect(canonicalizeEmail('+tag@example.com')).toBe('+tag@example.com');
  });
});

describe('linkLooksPublic', () => {
  it('accepts an https URL with a real hostname', () => {
    expect(linkLooksPublic('https://github.com/ada')).toBe(true);
    expect(linkLooksPublic('https://ada.example.co.uk/about')).toBe(true);
  });

  it('rejects the schemes that must never become an href in the admin queue', () => {
    expect(linkLooksPublic('javascript:alert(1)')).toBe(false);
    expect(linkLooksPublic('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
    expect(linkLooksPublic('http://github.com/ada')).toBe(false);
  });

  it('rejects hostnames that cannot be a public page', () => {
    expect(linkLooksPublic('https://localhost/ada')).toBe(false);
    expect(linkLooksPublic('not a url')).toBe(false);
  });
});

describe('normalizeLinkInput', () => {
  it('adds the scheme a person leaves off when pasting from the address bar', () => {
    expect(normalizeLinkInput('github.com/ada')).toBe('https://github.com/ada');
    expect(normalizeLinkInput('  github.com/ada  ')).toBe('https://github.com/ada');
  });

  it('leaves an explicit scheme alone, including one it will later reject', () => {
    expect(normalizeLinkInput('https://github.com/ada')).toBe('https://github.com/ada');
    expect(normalizeLinkInput('javascript:alert(1)')).toBe('javascript:alert(1)');
  });

  it('leaves an empty value empty rather than producing a bare https://', () => {
    expect(normalizeLinkInput('   ')).toBe('');
  });

  it('leaves prose alone rather than storing an answer the requester never wrote', () => {
    expect(normalizeLinkInput('my blog, ada.example.com')).toBe('my blog, ada.example.com');
    expect(normalizeLinkInput('ask me')).toBe('ask me');
    expect(normalizeLinkInput('localhost/ada')).toBe('localhost/ada');
  });
});

describe('InviteRequestSubmissionSchema', () => {
  const valid = {
    name: 'Ada Lovelace',
    email: 'ada@lovelace.dev',
    link: 'https://github.com/ada',
    occupation: 'Independent researcher',
    useCase: 'I want to run a recurring literature scan and have it write up what changed.',
  };

  it('accepts a complete submission', () => {
    expect(InviteRequestSubmissionSchema.safeParse(valid).success).toBe(true);
  });

  it('needs only the address it will reply to', () => {
    expect(InviteRequestSubmissionSchema.safeParse({ email: valid.email }).success).toBe(true);
    for (const field of ['name', 'link', 'occupation', 'useCase'] as const) {
      const { [field]: _dropped, ...rest } = valid;
      expect(InviteRequestSubmissionSchema.safeParse(rest).success).toBe(true);
    }
    const { email: _noEmail, ...withoutEmail } = valid;
    expect(InviteRequestSubmissionSchema.safeParse(withoutEmail).success).toBe(false);
    expect(InviteRequestSubmissionSchema.safeParse({ email: 'not-an-address' }).success).toBe(
      false,
    );
  });

  it('refuses an address that could never be replied to', () => {
    // Not a formatting nicety: the request would be queued, notify the admins,
    // and resolve to an invite that can only bounce.
    for (const email of ['ada@example.com', 'ada@phoenix.local', 'ada@host.invalid']) {
      expect(InviteRequestSubmissionSchema.safeParse({ ...valid, email }).success).toBe(false);
    }
  });

  it('reads a blank optional field as unanswered rather than as an empty answer', () => {
    const parsed = InviteRequestSubmissionSchema.parse({
      email: valid.email,
      name: '   ',
      link: '',
      occupation: '',
      useCase: '',
    });
    expect(parsed).toEqual({ email: valid.email });
  });

  it('takes a short use case, and stops at the paste-a-document backstop', () => {
    expect(InviteRequestSubmissionSchema.safeParse({ ...valid, useCase: 'ML stuff' }).success).toBe(
      true,
    );
    expect(
      InviteRequestSubmissionSchema.safeParse({
        ...valid,
        useCase: 'x'.repeat(USE_CASE_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('takes a link in whatever shape it was pasted', () => {
    for (const link of ['github.com/ada', 'http://ada.example.com', 'my blog, ada.example.com']) {
      expect(InviteRequestSubmissionSchema.safeParse({ ...valid, link }).success).toBe(true);
    }
  });

  it('rejects a referral outside the offered options', () => {
    expect(InviteRequestSubmissionSchema.safeParse({ ...valid, referral: 'made up' }).success).toBe(
      false,
    );
    expect(InviteRequestSubmissionSchema.safeParse({ ...valid, referral: 'GitHub' }).success).toBe(
      true,
    );
  });
});
