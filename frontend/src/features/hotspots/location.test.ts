import { describe, expect, it } from 'vitest';

import type { HotspotDetail } from './api';
import { checkLocation, frameAround, googleMapsUrl, nearbyOf } from './location';
import { mapHotspotSchema, type PlacedHotspot } from './map/records';

const detail = (latitude: number | null, longitude: number | null): HotspotDetail => ({
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

const at = (id: string, latitude: number | null, longitude: number | null, review = 'active') =>
  mapHotspotSchema.parse({ id, name: id, latitude, longitude, review_status: review });

describe('checkLocation', () => {
  it('places a position in Uganda', () => {
    const check = checkLocation(detail(0.431902, 33.1970468));
    expect(check.kind).toBe('placed');
    expect(check.kind === 'placed' && check.hotspot).toMatchObject({
      id: 'h-target',
      latitude: 0.431902,
      longitude: 33.1970468,
      review: 'submitted',
    });
  });

  it.each([
    ['no coordinates', null, null],
    ['half a position', 0.43, null],
    ['0, 0, which legacy rows use for unknown', 0, 0],
  ])('treats %s as missing', (_, latitude, longitude) => {
    expect(checkLocation(detail(latitude, longitude))).toEqual({ kind: 'missing' });
  });

  it('spots latitude and longitude the wrong way round', () => {
    expect(checkLocation(detail(33.197, 0.4319))).toEqual({
      kind: 'swapped',
      latitude: 33.197,
      longitude: 0.4319,
    });
  });

  it('flags a position outside Uganda', () => {
    expect(checkLocation(detail(37.4221, -122.0839))).toEqual({
      kind: 'outside',
      latitude: 37.4221,
      longitude: -122.0839,
    });
  });
});

describe('nearbyOf', () => {
  const target = at('h-target', 0.4319, 33.197, 'submitted') as PlacedHotspot;

  it('lists the others nearest first and flags those within 100 m as duplicates', () => {
    const { nearby, duplicates } = nearbyOf(target, [
      at('far', 0.4369, 33.197), // about 556 m north
      target,
      at('close', 0.4323, 33.197), // about 44 m north
      at('same', 0.4319, 33.197, 'deactivated'),
      at('unplaced', null, null),
    ]);

    expect(nearby.map(({ hotspot }) => hotspot.id)).toEqual(['same', 'close', 'far']);
    expect(duplicates.map(({ hotspot }) => hotspot.id)).toEqual(['same', 'close']);
    expect(nearby[1]?.km).toBeCloseTo(0.0445, 3);
  });

  it('finds nothing when the hotspot stands alone', () => {
    expect(nearbyOf(target, [target])).toEqual({ nearby: [], duplicates: [] });
  });
});

describe('links and framing', () => {
  it('opens the point in Google Maps', () => {
    expect(googleMapsUrl({ latitude: 0.4319, longitude: 33.197 })).toBe(
      'https://www.google.com/maps/search/?api=1&query=0.4319,33.197',
    );
  });

  it('frames a few hundred metres around the point', () => {
    const frame = frameAround({ latitude: 0.4319, longitude: 33.197 });
    expect(frame.west).toBeLessThan(33.197);
    expect(frame.east).toBeGreaterThan(33.197);
    expect(frame.north - frame.south).toBeCloseTo(0.006, 6);
  });
});
