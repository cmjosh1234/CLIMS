'use client';

import {
  Ban,
  CalendarClock,
  Inbox,
  MapPinOff,
  MessageSquare,
  PackageCheck,
  Truck,
} from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo } from 'react';

import { BarChart } from '@/components/charts/BarChart';
import { ColumnChart } from '@/components/charts/ColumnChart';
import { DataTable, type DataTableColumn } from '@/components/data-table/DataTable';
import { FilterSelect } from '@/components/FilterSelect';
import { FilterTabs } from '@/components/FilterTabs';
import { PageActions } from '@/components/PageActions';
import { StatCard, StatCardGrid } from '@/components/StatCard';
import { FilterBar } from '@/features/analytics/FilterBar';
import { apiParams, type FilterField } from '@/features/analytics/filters';
import { useReportFilters } from '@/features/analytics/useReportFilters';
import { productName } from '@/features/catalogue/api';
import { useProducts } from '@/features/catalogue/queries';
import { DownloadButtons } from '@/features/programme-reports/ReportTableView';
import { EMPTY_VALUE, formatNumber, formatTimestamp } from '@/lib/format';

import {
  csvPath,
  useConsumption,
  useConsumptionRecords,
  useConsumptionTable,
  type ConsumptionRecord,
  type Level,
} from './api';

export type ConsumptionWorkspace = 'moh' | 'dcfp' | 'warehouse';

/** The levels each workspace reads: MOH every one, a district its hotspots, a warehouse its orders. */
const LEVELS: Record<ConsumptionWorkspace, readonly Level[]> = {
  moh: ['hotspot', 'district', 'warehouse'],
  dcfp: ['hotspot'],
  warehouse: ['district', 'warehouse'],
};

const LEVEL_LABELS: Record<Level, string> = {
  hotspot: 'Hotspots',
  district: 'Districts',
  warehouse: 'Warehouses',
};

const ALL = 'all';

const days = (value: number | null) =>
  value === null ? EMPTY_VALUE : `${formatNumber(Math.round(value * 10) / 10)} days`;
const both = (male: number, female: number) =>
  `${formatNumber(male)} male · ${formatNumber(female)} female`;

function columns(level: Level): DataTableColumn<ConsumptionRecord>[] {
  const name: DataTableColumn<ConsumptionRecord> = {
    id: 'name',
    header: LEVEL_LABELS[level].replace(/s$/, ''),
    value: (row) => row.name,
    cell: (row) => (
      <div className="min-w-0">
        <div className="truncate font-medium">{row.name}</div>
        {level === 'hotspot' ? (
          <div className="text-muted-foreground truncate text-xs">
            {[row.district, row.subcounty].filter(Boolean).join(' · ') || EMPTY_VALUE}
          </div>
        ) : null}
      </div>
    ),
  };
  const received: DataTableColumn<ConsumptionRecord> = {
    id: 'received',
    header: 'Received',
    filter: false,
    numeric: true,
    value: (row) => row.received_male_pieces + row.received_female_pieces,
    cell: (row) => both(row.received_male_pieces, row.received_female_pieces),
  };
  const average: DataTableColumn<ConsumptionRecord> = {
    id: 'average',
    header: level === 'hotspot' ? 'Days between requests' : 'Days between orders',
    filter: false,
    numeric: true,
    value: (row) => row.average_days_between,
    cell: (row) => days(row.average_days_between),
  };
  const rejected: DataTableColumn<ConsumptionRecord> = {
    id: 'rejected',
    header: 'Rejected',
    filter: false,
    numeric: true,
    value: (row) => row.rejected,
  };
  if (level === 'hotspot') {
    return [
      name,
      {
        id: 'requests',
        header: 'Requests',
        filter: false,
        numeric: true,
        value: (row) => row.requests ?? 0,
      },
      {
        id: 'messages',
        header: 'Messages',
        filter: false,
        numeric: true,
        value: (row) => row.messages ?? 0,
      },
      average,
      {
        id: 'delivered',
        header: 'Delivered',
        filter: false,
        numeric: true,
        value: (row) => (row.delivered_male_pieces ?? 0) + (row.delivered_female_pieces ?? 0),
        cell: (row) => both(row.delivered_male_pieces ?? 0, row.delivered_female_pieces ?? 0),
      },
      received,
      rejected,
      {
        id: 'last',
        header: 'Last request',
        filter: false,
        value: (row) => row.last_requested_at ?? null,
        cell: (row) =>
          row.last_requested_at ? formatTimestamp(row.last_requested_at) : EMPTY_VALUE,
      },
    ];
  }
  return [
    name,
    {
      id: 'orders',
      header: 'Orders',
      filter: false,
      numeric: true,
      value: (row) => row.orders ?? 0,
    },
    average,
    {
      id: 'issued',
      header: 'Issued',
      filter: false,
      numeric: true,
      value: (row) => (row.issued_male_pieces ?? 0) + (row.issued_female_pieces ?? 0),
      cell: (row) => both(row.issued_male_pieces ?? 0, row.issued_female_pieces ?? 0),
    },
    received,
    rejected,
    ...(level === 'warehouse'
      ? [
          {
            id: 'without',
            header: 'Sent without an order',
            filter: false as const,
            numeric: true,
            value: (row: ConsumptionRecord) => row.dispatches_without_order ?? 0,
          },
        ]
      : []),
  ];
}

/**
 * Consumption, read from demand and supply: how often hotspots ask for stock and what reaches them,
 * and one level up how often districts order from NMS and JMS and what reaches them. Requests raised
 * in the period count, with everything delivered against them.
 */
export default function ConsumptionPage({ workspace }: { workspace: ConsumptionWorkspace }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const filters = useReportFilters();
  const products = useProducts();
  const levels = LEVELS[workspace];
  const raw = params.get('level');
  const level: Level = levels.find((value) => value === raw) ?? levels[0] ?? 'hotspot';
  const requested = params.get('requested') ?? '';
  const sent = params.get('sent') ?? '';
  const product = params.get('product') ?? '';
  const search = params.get('q') ?? '';

  /** Changes page parameters, keeping the rest of the address. */
  const go = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    const text = next.toString();
    router.replace(text ? `${pathname}?${text}` : pathname, { scroll: false });
  };

  // A district's account is limited to its district by the server, so it is offered no district filter.
  const fields: FilterField[] = [
    'period',
    ...(workspace === 'moh' ? (['district'] as const) : []),
    ...(workspace === 'moh' && level !== 'hotspot' ? (['warehouse'] as const) : []),
  ];
  const apiFilters = useMemo(
    () => ({
      ...apiParams(filters.state, ['from', 'to', 'district_id', 'warehouse_store_id']),
      level,
      requested: level !== 'hotspot' && requested === 'both' ? '' : requested,
      sent,
      condom_id: product,
    }),
    [filters.state, level, requested, sent, product],
  );
  const report = useConsumption(apiFilters);
  const recordParams = useMemo(() => ({ ...apiFilters, q: search }), [apiFilters, search]);
  const records = useConsumptionRecords(recordParams);
  const table = useConsumptionTable(apiFilters);
  const data = report.data;
  const loading = report.isPending;
  const hot = data?.hotspots;
  const orders = data?.orders;
  const tableColumns = useMemo(() => columns(level), [level]);
  const monthly = (data?.monthly ?? []).map((month) => ({
    label: month.month,
    values: {
      requests: month.requests,
      male: month.received_pieces.male,
      female: month.received_pieces.female,
    },
  }));

  const typeOptions = [
    { value: ALL, label: 'Any type' },
    { value: 'male', label: 'Male' },
    { value: 'female', label: 'Female' },
  ];

  return (
    <div className="gap-section flex flex-col">
      <PageActions>
        <DownloadButtons table={table.data} csvPath={csvPath(apiFilters)} />
      </PageActions>
      {levels.length > 1 ? (
        <FilterTabs
          label="Choose a level"
          value={level}
          tabs={levels.map((value) => ({ value, label: LEVEL_LABELS[value] }))}
          hrefFor={(value) => {
            const next = new URLSearchParams(params.toString());
            next.set('level', value);
            next.delete('q');
            return `${pathname}?${next.toString()}`;
          }}
        />
      ) : null}
      <FilterBar filters={filters} fields={fields} inline={fields} />
      <div className="flex flex-wrap items-end gap-3" aria-label="Type and product">
        <FilterSelect
          label="Type requested"
          value={requested || ALL}
          options={
            level === 'hotspot'
              ? [...typeOptions, { value: 'both', label: 'Male and female' }]
              : typeOptions
          }
          onValueChange={(value) => {
            go({ requested: value === ALL ? '' : value });
          }}
        />
        <FilterSelect
          label="Type sent"
          value={sent || ALL}
          options={typeOptions}
          onValueChange={(value) => {
            go({ sent: value === ALL ? '' : value });
          }}
        />
        <FilterSelect
          label="Product"
          value={product || ALL}
          options={[
            { value: ALL, label: 'Any product' },
            ...(products.data ?? []).map((item) => ({ value: item.id, label: productName(item) })),
          ]}
          onValueChange={(value) => {
            go({ product: value === ALL ? '' : value });
          }}
          disabled={products.isPending}
        />
      </div>

      {level === 'hotspot' ? (
        <StatCardGrid>
          <StatCard
            label="Stockout requests"
            value={hot ? formatNumber(hot.requests) : '…'}
            extra={hot ? `${formatNumber(hot.hotspots_requesting)} hotspots asked` : undefined}
            icon={Inbox}
          />
          <StatCard
            label="Messages"
            value={hot ? formatNumber(hot.messages) : '…'}
            extra="Requests and the repeats sent while one was open"
            icon={MessageSquare}
          />
          <StatCard
            label="Days between requests"
            value={hot ? days(hot.average_days_between) : '…'}
            extra="Average gap, for hotspots that asked more than once"
            icon={CalendarClock}
          />
          <StatCard
            label="Pieces received"
            value={hot ? formatNumber(hot.received_pieces.male + hot.received_pieces.female) : '…'}
            extra={
              hot
                ? `${both(hot.received_pieces.male, hot.received_pieces.female)} · ${formatNumber(hot.delivered_pieces.male + hot.delivered_pieces.female)} delivered`
                : undefined
            }
            icon={PackageCheck}
            accent="positive"
          />
          <StatCard
            label="Rejected"
            value={hot ? formatNumber(hot.rejected) : '…'}
            icon={Ban}
            accent="caution"
          />
          <StatCard
            label="Hotspots that did not ask"
            value={hot ? formatNumber(hot.silent_hotspots) : '…'}
            extra="Active hotspots with no request in the period"
            icon={MapPinOff}
          />
        </StatCardGrid>
      ) : (
        <StatCardGrid>
          <StatCard
            label="Orders"
            value={orders ? formatNumber(orders.orders) : '…'}
            icon={Inbox}
          />
          <StatCard
            label="Days between orders"
            value={orders ? days(orders.average_days_between) : '…'}
            icon={CalendarClock}
          />
          <StatCard
            label="Pieces issued"
            value={
              orders ? formatNumber(orders.issued_pieces.male + orders.issued_pieces.female) : '…'
            }
            extra={
              orders ? both(orders.issued_pieces.male, orders.issued_pieces.female) : undefined
            }
            icon={Truck}
          />
          <StatCard
            label="Pieces received"
            value={
              orders
                ? formatNumber(orders.received_pieces.male + orders.received_pieces.female)
                : '…'
            }
            extra={
              orders ? both(orders.received_pieces.male, orders.received_pieces.female) : undefined
            }
            icon={PackageCheck}
            accent="positive"
          />
          <StatCard
            label="Rejected"
            value={orders ? formatNumber(orders.rejected) : '…'}
            icon={Ban}
            accent="caution"
          />
          {data?.dispatches_without_order ? (
            <StatCard
              label="Sent without an order"
              value={formatNumber(data.dispatches_without_order.dispatches)}
              extra={`${formatNumber(data.dispatches_without_order.issued_pieces)} pieces`}
              icon={Truck}
            />
          ) : null}
        </StatCardGrid>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <ColumnChart
          title={level === 'hotspot' ? 'Requests by month' : 'Orders by month'}
          description="Raised in each month of the period."
          categoryLabel="Month"
          series={{
            key: 'requests',
            label: level === 'hotspot' ? 'Requests' : 'Orders',
            color: 'var(--chart-1)',
          }}
          rows={monthly}
          isLoading={loading}
          error={report.error}
          onRetry={() => void report.refetch()}
          emptyMessage="Nothing was requested in this period."
        />
        <ColumnChart
          title="Pieces received by month"
          description="What reached them, against the requests of each month."
          categoryLabel="Month"
          series={[
            { key: 'male', label: 'Male', color: 'var(--chart-1)' },
            { key: 'female', label: 'Female', color: 'var(--chart-2)' },
          ]}
          stacked
          rows={monthly}
          isLoading={loading}
          error={report.error}
          onRetry={() => void report.refetch()}
          emptyMessage="Nothing was received in this period."
        />
        {level === 'hotspot' && workspace === 'moh' ? (
          <BarChart
            title="Requests by district"
            description="Stockout requests raised by each district's hotspots."
            categoryLabel="District"
            series={[{ key: 'requests', label: 'Requests', color: 'var(--chart-1)' }]}
            rows={(data?.by_district ?? []).map((group) => ({
              label: group.district ?? 'No district',
              values: { requests: group.requests },
            }))}
            isLoading={loading}
            error={report.error}
            onRetry={() => void report.refetch()}
            emptyMessage="Nothing was requested in this period."
          />
        ) : null}
      </div>

      <DataTable
        label={`Consumption by ${LEVEL_LABELS[level].toLowerCase().replace(/s$/, '')}`}
        preferencesKey={`consumption-${level}`}
        columns={tableColumns}
        rows={records.data?.pages.flat()}
        getRowId={(row) => row.id}
        isLoading={records.isPending}
        error={records.error}
        onRetry={() => void records.refetch()}
        isRetrying={records.isRefetching}
        pageSize={25}
        searchPlaceholder={level === 'hotspot' ? 'Search hotspots and places…' : 'Search names…'}
        serverSearch={{
          value: search,
          onChange: (q) => {
            go({ q });
          },
        }}
        more={{
          hasMore: records.hasNextPage,
          isLoading: records.isFetchingNextPage,
          onLoadMore: () => void records.fetchNextPage(),
          noun: 'rows',
        }}
        emptyTitle="Nothing in this view"
        emptyDescription="Choose another period, type or product."
      />
      {data ? <p className="text-muted-foreground text-xs">{data.date_basis}</p> : null}
    </div>
  );
}
