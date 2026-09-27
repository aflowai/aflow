'use client';

import { useState } from 'react';
import {
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  Badge,
  Text,
  Stack,
  Inline,
  Icon,
  CodeBlock,
  JsonViewer,
} from '@aflow/design-system';

import { OutputSection } from '../output/OutputSection.js';

// ---------------------------------------------------------------------------
// Shape types (mirrors ComputeExecOutput from @aflow/schemas)
// ---------------------------------------------------------------------------

interface ResourceUsage {
  peakMemoryMB?: number;
  cpuTimeMs?: number;
}

interface OutputSummary {
  stdoutBytes: number;
  stderrBytes: number;
  stdoutLines: number;
  stderrLines: number;
  stdoutPreview?: string;
  stderrPreview?: string;
}

interface ComputeResult {
  exitCode: number;
  data: string;
  stderr: string;
  result?: unknown;
  outputFiles?: Record<string, string>;
  durationMs: number;
  resourceUsage?: ResourceUsage;
  timedOut?: boolean;
  truncated?: boolean;
  dataRef?: string;
  outputSummary?: OutputSummary;
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export function isComputeResult(data: unknown): data is ComputeResult {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  return (
    'exitCode' in obj &&
    typeof obj['exitCode'] === 'number' &&
    'data' in obj &&
    'durationMs' in obj &&
    typeof obj['durationMs'] === 'number'
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function exitCodeVariant(code: number): 'succeeded' | 'failed' | 'warning' {
  if (code === 0) return 'succeeded';
  if (code === 124) return 'warning'; // timeout
  return 'failed';
}

function exitCodeLabel(code: number, timedOut?: boolean): string {
  if (timedOut || code === 124) return 'Timeout';
  if (code === 0) return 'Success';
  if (code === 127) return 'Launch failed';
  return `Exit ${String(code)}`;
}

/** Max lines of stdout/stderr to show collapsed */
// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ComputeResultCard({ data }: { data: unknown }) {
  const [showDetails, setShowDetails] = useState(false);

  if (!isComputeResult(data)) {
    return <JsonViewer data={data} collapseDepth={3} maxHeight="400px" />;
  }

  const result = data;
  const hasStdout = result.data.length > 0;
  const hasStderr = result.stderr.length > 0;
  const hasResult = result.result !== undefined && result.result !== null;
  const hasOutputFiles =
    result.outputFiles !== undefined && Object.keys(result.outputFiles).length > 0;
  const isSuccess = result.exitCode === 0;
  const isTimeout = result.timedOut === true || result.exitCode === 124;

  return (
    <Card style={{ backgroundColor: 'var(--color-surface-3)' }}>
      <CardHeader>
        <Inline
          gap="2"
          align="center"
          wrap
          style={{ justifyContent: 'space-between', width: '100%' }}
        >
          <Inline gap="2" align="center" wrap>
            <Icon name="terminal" size="sm" />
            <Text variant="label" size="sm">
              Code Execution
            </Text>
            <Badge variant={exitCodeVariant(result.exitCode)}>
              {exitCodeLabel(result.exitCode, result.timedOut)}
            </Badge>
            {result.truncated && <Badge variant="warning">Truncated</Badge>}
          </Inline>
          <Inline gap="2" align="center">
            <Text variant="muted" size="xs">
              {formatDuration(result.durationMs)}
            </Text>
            {(hasResult || hasOutputFiles || result.resourceUsage) && (
              <button
                onClick={() => {
                  setShowDetails(!showDetails);
                }}
                style={{
                  background: 'none',
                  border: '1px solid var(--color-border-default)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '2px 8px',
                  cursor: 'pointer',
                  fontSize: '12px',
                  color: 'var(--color-text-muted)',
                }}
              >
                {showDetails ? 'Less' : 'More'}
              </button>
            )}
          </Inline>
        </Inline>
      </CardHeader>

      <CardBody>
        <Stack gap="3">
          {/* Timeout warning */}
          {isTimeout && (
            <div
              style={{
                padding: 'var(--space-2) var(--space-3)',
                background: 'var(--color-warning-subtle)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--color-warning-default)',
              }}
            >
              <Text size="xs" style={{ color: 'var(--color-warning-default)' }}>
                Execution was killed due to timeout. Partial output may be available.
              </Text>
            </div>
          )}

          {/* stderr — always visible when present and failed */}
          {hasStderr && !isSuccess && (
            <OutputSection label="Errors" content={result.stderr} variant="danger" />
          )}

          {/* stdout — primary output */}
          {hasStdout && <OutputSection label="Output" content={result.data} />}

          {/* stderr — shown collapsed when execution succeeded (warnings) */}
          {hasStderr && isSuccess && (
            <CollapsedSection label="Warnings" defaultOpen={false}>
              <OutputSection label="" content={result.stderr} variant="danger" />
            </CollapsedSection>
          )}

          {/* Empty output notice */}
          {!hasStdout && !hasStderr && !hasResult && isSuccess && (
            <Text variant="muted" size="sm">
              Execution completed with no output.
            </Text>
          )}

          {/* Structured result — shown in details */}
          {showDetails && hasResult && (
            <Stack gap="1">
              <Text variant="label" size="xs">
                Return value
              </Text>
              <JsonViewer data={result.result} collapseDepth={3} maxHeight="300px" />
            </Stack>
          )}

          {/* Output files — shown in details */}
          {showDetails && hasOutputFiles && (
            <Stack gap="1">
              <Text variant="label" size="xs">
                Output files
              </Text>
              {Object.entries(result.outputFiles!).map(([name, content]) => (
                <CollapsedSection key={name} label={name} defaultOpen={false}>
                  <div
                    style={{
                      fontSize: 'var(--font-size-xs)',
                      maxHeight: '200px',
                      overflow: 'auto',
                    }}
                  >
                    <CodeBlock copyable>{content}</CodeBlock>
                  </div>
                </CollapsedSection>
              ))}
            </Stack>
          )}
        </Stack>
      </CardBody>

      {/* Footer — resource usage + output summary */}
      {showDetails && (result.resourceUsage || result.outputSummary) && (
        <CardFooter>
          <Inline gap="3" align="center" wrap>
            {result.resourceUsage?.peakMemoryMB != null && (
              <Text variant="muted" size="xs">
                Peak memory: {result.resourceUsage.peakMemoryMB.toFixed(0)} MB
              </Text>
            )}
            {result.resourceUsage?.cpuTimeMs != null && (
              <Text variant="muted" size="xs">
                CPU time: {formatDuration(result.resourceUsage.cpuTimeMs)}
              </Text>
            )}
            {result.outputSummary && (
              <>
                <Text variant="muted" size="xs">
                  stdout: {formatBytes(result.outputSummary.stdoutBytes)} ·{' '}
                  {String(result.outputSummary.stdoutLines)} lines
                </Text>
                {result.outputSummary.stderrBytes > 0 && (
                  <Text variant="muted" size="xs">
                    stderr: {formatBytes(result.outputSummary.stderrBytes)} ·{' '}
                    {String(result.outputSummary.stderrLines)} lines
                  </Text>
                )}
              </>
            )}
          </Inline>
        </CardFooter>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Generic collapsed section
// ---------------------------------------------------------------------------

function CollapsedSection({
  label,
  defaultOpen,
  children,
}: {
  label: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div>
      <button
        onClick={() => {
          setOpen((prev) => !prev);
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-1)',
          background: 'none',
          border: 'none',
          padding: 'var(--space-1) 0',
          cursor: 'pointer',
          color: 'var(--color-text-muted)',
          fontSize: 'var(--font-size-xs)',
        }}
      >
        <Icon name={open ? 'caret-down' : 'caret-right'} size="xs" />
        <Text size="xs" variant="muted">
          {label}
        </Text>
      </button>
      {open && <div style={{ paddingLeft: 'var(--space-3)' }}>{children}</div>}
    </div>
  );
}
