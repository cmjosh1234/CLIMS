import { ChevronLeftIcon } from 'lucide-react';
import Link from 'next/link';

import { cn } from '@/lib/utils';
import type { NavCounts, NavItem, NavLocation } from '@/navigation/navigation';

/** The title when the address matches no page. */
const NOT_FOUND_TITLE = 'Page not found';
/** Read after a tab badge's number by screen readers. */
const COUNT_SUFFIX = 'need attention';
/** Put before the section's name on a record's way back to it. */
const BACK_PREFIX = 'Back to';

interface PageTabsProps {
  item: NavItem;
  currentPath: string | undefined;
  counts: NavCounts | undefined;
}

/**
 * The pages of one sidebar item, as links. Each tab is its own address, so a
 * tab can be bookmarked, shared and reached with the back button; this is
 * navigation, not an in-page tab panel.
 */
function PageTabs({ item, currentPath, counts }: PageTabsProps) {
  return (
    <nav
      aria-label={`${item.label} pages`}
      className="-mb-px flex [scrollbar-width:none] gap-5 overflow-x-auto [&::-webkit-scrollbar]:hidden"
    >
      {item.pages.map((page) => {
        const isCurrent = page.path === currentPath;
        const count = counts?.[page.path] ?? 0;
        return (
          <Link
            key={page.path}
            href={page.path}
            aria-current={isCurrent ? 'page' : undefined}
            className={cn(
              'focus-visible:ring-ring flex h-8 shrink-0 items-center gap-2 rounded-t-md border-b-2 px-0.5 text-sm outline-none focus-visible:ring-2',
              isCurrent
                ? 'border-foreground text-foreground font-semibold'
                : 'text-muted-foreground hover:text-foreground border-transparent font-medium',
            )}
          >
            {page.tab}
            {count > 0 ? (
              <>
                <span
                  aria-hidden="true"
                  className="bg-foreground text-background flex h-4.5 min-w-4.5 items-center justify-center rounded-full px-1.25 text-[0.65625rem] font-semibold"
                >
                  {count}
                </span>
                <span className="sr-only">{`, ${count} ${COUNT_SUFFIX}`}</span>
              </>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

interface PageHeadingProps {
  /** Where the current address sits in the navigation. */
  location: NavLocation;
  /** Tab badge counts by page path. */
  counts?: NavCounts;
  /** The title when the address has no page or record, instead of "Page not found". */
  fallbackTitle?: string;
  /** The line under `fallbackTitle`. */
  fallbackDescription?: string;
}

/**
 * The band under the top bar: the page title, one line on what the page is
 * for, and the section's tabs. A record (a detail page) instead gets a link
 * back to its section above the title. Everything comes from the navigation
 * table.
 */
export function PageHeading({
  location,
  counts,
  fallbackTitle,
  fallbackDescription,
}: PageHeadingProps) {
  const { item, page, detail } = location;
  const title = page?.title ?? detail?.label ?? fallbackTitle ?? NOT_FOUND_TITLE;
  const description = page ? page.description : detail ? undefined : fallbackDescription;
  const tabbedItem = page && item && item.pages.length > 1 ? item : null;
  const backItem = detail ? item : null;

  return (
    <div className="bg-card border-b">
      <div className={cn('px-4 pt-2.5', tabbedItem ? 'pb-0' : 'pb-2.5')}>
        {backItem ? (
          <Link
            href={backItem.pages[0].path}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring mb-0.5 -ml-0.5 inline-flex items-center gap-1 rounded-md text-[0.8125rem] font-medium outline-none focus-visible:ring-2"
          >
            <ChevronLeftIcon className="size-3.5" aria-hidden="true" />
            {`${BACK_PREFIX} ${backItem.label}`}
          </Link>
        ) : null}
        <h1 className="text-lg leading-snug font-semibold tracking-tight text-balance">{title}</h1>
        {description ? (
          <p className="text-muted-foreground max-w-190 text-[0.8125rem] text-pretty">
            {description}
          </p>
        ) : null}
        {tabbedItem ? (
          <div className="mt-1.5">
            <PageTabs item={tabbedItem} currentPath={page?.path} counts={counts} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
