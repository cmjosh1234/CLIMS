'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';

import { DataTable, type DataTableColumn } from '@/components/data-table/DataTable';
import { RowActions, type RowAction } from '@/components/data-table/RowActions';
import { FilterTabs } from '@/components/FilterTabs';
import { StatusBadge } from '@/components/StatusBadge';
import { useCan } from '@/features/auth/queries';
import { useDistrictContext } from '@/features/district/DistrictContext';
import { EMPTY_VALUE } from '@/lib/format';

import { DECISIONS_FROM, REVIEW_STATUSES, type Hotspot, type HotspotDecision } from './api';
import { DECISION_TEXT, DecisionDialog } from './HotspotDecisionDialog';
import { dispenserSummary, hotspotLabel } from './hotspotForm';
import { useNationalHotspots } from './queries';

export const MOH_HOTSPOTS_PATH = '/moh/hotspots';
export const mohHotspotPath = (id: string) => `${MOH_HOTSPOTS_PATH}/${encodeURIComponent(id)}`;

const REVIEW_FILTERS = ['all', ...REVIEW_STATUSES] as const;
type ReviewFilter = (typeof REVIEW_FILTERS)[number];

const REVIEW_LABELS: Record<ReviewFilter, string> = {
  all: 'All',
  submitted: 'To review',
  active: 'Active',
  deactivated: 'Deactivated',
  rejected: 'Rejected',
};

const reviewFilterFrom = (value: string | null): ReviewFilter =>
  REVIEW_FILTERS.find((filter) => filter === value) ?? 'all';

/**
 * Every hotspot in the country, or in the district chosen in the district menu, for MOH. The
 * country holds tens of thousands, so the list pages, filters and searches on the server.
 */
export default function NationalHotspotsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const can = useCan();
  const districtId = useDistrictContext()?.districtId ?? null;
  const filter = reviewFilterFrom(params.get('review'));
  const search = params.get('q') ?? '';
  const hotspots = useNationalHotspots({
    districtId,
    reviewStatus: filter === 'all' ? null : filter,
    search,
  });
  const [deciding, setDeciding] = useState<{
    hotspot: Hotspot;
    decision: HotspotDecision;
  } | null>(null);

  const hrefFor = (review: ReviewFilter, q: string) => {
    const query = new URLSearchParams(params.toString());
    if (review === 'all') query.delete('review');
    else query.set('review', review);
    if (q) query.set('q', q);
    else query.delete('q');
    const text = query.toString();
    return text ? `${pathname}?${text}` : pathname;
  };

  const columns = useMemo<DataTableColumn<Hotspot>[]>(
    () => [
      {
        id: 'name',
        header: 'Hotspot',
        value: (hotspot) => `${hotspotLabel(hotspot)} ${hotspot.village ?? ''}`,
        cell: (hotspot) => (
          <div className="min-w-0">
            <Link
              href={mohHotspotPath(hotspot.id)}
              className="text-foreground font-medium underline-offset-4 hover:underline"
            >
              {hotspotLabel(hotspot)}
            </Link>
            <div className="text-muted-foreground truncate text-xs">
              {hotspot.village ?? EMPTY_VALUE}
            </div>
          </div>
        ),
      },
      {
        id: 'district',
        filter: 'select',
        header: 'District',
        value: (hotspot) => hotspot.district?.name,
      },
      {
        id: 'subcounty',
        filter: 'select',
        header: 'Subcounty',
        hideable: true,
        value: (hotspot) => hotspot.subcounty?.name,
      },
      { id: 'type', filter: 'select', header: 'Type', value: (hotspot) => hotspot.type },
      {
        id: 'contact',
        header: 'Hotspot manager',
        hideable: true,
        value: (hotspot) => hotspot.contact_person?.name,
      },
      {
        id: 'phone',
        header: 'Manager phone',
        hideable: true,
        defaultHidden: true,
        value: (hotspot) => hotspot.contact_person?.phone_number,
      },
      { id: 'dispenser', header: 'Dispenser', hideable: true, value: dispenserSummary },
      {
        id: 'status',
        filter: 'select',
        header: 'Status',
        value: (hotspot) => hotspot.review_status,
        cell: (hotspot) => <StatusBadge status={hotspot.review_status} />,
      },
    ],
    [],
  );

  const reviewActions = (hotspot: Hotspot): RowAction[] =>
    can('hotspots:activate')
      ? DECISIONS_FROM[hotspot.review_status].map((decision) => ({
          label: DECISION_TEXT[decision].verb,
          icon: DECISION_TEXT[decision].icon,
          destructive: DECISION_TEXT[decision].destructive,
          onSelect: () => {
            setDeciding({ hotspot, decision });
          },
        }))
      : [];

  const narrowed = filter !== 'all' || search !== '' || districtId !== null;

  return (
    <div className="gap-section flex flex-col">
      <FilterTabs
        label="Filter hotspots by review status"
        value={filter}
        hrefFor={(value) => hrefFor(value, search)}
        tabs={REVIEW_FILTERS.map((value) => ({ value, label: REVIEW_LABELS[value] }))}
      />
      <DataTable
        key={filter}
        label="Hotspots"
        preferencesKey="moh-hotspots"
        columns={columns}
        rows={hotspots.data?.pages.flat()}
        getRowId={(hotspot) => hotspot.id}
        isLoading={hotspots.isPending}
        error={hotspots.error}
        onRetry={() => void hotspots.refetch()}
        isRetrying={hotspots.isRefetching}
        searchPlaceholder="Search hotspots, places, managers…"
        serverSearch={{
          value: search,
          onChange: (q) => {
            router.replace(hrefFor(filter, q), { scroll: false });
          },
        }}
        more={{
          hasMore: hotspots.hasNextPage,
          isLoading: hotspots.isFetchingNextPage,
          onLoadMore: () => void hotspots.fetchNextPage(),
          noun: 'hotspots',
        }}
        emptyTitle={
          narrowed
            ? filter === 'submitted'
              ? 'No hotspots to review'
              : 'No hotspots match'
            : 'No hotspots yet'
        }
        emptyDescription={
          narrowed
            ? 'Clear the search, choose All, or pick All districts to see more hotspots.'
            : 'Hotspots appear here once VHTs submit them in the mobile app.'
        }
        rowActions={(hotspot) => {
          const actions = reviewActions(hotspot);
          return actions.length ? (
            <RowActions label={`Actions for ${hotspotLabel(hotspot)}`} actions={actions} />
          ) : null;
        }}
      />

      {deciding ? (
        <DecisionDialog
          hotspot={deciding.hotspot}
          decision={deciding.decision}
          onClose={() => {
            setDeciding(null);
          }}
        />
      ) : null}
    </div>
  );
}
