'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo } from 'react';

import { DataTable, type DataTableColumn } from '@/components/data-table/DataTable';
import { FilterSelect } from '@/components/FilterSelect';
import { StatusBadge } from '@/components/StatusBadge';
import { ORDER_STATUS, orderLinks } from '@/features/dcfp/orders';
import { useOrderNames } from '@/features/dcfp/useOrderNames';
import { useDistrictContext } from '@/features/district/DistrictContext';
import { useStores } from '@/features/geography/queries';
import type { Order } from '@/features/orders/api';
import { EMPTY_VALUE, formatNumber, formatTimestamp } from '@/lib/format';

import { useShipments, type ShipmentFilters, type ShipmentStatus } from './api';

const STATUS_OPTIONS = [
  { value: 'all', label: 'On the way and received' },
  { value: 'dispatched', label: ORDER_STATUS.dispatched.label },
  { value: 'received', label: ORDER_STATUS.received.label },
] as const;

const statusFrom = (value: string | null): ShipmentStatus | null =>
  value === 'dispatched' || value === 'received' ? value : null;

/** The transport the warehouse recorded at dispatch, in one line; "" when it recorded none. */
const transportOf = (order: Order) =>
  [
    order.waybill_number ? `Waybill ${order.waybill_number}` : null,
    order.vehicle_registration,
    order.driver_name,
  ]
    .filter(Boolean)
    .join(' · ');

/**
 * Stock NMS and JMS have sent to district stores: every warehouse order that has left the
 * warehouse, on the way or received, including stock sent before a district ordered. Read-only;
 * each row opens the order.
 */
export default function ShipmentsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const names = useOrderNames();
  const stores = useStores();
  const districtId = useDistrictContext()?.districtId ?? null;
  const links = orderLinks('national');

  const warehouseCode = params.get('warehouse');
  const warehouse = names.warehouses?.find((candidate) => candidate.code === warehouseCode);
  const filters: ShipmentFilters = {
    districtId,
    warehouseId: warehouse?.id ?? null,
    status: statusFrom(params.get('status')),
    search: params.get('q') ?? '',
  };
  // A warehouse in the address waits for the warehouse list, so the first page is already narrowed.
  const waiting = warehouseCode !== null && names.warehouses === undefined;
  const shipments = useShipments(filters);

  const storeName = useMemo(() => {
    const byId = new Map(
      (stores.data ?? []).map((store) => [store.id, store.district_name ?? store.name]),
    );
    return (id: string) => byId.get(id) ?? '';
  }, [stores.data]);

  const go = (next: Partial<Record<'status' | 'warehouse' | 'q', string | null>>) => {
    const query = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value) query.set(key, value);
      else query.delete(key);
    }
    const text = query.toString();
    router.replace(text ? `${pathname}?${text}` : pathname, { scroll: false });
  };

  const columns = useMemo<DataTableColumn<Order>[]>(
    () => [
      {
        id: 'sent',
        header: 'Sent',
        value: (order) => order.dispatched_at ?? order.created_at,
        cell: (order) => formatTimestamp(order.dispatched_at ?? order.created_at),
      },
      {
        id: 'product',
        header: 'Product',
        value: (order) => names.product(order.condom_id, order.condom_category),
        cell: (order) => (
          <Link
            href={links.detail(order.id)}
            className="font-medium underline-offset-4 hover:underline"
          >
            {names.product(order.condom_id, order.condom_category)}
          </Link>
        ),
      },
      {
        id: 'from',
        filter: 'select',
        header: 'From',
        value: (order) => names.warehouseLabel(order.ordered_from_store_id),
      },
      {
        id: 'to',
        filter: 'select',
        header: 'To district',
        value: (order) => storeName(order.ordered_for_store_id),
        cell: (order) => storeName(order.ordered_for_store_id) || EMPTY_VALUE,
      },
      {
        id: 'sentQuantity',
        header: 'Quantity sent',
        numeric: true,
        value: (order) => order.quantity_issued,
        cell: (order) => names.quantity(order.quantity_issued, order.unit_of_measure_id),
      },
      {
        id: 'received',
        header: 'Quantity received',
        numeric: true,
        value: (order) => order.quantity_received,
        cell: (order) => {
          if (order.order_status !== 'received' || order.quantity_received === null) {
            return <span className="text-muted-foreground">Not received yet</span>;
          }
          const short = (order.quantity_issued ?? 0) - order.quantity_received;
          return (
            <>
              {names.quantity(order.quantity_received, order.unit_of_measure_id)}
              {short > 0 ? (
                <span className="text-warning"> · {formatNumber(short)} short</span>
              ) : null}
            </>
          );
        },
      },
      {
        id: 'receivedAt',
        header: 'Received',
        hideable: true,
        value: (order) => order.received_at ?? '',
        cell: (order) => (order.received_at ? formatTimestamp(order.received_at) : EMPTY_VALUE),
      },
      {
        id: 'reason',
        filter: 'select',
        header: 'Sent for',
        hideable: true,
        value: (order) => (order.unrequested ? 'Sent without an order' : 'District order'),
      },
      {
        id: 'transport',
        header: 'Transport',
        hideable: true,
        defaultHidden: true,
        value: transportOf,
        cell: (order) => transportOf(order) || EMPTY_VALUE,
      },
      {
        id: 'status',
        filter: 'select',
        header: 'Status',
        value: (order) => ORDER_STATUS[order.order_status].label,
        cell: (order) => (
          <StatusBadge
            status={ORDER_STATUS[order.order_status].label}
            tone={ORDER_STATUS[order.order_status].tone}
          />
        ),
      },
    ],
    [names, links, storeName],
  );

  const filtered = filters.status !== null || filters.warehouseId !== null || filters.search !== '';

  return (
    <DataTable
      label="Shipments from NMS and JMS"
      preferencesKey="moh-shipments"
      columns={columns}
      rows={waiting ? undefined : shipments.data?.pages.flat()}
      getRowId={(order) => order.id}
      isLoading={waiting || shipments.isPending || names.isPending}
      error={shipments.error ?? names.error}
      onRetry={() => {
        void shipments.refetch();
        names.refetch();
      }}
      isRetrying={shipments.isRefetching}
      searchPlaceholder="Search district stores…"
      serverSearch={{
        value: filters.search,
        onChange: (q) => {
          go({ q });
        },
      }}
      more={{
        hasMore: shipments.hasNextPage,
        isLoading: shipments.isFetchingNextPage,
        onLoadMore: () => void shipments.fetchNextPage(),
        noun: 'shipments',
      }}
      toolbar={
        <>
          <FilterSelect
            label="From"
            value={warehouse?.code ?? 'all'}
            options={[
              { value: 'all', label: 'NMS and JMS' },
              ...(names.warehouses ?? []).map((candidate) => ({
                value: candidate.code,
                label: names.warehouseLabel(candidate.id),
              })),
            ]}
            onValueChange={(next) => {
              go({ warehouse: next === 'all' ? null : next });
            }}
          />
          <FilterSelect
            label="Status"
            value={filters.status ?? 'all'}
            options={STATUS_OPTIONS}
            onValueChange={(next) => {
              go({ status: next === 'all' ? null : next });
            }}
          />
        </>
      }
      emptyTitle={filtered ? 'No shipments match' : 'No shipments from NMS or JMS yet'}
      emptyDescription={
        filtered
          ? 'Clear the search or the filters to see every shipment.'
          : 'Shipments appear here once a warehouse dispatches stock to a district store.'
      }
      defaultSort={{ columnId: 'sent', direction: 'desc' }}
    />
  );
}
