'use client';

import {
  Suspense,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  Column,
  EmptyState,
  Icon,
  Input,
  Row,
  Spinner,
  SplitPane,
  Text,
  useBreakpoint,
} from '@aflow/design-system';
import type {
  HelpArticleListResponse,
  HelpArticleResponse,
  HelpArticleSummary,
  HelpTheme,
} from '@aflow/schemas';
import { AppPageHeader } from '../components/app-page-header.js';
import { MarkdownRenderer } from '../components/markdown-renderer.js';
import { useApiQuery } from '../hooks/useApiQuery.js';
import { HELP_THEME_LABELS, HELP_THEME_ORDER } from '../lib/helpThemes.js';

// Articles change only with a deploy, so a page visit never needs a refetch.
const HELP_STALE_TIME_MS = 60 * 60 * 1000;
const INDEX_WIDTH = 320;

interface HelpSelection {
  theme?: HelpTheme;
  articleId?: string;
}

function helpHref({ theme, articleId }: HelpSelection): string {
  const params = new URLSearchParams();
  if (theme !== undefined) params.set('theme', theme);
  if (articleId !== undefined) params.set('article', articleId);
  const query = params.toString();
  return query === '' ? '/help' : `/help?${query}`;
}

function isHelpTheme(value: string | null): value is HelpTheme {
  return value !== null && (HELP_THEME_ORDER as readonly string[]).includes(value);
}

function useHelpArticles(query: string) {
  return useApiQuery<HelpArticleListResponse>({
    key: ['help', 'articles', query],
    path: query === '' ? '/help/articles' : `/help/articles?q=${encodeURIComponent(query)}`,
    staleTime: HELP_STALE_TIME_MS,
  });
}

export function HelpIndexPage(): ReactElement {
  return (
    <Suspense fallback={null}>
      <HelpCenter />
    </Suspense>
  );
}

/** A link to one answer opens the index on that answer's theme, with the answer open. */
export function HelpArticlePage(): ReactElement {
  const params = useParams<{ articleId: string }>();
  return (
    <Suspense fallback={null}>
      <HelpCenter routeArticleId={params.articleId} />
    </Suspense>
  );
}

function HelpCenter({ routeArticleId }: { routeArticleId?: string }): ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isMobile } = useBreakpoint();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query.trim());

  const catalog = useHelpArticles('');
  const articles = catalog.data?.articles ?? [];

  const themeParam = searchParams.get('theme');
  const selectedArticleId = routeArticleId ?? searchParams.get('article') ?? undefined;
  const selectedArticle = articles.find((article) => article.id === selectedArticleId);
  const firstTheme = HELP_THEME_ORDER.find((theme) =>
    articles.some((article) => article.theme === theme),
  );
  const selectedTheme: HelpTheme | undefined =
    selectedArticle?.theme ?? (isHelpTheme(themeParam) ? themeParam : firstTheme);
  const hasSelection = selectedArticleId !== undefined || isHelpTheme(themeParam);

  const select = (selection: HelpSelection): void => {
    router.push(helpHref(selection), { scroll: false });
  };

  const index = (
    <HelpIndex
      articles={articles}
      query={query}
      searchQuery={deferredQuery}
      onQueryChange={setQuery}
      selectedTheme={selectedTheme}
      selectedArticleId={selectedArticle?.id}
      onSelect={select}
    />
  );

  let content: ReactNode;
  if (catalog.isLoading) {
    content = (
      <Row justify="center" style={{ padding: 'var(--space-6)' }}>
        <Spinner size="lg" label="Loading help" />
      </Row>
    );
  } else if (catalog.error) {
    content = <EmptyState title="Help could not be loaded" description={catalog.error.message} />;
  } else if (selectedArticleId !== undefined && selectedArticle === undefined) {
    content = (
      <EmptyState
        title="This answer is not available"
        description="It may not apply to this edition of Aflow."
      />
    );
  } else if (selectedTheme === undefined) {
    content = <EmptyState title="No help articles" description="Nothing is published yet." />;
  } else {
    content = (
      <HelpThemeView
        key={selectedTheme}
        theme={selectedTheme}
        articles={articles.filter((article) => article.theme === selectedTheme)}
        selectedArticleId={selectedArticle?.id}
        onSelect={select}
      />
    );
  }

  return (
    <Column grow style={{ height: '100%', minHeight: 0 }}>
      <AppPageHeader title="Help" subtitle="Answers about how Aflow works and where things are." />
      {isMobile ? (
        <Column grow style={{ minHeight: 0, overflow: 'auto' }}>
          {hasSelection ? (
            <Column gap="none">
              <button
                type="button"
                onClick={() => {
                  router.push('/help', { scroll: false });
                }}
                style={{ ...plainButtonStyle, padding: 'var(--space-3) var(--space-4)' }}
              >
                <Row gap="xs" align="center">
                  <Icon name="arrow-left" size={16} />
                  <Text size="sm">All topics</Text>
                </Row>
              </button>
              {content}
            </Column>
          ) : (
            index
          )}
        </Column>
      ) : (
        <Row grow align="stretch" style={{ minHeight: 0, overflow: 'hidden' }}>
          <SplitPane aside={index} asidePlacement="start" asideWidth={INDEX_WIDTH}>
            {content}
          </SplitPane>
        </Row>
      )}
    </Column>
  );
}

const plainButtonStyle = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  color: 'var(--color-text-primary)',
  font: 'inherit',
} as const;

function IndexButton({
  selected,
  indent,
  onClick,
  children,
}: {
  selected: boolean;
  indent: boolean;
  onClick: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? 'true' : undefined}
      style={{
        ...plainButtonStyle,
        padding: indent
          ? 'var(--space-1-5) var(--space-3) var(--space-1-5) var(--space-8)'
          : 'var(--space-2) var(--space-3)',
        borderRadius: 'var(--radius-sm)',
        backgroundColor: selected ? 'var(--color-surface-2)' : 'transparent',
      }}
    >
      {children}
    </button>
  );
}

function HelpIndex({
  articles,
  query,
  searchQuery,
  onQueryChange,
  selectedTheme,
  selectedArticleId,
  onSelect,
}: {
  articles: readonly HelpArticleSummary[];
  query: string;
  searchQuery: string;
  onQueryChange: (query: string) => void;
  selectedTheme: HelpTheme | undefined;
  selectedArticleId: string | undefined;
  onSelect: (selection: HelpSelection) => void;
}): ReactElement {
  const search = useHelpArticles(searchQuery);
  const results = search.data?.articles ?? [];

  return (
    <Column gap="sm" style={{ padding: 'var(--space-3)' }}>
      <Input
        value={query}
        onChange={(event) => {
          onQueryChange(event.target.value);
        }}
        placeholder="Search help"
        aria-label="Search help"
      />
      {searchQuery !== '' ? (
        <Column gap="none">
          {search.isLoading && (
            <Row justify="center" style={{ padding: 'var(--space-4)' }}>
              <Spinner label="Searching help" />
            </Row>
          )}
          {!search.isLoading && results.length === 0 && (
            <Text size="sm" variant="muted" style={{ padding: 'var(--space-2) var(--space-3)' }}>
              No answers match. Try other words.
            </Text>
          )}
          {results.map((article) => (
            <IndexButton
              key={article.id}
              selected={article.id === selectedArticleId}
              indent={false}
              onClick={() => {
                onSelect({ theme: article.theme, articleId: article.id });
              }}
            >
              <Column gap="none">
                <Text size="sm">{article.question}</Text>
                <Text size="xs" variant="muted">
                  {HELP_THEME_LABELS[article.theme]}
                </Text>
              </Column>
            </IndexButton>
          ))}
        </Column>
      ) : (
        <Column gap="none">
          {HELP_THEME_ORDER.map((theme) => {
            const questions = articles.filter((article) => article.theme === theme);
            if (questions.length === 0) return null;
            const open = theme === selectedTheme;
            return (
              <Column key={theme} gap="none">
                <IndexButton
                  selected={open && selectedArticleId === undefined}
                  indent={false}
                  onClick={() => {
                    onSelect({ theme });
                  }}
                >
                  <Row gap="xs" align="center" justify="between">
                    <Row gap="xs" align="center">
                      <Icon name={open ? 'caret-down' : 'caret-right'} size={14} />
                      <Text size="sm" weight="semibold">
                        {HELP_THEME_LABELS[theme]}
                      </Text>
                    </Row>
                    <Text size="xs" variant="muted">
                      {questions.length}
                    </Text>
                  </Row>
                </IndexButton>
                {open &&
                  questions.map((article) => (
                    <IndexButton
                      key={article.id}
                      selected={article.id === selectedArticleId}
                      indent
                      onClick={() => {
                        onSelect({ theme, articleId: article.id });
                      }}
                    >
                      <Text size="sm">{article.question}</Text>
                    </IndexButton>
                  ))}
              </Column>
            );
          })}
        </Column>
      )}
    </Column>
  );
}

/** Every question in one theme with its short answer; the full answer opens in place. */
function HelpThemeView({
  theme,
  articles,
  selectedArticleId,
  onSelect,
}: {
  theme: HelpTheme;
  articles: readonly HelpArticleSummary[];
  selectedArticleId: string | undefined;
  onSelect: (selection: HelpSelection) => void;
}): ReactElement {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const sectionRefs = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    if (selectedArticleId === undefined) return;
    setExpanded((current) => new Set(current).add(selectedArticleId));
    sectionRefs.current.get(selectedArticleId)?.scrollIntoView({ block: 'start' });
  }, [selectedArticleId]);

  const toggle = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Column gap="lg" style={{ padding: 'var(--space-5)', maxWidth: 880 }}>
      <Text size="lg" weight="semibold">
        {HELP_THEME_LABELS[theme]}
      </Text>
      {articles.map((article) => {
        const open = expanded.has(article.id);
        return (
          <section
            key={article.id}
            ref={(element) => {
              if (element) sectionRefs.current.set(article.id, element);
              else sectionRefs.current.delete(article.id);
            }}
            style={{
              scrollMarginTop: 'var(--space-4)',
              paddingBottom: 'var(--space-4)',
              borderBottom: '1px solid var(--color-border-subtle)',
            }}
          >
            <Column gap="sm">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => {
                  toggle(article.id);
                }}
                style={plainButtonStyle}
              >
                <Row gap="xs" align="center">
                  <Icon name={open ? 'caret-down' : 'caret-right'} size={14} />
                  <Text size="base" weight="semibold">
                    {article.question}
                  </Text>
                </Row>
              </button>
              <Text size="sm" variant="muted">
                {article.summary}
              </Text>
              {open && <HelpArticleBody articleId={article.id} onSelect={onSelect} />}
            </Column>
          </section>
        );
      })}
    </Column>
  );
}

function HelpArticleBody({
  articleId,
  onSelect,
}: {
  articleId: string;
  onSelect: (selection: HelpSelection) => void;
}): ReactElement {
  const { data, isLoading, error } = useApiQuery<HelpArticleResponse>({
    key: ['help', 'article', articleId],
    path: `/help/articles/${encodeURIComponent(articleId)}`,
    staleTime: HELP_STALE_TIME_MS,
  });

  if (isLoading) return <Spinner label="Loading answer" />;
  if (error || !data) {
    return (
      <Text size="sm" tone="warning">
        {error?.message ?? 'This answer could not be loaded.'}
      </Text>
    );
  }

  return (
    <Column gap="md">
      <MarkdownRenderer content={data.article.body} />
      {data.related.length > 0 && (
        <Column gap="xs">
          <Text size="sm" weight="semibold">
            Related
          </Text>
          {data.related.map((related) => (
            <button
              key={related.id}
              type="button"
              onClick={() => {
                onSelect({ theme: related.theme, articleId: related.id });
              }}
              style={plainButtonStyle}
            >
              <Text size="sm" tone="accent">
                {related.question}
              </Text>
            </button>
          ))}
        </Column>
      )}
    </Column>
  );
}
