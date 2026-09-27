/**
 * Hand-authored work-board applet fixture — a real shared work item two
 * people and an agent operate end to end through the declared actions. The
 * definition is parsed at module load so an invalid fixture fails the build,
 * never a runtime resolve.
 */
import { AppletDefinitionSchema, type AppletDefinition } from '@aflow/schemas';

export const WORK_BOARD_DEFINITION: AppletDefinition = AppletDefinitionSchema.parse({
  appletKey: 'work-board',
  version: 1,
  name: 'Work Board',
  description:
    'A shared board of cards moving across columns, with a budget the team manages together.',
  semanticDescription:
    'A shared work item: cards are tasks moving across columns as work progresses, and budget ' +
    'is what the team has agreed to spend. Anyone in the space — human or agent — acts through ' +
    'the declared actions. close_board ends the item for everyone.',
  stateSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      status: { enum: ['open', 'closed'] },
      columns: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1 },
            name: { type: 'string', minLength: 1 },
            cards: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', minLength: 1 },
                  text: { type: 'string', minLength: 1, maxLength: 500 },
                  owner: { type: 'string', maxLength: 200 },
                },
                required: ['id', 'text'],
                additionalProperties: false,
              },
            },
          },
          required: ['id', 'name', 'cards'],
          additionalProperties: false,
        },
      },
      budget: { type: 'number', minimum: 0 },
    },
    required: ['title', 'status', 'columns', 'budget'],
    additionalProperties: false,
  },
  initialState: {
    title: 'Work board',
    status: 'open',
    budget: 0,
    columns: [
      { id: 'todo', name: 'To do', cards: [] },
      { id: 'doing', name: 'In progress', cards: [] },
      { id: 'done', name: 'Done', cards: [] },
    ],
  },
  actions: [
    {
      name: 'add_card',
      description: 'Add a card to a column',
      whenToUse: ['New work arrives that the board should track'],
      inputSchema: {
        type: 'object',
        properties: {
          columnIndex: {
            type: 'integer',
            minimum: 0,
            description: 'Index into /columns of the receiving column',
          },
          card: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1 },
              text: { type: 'string', minLength: 1, maxLength: 500 },
              owner: { type: 'string', maxLength: 200 },
            },
            required: ['id', 'text'],
            additionalProperties: false,
          },
        },
        required: ['columnIndex', 'card'],
        additionalProperties: false,
      },
      patch: {
        template: [
          {
            op: 'add',
            pathTemplate: ['/state/columns', { from: '/input/columnIndex' }, 'cards', '-'],
            valueFrom: '/input/card',
          },
        ],
      },
    },
    {
      name: 'move_card',
      description: 'Move a card to another column',
      pitfalls: [
        'The patch is yours to compute — read the current state and build it against the version you read',
        'input names the intent (which card, which columns); the patch is what actually moves it',
      ],
      inputSchema: {
        type: 'object',
        properties: {
          cardId: { type: 'string', minLength: 1 },
          fromColumnId: { type: 'string', minLength: 1 },
          toColumnId: { type: 'string', minLength: 1 },
        },
        required: ['cardId', 'fromColumnId', 'toColumnId'],
        additionalProperties: false,
      },
      patch: 'actor_supplied',
    },
    {
      name: 'set_budget',
      description: 'Set the board budget',
      inputSchema: {
        type: 'object',
        properties: { amount: { type: 'number', minimum: 0 } },
        required: ['amount'],
        additionalProperties: false,
      },
      patch: { template: [{ op: 'replace', path: '/state/budget', valueFrom: '/input/amount' }] },
    },
    {
      name: 'set_title',
      description: 'Rename the board',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string', minLength: 1, maxLength: 200 } },
        required: ['title'],
        additionalProperties: false,
      },
      patch: { template: [{ op: 'replace', path: '/state/title', valueFrom: '/input/title' }] },
    },
    {
      name: 'close_board',
      description: 'Close the board — ends the item for everyone',
      inputSchema: { type: 'object', additionalProperties: false },
      patch: { template: [{ op: 'replace', path: '/state/status', value: 'closed' }] },
      ends: true,
    },
  ],
  attentionProjection: { title: '/title' },
});

// The compiler exposes no stable build-time hash for the DS contract yet, so
// the pin rides catalogVersion; 'fallback' marks the hash slot as
// intentionally unpinned.
export const WORK_BOARD_CATALOG_PIN = {
  catalogId: 'phoenix-design-system',
  catalogVersion: '2.0.0-artifact',
  catalogHash: 'fallback',
} as const;

/**
 * The board view. The shell re-renders it with `state`/`viewer` props on every
 * host state push, and every mutation goes through `window.aflow.act` — the
 * author-facing bridge over the phoenix:action envelope. `move_card` is
 * actor-supplied: the view computes the patch from the state it rendered and
 * passes it as the `patch` extra.
 */
export const WORK_BOARD_VIEW_SOURCE = `
import React from 'react';
import { Badge, Button, Card, Column, Divider, Heading, Input, Panel, Row, Text } from '@aflow/design-system';

function act(name, input, extras) {
  const bridge = typeof window !== 'undefined' ? window.aflow : undefined;
  if (!bridge || typeof bridge.act !== 'function') {
    return Promise.reject(new Error('aflow host bridge unavailable'));
  }
  return bridge.act(name, input, extras);
}

function newCardId() {
  return 'card-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export default function WorkBoardView({ state: liveState, viewer: liveViewer }) {
  const state = liveState || {};
  const viewer = liveViewer || {};
  const columns = Array.isArray(state.columns) ? state.columns : [];
  const closed = state.status === 'closed';
  const readOnly = viewer.spaceRole === 'viewer' || closed;

  const [titleDraft, setTitleDraft] = React.useState('');
  const [budgetDraft, setBudgetDraft] = React.useState('');
  const [cardDrafts, setCardDrafts] = React.useState({});

  const submitTitle = () => {
    const title = titleDraft.trim();
    if (title) act('set_title', { title });
    setTitleDraft('');
  };

  const submitBudget = () => {
    const amount = Number(budgetDraft);
    if (Number.isFinite(amount) && amount >= 0) act('set_budget', { amount });
    setBudgetDraft('');
  };

  const addCard = (columnIndex) => {
    const text = (cardDrafts[columnIndex] || '').trim();
    if (!text) return;
    act('add_card', { columnIndex, card: { id: newCardId(), text } });
    setCardDrafts((drafts) => ({ ...drafts, [columnIndex]: '' }));
  };

  const moveCard = (fromIndex, cardIndex, toIndex) => {
    const from = columns[fromIndex];
    const to = columns[toIndex];
    const card = from && Array.isArray(from.cards) ? from.cards[cardIndex] : undefined;
    if (!card || !to) return;
    act(
      'move_card',
      { cardId: card.id, fromColumnId: from.id, toColumnId: to.id },
      {
        patch: [
          { op: 'remove', path: '/state/columns/' + fromIndex + '/cards/' + cardIndex },
          { op: 'add', path: '/state/columns/' + toIndex + '/cards/-', value: card },
        ],
      },
    );
  };

  const closeBoard = () => act('close_board', {});

  return (
    <Card elevated padding="lg">
      <Column gap="md">
        <Row justify="between" align="center" wrap gap="sm">
          <Column gap="xs">
            <Heading level={3}>{state.title || 'Work board'}</Heading>
            <Row gap="sm" align="center">
              <Badge variant={closed ? 'neutral' : 'success'}>{closed ? 'closed' : 'open'}</Badge>
              <Text size="sm" color="muted">
                Budget: {typeof state.budget === 'number' ? state.budget.toLocaleString('en-US') : '0'}
              </Text>
            </Row>
          </Column>
          {!readOnly && (
            <Row gap="sm" align="center" wrap>
              <Input
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                placeholder="Rename board"
              />
              <Button size="sm" variant="secondary" onClick={submitTitle} disabled={!titleDraft.trim()}>
                Rename
              </Button>
              <Input
                value={budgetDraft}
                onChange={(e) => setBudgetDraft(e.target.value)}
                placeholder="Budget"
                type="number"
              />
              <Button size="sm" variant="secondary" onClick={submitBudget} disabled={budgetDraft === ''}>
                Set budget
              </Button>
              <Button size="sm" variant="danger" onClick={closeBoard}>
                Close board
              </Button>
            </Row>
          )}
        </Row>
        <Divider subtle />
        <Row gap="md" align="start" wrap>
          {columns.map((column, columnIndex) => (
            <Panel key={column.id || columnIndex} padding="md" grow>
              <Column gap="sm">
                <Row justify="between" align="center">
                  <Text weight="semibold">{column.name}</Text>
                  <Badge variant="neutral">{(column.cards || []).length}</Badge>
                </Row>
                {(column.cards || []).map((card, cardIndex) => (
                  <Card key={card.id || cardIndex} padding="sm">
                    <Column gap="xs">
                      <Text size="sm">{card.text}</Text>
                      <Row justify="between" align="center">
                        {card.owner ? <Badge variant="info">{card.owner}</Badge> : <span />}
                        {!readOnly && (
                          <Row gap="xs">
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={columnIndex === 0}
                              onClick={() => moveCard(columnIndex, cardIndex, columnIndex - 1)}
                            >
                              ←
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={columnIndex === columns.length - 1}
                              onClick={() => moveCard(columnIndex, cardIndex, columnIndex + 1)}
                            >
                              →
                            </Button>
                          </Row>
                        )}
                      </Row>
                    </Column>
                  </Card>
                ))}
                {!readOnly && (
                  <Row gap="xs">
                    <Input
                      value={cardDrafts[columnIndex] || ''}
                      onChange={(e) => {
                        const next = e.target.value;
                        setCardDrafts((drafts) => ({ ...drafts, [columnIndex]: next }));
                      }}
                      placeholder="Add a card"
                    />
                    <Button
                      size="sm"
                      onClick={() => addCard(columnIndex)}
                      disabled={!(cardDrafts[columnIndex] || '').trim()}
                    >
                      Add
                    </Button>
                  </Row>
                )}
              </Column>
            </Panel>
          ))}
        </Row>
      </Column>
    </Card>
  );
}
`;
