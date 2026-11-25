import { describe, expect, it, vi } from 'vitest';

import type { HttpClient } from '@/lib/api';

import {
  commentOnHotspot,
  decideOnHotspot,
  getHotspot,
  listAllHotspots,
  listHotspots,
  listHotspotsNear,
} from './api';

function fakeHttp(...bodies: unknown[]) {
  const get = vi.fn();
  for (const body of bodies) get.mockResolvedValueOnce(body);
  return {
    get,
    post: vi.fn().mockResolvedValue({ success: true }),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  } as unknown as HttpClient & { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };
}

const district = '7f2c3c5e-1d4b-4c1a-9a51-2a8f6f0b9e11';
const wire = {
  id: '6f1e2c50-9d8a-4f3b-8c1e-2b7a9d0c4e11',
  name: 'Lake view bar',
  type: 'Guest house',
  village: '',
  region: { id: 'r-1', name: 'Central' },
  district: { id: district, name: 'Wakiso' },
  subcounty: null,
  latitude: 0.31,
  longitude: 32.63,
  has_condom_dispenser: true,
  dispenser_condition: 'Poor',
  status: 'inactive',
  review_status: 'submitted',
  submitted_by_id: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  contact_person: { id: 'c-1', name: 'Okello James', phone_number: '' },
  created_at: '2026-11-19T10:00:00Z',
  updated_at: '2026-11-20T10:00:00Z',
};
const page = (count: number) => ({
  success: true,
  data: Array.from({ length: count }, (_, index) => ({ ...wire, id: `h-${String(index)}` })),
});

describe('listHotspots', () => {
  it('reads the Go API envelope and normalises blanks to null', async () => {
    const http = fakeHttp({ success: true, data: [wire] });

    const [hotspot] = await listHotspots(http);

    expect(http.get).toHaveBeenCalledWith('/hotspots?limit=100', { signal: undefined });
    expect(hotspot).toMatchObject({
      village: null,
      review_status: 'submitted',
      district: { name: 'Wakiso' },
      contact_person: { name: 'Okello James', phone_number: null },
    });
  });

  it('sends the district UUID so the API filters before limiting results', async () => {
    const http = fakeHttp({ success: true, data: [] });
    const signal = new AbortController().signal;

    await listHotspots(http, signal, district);

    expect(http.get).toHaveBeenCalledWith(`/hotspots?limit=100&district_id=${district}`, {
      signal,
    });
  });

  it('refuses a hotspot without a review status', async () => {
    const http = fakeHttp({ success: true, data: [{ ...wire, review_status: 'verified' }] });

    await expect(listHotspots(http)).rejects.toMatchObject({ kind: 'unexpected_response' });
  });
});

describe('listAllHotspots', () => {
  it('pages through a review queue until a short page', async () => {
    const http = fakeHttp(page(100), page(3));

    const { items, complete } = await listAllHotspots(http, { review_status: 'submitted' });

    expect(http.get).toHaveBeenNthCalledWith(
      1,
      '/hotspots?limit=100&offset=0&review_status=submitted',
      { signal: undefined },
    );
    expect(http.get).toHaveBeenNthCalledWith(
      2,
      '/hotspots?limit=100&offset=100&review_status=submitted',
      { signal: undefined },
    );
    expect(items).toHaveLength(100); // the second page repeats the first page's ids
    expect(complete).toBe(true);
  });
});

describe('getHotspot', () => {
  it('reads the hotspot with its comment thread', async () => {
    // The client unwraps the `{ success, data }` envelope before a single record is parsed.
    const http = fakeHttp({
      ...wire,
      comments: [
        {
          id: 'm-1',
          user_id: null,
          action: 'comment',
          comment: 'Busy on Fridays',
          created_at: '2026-11-19T10:00:00Z',
        },
      ],
    });

    const detail = await getHotspot(http, wire.id);

    expect(http.get).toHaveBeenCalledWith(`/hotspots/${wire.id}`, { signal: undefined });
    expect(detail.comments).toEqual([expect.objectContaining({ comment: 'Busy on Fridays' })]);
  });
});

describe('decisions and comments', () => {
  it('posts each with its comment', async () => {
    const http = fakeHttp();

    await decideOnHotspot(http, wire.id, 'activate', 'Visited');
    await decideOnHotspot(http, wire.id, 'reject', 'Duplicate');
    await commentOnHotspot(http, wire.id, 'Which village?');

    expect(http.post).toHaveBeenNthCalledWith(1, `/hotspots/${wire.id}/activate`, {
      comment: 'Visited',
    });
    expect(http.post).toHaveBeenNthCalledWith(2, `/hotspots/${wire.id}/reject`, {
      comment: 'Duplicate',
    });
    expect(http.post).toHaveBeenNthCalledWith(3, `/hotspots/${wire.id}/comments`, {
      comment: 'Which village?',
    });
  });
});

describe('listHotspotsNear', () => {
  it('asks for hotspots within a kilometre of the point, a full page of them', async () => {
    const http = fakeHttp({ success: true, data: [{ ...wire, distance_m: 42.5 }] });

    const [hotspot] = await listHotspotsNear(http, { latitude: 0.4319, longitude: 33.197 });

    expect(http.get).toHaveBeenCalledWith(
      '/hotspots?near_lat=0.4319&near_lng=33.197&radius_m=1000&limit=100',
      { signal: undefined },
    );
    expect(hotspot).toMatchObject({ id: wire.id, review: 'submitted', latitude: 0.31 });
  });
});
