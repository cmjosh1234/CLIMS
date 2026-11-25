import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { RecordedRequest } from '@/test/fakeAdapter';
import { testRouter } from '@/test/navigation';
import { renderApp, sessionWith } from '@/test/renderApp';

import { HOTSPOT_PAGE_SIZE } from './api';
import NationalHotspotsPage from './NationalHotspotsPage';

/* MOH's national hotspot list pages, filters and searches on the server. */

const MOH = sessionWith(['hotspots:read', 'hotspots:all_districts'], ['moh']);
const ADMIN = sessionWith(
  ['hotspots:read', 'hotspots:all_districts', 'hotspots:activate'],
  ['admin'],
);

const hotspot = (id: string, extra: object = {}) => ({
  id,
  name: 'Lake view bar',
  type: 'Bar',
  village: 'Seja',
  region: { id: 'region-1', name: 'Central' },
  district: { id: 'district-1', name: 'Buvuma' },
  subcounty: { id: 'subcounty-1', name: 'Nairambi' },
  latitude: null,
  longitude: null,
  has_condom_dispenser: true,
  dispenser_condition: 'Good',
  status: 'active',
  review_status: 'active',
  submitted_by_id: null,
  contact_person: { id: 'contact-1', name: 'Okello James', phone_number: '+256772000000' },
  created_at: '2026-11-19T10:00:00Z',
  updated_at: '2026-11-19T10:00:00Z',
  ...extra,
});

const query = (request: RecordedRequest | undefined) =>
  new URLSearchParams(request?.url.split('?')[1] ?? '');
const lastList = (requests: RecordedRequest[]) =>
  requests.filter((request) => request.url.split('?')[0] === '/hotspots').at(-1);

function api(items: object[]) {
  return (request: RecordedRequest) =>
    request.url.split('?')[0] === '/hotspots'
      ? {
          status: 200,
          body: { success: true, data: query(request).get('offset') ? [] : items },
        }
      : { status: 200, body: { success: true, data: [] } };
}

describe('NationalHotspotsPage', () => {
  it('reads a page of every district’s hotspots, each linking to its MOH record', async () => {
    const { requests } = renderApp(<NationalHotspotsPage />, {
      route: '/moh/hotspots',
      session: MOH,
      replies: [api([hotspot('h1')])],
    });

    expect(await screen.findByRole('link', { name: 'Lake view bar' })).toHaveAttribute(
      'href',
      '/moh/hotspots/h1',
    );
    const row = screen.getByRole('link', { name: 'Lake view bar' }).closest('tr')!;
    expect(within(row).getByText('Buvuma')).toBeInTheDocument();
    const sent = query(lastList(requests));
    expect(sent.get('limit')).toBe(String(HOTSPOT_PAGE_SIZE));
    expect(sent.get('review_status')).toBeNull();
    expect(sent.get('q')).toBeNull();
    // Reading is all MOH may do.
    expect(screen.queryByRole('button', { name: /actions for/i })).not.toBeInTheDocument();
  });

  it('sends the review tab and the search to the server', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp(<NationalHotspotsPage />, {
      route: '/moh/hotspots?review=submitted',
      session: MOH,
      replies: [api([hotspot('h1', { review_status: 'submitted', status: 'inactive' })])],
    });

    await screen.findByRole('link', { name: 'Lake view bar' });
    expect(query(lastList(requests)).get('review_status')).toBe('submitted');

    await user.type(screen.getByPlaceholderText('Search hotspots, places, managers…'), 'seja');
    await waitFor(() => {
      expect(testRouter.location).toBe('/moh/hotspots?review=submitted&q=seja');
    });
    await waitFor(() => {
      expect(query(lastList(requests)).get('q')).toBe('seja');
    });
  });

  it('offers the review decisions to someone who may take them', async () => {
    renderApp(<NationalHotspotsPage />, {
      route: '/moh/hotspots',
      session: ADMIN,
      replies: [api([hotspot('h1')])],
    });

    expect(
      await screen.findByRole('button', { name: 'Actions for Lake view bar' }),
    ).toBeInTheDocument();
  });

  it('reads the next page on request', async () => {
    const user = userEvent.setup();
    const page = Array.from({ length: HOTSPOT_PAGE_SIZE }, (_, n) => hotspot(`h-${String(n)}`));
    const { requests } = renderApp(<NationalHotspotsPage />, {
      route: '/moh/hotspots',
      session: MOH,
      replies: [api(page)],
    });

    await user.click(await screen.findByRole('button', { name: 'Load more hotspots' }));
    await waitFor(() => {
      expect(query(lastList(requests)).get('offset')).toBe(String(HOTSPOT_PAGE_SIZE));
    });
  });

  it('says when nothing matches', async () => {
    renderApp(<NationalHotspotsPage />, {
      route: '/moh/hotspots?q=nowhere',
      session: MOH,
      replies: [api([])],
    });

    expect(await screen.findByText('No hotspots match')).toBeInTheDocument();
  });
});
