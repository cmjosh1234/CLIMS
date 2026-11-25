import { useApiQuery } from '@/lib/api';

import {
  getReportTable,
  getSummary,
  type ReportFilters,
  type ReportKind,
  type SummaryKind,
} from './api';

const ROOT = 'programme-reports';
export const programmeReportKeys = {
  all: [ROOT] as const,
  table: (report: ReportKind, filters: ReportFilters) => [ROOT, 'table', report, filters] as const,
  summary: (report: ReportKind, filters: ReportFilters) =>
    [ROOT, 'summary', report, filters] as const,
};

export function useReportTable(report: ReportKind, filters: ReportFilters) {
  return useApiQuery(programmeReportKeys.table(report, filters), (http, signal) =>
    getReportTable(http, report, filters, signal),
  );
}

export function useReportSummary<Kind extends SummaryKind>(report: Kind, filters: ReportFilters) {
  return useApiQuery(programmeReportKeys.summary(report, filters), (http, signal) =>
    getSummary(http, report, filters, signal),
  );
}
