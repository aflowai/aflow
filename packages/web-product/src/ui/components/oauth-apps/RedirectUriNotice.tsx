'use client';

import { useCallback, useEffect, useState } from 'react';
import { Column, Row, Text, Label, Input, Button, Icon } from '@aflow/design-system';

export const REDIRECT_URI_INSTRUCTION =
  "Add this as an authorized redirect URI in the provider's console.";

/**
 * The callback URL a provider's console must list before consent can return
 * here. The value comes from the server (`resolveOAuthCallbackUrl()`), never
 * from the browser, because only the server knows its own public origin.
 */
export function RedirectUriNotice({ redirectUri }: { redirectUri: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
  }, [redirectUri]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(redirectUri);
      setCopied(true);
    } catch {
      // The input stays selectable when the clipboard is refused.
    }
  }, [redirectUri]);

  return (
    <Column gap="xs" data-testid="oauth-redirect-uri">
      <Label>Redirect URI</Label>
      <Row gap="sm" align="center" wrap>
        <Input
          readOnly
          aria-label="Redirect URI"
          value={redirectUri}
          style={{
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: '13px',
            flex: '1 1 260px',
            minWidth: 0,
          }}
          onClick={(e) => {
            (e.target as HTMLInputElement).select();
          }}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void handleCopy();
          }}
          leftIcon={<Icon name={copied ? 'check' : 'copy'} size="sm" />}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </Row>
      <Text size="xs" variant="muted">
        {REDIRECT_URI_INSTRUCTION}
      </Text>
    </Column>
  );
}
