import { useInfiniteQuery } from '@tanstack/react-query';
import { z } from 'zod';

import { reportTableSchema, type ReportTable } from '@/features/programme-reports/api';
import {
  parseBody,
  parseList,
  useApiQuery,
  useHttp,
  type ApiError,
  type HttpClient,
} from '@/lib/api';

/*
 * Consumption (docs/modules/reports.md#consumption): CLIMS does not record what hotspots hand out,
 * so it is read from demand and supply. Requests raised in the period count, with everything
 * delivered against them whenever it arrived.
 *
 *   GET /reports/consumption?level=&from=&to=&district_id=&warehouse_store_id=&requested=&sent=&condom_id=
 *   GET /reports/consumption/records?…&q=&limit=&offset=
 *   GET /reports/export/consumption?…&level=
 */

export const LEVELS = ['hotspot', 'district', 'warehouse'] as const;
export type Level = (typeof LEVELS)[number];

export const PAGE_SIZE = 50;

const count = z.number().int().nonnegative();
const pieces = z.object({ male: count, female: count });
const average = z.number().nullable();

const hotspotFigures = z.object({
  requests: count,
  messages: count,
  rejected: count,
  average_days_between: average,
  delivered_pieces: pieces,
  received_pieces: pieces,
});

const orderFigures = z.object({
  orders: count,
  rejected: count,
  average_days_between: average,
  requested_pieces: pieces,
  approved_pieces: pieces,
  issued_pieces: pieces,
  received_pieces: pieces,
  unconverted: count,
});

const reportSchema = z.object({
  level: z.enum(LEVELS),
  period: z.object({ from: z.string(), to: z.string() }),
  date_basis: z.string(),
  data_updated_at: z.string(),
  hotspots: hotspotFigures
    .extend({ hotspots_requesting: count, silent_hotspots: count })
    .optional(),
  by_district: z
    .array(
      hotspotFigures.extend({
        district_id: z.string().nullable(),
        district: z.string().nullable(),
        hotspots_requesting: count,
      }),
    )
    .optional(),
  orders: orderFigures.optional(),
  dispatches_without_order: z
    .looseObject({ dispatches: count, issued_pieces: count, received_pieces: count })
    .optional(),
  monthly: z.array(z.object({ month: z.string(), requests: count, received_pieces: pieces })),
});
export type ConsumptionReport = z.infer<typeof reportSchema>;

/** A row at any level: a hotspot's figures, or a district's or warehouse's orders. */
const recordSchema = z.object({
  id: z.string(),
  name: z.string(),
  district: z.string().nullish(),
  subcounty: z.string().nullish(),
  last_requested_at: z.string().optional(),
  last_ordered_at: z.string().optional(),
  requests: count.optional(),
  messages: count.optional(),
  orders: count.optional(),
  rejected: count,
  average_days_between: average,
  delivered_male_pieces: count.optional(),
  delivered_female_pieces: count.optional(),
  issued_male_pieces: count.optional(),
  issued_female_pieces: count.optional(),
  received_male_pieces: count,
  received_female_pieces: count,
  dispatches_without_order: count.nullish(),
});
export type ConsumptionRecord = z.infer<typeof recordSchema>;

/** The report's parameters, as the API takes them; empty values are left out. */
export type ConsumptionParams = Readonly<Record<string, string>>;

function query(params: ConsumptionParams, extra: Record<string, string> = {}): string {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...params, ...extra }).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (value) out.set(key, value);
  }
  return out.toString();
}

export async function getConsumption(
  http: HttpClient,
  params: ConsumptionParams,
  signal?: AbortSignal,
): Promise<ConsumptionReport> {
  const body = await http.get(`/reports/consumption?${query(params)}`, { signal });
  return parseBody(reportSchema, body, 'consumption report');
}

export async function listConsumption(
  http: HttpClient,
  params: ConsumptionParams,
  offset: number,
  signal?: AbortSignal,
): Promise<ConsumptionRecord[]> {
  const extra: Record<string, string> = { limit: String(PAGE_SIZE) };
  if (offset > 0) extra.offset = String(offset);
  const body = await http.get(`/reports/consumption/records?${query(params, extra)}`, { signal });
  return parseList(recordSchema, body, 'consumption records');
}

export async function getConsumptionTable(
  http: HttpClient,
  params: ConsumptionParams,
  signal?: AbortSignal,
): Promise<ReportTable> {
  const body = await http.get(`/reports/export/consumption?${query(params)}`, { signal });
  return parseBody(reportTableSchema, body, 'consumption table');
}

/** The CSV download's path for the same parameters. */
export function csvPath(params: ConsumptionParams): string {
  return `/reports/export/consumption?${query(params, { format: 'csv' })}`;
}

/* Queries. */

const keys = {
  summary: (params: ConsumptionParams) => ['consumption', 'summary', params] as const,
  records: (params: ConsumptionParams) => ['consumption', 'records', params] as const,
  table: (params: ConsumptionParams) => ['consumption', 'table', params] as const,
};

export function useConsumption(params: ConsumptionParams) {
  return useApiQuery(keys.summary(params), (http, signal) => getConsumption(http, params, signal));
}

/** The rows a page at a time; `params` includes the search. */
export function useConsumptionRecords(params: ConsumptionParams) {
  const http = useHttp();
  // `http` is the provider's one client, so it is not part of the key.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  return useInfiniteQuery<ConsumptionRecord[], ApiError>({
    queryKey: keys.records(params),
    queryFn: ({ pageParam, signal }) =>
      listConsumption(http, params, typeof pageParam === 'number' ? pageParam : 0, signal),
    initialPageParam: 0,
    getNextPageParam: (last, pages) =>
      last.length < PAGE_SIZE ? undefined : pages.length * PAGE_SIZE,
  });
}

/** The export table, for the Excel and CSV downloads. */
export function useConsumptionTable(params: ConsumptionParams) {
  return useApiQuery(keys.table(params), (http, signal) =>
    getConsumptionTable(http, params, signal),
  );
}
