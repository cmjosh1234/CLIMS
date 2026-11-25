import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { anOrder, dcfpApi, JMS, NMS } from '@/test/dcfpFixtures';
import type { RecordedRequest } from '@/test/fakeAdapter';
import { testRouter } from '@/test/navigation';
import { renderApp, sessionWith } from '@/test/renderApp';

import { periodStart, type DistributionLine, type DistributionSummary } from './api';
import DistributionPage from './DistributionPage';
import ShipmentsPage from './ShipmentsPage';

/* MOH's Distribution screens read every district, paging and filtering on the server. */

const MOH = sessionWith(['orders:read', 'orders:all_stores'], ['moh']);
const query = (request: RecordedRequest | undefined) =>
  new URLSearchParams(request?.url.split('?')[1] ?? '');
const lastTo = (requests: RecordedRequest[], path: string) =>
  requests
    .filter((request) => request.method === 'GET' && request.url.split('?')[0] === path)
    .at(-1);
const envelope = (data: unknown) => ({ status: 200, body: { success: true, data } });

function aLine(overrides: Partial<DistributionLine> = {}): DistributionLine {
  return {
    id: 'l1',
    delivery_id: 'd1',
    stockout_report_id: 'r1',
    delivered_at: '2026-11-21T09:00:00Z',
    hot_spot_id: 'h1',
    hot_spot: 'Kisenyi Landing',
    village: 'Kisenyi',
    subcounty: 'Central',
    district_id: 'district-kampala',
    district: 'Kampala',
    district_store_id: 'store-kampala',
    district_store: 'Kampala District',
    category: 'female',
    product: 'Orange Free Female',
    unit: 'Box',
    quantity: 4,
    pieces: 400,
    sent_by: 'Grace Nakato',
    rider: 'Moses Kato',
    rider_phone: '0772000111',
    acknowledged_pieces: 380,
    acknowledged_at: '2026-11-21T12:00:00Z',
    ...overrides,
  };
}

const SUMMARY: DistributionSummary = {
  deliveries: 3,
  hotspots: 2,
  pieces: 1_200,
  male_pieces: 800,
  female_pieces: 400,
  acknowledged_pieces: 900,
  unacknowledged_lines: 1,
};

function distributionApi(lines: DistributionLine[], summary: DistributionSummary = SUMMARY) {
  return (request: RecordedRequest) => {
    const [path] = request.url.split('?');
    if (path === '/orders/hotspot-deliveries') return envelope(lines);
    if (path === '/orders/hotspot-deliveries/summary') return envelope(summary);
    return dcfpApi()(request);
  };
}

describe('DistributionPage', () => {
  it('lists each delivery line with what the hotspot confirmed, and totals every match', async () => {
    const { requests } = renderApp(<DistributionPage />, {
      route: '/moh/distribution',
      session: MOH,
      replies: [distributionApi([aLine(), aLine({ id: 'l2', acknowledged_pieces: null })])],
    });

    const link = await screen.findAllByRole('link', { name: 'Kisenyi Landing' });
    expect(link[0]).toHaveAttribute('href', '/moh/orders/r1');
    const rows = within(screen.getByRole('table', { name: 'Hotspot deliveries' })).getAllByRole(
      'row',
    );
    expect(within(rows[1]!).getByText('4 Box')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('· 20 short')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Moses Kato')).toBeInTheDocument();
    expect(screen.getByText('Not confirmed yet')).toBeInTheDocument();

    // The figures come from the summary, so they cover every match, not the rows loaded.
    expect(await screen.findByText('1,200')).toBeInTheDocument();
    expect(screen.getByText('800 male · 400 female')).toBeInTheDocument();
    expect(screen.getByText('75% of the pieces delivered')).toBeInTheDocument();
    expect(screen.getByText('3 deliveries')).toBeInTheDocument();

    // The last 30 days by default.
    const sent = query(lastTo(requests, '/orders/hotspot-deliveries'));
    expect(sent.get('from')).toBe(periodStart('30'));
    expect(sent.get('limit')).toBe('50');
    expect(query(lastTo(requests, '/orders/hotspot-deliveries/summary')).get('from')).toBe(
      periodStart('30'),
    );
  });

  it('sends the category, period and search to the server, and keeps them in the address', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp(<DistributionPage />, {
      route: '/moh/distribution?category=male&period=all',
      session: MOH,
      replies: [distributionApi([aLine({ category: 'male' })])],
    });

    await screen.findAllByRole('link', { name: 'Kisenyi Landing' });
    let sent = query(lastTo(requests, '/orders/hotspot-deliveries'));
    expect(sent.get('category')).toBe('male');
    expect(sent.get('from')).toBeNull();

    await user.type(screen.getByPlaceholderText('Search hotspots, places, products…'), 'kisenyi');
    await waitFor(() => {
      expect(testRouter.location).toBe('/moh/distribution?category=male&period=all&q=kisenyi');
    });
    await waitFor(() => {
      sent = query(lastTo(requests, '/orders/hotspot-deliveries/summary'));
      expect(sent.get('q')).toBe('kisenyi');
    });
    expect(sent.get('category')).toBe('male');
  });

  it('says so when nothing was delivered in the period', async () => {
    renderApp(<DistributionPage />, {
      route: '/moh/distribution',
      session: MOH,
      replies: [
        distributionApi([], {
          ...SUMMARY,
          deliveries: 0,
          hotspots: 0,
          pieces: 0,
          male_pieces: 0,
          female_pieces: 0,
          acknowledged_pieces: 0,
          unacknowledged_lines: 0,
        }),
      ],
    });

    expect(await screen.findByText('No deliveries to hotspots in this period')).toBeInTheDocument();
    expect(await screen.findByText('— of the pieces delivered')).toBeInTheDocument();
  });

  it('shows what failed when the deliveries cannot be read', async () => {
    renderApp(<DistributionPage />, {
      route: '/moh/distribution',
      session: MOH,
      replies: [
        (request: RecordedRequest) =>
          request.url.startsWith('/orders/hotspot-deliveries')
            ? { status: 500, body: { success: false, message: 'boom' } }
            : dcfpApi()(request),
      ],
    });

    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
    // Every figure says it is missing, rather than showing zero.
    expect(screen.getAllByText('Totals could not be loaded')).toHaveLength(4);
  });
});

describe('ShipmentsPage', () => {
  it('asks for the orders that left NMS and JMS, and says what was received', async () => {
    const { requests } = renderApp(<ShipmentsPage />, {
      route: '/moh/distribution/warehouses',
      session: MOH,
      replies: [
        dcfpApi({
          orders: [
            anOrder({
              id: 'o-sent',
              order_status: 'dispatched',
              quantity_issued: 300,
              dispatched_at: '2026-11-21T09:00:00Z',
            }),
            anOrder({
              id: 'o-in',
              order_status: 'received',
              ordered_from_store_id: JMS.id,
              quantity_issued: 300,
              quantity_received: 290,
              unrequested: true,
              dispatched_at: '2026-11-20T09:00:00Z',
              received_at: '2026-11-21T10:00:00Z',
            }),
          ],
        }),
      ],
    });

    const table = await screen.findByRole('table', { name: 'Shipments from NMS and JMS' });
    await waitFor(() => {
      expect(within(table).getByText('Not received yet')).toBeInTheDocument();
    });
    expect(within(table).getByText('· 10 short')).toBeInTheDocument();
    expect(within(table).getByText('Sent without an order')).toBeInTheDocument();
    const sent = query(lastTo(requests, '/orders'));
    expect(sent.get('type')).toBe('warehouse_request');
    expect(sent.get('status')).toBe('dispatched,received');
    expect(sent.get('warehouse_store_id')).toBeNull();
  });

  it('narrows to one warehouse and one status on the server', async () => {
    const { requests } = renderApp(<ShipmentsPage />, {
      route: '/moh/distribution/warehouses?warehouse=nms&status=dispatched',
      session: MOH,
      replies: [dcfpApi({ orders: [anOrder({ order_status: 'dispatched' })] })],
    });

    await screen.findByRole('table', { name: 'Shipments from NMS and JMS' });
    await waitFor(() => {
      expect(query(lastTo(requests, '/orders')).get('warehouse_store_id')).toBe(NMS.id);
    });
    expect(query(lastTo(requests, '/orders')).get('status')).toBe('dispatched');
  });
});
