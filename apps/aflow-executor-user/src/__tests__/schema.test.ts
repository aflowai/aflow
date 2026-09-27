import { describe, it, expect } from 'vitest';
import {
  UserSendEmailInputSchema,
  UserSendEmailOutputSchema,
  UserListEmailsInputSchema,
  UserListEmailsOutputSchema,
} from '@aflow/schemas';

describe('UserSendEmailInputSchema', () => {
  it('validates minimal input', () => {
    const result = UserSendEmailInputSchema.safeParse({
      subject: 'Test subject',
      content: 'Hello world',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contentFormat).toBe('markdown');
    }
  });

  it('validates with explicit html format', () => {
    const result = UserSendEmailInputSchema.safeParse({
      subject: 'Test',
      content: '<p>Hello</p>',
      contentFormat: 'html',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty subject', () => {
    const result = UserSendEmailInputSchema.safeParse({
      subject: '',
      content: 'Hello',
    });
    expect(result.success).toBe(false);
  });

  it('rejects subject over 200 chars', () => {
    const result = UserSendEmailInputSchema.safeParse({
      subject: 'x'.repeat(201),
      content: 'Hello',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty content', () => {
    const result = UserSendEmailInputSchema.safeParse({
      subject: 'Test',
      content: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid contentFormat', () => {
    const result = UserSendEmailInputSchema.safeParse({
      subject: 'Test',
      content: 'Hello',
      contentFormat: 'plaintext',
    });
    expect(result.success).toBe(false);
  });
});

describe('UserSendEmailOutputSchema', () => {
  it('validates a complete output', () => {
    const result = UserSendEmailOutputSchema.safeParse({
      provider: 'ses_smtp',
      messageId: '<abc123@ses>',
      recipientUserId: '00000000-0000-0000-0000-000000000001',
      recipientEmail: 'user@example.com',
      subject: 'Test',
      contentFormat: 'markdown',
      sentAt: '2026-03-08T10:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });
});

describe('UserListEmailsInputSchema', () => {
  it('applies defaults for empty input', () => {
    const result = UserListEmailsInputSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(20);
      expect(result.data.before).toBeUndefined();
    }
  });

  it('accepts custom limit and before', () => {
    const result = UserListEmailsInputSchema.safeParse({
      limit: 5,
      before: '2026-03-08T10:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects limit over 100', () => {
    const result = UserListEmailsInputSchema.safeParse({ limit: 101 });
    expect(result.success).toBe(false);
  });

  it('rejects limit of 0', () => {
    const result = UserListEmailsInputSchema.safeParse({ limit: 0 });
    expect(result.success).toBe(false);
  });
});

describe('UserListEmailsOutputSchema', () => {
  it('validates output with emails', () => {
    const result = UserListEmailsOutputSchema.safeParse({
      emails: [
        {
          stepExecutionId: '00000000-0000-0000-0000-000000000001',
          runId: '00000000-0000-0000-0000-000000000002',
          subject: 'Test email',
          recipientEmail: 'user@example.com',
          contentFormat: 'markdown',
          sentAt: '2026-03-08T10:00:00.000Z',
          messageId: '<abc@ses>',
        },
      ],
      totalReturned: 1,
      hasMore: false,
    });
    expect(result.success).toBe(true);
  });

  it('validates empty output', () => {
    const result = UserListEmailsOutputSchema.safeParse({
      emails: [],
      totalReturned: 0,
      hasMore: false,
    });
    expect(result.success).toBe(true);
  });
});
