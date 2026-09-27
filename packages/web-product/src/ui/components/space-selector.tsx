'use client';

import { useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { isSoloSpace, useSpace, type SpaceInfo } from './providers.js';
import { Icon, Popover } from '@aflow/design-system';
import { CreateSpaceDialog } from './create-space-dialog.js';
import { equivalentRouteInSpace } from '../lib/space-routes.js';

function SpaceIcon({ space }: { space: SpaceInfo }) {
  return (
    <Icon name={isSoloSpace(space) ? 'robot' : 'buildings'} size={22} style={{ flexShrink: 0 }} />
  );
}

export function SpaceSelector({
  collapsed = false,
  variant = 'sidebar',
}: {
  collapsed?: boolean;
  /** 'sidebar' — full button with border (default). 'inline' — minimal breadcrumb-style trigger. */
  variant?: 'sidebar' | 'inline';
}) {
  const { accessibleSpaces, activeSpace, refresh } = useSpace();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [hoveredIdx, setHoveredIdx] = useState(-1);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  if (accessibleSpaces.length === 0) return null;

  const handleSelect = (space: SpaceInfo) => {
    setOpen(false);
    if (space.id === activeSpace?.id) return;
    const target = equivalentRouteInSpace(pathname ?? '/', space.slug);
    router.push(target);
  };

  const isInline = variant === 'inline';

  const sidebarStyle: React.CSSProperties = {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    width: '100%',
    padding: collapsed ? '8px' : '8px 10px',
    justifyContent: collapsed ? 'center' : 'flex-start',
    background: open ? 'var(--color-surface-2)' : 'transparent',
    border: '1px solid',
    borderColor: open ? 'var(--color-border-default)' : 'var(--color-border-subtle)',
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
    color: 'var(--color-text-primary)',
    fontSize: 'var(--font-size-base)',
    lineHeight: 1.4,
    transition: 'background 120ms, border-color 120ms',
    overflow: 'hidden',
  };

  const inlineStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 8px',
    background: 'var(--surface-raised-alpha',
    border: '1px solid var(--color-border-subtle)',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
    color: 'var(--color-text-primary)',
    fontSize: 'var(--font-size-sm)',
    fontWeight: 500,
    letterSpacing: 'normal',
    lineHeight: 1.4,
    transition: 'color 120ms, background 120ms, border-color 120ms',
    whiteSpace: 'nowrap',
  };

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setHoveredIdx(-1);
        }}
        placement={collapsed ? 'right-start' : 'bottom-start'}
        offset={collapsed ? 8 : 4}
        {...(collapsed ? { width: 220 } : { minWidth: 200 })}
        aria-label="Workspaces"
        panelStyle={{
          padding: 4,
          minWidth: 180,
          maxHeight: 480,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        trigger={({ ref, open: isOpen, toggle }) => (
          <button
            ref={ref}
            onClick={toggle}
            style={isInline ? inlineStyle : sidebarStyle}
            onMouseEnter={(e) => {
              if (isInline) {
                e.currentTarget.style.background = 'var(--color-surface-2)';
                e.currentTarget.style.borderColor = 'var(--color-border-default)';
              } else if (!isOpen) {
                e.currentTarget.style.background = 'var(--color-surface-2)';
                e.currentTarget.style.borderColor = 'var(--color-border-default)';
              }
            }}
            onMouseLeave={(e) => {
              if (isInline) {
                e.currentTarget.style.background = 'var(--color-surface-1)';
                e.currentTarget.style.borderColor = 'var(--color-border-subtle)';
              } else if (!isOpen) {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.borderColor = 'var(--color-border-subtle)';
              }
            }}
          >
            {activeSpace ? (
              <>
                {isInline ? (
                  <Icon
                    name={isSoloSpace(activeSpace) ? 'robot' : 'buildings'}
                    size={13}
                    style={{ opacity: 0.7 }}
                  />
                ) : (
                  <SpaceIcon space={activeSpace} />
                )}
                {!collapsed && (
                  <span
                    style={
                      isInline
                        ? {
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            maxWidth: 'min(40vw, 240px)',
                            minWidth: 0,
                          }
                        : {
                            flex: 1,
                            textAlign: 'left',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                          }
                    }
                  >
                    <span
                      style={{
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {activeSpace.name}
                    </span>
                  </span>
                )}
              </>
            ) : (
              <>
                <Icon name="buildings" size={isInline ? 13 : 22} style={{ opacity: 0.5 }} />
                {!collapsed && (
                  <span style={{ flex: isInline ? undefined : 1, textAlign: 'left', opacity: 0.5 }}>
                    Select space
                  </span>
                )}
              </>
            )}
            {!collapsed && !isInline && (
              <Icon name="caret-down" size="sm" style={{ opacity: 0.55, flexShrink: 0 }} />
            )}
            {isInline && (
              <Icon name="caret-down" size={11} style={{ opacity: 0.7, flexShrink: 0 }} />
            )}
          </button>
        )}
      >
        <div
          style={{
            padding: '4px 8px 6px',
            fontSize: 'var(--font-size-xs)',
            color: 'var(--color-text-muted)',
            fontWeight: 500,
            letterSpacing: '0.02em',
            flexShrink: 0,
          }}
        >
          Workspaces
        </div>
        <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
          {accessibleSpaces.map((space, idx) => {
            const isSelected = space.id === activeSpace?.id;
            const isHovered = hoveredIdx === idx;
            return (
              <div
                key={space.id}
                role="button"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  padding: '8px 10px',
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                  fontSize: 'var(--font-size-base)',
                  color: isSelected ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                  background: isHovered ? 'var(--color-surface-2)' : 'transparent',
                  fontWeight: isSelected ? 500 : 400,
                  transition: 'background 80ms',
                }}
                onMouseEnter={() => {
                  setHoveredIdx(idx);
                }}
                onMouseLeave={() => {
                  setHoveredIdx(-1);
                }}
                onClick={() => {
                  handleSelect(space);
                }}
              >
                <SpaceIcon space={space} />
                <span
                  style={{
                    flex: 1,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    minWidth: 0,
                  }}
                >
                  <span
                    style={{
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {space.name}
                  </span>
                </span>
                {isSelected && (
                  <Icon name="check" size="sm" style={{ flexShrink: 0, opacity: 0.6 }} />
                )}
              </div>
            );
          })}
        </div>
        {/* Space Settings action */}
        <div
          style={{
            height: 1,
            backgroundColor: 'var(--color-border-subtle)',
            margin: '4px 0',
            flexShrink: 0,
          }}
        />
        <div
          role="button"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            padding: '7px 8px',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
            fontSize: 'var(--font-size-sm)',
            color: 'var(--color-text-secondary)',
            transition: 'background 80ms',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--color-surface-2)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
          onClick={() => {
            setOpen(false);
            // Only where there is a workspace to settle. The fallback used to be
            // `/spaces`, which no application has ever served — a click with no
            // active space left the menu and landed on a 404.
            if (activeSpace?.slug) {
              router.push(`/s/${encodeURIComponent(activeSpace.slug)}/settings/general`);
            }
          }}
        >
          <Icon name="gear" size="md" style={{ flexShrink: 0 }} />
          <span style={{ flex: 1 }}>Workspace Settings</span>
        </div>
        <div
          role="button"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            padding: '7px 8px',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
            fontSize: 'var(--font-size-sm)',
            color: 'var(--color-text-secondary)',
            transition: 'background 80ms',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--color-surface-2)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
          onClick={() => {
            setOpen(false);
            setCreateDialogOpen(true);
          }}
        >
          <Icon name="plus" size="md" style={{ flexShrink: 0 }} />
          <span style={{ flex: 1 }}>Create new workspace</span>
        </div>
      </Popover>

      <CreateSpaceDialog
        open={createDialogOpen}
        onClose={() => {
          setCreateDialogOpen(false);
        }}
        onCreated={(space) => {
          setCreateDialogOpen(false);
          refresh();
          router.push(`/s/${encodeURIComponent(space.slug)}/chat`);
        }}
      />
    </>
  );
}
