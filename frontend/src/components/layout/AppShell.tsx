'use client';

import { usePathname } from 'next/navigation';
import { useRef, type CSSProperties, type ReactNode } from 'react';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { AppSidebar } from '@/components/layout/AppSidebar';
import type { AppNotification, NotificationActions } from '@/components/layout/NotificationsBell';
import { PageHeading } from '@/components/layout/PageHeading';
import { TopBar } from '@/components/layout/TopBar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { useFocusWhenLost } from '@/hooks/useFocusWhenLost';
import { useStoredBoolean } from '@/hooks/useStoredBoolean';
import type { StorageLike } from '@/lib/storage/jsonStorage';
import { locate, type NavCounts, type Workspace } from '@/navigation/navigation';

interface AppShellProps {
  workspaces: readonly Workspace[];
  /** Where the sidebar's open/closed preference is remembered. */
  storage: StorageLike;
  /** Badge counts by page path, for the sidebar and tabs. */
  counts?: NavCounts;
  /** The bell's list; leave out while there is no notification feed. */
  notifications?: readonly AppNotification[];
  /** What the bell may do with the feed: open an item, mark all read. */
  notificationActions?: NotificationActions;
  /** The heading for an address that has no page in `workspaces`, e.g. one the person may not open. */
  fallbackTitle?: string;
  /** The line under `fallbackTitle`, for a page outside `workspaces` such as the person's profile. */
  fallbackDescription?: string;
  /** The routed page. */
  children: ReactNode;
}

/** The signed-in frame: top bar, sidebar, heading band and the routed page. */
export function AppShell({
  workspaces,
  storage,
  counts,
  notifications,
  notificationActions,
  fallbackTitle,
  fallbackDescription,
  children,
}: AppShellProps) {
  const pathname = usePathname();
  const location = locate(workspaces, pathname);
  const [isSidebarOpen, setIsSidebarOpen] = useStoredBoolean(storage, 'clims.sidebar-open', true);
  // Following a link inside the page removes the link, which drops focus to
  // the body; start the new page at its main region instead. Next.js announces
  // the new title. Focus left on the sidebar or a tab stays where it is.
  const mainRef = useRef<HTMLElement>(null);
  useFocusWhenLost(mainRef, pathname);

  return (
    <SidebarProvider
      open={isSidebarOpen}
      onOpenChange={setIsSidebarOpen}
      className="flex-col"
      style={{ '--sidebar-width': '14rem', '--sidebar-width-icon': '3rem' } as CSSProperties}
    >
      <a
        href="#main"
        className="bg-background text-foreground focus-visible:ring-ring sr-only z-50 rounded-lg px-3 py-2 text-sm font-medium focus-visible:not-sr-only focus-visible:fixed focus-visible:top-3 focus-visible:left-3 focus-visible:ring-2"
      >
        Skip to content
      </a>
      <TopBar notifications={notifications} notificationActions={notificationActions} />
      <div className="flex flex-1">
        <AppSidebar workspaces={workspaces} location={location} counts={counts} />
        <SidebarInset
          ref={mainRef}
          id="main"
          tabIndex={-1}
          className="bg-canvas min-w-0 outline-none"
        >
          <PageHeading
            location={location}
            counts={counts}
            fallbackTitle={fallbackTitle}
            fallbackDescription={fallbackDescription}
          />
          <div className="w-full flex-1 px-4 pt-3 pb-8">
            <ErrorBoundary resetKey={pathname}>
              <div className="gap-section flex w-full flex-col">{children}</div>
            </ErrorBoundary>
          </div>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
