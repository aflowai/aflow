'use client';

/**
 * A node's decision card on the rail (Plan 337 D3), in D1's order: What
 * changes, Why, What it affects, Risks, Open questions, Not done on purpose
 * and Done when. Done when is the node's criteria, read from the node and
 * never from the card. Each item renders as markdown, and its label stays
 * outside the markdown.
 */
import type { ReactNode } from 'react';
import { Text } from '@aflow/design-system';
import type { PlanNodeCard } from '@aflow/schemas';
import { MarkdownRenderer } from '../markdown-renderer.js';
import { RailSection, railProse } from './PlanParts.js';

const cardListStyle = {
  margin: 0,
  paddingLeft: 'var(--space-4)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-1)',
} as const;

const proseStyle = {
  color: 'var(--color-text-secondary)',
  fontSize: 'var(--font-size-base)',
  lineHeight: 1.55,
  minWidth: 0,
} as const;

/** A label and the item it heads, on one line where the item fits. */
const leadRow = { display: 'flex', gap: 'var(--space-1)', alignItems: 'baseline' } as const;

/** One card item. A writer may use markdown, so the item renders as markdown. */
function Prose({ children }: { children: string }) {
  return <MarkdownRenderer content={children} style={proseStyle} />;
}

/** A section's items as a list. An empty list says the writer found none. */
function CardList({ items }: { items: readonly ReactNode[] }) {
  if (items.length === 0) {
    return (
      <Text size="sm" variant="muted" data-plan-card-none>
        None.
      </Text>
    );
  }
  return (
    <ul style={cardListStyle}>
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

/** A small label above or before an item's own words. */
function Lead({ children }: { children: string }) {
  return (
    <Text
      as="span"
      size="sm"
      weight="medium"
      color="secondary"
      style={{ flexShrink: 0, whiteSpace: 'pre' }}
    >
      {children}
    </Text>
  );
}

export function PlanCardSections({
  card,
  criteria,
  criteriaLabel,
}: {
  card: PlanNodeCard;
  criteria: string;
  /** **Done when**, or **Decided when** on a decide node, as the rail labels criteria. */
  criteriaLabel: string;
}) {
  return (
    <>
      <RailSection label="What changes">
        <div data-plan-card-change="today" style={leadRow}>
          <Lead>Today: </Lead>
          <Prose>{card.change.today}</Prose>
        </div>
        <div data-plan-card-change="after" style={leadRow}>
          <Lead>After: </Lead>
          <Prose>{card.change.after}</Prose>
        </div>
      </RailSection>
      <RailSection label="Why">
        <CardList
          items={card.why.map((item) => (
            <Prose>{item}</Prose>
          ))}
        />
      </RailSection>
      <RailSection label="What it affects">
        <CardList
          items={card.affects.map((item) => (
            <Prose>{item}</Prose>
          ))}
        />
      </RailSection>
      <RailSection label="Risks">
        <CardList
          items={card.risks.map((item) => (
            <div data-plan-card-risk>
              <Prose>{item.risk}</Prose>
              {item.mitigation !== undefined && (
                <div data-plan-card-mitigation style={leadRow}>
                  <Lead>Mitigation: </Lead>
                  <Prose>{item.mitigation}</Prose>
                </div>
              )}
            </div>
          ))}
        />
      </RailSection>
      <RailSection label="Open questions">
        <CardList
          items={card.questions.map((item) => (
            <div data-plan-card-question>
              <Prose>{item.question}</Prose>
              <div data-plan-card-recommended style={leadRow}>
                <Lead>Recommended: </Lead>
                <Prose>{item.recommended}</Prose>
              </div>
            </div>
          ))}
        />
      </RailSection>
      <RailSection label="Not done on purpose">
        <CardList
          items={card.notDoing.map((item) => (
            <Prose>{item}</Prose>
          ))}
        />
      </RailSection>
      <RailSection label={criteriaLabel}>
        <Text size="base" color="secondary" style={railProse}>
          {criteria}
        </Text>
      </RailSection>
    </>
  );
}
