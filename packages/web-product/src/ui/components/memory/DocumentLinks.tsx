'use client';

import type { CSSProperties, ReactNode } from 'react';
import {
  Badge,
  Column,
  EmptyState,
  Icon,
  List,
  ListItem,
  Row,
  Spinner,
  Text,
} from '@aflow/design-system';
import type {
  MemoryBacklink,
  MemoryLinkedDoc,
  MemoryLinksBlock,
  MemoryOutgoingLink,
} from '../../hooks/use-memory-links.js';

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function formatUpdated(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

const contextStyle: CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
};

const ghostRowStyle: CSSProperties = {
  borderStyle: 'dashed',
  borderColor: 'var(--color-border-subtle)',
};

function LinkRow({
  path,
  context,
  icon,
  trailing,
  onOpen,
  style,
}: {
  path: string;
  context: string | undefined;
  icon: ReactNode;
  trailing?: ReactNode | undefined;
  onOpen?: (() => void) | undefined;
  style?: CSSProperties | undefined;
}) {
  const body = (
    <>
      <Text size="sm" weight="medium" truncate>
        {basename(path)}
      </Text>
      <Text variant="mono" size="xs" color="muted" truncate>
        {path}
      </Text>
      {context ? (
        <Text size="xs" color="muted" style={contextStyle}>
          {context}
        </Text>
      ) : null}
    </>
  );

  if (onOpen) {
    return (
      <ListItem
        clickable
        icon={icon}
        trailing={trailing}
        onClick={onOpen}
        {...(style ? { style } : {})}
      >
        {body}
      </ListItem>
    );
  }

  return (
    <ListItem icon={icon} trailing={trailing} {...(style ? { style } : {})}>
      {body}
    </ListItem>
  );
}

function SectionHeader({
  title,
  total,
  shown,
  extra,
}: {
  title: string;
  total: number;
  shown: number;
  extra?: ReactNode | undefined;
}) {
  return (
    <Row justify="between" align="center" gap="2">
      <Row gap="2" align="center" style={{ minWidth: 0 }}>
        <Text size="sm" weight="medium">
          {title}
        </Text>
        <Badge variant="neutral">{total}</Badge>
        {extra}
      </Row>
      {shown < total ? (
        <Text size="xs" color="muted">
          showing {shown}
        </Text>
      ) : null}
    </Row>
  );
}

function OutgoingSection({
  outgoing,
  outgoingTotal,
  ghostTotal,
  onOpenDoc,
}: {
  outgoing: MemoryOutgoingLink[];
  outgoingTotal: number;
  ghostTotal: number;
  onOpenDoc: (doc: MemoryLinkedDoc) => void;
}) {
  return (
    <Column gap="2">
      <SectionHeader
        title="Links from this document"
        total={outgoingTotal}
        shown={outgoing.length}
        extra={
          ghostTotal > 0 ? (
            <Badge variant="warning" icon={<Icon name="ghost" size="xs" />}>
              {ghostTotal} not written yet
            </Badge>
          ) : undefined
        }
      />
      {outgoing.length === 0 ? (
        <Text size="sm" color="muted">
          This document does not reference any other note.
        </Text>
      ) : (
        <List gap="xs">
          {outgoing.map((link) => {
            const target = link.target;
            return (
              <LinkRow
                key={link.targetPath}
                path={link.targetPath}
                context={link.context}
                icon={<Icon name={link.resolved ? 'file-text' : 'ghost'} size="sm" />}
                trailing={
                  <Row gap="1" align="center">
                    {link.occurrenceCount > 1 ? (
                      <Badge variant="neutral">×{link.occurrenceCount}</Badge>
                    ) : null}
                    {link.resolved ? null : <Badge variant="warning">Not written yet</Badge>}
                  </Row>
                }
                {...(target
                  ? {
                      onOpen: () => {
                        onOpenDoc(target);
                      },
                    }
                  : {})}
                {...(link.resolved ? {} : { style: ghostRowStyle })}
              />
            );
          })}
        </List>
      )}
    </Column>
  );
}

function BacklinkSection({
  backlinks,
  backlinkTotal,
  onOpenDoc,
}: {
  backlinks: MemoryBacklink[];
  backlinkTotal: number;
  onOpenDoc: (doc: MemoryLinkedDoc) => void;
}) {
  return (
    <Column gap="2">
      <SectionHeader title="Referenced by" total={backlinkTotal} shown={backlinks.length} />
      {backlinks.length === 0 ? (
        <Text size="sm" color="muted">
          No other note references this document.
        </Text>
      ) : (
        <List gap="xs">
          {backlinks.map((backlink) => {
            const source = backlink.source;
            return (
              <LinkRow
                key={backlink.fromPath}
                path={backlink.fromPath}
                context={backlink.context}
                icon={<Icon name="arrow-left" size="sm" />}
                trailing={
                  <Text size="xs" color="muted">
                    {formatUpdated(backlink.updatedAt)}
                  </Text>
                }
                {...(source
                  ? {
                      onOpen: () => {
                        onOpenDoc(source);
                      },
                    }
                  : {})}
              />
            );
          })}
        </List>
      )}
    </Column>
  );
}

export interface DocumentLinksProps {
  links: MemoryLinksBlock | undefined;
  isLoading: boolean;
  error: string | null;
  onOpenDoc: (doc: MemoryLinkedDoc) => void;
}

export function DocumentLinks({ links, isLoading, error, onOpenDoc }: DocumentLinksProps) {
  if (isLoading && !links) {
    return (
      <Row justify="center" padding="lg">
        <Spinner size="md" />
      </Row>
    );
  }

  if (error) {
    return (
      <Text size="sm" tone="danger">
        {error}
      </Text>
    );
  }

  if (!links) {
    return (
      <Text size="sm" color="muted">
        No link information loaded.
      </Text>
    );
  }

  if (links.outgoingTotal === 0 && links.backlinkTotal === 0) {
    return (
      <EmptyState
        icon={<Icon name="link" size="lg" />}
        title="No links yet"
        description="This document neither references another note nor is referenced by one. Write [[/path/to/note]] anywhere in the body to link it."
      />
    );
  }

  return (
    <Column gap="6">
      <OutgoingSection
        outgoing={links.outgoing}
        outgoingTotal={links.outgoingTotal}
        ghostTotal={links.outgoingGhostTotal}
        onOpenDoc={onOpenDoc}
      />
      <BacklinkSection
        backlinks={links.backlinks}
        backlinkTotal={links.backlinkTotal}
        onOpenDoc={onOpenDoc}
      />
    </Column>
  );
}
