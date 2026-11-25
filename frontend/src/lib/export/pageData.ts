import { csvCell, downloadName, saveBlob } from './download';
import { exportFileName, toExportCell } from './excel';

/** One cell of a table read from the page: numbers stay numbers in the files. */
export type PageCell = string | number | null;

/** A table read from the page: a chart's data, a list, or the headline figures. */
export interface PageTable {
  title: string;
  columns: readonly string[];
  rows: readonly (readonly PageCell[])[];
}

/** What a page's CSV and Excel downloads hold. */
export interface PageData {
  title: string;
  subtitle?: string;
  /** The period, filters and anything else that says what the figures cover. */
  meta: readonly (readonly [string, string])[];
  tables: readonly PageTable[];
}

export interface PageKpi {
  label: string;
  value: string;
  detail?: string;
}

/** The period and filter chips `FilterBar` shows, as every report download lists them. */
export function readFilters(root: ParentNode = document): [string, string][] {
  const filters: [string, string][] = [];
  const period = root.querySelector<HTMLElement>('[data-filter-period]')?.dataset.filterPeriod;
  if (period) filters.push(['Period', period]);
  const chips = [...root.querySelectorAll<HTMLElement>('[data-filter-chip]')]
    .filter((node) => node.dataset.filterChip !== 'Period')
    .map((node) => `${node.dataset.filterChip}: ${node.dataset.filterValue ?? ''}`);
  filters.push(['Filters', chips.length > 0 ? chips.join(' · ') : 'None (everything you can see)']);
  return filters;
}

/** The headline figures inside `target` (`StatCard` marks itself `data-kpi` once loaded). */
export function readKpis(target: ParentNode): PageKpi[] {
  return [...target.querySelectorAll<HTMLElement>('[data-kpi]')]
    .map((node) => ({
      label: node.dataset.kpiLabel ?? '',
      value: node.dataset.kpiValue ?? '',
      detail: node.dataset.kpiDetail || undefined,
    }))
    .filter((kpi) => kpi.value);
}

function parseTable(text: string | undefined): PageTable | null {
  try {
    const table = JSON.parse(text ?? '') as Partial<PageTable>;
    return typeof table.title === 'string' &&
      Array.isArray(table.columns) &&
      Array.isArray(table.rows)
      ? (table as PageTable)
      : null;
  } catch {
    return null;
  }
}

/**
 * Everything inside `target` a spreadsheet can hold, in page order: the headline figures as one
 * table, then each list (`data-pdf-table`, e.g. a watch list) and each chart's or table's data
 * (`data-export-table`, which `ChartCard` sets once its figures load).
 */
export function collectPageData(target: HTMLElement, title: string, subtitle?: string): PageData {
  const kpis = readKpis(target);
  const tables: PageTable[] = [];
  if (kpis.length > 0) {
    tables.push({
      title: 'Headline figures',
      columns: ['Figure', 'Value', 'Detail'],
      rows: kpis.map((kpi) => [kpi.label, kpi.value, kpi.detail ?? null]),
    });
  }
  for (const node of target.querySelectorAll<HTMLElement>(
    '[data-export-table], [data-pdf-table]',
  )) {
    const table = parseTable(node.dataset.exportTable ?? node.dataset.pdfTable);
    if (table) tables.push(table);
  }
  return { title, subtitle, meta: readFilters(), tables };
}

const BOM = String.fromCharCode(0xfeff);

/**
 * One CSV file for the whole page: the title and what it covers, then each table under its own
 * title, separated by a blank line. Excel and LibreOffice open it as a single sheet.
 */
export function toPageCsv(data: PageData, generatedAt: Date): string {
  const lines: (readonly PageCell[])[] = [
    [data.title],
    ...(data.subtitle ? [[data.subtitle]] : []),
    ...data.meta.map(([label, value]) => [label, value]),
    ['Generated', formatGenerated(generatedAt)],
  ];
  for (const table of data.tables) {
    lines.push([], [table.title], table.columns, ...table.rows);
  }
  return `${BOM}${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** Characters a worksheet name cannot hold. */
const SHEET_FORBIDDEN = /[\\/?*[\]:]/g;

/**
 * A worksheet name for `title`: at most 31 characters, none Excel refuses, and not one already in
 * `used` (compared without case, as Excel does). "History" is reserved by Excel.
 */
export function sheetName(title: string, used: Set<string>): string {
  const clean = title.replace(SHEET_FORBIDDEN, ' ').replace(/\s+/g, ' ').trim() || 'Sheet';
  const base = clean.toLowerCase() === 'history' ? 'History data' : clean;
  let name = base.slice(0, 31).trim();
  for (let n = 2; used.has(name.toLowerCase()); n += 1) {
    const suffix = ` (${n})`;
    name = `${base.slice(0, 31 - suffix.length).trim()}${suffix}`;
  }
  used.add(name.toLowerCase());
  return name;
}

const bold = (value: string) => ({ value, type: String, fontWeight: 'bold' as const });

/** The sheets of a page's workbook: one per table, then "About" with what the figures cover. */
export function pageSheets(data: PageData, generatedAt: Date) {
  const used = new Set<string>(['about']);
  const sheets = data.tables.map((table) => ({
    sheet: sheetName(table.title, used),
    data: [
      table.columns.map(bold),
      ...table.rows.map((row) => row.map((cell) => toExportCell(cell))),
    ],
  }));
  const about: [string, string][] = [
    ['Report', data.title],
    ...(data.subtitle ? [['About', data.subtitle] as [string, string]] : []),
    ...data.meta.map(([label, value]): [string, string] => [label, value]),
    ['Generated', formatGenerated(generatedAt)],
  ];
  return [
    ...sheets,
    {
      sheet: 'About',
      data: about.map(([label, value]) => [bold(label), { value, type: String }]),
      columns: [{ width: 16 }, { width: 100 }],
    },
  ];
}

function formatGenerated(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Kampala',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function downloadPageCsv(data: PageData, generatedAt: Date = new Date()): void {
  saveBlob(
    new Blob([toPageCsv(data, generatedAt)], { type: 'text/csv;charset=utf-8' }),
    downloadName(data.title, 'csv', generatedAt),
  );
}

/** Saves the page as .xlsx; the writer loads only when someone downloads. */
export async function downloadPageExcel(
  data: PageData,
  generatedAt: Date = new Date(),
): Promise<void> {
  const { default: writeExcelFile } = await import('write-excel-file/browser');
  await writeExcelFile(pageSheets(data, generatedAt)).toFile(
    exportFileName(data.title, generatedAt),
  );
}
