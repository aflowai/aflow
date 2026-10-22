'use client';

/**
 * The space's plan (Plan 322 P3): the trees the Helmsman works through, with
 * what is done, what is in flight and what each node's work left behind.
 *
 * Until this page the plan was visible only to the Helmsman, in its attention
 * block, and to whoever asked it. It reads the one authority the Helmsman's
 * operations write, so the operator and the agent see the same tree.
 */
import {
  Card,
  CardBody,
  Column,
  Heading,
  HelperText,
  PageContainer,
  Text,
} from '@aflow/design-system';
import type { PlanTreeNode, PlanTreeOutput } from '@aflow/schemas';
import { useSpaceFromRoute } from '../components/providers.js';
import { useApiQuery } from '../hooks/useApiQuery.js';
import { PlanTree } from '../components/plan/PlanTree.js';

function placedRuns(nodes: readonly PlanTreeNode[]): number {
  return nodes.reduce((sum, node) => sum + node.runs.length + placedRuns(node.children), 0);
}

const TRUNCATION_LINE: Record<'limit' | 'depth' | 'nodes', (value: number) => string> = {
  limit: (value) => `Only the first ${String(value)} nodes are shown.`,
  depth: (value) => `Nodes more than ${String(value)} levels below their root are not shown.`,
  nodes: (value) => `This plan holds more than ${String(value)} nodes; the rest are not shown.`,
};

export function SpacePlanPage(): React.ReactNode {
  const routeSpace = useSpaceFromRoute();
  const spaceId = routeSpace?.id ?? '';
  const spaceSlug = routeSpace?.slugFromRoute ?? '';

  const { data, isLoading, error } = useApiQuery<PlanTreeOutput>({
    key: ['space', spaceId, 'plan'],
    path: `/spaces/${spaceId}/plan`,
    enabled: spaceId.length > 0,
  });

  const header = (
    <Column gap="xs">
      <Heading level={2}>Plan</Heading>
      <Text variant="muted">
        What the Helmsman is working through here: each goal broken into steps, what is done and
        how, and the work under way for each.
      </Text>
    </Column>
  );

  if (isLoading || spaceId.length === 0) {
    return (
      <PageContainer>
        <Column gap="lg">
          {header}
          <Text>Loading…</Text>
        </Column>
      </PageContainer>
    );
  }

  if (error) {
    return (
      <PageContainer>
        <Column gap="lg">
          {header}
          <Text tone="danger">{`The plan could not be read: ${error.message}`}</Text>
        </Column>
      </PageContainer>
    );
  }

  const roots = data?.roots ?? [];
  const unplacedRuns = (data?.runsTotal ?? 0) - placedRuns(roots);

  return (
    <PageContainer>
      <Column gap="lg">
        {header}
        {roots.length === 0 ? (
          <Card>
            <CardBody>
              <Column gap="xs">
                <Text variant="muted">This space has no plan yet.</Text>
                <HelperText>
                  Ask the Helmsman in chat to plan a piece of work, and its steps appear here as it
                  records them.
                </HelperText>
              </Column>
            </CardBody>
          </Card>
        ) : (
          <Card>
            <CardBody>
              <PlanTree roots={roots} spaceSlug={spaceSlug} />
            </CardBody>
          </Card>
        )}
        {data?.truncated !== undefined && (
          <HelperText>{TRUNCATION_LINE[data.truncated.bound](data.truncated.value)}</HelperText>
        )}
        {unplacedRuns > 0 && (
          <HelperText>
            {`${String(unplacedRuns)} more run${unplacedRuns === 1 ? '' : 's'} in flight for this plan ${unplacedRuns === 1 ? 'is' : 'are'} not shown.`}
          </HelperText>
        )}
      </Column>
    </PageContainer>
  );
}
