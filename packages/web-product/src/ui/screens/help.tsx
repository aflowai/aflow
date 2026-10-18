'use client';

import { useDeferredValue, useState, type ReactElement } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  Badge,
  Card,
  CardBody,
  Column,
  EmptyState,
  Input,
  PageContainer,
  Row,
  Spinner,
  Text,
} from '@aflow/design-system';
import type {
  HelpArticleListResponse,
  HelpArticleResponse,
  HelpArticleSummary,
} from '@aflow/schemas';
import { AppPageHeader } from '../components/app-page-header.js';
import { MarkdownRenderer } from '../components/markdown-renderer.js';
import { useApiQuery } from '../hooks/useApiQuery.js';
import { HELP_THEME_LABELS, HELP_THEME_ORDER } from '../lib/helpThemes.js';

// Articles change only with a deploy, so a page visit never needs a refetch.
const HELP_STALE_TIME_MS = 60 * 60 * 1000;

function helpArticleHref(id: string): string {
  return `/help/${encodeURIComponent(id)}`;
}

function ArticleRow({ article }: { article: HelpArticleSummary }): ReactElement {
  return (
    <Link href={helpArticleHref(article.id)} style={{ textDecoration: 'none', color: 'inherit' }}>
      <Card>
        <CardBody>
          <Column gap="xs">
            <Text size="sm" weight="semibold">
              {article.question}
            </Text>
            <Text size="sm" variant="muted">
              {article.summary}
            </Text>
          </Column>
        </CardBody>
      </Card>
    </Link>
  );
}

export function HelpIndexPage(): ReactElement {
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query.trim());
  const path =
    deferredQuery === ''
      ? '/help/articles'
      : `/help/articles?q=${encodeURIComponent(deferredQuery)}`;
  const { data, isLoading, error } = useApiQuery<HelpArticleListResponse>({
    key: ['help', 'articles', deferredQuery],
    path,
    staleTime: HELP_STALE_TIME_MS,
  });
  const articles = data?.articles ?? [];

  return (
    <>
      <AppPageHeader title="Help" subtitle="Answers about how Aflow works and where things are." />
      <PageContainer maxWidth={880}>
        <Column gap="lg">
          <Input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            placeholder="Search help"
            aria-label="Search help"
          />

          {error && (
            <Text size="sm" style={{ color: 'var(--color-status-warning)' }}>
              {error.message}
            </Text>
          )}

          {isLoading && (
            <Row justify="center" style={{ padding: 'var(--space-6)' }}>
              <Spinner size="lg" label="Loading help" />
            </Row>
          )}

          {!isLoading && !error && articles.length === 0 && (
            <EmptyState
              title="No answers match"
              description="Try other words, or clear the search to browse every topic."
            />
          )}

          {deferredQuery !== '' ? (
            <Column gap="sm">
              {articles.map((article) => (
                <ArticleRow key={article.id} article={article} />
              ))}
            </Column>
          ) : (
            HELP_THEME_ORDER.map((theme) => {
              const shelf = articles.filter((article) => article.theme === theme);
              if (shelf.length === 0) return null;
              return (
                <Column key={theme} gap="sm">
                  <Text size="base" weight="semibold">
                    {HELP_THEME_LABELS[theme]}
                  </Text>
                  {shelf.map((article) => (
                    <ArticleRow key={article.id} article={article} />
                  ))}
                </Column>
              );
            })
          )}
        </Column>
      </PageContainer>
    </>
  );
}

export function HelpArticlePage(): ReactElement {
  const params = useParams<{ articleId: string }>();
  const articleId = params.articleId;
  const { data, isLoading, error } = useApiQuery<HelpArticleResponse>({
    key: ['help', 'article', articleId],
    path: `/help/articles/${encodeURIComponent(articleId)}`,
    staleTime: HELP_STALE_TIME_MS,
  });

  const back = (
    <Link href="/help">
      <Text size="sm">← All help</Text>
    </Link>
  );

  if (isLoading) {
    return (
      <PageContainer maxWidth={880}>
        <Row justify="center" style={{ padding: 'var(--space-6)' }}>
          <Spinner size="lg" label="Loading article" />
        </Row>
      </PageContainer>
    );
  }

  if (error || !data) {
    return (
      <PageContainer maxWidth={880}>
        <EmptyState
          title="This answer is not available"
          description="It may not apply to this edition of Aflow."
          action={back}
        />
      </PageContainer>
    );
  }

  const { article, related } = data;
  return (
    <>
      <AppPageHeader title={article.question} />
      <PageContainer maxWidth={880}>
        <Column gap="lg">
          <Row gap="sm" align="center">
            {back}
            <Badge variant="neutral">{HELP_THEME_LABELS[article.theme]}</Badge>
          </Row>
          <MarkdownRenderer content={article.body} />
          {related.length > 0 && (
            <Column gap="sm">
              <Text size="base" weight="semibold">
                Related
              </Text>
              {related.map((summary) => (
                <ArticleRow key={summary.id} article={summary} />
              ))}
            </Column>
          )}
        </Column>
      </PageContainer>
    </>
  );
}
