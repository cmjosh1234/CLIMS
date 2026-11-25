import { afterEach, describe, expect, it } from 'vitest';

import { collectPageData, pageSheets, sheetName, toPageCsv, type PageData } from './pageData';

const GENERATED = new Date('2026-11-24T16:05:00Z'); // 19:05 in Kampala

function page(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.querySelector<HTMLElement>('#report')!;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('collectPageData', () => {
  it('reads the figures, lists and charts in page order, with the filters', () => {
    const chart = JSON.stringify({
      title: 'Requests by month',
      columns: ['Month', 'Raised'],
      rows: [['Oct 26', 4]],
    });
    const list = JSON.stringify({
      title: 'What needs watching',
      columns: ['Status', 'What', 'Detail'],
      rows: [['Overdue', 'Wakiso', '3 requests']],
    });
    const target = page(`
      <div data-filter-period="Last 12 months"></div>
      <span data-filter-chip="District" data-filter-value="Wakiso"></span>
      <div id="report">
        <div data-kpi data-kpi-label="Usable stock" data-kpi-value="50,300 pcs" data-kpi-detail="Two stores"></div>
        <div data-kpi data-kpi-label="Loading" data-kpi-value=""></div>
        <ol data-pdf-table='${list}'></ol>
        <section data-visual data-export-table='${chart}'></section>
        <section data-visual></section>
        <div data-export-table="not json"></div>
      </div>
    `);

    const data = collectPageData(target, 'Overview', 'The programme at a glance.');

    expect(data.meta).toEqual([
      ['Period', 'Last 12 months'],
      ['Filters', 'District: Wakiso'],
    ]);
    expect(data.tables.map((table) => table.title)).toEqual([
      'Headline figures',
      'What needs watching',
      'Requests by month',
    ]);
    expect(data.tables[0]?.rows).toEqual([['Usable stock', '50,300 pcs', 'Two stores']]);
  });

  it('has no tables while nothing has loaded', () => {
    const target = page('<div id="report"><section data-visual></section></div>');
    expect(collectPageData(target, 'Overview').tables).toEqual([]);
  });
});

const sample: PageData = {
  title: 'Hotspot coverage',
  subtitle: 'Where the pick points are.',
  meta: [['Filters', 'None (everything you can see)']],
  tables: [
    {
      title: 'By district',
      columns: ['District', 'Active'],
      rows: [
        ['Kampala, Central', 12],
        ['=cmd', null],
      ],
    },
  ],
};

describe('toPageCsv', () => {
  it('stacks each table under its title, after what the figures cover', () => {
    const csv = toPageCsv(sample, GENERATED);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.slice(1).split('\r\n')).toEqual([
      'Hotspot coverage',
      'Where the pick points are.',
      'Filters,None (everything you can see)',
      'Generated,"24 Nov 2026, 19:05"',
      '',
      'By district',
      'District,Active',
      '"Kampala, Central",12',
      "'=cmd,",
      '',
    ]);
  });
});

describe('pageSheets', () => {
  it('puts each table on its own sheet with typed cells, then About', () => {
    const sheets = pageSheets(sample, GENERATED);
    expect(sheets.map((sheet) => sheet.sheet)).toEqual(['By district', 'About']);
    const [table] = sheets;
    expect(table?.data[0]).toEqual([
      { value: 'District', type: String, fontWeight: 'bold' },
      { value: 'Active', type: String, fontWeight: 'bold' },
    ]);
    expect(table?.data[1]).toEqual([
      { value: 'Kampala, Central', type: String },
      { value: 12, type: Number },
    ]);
    // Text that looks like a formula stays text; a blank stays blank.
    expect(table?.data[2]).toEqual([{ value: '=cmd', type: String }, { value: undefined }]);
  });
});

describe('sheetName', () => {
  it('keeps names Excel accepts: short, unique, without reserved characters', () => {
    const used = new Set<string>(['about']);
    expect(sheetName('Stock: NMS / JMS [all]?', used)).toBe('Stock NMS JMS all');
    expect(sheetName('Requests fulfilled within the agreed number of days', used)).toBe(
      'Requests fulfilled within the a',
    );
    expect(sheetName('Requests fulfilled within the agreed number of days', used)).toBe(
      'Requests fulfilled within t (2)',
    );
    expect(sheetName('About', used)).toBe('About (2)');
    expect(sheetName('History', used)).toBe('History data');
    expect(sheetName('???', used)).toBe('Sheet');
  });
});
