import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { testRouter } from '@/test/navigation';
import { renderApp } from '@/test/renderApp';
import { aReport, aSentReport } from '@/test/reportFixtures';

import ReporterReportsPage from './ReporterReportsPage';

const reports = [
  aReport(),
  aSentReport({ id: 'RPT-2609-WAKISO', period: '2026-09', due_on: '2026-10-20' }),
];

describe('ReporterReportsPage', () => {
  it("asks for the district's own reports and leads with the newest month", async () => {
    const { requests } = renderApp(<ReporterReportsPage workspace="dcfp" level="district" />, {
      route: '/dcfp/reports',
      signedIn: true,
      replies: [{ status: 200, body: reports }],
    });

    expect(
      await screen.findByRole('heading', { name: 'October 2026 · District stock report' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Start report/ })).toHaveAttribute(
      'href',
      '/dcfp/reports/RPT-2610-WAKISO',
    );
    expect(requests[0]?.url).toBe('/monthly-reports/own?level=district');
    const history = screen.getByRole('table', { name: 'Report history' });
    expect(within(history).getByText('Passed first time')).toBeInTheDocument();
  });

  it('keeps the chosen month in the address', async () => {
    const user = userEvent.setup();
    renderApp(<ReporterReportsPage workspace="dcfp" level="district" />, {
      route: '/dcfp/reports',
      signedIn: true,
      replies: [{ status: 200, body: reports }],
    });

    await user.click(await screen.findByRole('combobox', { name: 'Reporting month' }));
    await user.click(await screen.findByRole('option', { name: 'September 2026' }));
    expect(testRouter.location).toBe('/dcfp/reports?month=2026-09');
    expect(
      await screen.findByRole('heading', { name: 'September 2026 · District stock report' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /View report/ })).toBeInTheDocument();
  });

  it('says so when there are no reports yet', async () => {
    renderApp(<ReporterReportsPage workspace="dcfp" level="district" />, {
      route: '/dcfp/reports',
      signedIn: true,
      replies: [{ status: 200, body: [] }],
    });
    expect(await screen.findByText('No reports yet')).toBeInTheDocument();
  });
});
