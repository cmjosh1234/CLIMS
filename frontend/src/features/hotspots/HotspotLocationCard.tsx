'use client';

import { ExternalLink, Map as MapIcon, MapPinOff, TriangleAlert, X } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';

import { ErrorState } from '@/components/states/ErrorState';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useAppConfig } from '@/config/ConfigProvider';
import { DCFP_PATHS } from '@/features/dcfp/orders';
import { formatNumber } from '@/lib/format';

import { NEARBY_LIMIT, NEARBY_RADIUS_M, type HotspotDetail } from './api';
import {
  DUPLICATE_RADIUS_KM,
  checkLocation,
  frameAround,
  googleMapsUrl,
  nearbyOf,
  type NearbyHotspot,
} from './location';
import { formatDistance } from './map/filters';
import { hotspotName } from './map/HotspotList';
import { Segmented } from './map/MapToolbar';
import { useIsDarkTheme, useMapPalette } from './map/palette';
import { REVIEW_LABELS } from './map/records';
import { useHotspotsNear } from './queries';

/*
 * Where a hotspot is, for the DCFP verifying it: its pin on a street-level map,
 * the other hotspots within a kilometre, and a warning when one lies so close it
 * may be the same place registered twice. Read-only: a wrong position is raised
 * with the VHT in a comment.
 */

const HotspotMapCanvas = dynamic(() => import('./map/HotspotMapCanvas'), {
  ssr: false,
  loading: () => <Skeleton className="size-full rounded-none" />,
});

export function HotspotLocationCard({ hotspot }: { hotspot: HotspotDetail }) {
  const check = useMemo(() => checkLocation(hotspot), [hotspot]);
  // Where the links open: the pin, or the recorded position when it cannot be drawn.
  const recorded =
    check.kind === 'placed'
      ? { latitude: check.hotspot.latitude, longitude: check.hotspot.longitude }
      : check.kind === 'missing'
        ? null
        : { latitude: check.latitude, longitude: check.longitude };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Location</CardTitle>
        <CardDescription>
          Where the VHT recorded the hotspot, and the hotspots around it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {check.kind === 'placed' ? (
          <PlacedLocation hotspot={hotspot} check={check} />
        ) : check.kind === 'missing' ? (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <MapPinOff aria-hidden="true" className="size-4 shrink-0" />
            No valid location recorded. Ask the VHT for it in a comment.
          </div>
        ) : (
          <Alert variant="warning">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>
              {check.kind === 'swapped'
                ? 'The latitude and longitude look swapped'
                : 'The recorded location is outside Uganda'}
            </AlertTitle>
            <AlertDescription>
              Recorded as {String(check.latitude)}, {String(check.longitude)}.{' '}
              {check.kind === 'swapped'
                ? 'The other way round, it falls in Uganda.'
                : 'Ask the VHT to record it again on site.'}
            </AlertDescription>
          </Alert>
        )}
        <LocationLinks hotspotId={hotspot.id} point={recorded} onMap={check.kind === 'placed'} />
      </CardContent>
    </Card>
  );
}

function PlacedLocation({
  hotspot,
  check,
}: {
  hotspot: HotspotDetail;
  check: Extract<ReturnType<typeof checkLocation>, { kind: 'placed' }>;
}) {
  const target = check.hotspot;
  const point = useMemo(
    () => ({ latitude: target.latitude, longitude: target.longitude }),
    [target.latitude, target.longitude],
  );
  const near = useHotspotsNear(point);
  const { nearby, duplicates } = useMemo(
    () => nearbyOf(target, near.data ?? []),
    [target, near.data],
  );
  const byId = useMemo(() => new Map(nearby.map((entry) => [entry.hotspot.id, entry])), [nearby]);
  const shown = useMemo(() => [target, ...nearby.map(({ hotspot }) => hotspot)], [target, nearby]);

  const { mapTiles } = useAppConfig();
  const basemaps = mapTiles.kind === 'basemaps' ? mapTiles.basemaps : [];
  const [basemapId, setBasemapId] = useState(basemaps[0]?.id ?? 'none');
  const basemap = basemaps.find(({ id }) => id === basemapId) ?? basemaps[0] ?? null;
  const palette = useMapPalette();
  const dark = useIsDarkTheme();
  const [mapFailed, setMapFailed] = useState(false);
  const [tilesFailing, setTilesFailing] = useState(false);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const chosen = chosenId ? (byId.get(chosenId) ?? null) : null;
  const initialBounds = useMemo(() => frameAround(point), [point]);

  const describe = useCallback(
    (id: string) => {
      if (id === target.id) return { title: hotspotName(hotspot), detail: 'This hotspot' };
      const entry = byId.get(id);
      if (!entry) return null;
      return {
        title: hotspotName(entry.hotspot),
        detail: `${REVIEW_LABELS[entry.hotspot.review]} · ${formatDistance(entry.km)} away`,
      };
    },
    [byId, hotspot, target.id],
  );

  return (
    <>
      <NearbySummary
        loading={near.isPending}
        failed={near.isError}
        onRetry={() => void near.refetch()}
        retrying={near.isRefetching}
        nearby={nearby}
        duplicates={duplicates}
        capped={(near.data?.length ?? 0) >= NEARBY_LIMIT}
      />
      <div className="bg-muted relative h-80 overflow-hidden rounded-lg border">
        {mapFailed ? (
          <div className="grid size-full place-items-center p-4">
            <ErrorState
              title="This browser cannot draw the map"
              error={
                new Error(
                  'The map needs WebGL, which is switched off or unavailable here. The coordinates are in the details.',
                )
              }
            />
          </div>
        ) : (
          <HotspotMapCanvas
            compact
            label={`Map of ${hotspotName(hotspot)} and the hotspots within ${formatNumber(NEARBY_RADIUS_M)} metres.`}
            basemap={basemap}
            dark={dark}
            palette={palette}
            view="points"
            colourBy="review"
            hotspots={shown}
            selected={target}
            highlightedId={chosenId}
            initialBounds={initialBounds}
            describe={describe}
            onSelect={(id) => {
              setChosenId(id === target.id ? null : id);
            }}
            onViewportChange={() => undefined}
            onFailure={() => {
              setMapFailed(true);
            }}
            onTilesFailing={() => {
              setTilesFailing(true);
            }}
          />
        )}
        {!mapFailed && basemaps.length > 1 ? (
          <div className="bg-card/95 absolute top-3 left-3 z-10 rounded-lg border p-1 shadow-xs backdrop-blur-sm">
            <Segmented
              label="Base map"
              value={basemap?.id ?? ''}
              options={basemaps.map(({ id, label }) => ({ value: id, label }))}
              onChange={setBasemapId}
            />
          </div>
        ) : null}
        {tilesFailing ? (
          <p className="bg-card/95 absolute right-3 bottom-10 left-3 z-10 rounded-lg border px-3 py-2 text-xs shadow-xs">
            The street map is not loading. The pins are still in the right places.
          </p>
        ) : null}
        {chosen ? (
          <NearbyPanel
            entry={chosen}
            onClose={() => {
              setChosenId(null);
            }}
          />
        ) : null}
      </div>
    </>
  );
}

function NearbySummary({
  loading,
  failed,
  onRetry,
  retrying,
  nearby,
  duplicates,
  capped,
}: {
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  retrying: boolean;
  nearby: readonly NearbyHotspot[];
  duplicates: readonly NearbyHotspot[];
  capped: boolean;
}) {
  if (loading) {
    return (
      <p role="status" className="text-muted-foreground flex items-center gap-2 text-sm">
        <Spinner aria-hidden="true" className="size-4" />
        Checking for nearby hotspots…
      </p>
    );
  }
  if (failed) {
    return (
      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
        <TriangleAlert aria-hidden="true" className="text-warning size-4" />
        Couldn’t check for duplicates nearby.
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0"
          onClick={onRetry}
          disabled={retrying}
        >
          {retrying ? 'Trying again…' : 'Try again'}
        </Button>
      </div>
    );
  }
  if (duplicates.length > 0) {
    return (
      <Alert variant="warning">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>
          {duplicates.length === 1
            ? `1 hotspot within ${String(DUPLICATE_RADIUS_KM * 1000)} m: check it is not the same place`
            : `${formatNumber(duplicates.length)} hotspots within ${String(DUPLICATE_RADIUS_KM * 1000)} m: check none is the same place`}
        </AlertTitle>
        <AlertDescription>
          <ul className="flex flex-col gap-0.5">
            {duplicates.map(({ hotspot, km }) => (
              <li key={hotspot.id}>
                <Link
                  href={DCFP_PATHS.hotspot(hotspot.id)}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {hotspotName(hotspot)}
                </Link>{' '}
                <span className="text-muted-foreground">
                  · {REVIEW_LABELS[hotspot.review]} · {formatDistance(km)}
                </span>
              </li>
            ))}
          </ul>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <p className="text-muted-foreground text-sm">
      {nearby.length === 0
        ? `No other hotspots within ${formatNumber(NEARBY_RADIUS_M / 1000)} km that you can see.`
        : `${capped ? `The nearest ${formatNumber(nearby.length)}` : formatNumber(nearby.length)} other ${nearby.length === 1 ? 'hotspot' : 'hotspots'} within ${formatNumber(NEARBY_RADIUS_M / 1000)} km; none closer than ${String(DUPLICATE_RADIUS_KM * 1000)} m.`}
    </p>
  );
}

function NearbyPanel({ entry, onClose }: { entry: NearbyHotspot; onClose: () => void }) {
  const { hotspot, km } = entry;
  return (
    <div className="bg-card/95 absolute bottom-3 left-3 z-10 flex max-w-[calc(100%-1.5rem)] items-start gap-3 rounded-lg border p-3 text-sm shadow-xs backdrop-blur-sm sm:max-w-72">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-medium">{hotspotName(hotspot)}</span>
        <span className="text-muted-foreground text-xs">
          {REVIEW_LABELS[hotspot.review]} · {formatDistance(km)} away
        </span>
        <Link
          href={DCFP_PATHS.hotspot(hotspot.id)}
          className="text-xs font-medium underline-offset-4 hover:underline"
        >
          Open this hotspot
        </Link>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="-mt-1 -mr-1 size-7 shrink-0"
        aria-label="Close"
        onClick={onClose}
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}

function LocationLinks({
  hotspotId,
  point,
  onMap,
}: {
  hotspotId: string;
  point: { latitude: number; longitude: number } | null;
  onMap: boolean;
}) {
  if (!point) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {onMap ? (
        <Button variant="outline" size="sm" asChild>
          <Link href={DCFP_PATHS.hotspotOnMap(hotspotId)}>
            <MapIcon data-icon="inline-start" aria-hidden="true" />
            View on hotspot map
          </Link>
        </Button>
      ) : null}
      <Button variant="outline" size="sm" asChild>
        <a href={googleMapsUrl(point)} target="_blank" rel="noopener noreferrer">
          <ExternalLink data-icon="inline-start" aria-hidden="true" />
          Open in Google Maps
        </a>
      </Button>
    </div>
  );
}
