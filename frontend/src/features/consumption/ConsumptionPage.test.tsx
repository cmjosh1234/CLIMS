import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { RecordedRequest } from '@/test/fakeAdapter';
import { testRouter } from '@/test/navigation';
import { renderApp, sessionWith } from '@/test/renderApp';

import ConsumptionPage from './ConsumptionPage';

const envelope = (data: unknown) => ({ status: 200, body: { success: true, data } });
const pieces = (male: number, female: number) => ({ male, female });

const HOTSPOT_SUMMARY = {
  level: 'hotspot',
  period: { from: '2026-11-01', to: '2026-11-25' },
  date_basis: 'Requests raised in the period, with everything delivered against them.',
  data_updated_at: '2026-11-25T09:00:00Z',
  hotspots: {
    requests: 6,
    messages: 9,
    rejected: 1,
    average_days_between: 6.5,
    delivered_pieces: pieces(1500, 400),
    received_pieces: pieces(1450, 400),
    hotspots_requesting: 2,
    silent_hotspots: 12,
  },
  by_district: [],
  monthly: [{ month: '2026-11', requests: 6, received_pieces: pieces(1450, 400) }],
};

const OWINO = {
  id: 'h-owino',
  name: 'Owino Market',
  district_id: 'd-kampala',
  district: 'Kampala',
  subcounty: 'Central',
  last_requested_at: '2026-11-24T08:00:00Z',
  requests: 4,
  messages: 7,
  rejected: 0,
  average_days_between: 6.5,
  delivered_male_pieces: 1200,
  delivered_female_pieces: 400,
  received_male_pieces: 1150,
  received_female_pieces: 400,
};

const DISTRICT_SUMMARY = {
  ...HOTSPOT_SUMMARY,
  level: 'district',
  hotspots: undefined,
  orders: {
    orders: 3,
    rejected: 0,
    average_days_between: 9,
    requested_pieces: pieces(6000, 400),
    approved_pieces: pieces(6000, 400),
    issued_pieces: pieces(6000, 400),
    received_pieces: pieces(5880, 400),
    unconverted: 0,
  },
};

const query = (request: RecordedRequest | undefined) =>
  new URLSearchParams(request?.url.split('?')[1] ?? '');
const lastTo = (requests: RecordedRequest[], path: string) =>
  requests.filter((request) => request.url.split('?')[0] === path).at(-1);

function api(request: RecordedRequest) {
  const path = request.url.split('?')[0];
  const level = query(request).get('level');
  if (path === '/reports/consumption')
    return envelope(level === 'hotspot' ? HOTSPOT_SUMMARY : DISTRICT_SUMMARY);
  if (path === '/reports/consumption/records') return envelope(level === 'hotspot' ? [OWINO] : []);
  if (path === '/catalogue/products') return envelope([]);
  return envelope([]);
}

const MOH = sessionWith(['reports:read', 'orders:all_stores'], ['moh']);

describe('ConsumptionPage', () => {
  it('shows MOH how often hotspots asked and what they received, a row per hotspot', async () => {
    const { requests } = renderApp(<ConsumptionPage workspace="moh" />, {
      route: '/moh/reports',
      session: MOH,
      replies: [api],
    });

    const row = (await screen.findByText('Owino Market')).closest('tr')!;
    expect(within(row).getByText('Kampala · Central')).toBeInTheDocument();
    expect(within(row).getByText('1,150 male · 400 female')).toBeInTheDocument();
    expect(screen.getAllByText('6.5 days')).toHaveLength(2); // the card and the hotspot's row
    expect(screen.getByText('12')).toBeInTheDocument(); // hotspots that did not ask
    const tabs = screen.getByRole('navigation', { name: 'Choose a level' });
    expect(
      within(tabs)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Hotspots', 'Districts', 'Warehouses']);
    expect(query(lastTo(requests, '/reports/consumption')).get('level')).toBe('hotspot');
  });

  it('sends the level, type requested, type sent and product in the address to the server', async () => {
    const { requests } = renderApp(<ConsumptionPage workspace="moh" />, {
      route: '/moh/reports?level=district&requested=female&sent=female&product=p-fc2',
      session: MOH,
      replies: [api],
    });

    expect(await screen.findByText('Pieces issued')).toBeInTheDocument();
    const sent = query(lastTo(requests, '/reports/consumption'));
    expect(sent.get('level')).toBe('district');
    expect(sent.get('requested')).toBe('female');
    expect(sent.get('sent')).toBe('female');
    expect(sent.get('condom_id')).toBe('p-fc2');
  });

  it('searches on the server and keeps the search in the address', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp(<ConsumptionPage workspace="moh" />, {
      route: '/moh/reports',
      session: MOH,
      replies: [api],
    });

    await screen.findByText('Owino Market');
    await user.type(screen.getByPlaceholderText('Search hotspots and places…'), 'Owino');
    await waitFor(() => {
      expect(testRouter.location).toBe('/moh/reports?q=Owino');
    });
    await waitFor(() => {
      expect(query(lastTo(requests, '/reports/consumption/records')).get('q')).toBe('Owino');
    });
  });

  it('gives a district its hotspots only, and a warehouse its districts and itself', async () => {
    renderApp(<ConsumptionPage workspace="dcfp" />, {
      route: '/dcfp/reports',
      session: sessionWith(['reports:read'], ['dfcp']),
      replies: [api],
    });
    await screen.findByText('Owino Market');
    expect(screen.queryByRole('navigation', { name: 'Choose a level' })).not.toBeInTheDocument();
  });

  it('opens a warehouse on its districts', async () => {
    const { requests } = renderApp(<ConsumptionPage workspace="warehouse" />, {
      route: '/warehouse/reports',
      session: sessionWith(['reports:read'], ['nms']),
      replies: [api],
    });
    expect(await screen.findByText('Pieces issued')).toBeInTheDocument();
    expect(query(lastTo(requests, '/reports/consumption')).get('level')).toBe('district');
    const tabs = screen.getByRole('navigation', { name: 'Choose a level' });
    expect(
      within(tabs)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Districts', 'Warehouses']);
  });
});
