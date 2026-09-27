'use client';

import { use } from 'react';
import { MemoryExplorer } from './space-memory.js';

interface DeepMemoryPageProps {
  params: Promise<{ space: string; path: string[] }>;
}

export function SpaceMemoryPathPage({ params }: DeepMemoryPageProps) {
  const { path: segments } = use(params);
  const joined = '/' + segments.map(decodeURIComponent).join('/');
  const last = segments[segments.length - 1] ?? '';
  const looksLikeDocument = last.length > 0 && last.includes('.');

  let initialPath = joined;
  let initialDocPath: string | undefined;
  if (looksLikeDocument) {
    initialDocPath = joined;
    const lastSlash = joined.lastIndexOf('/');
    initialPath = lastSlash > 0 ? `${joined.slice(0, lastSlash)}/` : '/';
  } else if (!initialPath.endsWith('/')) {
    initialPath = `${initialPath}/`;
  }

  return <MemoryExplorer initialPath={initialPath} initialDocPath={initialDocPath} />;
}
