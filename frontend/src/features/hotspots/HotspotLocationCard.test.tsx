import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderApp } from '@/test/renderApp';

import type { HotspotDetail } from './api';
import { HotspotLocationCard } from './HotspotLocationCard';

// jsdom has no WebGL; the stub shows which hotspots the map was given.
vi.mock('./map/HotspotMapCanvas', () => ({
  default: function MapStub({ hotspots }: { hotspots: readonly { id: string }[] }) {
    return <div data-testid="hotspot-map">{hotspots.map(({ id }) => id).join(',')}</div>;
  },
}));

const hotspot = (latitude: number | null, longitude: number | null): HotspotDetail => ({
  id: 'h-target',
  name: 'Tourist Bay',
  type: 'Guest house',
  village: null,
  region: null,
  district: { id: 'd-1', name: 'Jinja City' },
  subcounty: null,
  latitude,
  longitude,
  has_condom_dispenser: true,
  dispenser_condition: 'Good',
  status: 'inactive',
  review_status: 'submitted',
  submitted_by_id: null,
  contact_person: null,
  created_at: '2026-11-24T19:14:00Z',
  updated_at: '2026-11-24T19:14:00Z',
  comments: [],
});

const wire = (id: string, name: string, latitude: number, review = 'active') => ({
  id,
  name,
  latitude,
  longitude: 33.197,
  review_status: review,
  status: review === 'active' ? 'active' : 'inactive',
});
const near = (...items: object[]) => ({ status: 200, body: { success: true, data: items } });

describe('HotspotLocationCard', () => {
  it('warns about hotspots within 100 m and draws every nearby one', async () => {
    const { requests } = renderApp(<HotspotLocationCard hotspot={hotspot(0.4319, 33.197)} />, {
      signedIn: true,
      replies: [
        near(
          wire('h-target', 'Tourist Bay', 0.4319, 'submitted'),
          wire('h-close', 'Tourist Bay Lodge', 0.4323),
          wire('h-far', 'Lakeside inn', 0.4369, 'deactivated'),
        ),
      ],
    });

    expect(await screen.findByText(/1 hotspot within 100 m/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Tourist Bay Lodge' })).toHaveAttribute(
      'href',
      '/dcfp/hotspots/h-close',
    );
    expect(screen.getByText(/Active · 40 m/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Lakeside inn' })).not.toBeInTheDocument();
    expect(await screen.findByTestId('hotspot-map')).toHaveTextContent('h-target,h-close,h-far');
    expect(requests[0]?.url).toBe(
      '/hotspots?near_lat=0.4319&near_lng=33.197&radius_m=1000&limit=100',
    );
    expect(screen.getByRole('link', { name: /View on hotspot map/ })).toHaveAttribute(
      'href',
      '/dcfp/hotspot-map?hotspot=h-target',
    );
    expect(screen.getByRole('link', { name: /Open in Google Maps/ })).toHaveAttribute(
      'href',
      'https://www.google.com/maps/search/?api=1&query=0.4319,33.197',
    );
  });

  it('says when nothing is close enough to be a duplicate', async () => {
    renderApp(<HotspotLocationCard hotspot={hotspot(0.4319, 33.197)} />, {
      signedIn: true,
      replies: [near(wire('h-far', 'Lakeside inn', 0.4369))],
    });

    expect(
      await screen.findByText('1 other hotspot within 1 km; none closer than 100 m.'),
    ).toBeInTheDocument();
  });

  it('still shows the map when the nearby check fails', async () => {
    renderApp(<HotspotLocationCard hotspot={hotspot(0.4319, 33.197)} />, {
      signedIn: true,
      replies: [{ status: 500, body: { success: false, message: 'boom' } }],
    });

    expect(await screen.findByText(/Couldn’t check for duplicates nearby/)).toBeInTheDocument();
    expect(screen.getByTestId('hotspot-map')).toHaveTextContent('h-target');
  });

  it('shows no map without a valid location', () => {
    const { requests } = renderApp(<HotspotLocationCard hotspot={hotspot(null, null)} />, {
      signedIn: true,
    });

    expect(screen.getByText(/No valid location recorded/)).toBeInTheDocument();
    expect(screen.queryByTestId('hotspot-map')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Google Maps/ })).not.toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });

  it('flags a position outside Uganda instead of drawing it', () => {
    renderApp(<HotspotLocationCard hotspot={hotspot(37.4221, -122.0839)} />, { signedIn: true });

    expect(screen.getByText('The recorded location is outside Uganda')).toBeInTheDocument();
    expect(screen.queryByTestId('hotspot-map')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /View on hotspot map/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open in Google Maps/ })).toBeInTheDocument();
  });
});
