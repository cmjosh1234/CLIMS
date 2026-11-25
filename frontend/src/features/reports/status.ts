import type { Step } from '@/components/StepTracker';
import { formatTimestamp } from '@/lib/format';
import type { StatusTone } from '@/lib/status';

import type { MonthlyReport, ReportLevel } from './api';

interface StatusLabel {
  label: string;
  tone: StatusTone;
}

const monthFormat = new Intl.DateTimeFormat('en-UG', { month: 'long', year: 'numeric' });
const monthOnlyFormat = new Intl.DateTimeFormat('en-UG', { month: 'long' });

function monthDate(period: string): Date | null {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, 1) : null;
}

/** "October 2026" for `2026-10`; the input itself when it is not a period. */
export function periodLabel(period: string): string {
  const date = monthDate(period);
  return date ? monthFormat.format(date) : period;
}

/** "October" for `2026-10`. */
export function monthName(period: string): string {
  const date = monthDate(period);
  return date ? monthOnlyFormat.format(date) : period;
}

/** How many days the month has: the most days a store can have been out of stock. */
export function daysInPeriod(period: string): number {
  const date = monthDate(period);
  return date ? new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate() : 31;
}

export const LEVEL_LABELS: Record<ReportLevel, string> = {
  hotspot: 'Hotspot',
  vht: 'VHT',
  district: 'District',
  warehouse: 'Warehouse',
};

/** Plural, for filters and figures: "Districts". */
export const LEVEL_PLURALS: Record<ReportLevel, string> = {
  hotspot: 'Hotspots',
  vht: 'VHTs',
  district: 'Districts',
  warehouse: 'Warehouses',
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** How the reporter sees the report's status. */
export function reporterStatus(report: Pick<MonthlyReport, 'status'>): StatusLabel {
  switch (report.status) {
    case 'draft':
      return { label: 'Draft', tone: 'info' };
    case 'errors':
      return { label: 'Errors to fix', tone: 'negative' };
    case 'submitted':
      return { label: 'Sent to MOH', tone: 'positive' };
  }
}

/** How MOH sees it: new until someone opens it; anything not sent is not MOH's yet. */
export function mohStatus(report: Pick<MonthlyReport, 'status' | 'reviewed_at'>): StatusLabel {
  if (report.status !== 'submitted') return { label: 'Not sent', tone: 'caution' };
  return report.reviewed_at === null
    ? { label: 'New', tone: 'info' }
    : { label: 'Reviewed', tone: 'positive' };
}

/** "Passed first time", "Passed after 1 correction", "2 errors found", "Not run yet". */
export function validationText(
  report: Pick<MonthlyReport, 'status' | 'errors' | 'validation_runs'>,
): string {
  if (report.status === 'submitted') {
    const corrections = report.validation_runs - 1;
    return corrections <= 0
      ? 'Passed first time'
      : `Passed after ${plural(corrections, 'correction')}`;
  }
  if (report.status === 'errors') return `${plural(report.errors.length, 'error')} found`;
  return 'Not run yet';
}

/** What MOH reads in the validation column for a report that has not been sent. */
export function progressText(report: MonthlyReport): string {
  if (report.status === 'submitted') return validationText(report);
  if (report.status === 'errors') return 'Fixing errors';
  return report.saved_at === null ? 'Not started' : 'Draft in progress';
}

export interface LiveCheck {
  /** Problems found by the check on the page; null until it has been run. */
  problems: number | null;
  isSending: boolean;
}

/**
 * The report's progress: enter the figures, have them checked, fix what the
 * check found (skipped when it found nothing), send.
 */
export function reportSteps(report: MonthlyReport, live: LiveCheck, now = new Date()): Step[] {
  const sent = report.status === 'submitted';
  const runs = report.validation_runs;
  const problems = live.problems ?? (report.status === 'errors' ? report.errors.length : null);
  const checked = sent || live.isSending || problems !== null;
  const hasProblems = !sent && problems !== null && problems > 0;
  const passedClean = (sent && runs <= 1) || (live.isSending && runs === 0);

  return [
    {
      id: 'entry',
      label: 'Data entry',
      state: checked ? 'done' : 'current',
      detail:
        report.saved_at !== null ? `Saved ${formatTimestamp(report.saved_at, now)}` : 'Not started',
    },
    {
      id: 'validation',
      label: 'Data validation',
      state: checked ? 'done' : 'upcoming',
      detail: hasProblems
        ? `${plural(problems, 'error')} found`
        : checked
          ? 'Passed'
          : 'Runs when you send',
    },
    passedClean
      ? { id: 'rectify', label: 'Rectify errors', state: 'skipped', detail: 'No errors found' }
      : {
          id: 'rectify',
          label: 'Rectify errors',
          state: hasProblems
            ? 'attention'
            : runs > 1 || report.status === 'errors'
              ? 'done'
              : 'upcoming',
          detail: hasProblems
            ? `${problems} to fix`
            : runs > 1
              ? plural(runs - 1, 'round')
              : report.status === 'errors'
                ? 'Fixed'
                : 'Only if validation fails',
        },
    {
      id: 'sent',
      label: 'Sent to MOH',
      state: sent ? 'done' : live.isSending ? 'current' : 'upcoming',
      ...(sent
        ? { detail: formatTimestamp(report.submitted_at, now) }
        : live.isSending
          ? { detail: 'Sending…' }
          : {}),
    },
  ];
}

/** The workspaces that have report screens, and where their screens are. */
export type ReportsWorkspace = 'dcfp' | 'warehouse';

const base: Record<ReportsWorkspace, string> = {
  dcfp: '/dcfp/reports',
  warehouse: '/warehouse/reports',
};

export const REPORT_PATHS = {
  list: (workspace: ReportsWorkspace) => base[workspace],
  report: (workspace: ReportsWorkspace, id: string) =>
    `${base[workspace]}/${encodeURIComponent(id)}`,
};
