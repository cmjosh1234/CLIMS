import { useInfiniteQuery } from '@tanstack/react-query';
import { z } from 'zod';

import { orderSchema, type Order } from '@/features/orders/api';
import {
  parseBody,
  parseList,
  useApiQuery,
  useHttp,
  type ApiError,
  type HttpClient,
} from '@/lib/api';

/*
 * Where condoms went, read by MOH on its Distribution screen (docs/modules/orders.md):
 *
 *   GET /orders/hotspot-deliveries?district_id=&category=&from=&to=&q=&limit=&offset=
 *   GET /orders/hotspot-deliveries/summary?district_id=&category=&from=&to=&q=
 *   GET /orders?type=warehouse_request&status=dispatched,received&district_id=&warehouse_store_id=&q=
 *
 * The first is one row per product a district store delivered to a hotspot; the summary totals the
 * same rows. Shipments from NMS and JMS are the warehouse orders that have left the warehouse.
 * Lists page on the server, so a national list never loads the country into the browser.
 */

export const DISTRIBUTION_PAGE_SIZE = 50;

const count = z.number().int().nonnegative();
const text = z.string().nullable();

export const distributionLineSchema = z.object({
  id: z.string(),
  delivery_id: z.string(),
  stockout_report_id: z.string(),
  delivered_at: z.string(),
  hot_spot_id: z.string(),
  hot_spot: z.string(),
  village: text,
  subcounty: text,
  district_id: text,
  district: text,
  district_store_id: z.string(),
  district_store: z.string(),
  category: z.enum(['male', 'female']),
  product: z.string(),
  unit: z.string(),
  quantity: count,
  pieces: count,
  sent_by: z.string(),
  rider: text,
  rider_phone: text,
  acknowledged_pieces: count.nullable(),
  acknowledged_at: text,
});

export type DistributionLine = z.infer<typeof distributionLineSchema>;

const summarySchema = z.object({
  deliveries: count,
  hotspots: count,
  pieces: count,
  male_pieces: count,
  female_pieces: count,
  acknowledged_pieces: count,
  unacknowledged_lines: count,
});

export type DistributionSummary = z.infer<typeof summarySchema>;

export type Category = 'male' | 'female';

/** The periods the list offers, in days back from today; `all` sets no bound. */
export const PERIODS = ['7', '30', '90', 'all'] as const;
export type Period = (typeof PERIODS)[number];

export interface DistributionFilters {
  districtId: string | null;
  category: Category | null;
  period: Period;
  search: string;
}

/** The first day of a period as YYYY-MM-DD in Kampala, where the API counts days; null for all. */
export function periodStart(period: Period, now: Date = new Date()): string | null {
  if (period === 'all') return null;
  const start = new Date(now.getTime() - (Number(period) - 1) * 86_400_000);
  // en-CA writes dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala' }).format(start);
}

function filterQuery(filters: DistributionFilters): URLSearchParams {
  const query = new URLSearchParams();
  if (filters.districtId) query.set('district_id', filters.districtId);
  if (filters.category) query.set('category', filters.category);
  const from = periodStart(filters.period);
  if (from) query.set('from', from);
  if (filters.search) query.set('q', filters.search);
  return query;
}

export async function listDistributions(
  http: HttpClient,
  filters: DistributionFilters,
  offset: number,
  signal?: AbortSignal,
): Promise<DistributionLine[]> {
  const query = filterQuery(filters);
  query.set('limit', String(DISTRIBUTION_PAGE_SIZE));
  if (offset > 0) query.set('offset', String(offset));
  return parseList(
    distributionLineSchema,
    await http.get(`/orders/hotspot-deliveries?${query}`, { signal }),
    'hotspot deliveries',
  );
}

export async function getDistributionSummary(
  http: HttpClient,
  filters: DistributionFilters,
  signal?: AbortSignal,
): Promise<DistributionSummary> {
  const query = filterQuery(filters).toString();
  return parseBody(
    summarySchema,
    await http.get(`/orders/hotspot-deliveries/summary${query ? `?${query}` : ''}`, { signal }),
    'distribution totals',
  );
}

/** The shipment statuses: on the way, or received by the district. */
export type ShipmentStatus = 'dispatched' | 'received';

export interface ShipmentFilters {
  districtId: string | null;
  warehouseId: string | null;
  status: ShipmentStatus | null;
  search: string;
}

export async function listShipments(
  http: HttpClient,
  filters: ShipmentFilters,
  offset: number,
  signal?: AbortSignal,
): Promise<Order[]> {
  const query = new URLSearchParams({
    type: 'warehouse_request',
    status: filters.status ?? 'dispatched,received',
    limit: String(DISTRIBUTION_PAGE_SIZE),
  });
  if (filters.districtId) query.set('district_id', filters.districtId);
  if (filters.warehouseId) query.set('warehouse_store_id', filters.warehouseId);
  if (filters.search) query.set('q', filters.search);
  if (offset > 0) query.set('offset', String(offset));
  return parseList(orderSchema, await http.get(`/orders?${query}`, { signal }), 'shipments');
}

export const distributionKeys = {
  all: ['distribution'] as const,
  lines: (filters: DistributionFilters) => ['distribution', 'lines', filters] as const,
  summary: (filters: DistributionFilters) => ['distribution', 'summary', filters] as const,
  shipments: (filters: ShipmentFilters) => ['distribution', 'shipments', filters] as const,
};

/** A short page is the last one; the API gives no total. */
const nextOffset = (last: readonly unknown[], pages: readonly unknown[]) =>
  last.length < DISTRIBUTION_PAGE_SIZE ? undefined : pages.length * DISTRIBUTION_PAGE_SIZE;

const pageOf = (pageParam: unknown) => (typeof pageParam === 'number' ? pageParam : 0);

export function useDistributions(filters: DistributionFilters) {
  const http = useHttp();
  // `http` is the provider's one client, so it is not part of the key.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  return useInfiniteQuery<DistributionLine[], ApiError>({
    queryKey: distributionKeys.lines(filters),
    queryFn: ({ pageParam, signal }) => listDistributions(http, filters, pageOf(pageParam), signal),
    initialPageParam: 0,
    getNextPageParam: nextOffset,
  });
}

export function useDistributionSummary(filters: DistributionFilters) {
  return useApiQuery(
    distributionKeys.summary(filters),
    (http, signal) => getDistributionSummary(http, filters, signal),
    { keepPrevious: true },
  );
}

export function useShipments(filters: ShipmentFilters) {
  const http = useHttp();
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  return useInfiniteQuery<Order[], ApiError>({
    queryKey: distributionKeys.shipments(filters),
    queryFn: ({ pageParam, signal }) => listShipments(http, filters, pageOf(pageParam), signal),
    initialPageParam: 0,
    getNextPageParam: nextOffset,
  });
}
