'use client';

import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import {
  AppShell as Shell,
  SidebarHeader,
  SidebarNav,
  SidebarNavItem,
  SidebarFooter,
  SidebarAction,
  useSidebar,
  Icon,
  Tooltip,
  Logo,
  Row,
  Text,
  type IconName,
} from '@aflow/design-system';
import { useTheme } from '../providers/theme.js';
import { BlockedSessionNotice } from './blocked-session-notice.js';
import { useSpace } from './providers.js';
import { spaceRoute } from '../lib/space-routes.js';
import { SpaceSelector } from './space-selector.js';
import { UserAvatar, useCurrentUser } from './user-avatar.js';
import { useEdition, useHasSurface } from '../hooks/useEdition.js';
import { type ReactNode, useEffect } from 'react';

interface NavItem {
  label: string;
  /** Legacy top-level path — resolved to `/s/<slug>/…` when a space is active. */
  path: string;
  icon: IconName;
}

/** Primary destinations shown in every space. In the sidebar: Chat renders
 *  first, Skills is interleaved next (for cybernetic spaces), then Integrations,
 *  Shop, Memory, Settings, and finally People (admin-only). */
/**
 * A tuple, not a list, because the code below destructures the four by name. Typed
 * as an open array each one is possibly-undefined, which the application's looser
 * compilation never said and the shared product's does.
 */
const navItems: readonly [NavItem, NavItem, NavItem, NavItem] = [
  { label: 'Chat', path: '/chat', icon: 'chat-dots' },
  { label: 'Integrations', path: '/integrations', icon: 'plugs' },
  { label: 'Shop', path: '/store', icon: 'store' },
  { label: 'Memory', path: '/memory', icon: 'books' },
];

function isPrimaryNavActive(pathname: string, legacyPath: string, href: string): boolean {
  return pathname.startsWith(href) || pathname.startsWith(legacyPath);
}

function Sidebar() {
  const pathname = usePathname();
  const params = useParams<{ space?: string }>();
  const router = useRouter();
  const { collapsed, toggle, isMobile, closeDrawer } = useSidebar();
  const { resolvedTheme, setTheme } = useTheme();
  const { activeSpace, accessibleSpaces, isLoading: spacesLoading } = useSpace();
  const hasSpaceMembers = useHasSurface('space-members');
  // The host lane ships outside the image and needs a machine paired to this
  // instance, which a hosted space does not have — "host execution belongs to
  // the local edition, where the machine and the instance are the same
  // operator", in the words of the refusal the API already returns there. The
  // surface is registered in both editions, so it cannot answer this; the
  // edition can.
  // Signing out ends a session, and the local edition has none: reaching this
  // process is the whole of the identity, so its middleware passes `/auth/logout`
  // straight through to a route nothing serves. This is the edition itself
  // rather than a named surface — there is nothing for a `logout` surface to
  // compose.
  // Each edition is asked for by name. `useEdition` answers `null` until the
  // server does, so the negation of one is not the other — it is true while the
  // answer is pending, which renders the other edition's controls for as long as
  // that takes and prefetches routes this build does not serve.
  const edition = useEdition();
  const isHostedEdition = edition.id === 'enterprise';
  const isLocalEdition = edition.id === 'community-local';
  const user = useCurrentUser();
  // Zero accessible spaces = onboarding is the whole surface (Plan 227 D6):
  // no nav, no space selector — just identity, account, and sign-out. While
  // the space list loads, keep the normal chrome so page loads don't flash
  // the collapsed state.
  const hasSpaces = spacesLoading || accessibleSpaces.length > 0;

  // Close drawer on navigation (mobile)
  useEffect(() => {
    if (isMobile) {
      closeDrawer();
    }
  }, [pathname]); // intentionally omit isMobile/closeDrawer — only re-run on route change

  const toggleTheme = () => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
  };

  const userLabel = user?.displayName || user?.email || 'User';
  const showLabel = isMobile || !collapsed;

  return (
    <>
      <SidebarHeader>
        <Row justify="between" align="center">
          <Tooltip content="Home" side="right">
            <Link
              href="/"
              style={{
                display: 'grid',
                gridTemplateColumns: showLabel ? 'auto 1fr' : 'auto 0fr',
                alignItems: 'center',
                columnGap: showLabel ? 'var(--space-md)' : 0,
                textDecoration: 'none',
                color: 'var(--color-content-primary)',
                transition:
                  'grid-template-columns var(--transition-duration-normal) var(--transition-timing-ease-out), column-gap var(--transition-duration-normal) var(--transition-timing-ease-out)',
                overflow: 'hidden',
              }}
            >
              <Logo size={16} />
              <h5
                style={{
                  fontFamily: 'var(--font-family-title)',
                  letterSpacing: 'var(--font-letter-spacing-wide)',
                  margin: 0,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  opacity: showLabel ? 1 : 0,
                  transform: showLabel ? 'translateX(0)' : 'translateX(-4px)',
                  transition:
                    'opacity var(--transition-duration-normal) var(--transition-timing-ease-out), transform var(--transition-duration-normal) var(--transition-timing-ease-out)',
                }}
                aria-hidden={!showLabel}
              >
                aflow
              </h5>
            </Link>
          </Tooltip>
          {isMobile && (
            <button
              onClick={closeDrawer}
              aria-label="Close menu"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 'var(--space-sm)',
                color: 'var(--color-content-muted)',
              }}
            >
              <Icon name="x" size={18} />
            </button>
          )}
        </Row>
      </SidebarHeader>

      {hasSpaces &&
        (!showLabel ? (
          <div
            style={{
              padding: 'var(--space-1) var(--space-2)',
              marginBottom: 'var(--space-sm)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 'var(--space-0-5)',
            }}
          >
            <Tooltip content={activeSpace?.name ?? 'Select space'} side="right">
              <SpaceSelector collapsed />
            </Tooltip>
          </div>
        ) : (
          <div
            style={{
              padding: 'var(--space-sm) var(--space-2)',
              marginBottom: 'var(--space-sm)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-0-5)',
            }}
          >
            <div
              style={{
                fontSize: '10px',
                fontWeight: 600,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--color-content-muted)',
                marginBottom: 'var(--space-1)',
                paddingLeft: 'var(--space-2)',
              }}
            >
              Workspace
            </div>
            <SpaceSelector />
          </div>
        ))}

      {hasSpaces && (
        <SidebarNav>
          {(() => {
            // The URL is canonical, so the route slug wins wherever it exists and
            // `activeSpace` serves only the unscoped routes. It cannot be the other
            // way round: `activeSpace` trails the URL twice over — it is null until
            // the spaces query lands, and on a space switch `RouteSpaceBridge`
            // adopts the new id from an effect, so a render sits between the new
            // params and the new space. Reading it first builds the sidebar from a
            // missing slug on mount (`spaceRoute` then answers with an unscoped
            // path, which `<Link>` prefetches — silently for `/chat`,
            // `/integrations` and `/memory`, which still have legacy pages, and as
            // a 404 for `/store` and `/settings/general`, which do not) and from
            // the *previous* space's slug mid-switch, which is worse: those links
            // resolve, to the wrong space.
            const routeSlug = typeof params.space === 'string' ? params.space : undefined;
            const slug = routeSlug ?? activeSpace?.slug;
            // With neither, there is no space to navigate within, and `spaceRoute`
            // would answer every entry with the unscoped path the comment above
            // describes. That case is not only the first render of a space page: a
            // tenant-level page carries no route slug at all, so the sidebar sat on
            // those links for as long as the spaces query took — `/store`,
            // `/triggers`, `/computer`, `/skills` and `/settings/general` have no
            // unscoped page in either edition. Showing nothing until a space
            // resolves is the honest answer; the entries appear when it does.
            if (slug === undefined) return null;
            const [chatItem, integrationsItem, shopItem, memoryItem] = navItems;
            interface NavEntry {
              key: string;
              label: string;
              href: string;
              active: boolean;
              icon: IconName;
            }
            const entries: NavEntry[] = [];

            // Chat
            const chatHref = spaceRoute(slug, chatItem.path);
            entries.push({
              key: chatItem.path,
              label: chatItem.label,
              href: chatHref,
              active: isPrimaryNavActive(pathname, chatItem.path, chatHref),
              icon: chatItem.icon,
            });

            // Skills — for cybernetic spaces
            if (activeSpace) {
              const skillsHref = spaceRoute(slug, '/skills');
              entries.push({
                key: 'skills',
                label: 'Skills',
                href: skillsHref,
                active: pathname.startsWith(skillsHref),
                icon: 'skill',
              });
            }

            // Integrations
            const integrationsHref = spaceRoute(slug, integrationsItem.path);
            entries.push({
              key: integrationsItem.path,
              label: integrationsItem.label,
              href: integrationsHref,
              active: isPrimaryNavActive(pathname, integrationsItem.path, integrationsHref),
              icon: integrationsItem.icon,
            });

            // Shop
            const shopHref = spaceRoute(slug, shopItem.path);
            entries.push({
              key: shopItem.path,
              label: shopItem.label,
              href: shopHref,
              active: isPrimaryNavActive(pathname, shopItem.path, shopHref),
              icon: shopItem.icon,
            });

            // Memory
            const memoryHref = spaceRoute(slug, memoryItem.path);
            entries.push({
              key: memoryItem.path,
              label: memoryItem.label,
              href: memoryHref,
              active: isPrimaryNavActive(pathname, memoryItem.path, memoryHref),
              icon: memoryItem.icon,
            });

            // Triggers — everything armed to start work here on its own. A clock
            // and an inbound event are one thing from the operator's side, so
            // they share a page; split by source they read as two features.
            // Not under This Computer: a trigger can start anything, and works
            // the same on a hosted space with no machine attached at all.
            const triggersHref = spaceRoute(slug, '/triggers');
            entries.push({
              key: 'triggers',
              label: 'Triggers',
              href: triggersHref,
              active: isPrimaryNavActive(pathname, '/triggers', triggersHref),
              icon: 'clock',
            });

            // This Computer — folders on the operator's own machine that this
            // space can reach. A section rather than a settings tab: each folder
            // carries its own grants and its own local servers, which is content
            // the space uses, not a preference that applies to all of it.
            if (isLocalEdition) {
              const computerHref = spaceRoute(slug, '/computer');
              entries.push({
                key: 'computer',
                label: 'This Computer',
                href: computerHref,
                active: isPrimaryNavActive(pathname, '/computer', computerHref),
                icon: 'folder',
              });
            }

            // Space Settings
            const settingsHref = spaceRoute(slug, '/settings/general');
            entries.push({
              key: 'settings',
              label: 'Settings',
              href: settingsHref,
              active: pathname.startsWith(settingsHref),
              icon: 'sliders',
            });

            // People — admin only, links to settings/members
            const isSpaceAdmin = activeSpace?.myRole === 'admin';
            // Sharing a space is the enterprise `space-members` surface; the sole owner
            // of an appliance is always its admin, so the role alone does not decide.
            if (isSpaceAdmin && hasSpaceMembers) {
              const peopleHref = spaceRoute(slug, '/settings/members');
              entries.push({
                key: 'people',
                label: 'People',
                href: peopleHref,
                active: pathname.startsWith(peopleHref),
                icon: 'users',
              });
            }

            return entries.map((e) => {
              const node = (
                <SidebarNavItem
                  key={e.key}
                  label={e.label}
                  href={e.href}
                  active={e.active}
                  icon={<Icon name={e.icon} size={22} weight={e.active ? 'fill' : 'thin'} />}
                  as={Link}
                />
              );
              return isMobile ? (
                <div key={e.key}>{node}</div>
              ) : (
                <Tooltip key={e.key} content={e.label} side="right">
                  {node}
                </Tooltip>
              );
            });
          })()}
        </SidebarNav>
      )}

      <SidebarFooter>
        {user && (
          <Tooltip content="Account settings" side="right">
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: showLabel ? 'auto 1fr' : 'auto 0fr',
                alignItems: 'center',
                justifyContent: showLabel ? undefined : 'center',
                columnGap: showLabel ? 'var(--space-3)' : 0,
                padding: showLabel ? '8px var(--space-3)' : '8px',
                overflow: 'hidden',
                marginBottom: 'var(--space-sm)',
                cursor: 'pointer',
                borderRadius: 'var(--radius-md)',
                transition:
                  'grid-template-columns var(--transition-duration-normal) var(--transition-timing-ease-out), column-gap var(--transition-duration-normal) var(--transition-timing-ease-out)',
              }}
              onClick={() => {
                router.push('/account');
              }}
            >
              <UserAvatar user={user} size={24} />
              <Text
                variant="muted"
                size="xs"
                truncate
                style={{
                  opacity: showLabel ? 1 : 0,
                  transform: showLabel ? 'translateX(0)' : 'translateX(-4px)',
                  transition:
                    'opacity var(--transition-duration-normal) var(--transition-timing-ease-out), transform var(--transition-duration-normal) var(--transition-timing-ease-out)',
                }}
                aria-hidden={!showLabel}
              >
                {userLabel}
              </Text>
            </div>
          </Tooltip>
        )}
        {user?.isAdmin && (
          <Tooltip content="Tenant Admin" side="right">
            <SidebarAction
              icon={<Icon name="gear" size={18} />}
              label="Tenant Admin"
              onClick={() => {
                router.push('/settings');
              }}
            />
          </Tooltip>
        )}
        {isHostedEdition && (
          <Tooltip content="Sign out" side="right">
            <SidebarAction
              icon={<Icon name="sign-out" size={18} />}
              label="Sign out"
              onClick={() => {
                window.location.href = '/auth/logout';
              }}
            />
          </Tooltip>
        )}
        <Tooltip content={resolvedTheme === 'dark' ? 'Light mode' : 'Dark mode'} side="right">
          <SidebarAction
            icon={<Icon name={resolvedTheme === 'dark' ? 'sun' : 'moon'} size={15} />}
            label={resolvedTheme === 'dark' ? 'Light mode' : 'Dark mode'}
            onClick={toggleTheme}
          />
        </Tooltip>
        {/* Only show collapse toggle on desktop */}
        {!isMobile && (
          <Tooltip content={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} side="right">
            <SidebarAction
              icon={<Icon name={collapsed ? 'caret-right' : 'caret-left'} size={15} />}
              label="Collapse"
              onClick={toggle}
            />
          </Tooltip>
        )}
      </SidebarFooter>
    </>
  );
}

export function AppShellWrapper({ children }: { children: ReactNode }) {
  return (
    <Shell sidebar={<Sidebar />} defaultCollapsed={true} mobileBarFallback={<Logo size={16} />}>
      {/* Above the content, because it explains why the content stopped changing. */}
      <BlockedSessionNotice />
      {children}
    </Shell>
  );
}
