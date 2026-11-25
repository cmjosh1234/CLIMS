import { distanceKm } from './map/filters';
import {
  isPlaced,
  mapHotspotSchema,
  positionOf,
  type MapHotspot,
  type PlacedHotspot,
} from './map/records';
import type { HotspotDetail } from './api';

/*
 * What the Location card on a hotspot's page checks before a DCFP decides on it:
 * whether the recorded position can be drawn, and which other hotspots lie close
 * enough to be the same place registered twice.
 */

/** Closer than this, another hotspot is flagged as a possible duplicate. */
export const DUPLICATE_RADIUS_KM = 0.1;

export type LocationCheck =
  | { kind: 'placed'; hotspot: PlacedHotspot }
  | { kind: 'missing' }
  /** Latitude and longitude the wrong way round: reversed, the point is in Uganda. */
  | { kind: 'swapped'; latitude: number; longitude: number }
  | { kind: 'outside'; latitude: number; longitude: number };

export function checkLocation(hotspot: HotspotDetail): LocationCheck {
  const { latitude, longitude } = hotspot;
  const position = positionOf(latitude, longitude);
  if (position.check === 'placed') {
    const placed = mapHotspotSchema.parse(hotspot);
    return isPlaced(placed) ? { kind: 'placed', hotspot: placed } : { kind: 'missing' };
  }
  if (position.check === 'missing' || latitude === null || longitude === null) {
    return { kind: 'missing' };
  }
  return { kind: position.check, latitude, longitude };
}

export interface NearbyHotspot {
  hotspot: PlacedHotspot;
  km: number;
}

/**
 * The hotspots around `target`, nearest first, leaving out the target itself and any
 * that cannot be drawn; `duplicates` are those within DUPLICATE_RADIUS_KM.
 */
export function nearbyOf(
  target: PlacedHotspot,
  candidates: readonly MapHotspot[],
): { nearby: NearbyHotspot[]; duplicates: NearbyHotspot[] } {
  const nearby = candidates
    .filter(isPlaced)
    .filter(({ id }) => id !== target.id)
    .map((hotspot) => ({ hotspot, km: distanceKm(target, hotspot) }))
    .sort((a, b) => a.km - b.km);
  return { nearby, duplicates: nearby.filter(({ km }) => km < DUPLICATE_RADIUS_KM) };
}

/** About 330 m either side of the point: street level on a card-sized map. */
const FRAME_DEGREES = 0.003;

export function frameAround(point: { latitude: number; longitude: number }) {
  return {
    west: point.longitude - FRAME_DEGREES,
    east: point.longitude + FRAME_DEGREES,
    south: point.latitude - FRAME_DEGREES,
    north: point.latitude + FRAME_DEGREES,
  };
}

/** Opens the point in Google Maps, for satellite imagery and street view. */
export function googleMapsUrl(point: { latitude: number; longitude: number }): string {
  return `https://www.google.com/maps/search/?api=1&query=${String(point.latitude)},${String(point.longitude)}`;
}
