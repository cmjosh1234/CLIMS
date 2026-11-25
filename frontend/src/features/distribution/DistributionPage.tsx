'use client';

import { CircleCheck, Hourglass, MapPin, PackageCheck } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo } from 'react';

import { DataTable, type DataTableColumn } from '@/components/data-table/DataTable';
import { FilterSelect } from '@/components/FilterSelect';
import { StatCard, StatCardGrid } from '@/components/StatCard';
import { useDistrictContext } from '@/features/district/DistrictContext';
import { EMPTY_VALUE, formatNumber, formatTimestamp } from '@/lib/format';

import {
  PERIODS,
  useDistributions,
  useDistributionSummary,
  type Category,
  type DistributionFilters,
  type DistributionLine,
  type Period,
} from './api';

const PERIOD_LABELS: Record<Period, string> = {
  '7': 'Last 7 days',
  '30': 'Last 30 days',
  '90': 'Last 90 days',
  all: 'All time',
};

const CATEGORY_OPTIONS = [
  { value: 'all', label: 'Male and female' },
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
] as const;

const DEFAULT_PERIOD: Period = '30';

const periodFrom = (value: string | null): Period =>
  PERIODS.find((period) => period === value) ?? DEFAULT_PERIOD;

const categoryFrom = (value: string | null): Category | null =>
  value === 'male' || value === 'female' ? value : null;

/** Where the hotspot is, below the district: village and subcounty. */
const placeOf = (line: DistributionLine) =>
  [line.village, line.subcounty].filter(Boolean).join(', ');

/** "4 boxes"-style quantity in the product's own unit. */
const quantityOf = (line: DistributionLine) => `${formatNumber(line.quantity)} ${line.unit}`;

const percent = (part: number, whole: number) =>
  whole > 0 ? `${String(Math.round((part / whole) * 100))}%` : EMPTY_VALUE;

/**
 * MOH's distribution ledger: every product a district store delivered to a hotspot, across the
 * country (or the district chosen in the district menu), with what the hotspot confirmed receiving.
 * Read-only; each row opens the stockout request it answered.
 */
export default function DistributionPage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const districtId = useDistrictContext()?.districtId ?? null;
  const filters: DistributionFilters = {
    districtId,
    category: categoryFrom(params.get('category')),
    period: periodFrom(params.get('period')),
    search: params.get('q') ?? '',
  };
  const lines = useDistributions(filters);
  const summary = useDistributionSummary(filters);

  const go = (next: Partial<Record<'category' | 'period' | 'q', string | null>>) => {
    const query = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value) query.set(key, value);
      else query.delete(key);
    }
    if (query.get('period') === DEFAULT_PERIOD) query.delete('period');
    const text = query.toString();
    router.replace(text ? `${pathname}?${text}` : pathname, { scroll: false });
  };

  const columns = useMemo<DataTableColumn<DistributionLine>[]>(
    () => [
      {
        id: 'delivered',
        header: 'Delivered',
        value: (line) => line.delivered_at,
        cell: (line) => formatTimestamp(line.delivered_at),
      },
      {
        id: 'hotspot',
        header: 'Hotspot',
        value: (line) => `${line.hot_spot} ${placeOf(line)}`,
        cell: (line) => (
          <div className="min-w-0">
            <Link
              href={`/moh/orders/${encodeURIComponent(line.stockout_report_id)}`}
              className="font-medium underline-offset-4 hover:underline"
            >
              {line.hot_spot}
            </Link>
            <div className="text-muted-foreground truncate text-xs">
              {placeOf(line) || EMPTY_VALUE}
            </div>
          </div>
        ),
      },
      {
        id: 'district',
        filter: 'select',
        header: 'District',
        value: (line) => line.district ?? '',
        cell: (line) => line.district ?? EMPTY_VALUE,
      },
      { id: 'product', filter: 'select', header: 'Product', value: (line) => line.product },
      {
        id: 'quantity',
        header: 'Quantity',
        numeric: true,
        value: (line) => line.quantity,
        cell: quantityOf,
      },
      {
        id: 'pieces',
        header: 'Pieces',
        numeric: true,
        value: (line) => line.pieces,
        cell: (line) => formatNumber(line.pieces),
      },
      {
        id: 'received',
        header: 'Confirmed received',
        numeric: true,
        value: (line) => line.acknowledged_pieces,
        cell: (line) => {
          if (line.acknowledged_pieces === null) {
            return <span className="text-muted-foreground">Not confirmed yet</span>;
          }
          const short = line.pieces - line.acknowledged_pieces;
          return (
            <>
              {formatNumber(line.acknowledged_pieces)}
              {short > 0 ? (
                <span className="text-warning"> · {formatNumber(short)} short</span>
              ) : null}
            </>
          );
        },
      },
      {
        id: 'carrier',
        header: 'Delivered by',
        hideable: true,
        value: (line) => line.rider ?? line.sent_by,
        cell: (line) =>
          line.rider ? (
            <div className="min-w-0">
              <div>{line.rider}</div>
              <div className="text-muted-foreground text-xs">Sent by {line.sent_by}</div>
            </div>
          ) : (
            line.sent_by
          ),
      },
      {
        id: 'store',
        filter: 'select',
        header: 'From store',
        hideable: true,
        defaultHidden: true,
        value: (line) => line.district_store,
      },
    ],
    [],
  );

  const data = summary.data;
  const loadingFigures = summary.isPending && !summary.isError;
  const figure = (value: number | undefined) =>
    value === undefined ? EMPTY_VALUE : formatNumber(value);
  // A failed summary leaves the list usable; each figure says it is missing rather than zero.
  const detail = (text: string | undefined) =>
    summary.isError ? { detail: 'Totals could not be loaded' } : text ? { detail: text } : {};
  const filtered = filters.category !== null || filters.search !== '';

  return (
    <div className="gap-section flex flex-col">
      <StatCardGrid>
        <StatCard
          label="Pieces delivered"
          value={figure(data?.pieces)}
          icon={PackageCheck}
          accent="positive"
          isLoading={loadingFigures}
          {...detail(
            data &&
              `${formatNumber(data.male_pieces)} male · ${formatNumber(data.female_pieces)} female`,
          )}
        />
        <StatCard
          label="Hotspots supplied"
          value={figure(data?.hotspots)}
          icon={MapPin}
          accent="info"
          isLoading={loadingFigures}
          {...detail(
            data &&
              `${formatNumber(data.deliveries)} ${data.deliveries === 1 ? 'delivery' : 'deliveries'}`,
          )}
        />
        <StatCard
          label="Confirmed received"
          value={figure(data?.acknowledged_pieces)}
          icon={CircleCheck}
          accent="positive"
          isLoading={loadingFigures}
          {...detail(
            data && `${percent(data.acknowledged_pieces, data.pieces)} of the pieces delivered`,
          )}
        />
        <StatCard
          label="Awaiting confirmation"
          value={figure(data?.unacknowledged_lines)}
          icon={Hourglass}
          accent={data && data.unacknowledged_lines > 0 ? 'caution' : 'neutral'}
          isLoading={loadingFigures}
          {...detail('Delivery lines no manager has confirmed')}
        />
      </StatCardGrid>
      <DataTable
        label="Hotspot deliveries"
        preferencesKey="moh-distribution"
        columns={columns}
        rows={lines.data?.pages.flat()}
        getRowId={(line) => line.id}
        isLoading={lines.isPending}
        error={lines.error}
        onRetry={() => {
          void lines.refetch();
          void summary.refetch();
        }}
        isRetrying={lines.isRefetching}
        searchPlaceholder="Search hotspots, places, products…"
        serverSearch={{
          value: filters.search,
          onChange: (q) => {
            go({ q });
          },
        }}
        more={{
          hasMore: lines.hasNextPage,
          isLoading: lines.isFetchingNextPage,
          onLoadMore: () => void lines.fetchNextPage(),
          noun: 'delivery lines',
        }}
        toolbar={
          <>
            <FilterSelect
              label="Period"
              value={filters.period}
              options={PERIODS.map((value) => ({ value, label: PERIOD_LABELS[value] }))}
              onValueChange={(period) => {
                go({ period });
              }}
            />
            <FilterSelect
              label="Condoms"
              value={filters.category ?? 'all'}
              options={CATEGORY_OPTIONS}
              onValueChange={(next) => {
                go({ category: next === 'all' ? null : next });
              }}
            />
          </>
        }
        emptyTitle={filtered ? 'No deliveries match' : 'No deliveries to hotspots in this period'}
        emptyDescription={
          filtered
            ? 'Clear the search or choose Male and female to see every delivery.'
            : filters.period === 'all'
              ? 'Deliveries appear here once a district store sends stock to a hotspot that reported a stockout.'
              : 'Choose a longer period, or All time, to see earlier deliveries.'
        }
        defaultSort={{ columnId: 'delivered', direction: 'desc' }}
      />
    </div>
  );
}
