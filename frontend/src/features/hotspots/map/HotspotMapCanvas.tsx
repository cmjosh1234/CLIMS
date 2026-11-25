'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import './hotspotMap.css';

import {
  AttributionControl,
  GeolocateControl,
  Map as MapLibre,
  Marker,
  NavigationControl,
  Popup,
  ScaleControl,
  setWorkerUrl,
  type CircleLayerSpecification,
  type ExpressionSpecification,
  type GeoJSONSource,
  type IControl,
  type MapGeoJSONFeature,
  type Offset,
  type PositionAnchor,
  type SymbolLayerSpecification,
} from 'maplibre-gl';
import type { Feature, FeatureCollection, Position } from 'geojson';
import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';

import type { Basemap } from '@/config/env';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

import {
  clusterSize,
  clusterSummary,
  createClusterElement,
  type ClusterSlice,
} from './clusterMarker';
import type { Bounds, ColourBy, MapView } from './filters';
import {
  DISPENSER_CATEGORIES,
  REVIEW_CATEGORIES,
  categoriesFor,
  colourOf,
  type Category,
  type MapPalette,
} from './palette';
import { HOME_ICON_PATHS, PIN_TIP_SHIFT, drawPin, parsePinImageId } from './pins';
import type { PlacedHotspot } from './records';
import { UGANDA_BORDER, UGANDA_BOUNDS } from './uganda';

/*
 * The hotspot map itself: OpenStreetMap raster tiles under the hotspots, drawn
 * with MapLibre GL (WebGL), so twelve thousand points pan smoothly.
 *
 *   clusters  nearby hotspots merge into rings split by category, with the count
 *             inside; a single hotspot is a pin with its venue's glyph
 *   heatmap   where hotspots are dense, turning into pins as you zoom in
 *   points    every hotspot: dots across the country, pins from town level
 *
 * The map stays on Uganda: it cannot be panned far past the border, and
 * everything outside the border is dimmed. The base map is desaturated so the
 * hotspots carry the colour, and inverted in the dark theme. Everything this
 * component knows comes in as props; the page owns the filters and selection.
 */

// MapLibre runs its tiling in a worker. Bundlers cannot follow the URL it builds
// for that file by itself, so the file is named here and shipped as an asset.
let workerConfigured = false;
function configureWorker() {
  if (workerConfigured) return;
  setWorkerUrl(new URL('maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url).href);
  workerConfigured = true;
}

export interface HotspotMapHandle {
  /** Frames `bounds`, not closer than `maxZoom`. */
  fitTo: (bounds: Bounds, maxZoom?: number) => void;
  /** Centres on a point, zooming in to at least `zoom`. */
  flyTo: (point: { latitude: number; longitude: number }, zoom?: number) => void;
}

interface HotspotMapCanvasProps {
  /** Not `ref`: `next/dynamic` wrappers may keep `ref` for themselves. */
  handleRef?: Ref<HotspotMapHandle>;
  /** `null` draws the hotspots on a plain background. */
  basemap: Basemap | null;
  dark: boolean;
  palette: MapPalette;
  view: MapView;
  colourBy: ColourBy;
  hotspots: readonly PlacedHotspot[];
  selected: PlacedHotspot | null;
  /** A hotspot pointed at in the list, raised on the map. */
  highlightedId: string | null;
  initialBounds: Bounds;
  /** The words shown when the pointer rests on a hotspot. */
  describe: (id: string) => { title: string; detail: string } | null;
  onSelect: (id: string | null) => void;
  onViewportChange: (bounds: Bounds) => void;
  /** The map could not start, e.g. WebGL is off. */
  onFailure: (error: unknown) => void;
  /** Base map tiles are failing to load (offline, or blocked). */
  onTilesFailing: () => void;
  /** The map has loaded and can be moved. */
  onReady?: () => void;
  /**
   * What to show when a click lands on several hotspots at once (pins on one
   * position, or overlapping): a list to choose from, drawn beside the pin.
   */
  renderStack?: (stack: HotspotStack) => ReactNode;
  /**
   * A small map of one place, such as on a hotspot's page: the home button goes back to
   * `initialBounds` instead of all of Uganda, there is no "my location", and framing
   * leaves only a little room, as there is no style card or key over the map.
   */
  compact?: boolean;
  /** What a screen reader announces for the map. */
  label?: string;
  className?: string;
}

export interface HotspotStack {
  /** Every hotspot under the click, topmost first. */
  ids: readonly string[];
  /** All recorded at exactly the same position, so zooming in will not part them. */
  samePlace: boolean;
  /** Closes the list. Focus goes back to the map unless `restoreFocus` is false. */
  close: (restoreFocus?: boolean) => void;
}

const SOURCE = 'hotspots';
const FLAT_SOURCE = 'hotspots-flat';
const FOCUS_SOURCE = 'focus';
const UGANDA_SOURCE = 'uganda';
const BASEMAP = 'basemap';
const LAYERS = {
  ugandaMask: 'uganda-mask',
  ugandaBorder: 'uganda-border',
  heat: 'hotspot-heat',
  flatDots: 'hotspot-dots-flat',
  flatPins: 'hotspot-pins-flat',
  pins: 'hotspot-pins',
  selectedSpot: 'hotspot-selected-spot',
  highlight: 'hotspot-highlight',
  selected: 'hotspot-selected',
} as const;
const POINT_LAYERS = [LAYERS.pins, LAYERS.flatPins, LAYERS.flatDots];
const CLUSTER_MAX_ZOOM = 14;
/** Below this zoom the points style draws dots; from it, pins. */
const PIN_ZOOM = 11;

/** Uganda with room around it: the map cannot be panned or zoomed out past this. */
const MAX_BOUNDS: [[number, number], [number, number]] = [
  [UGANDA_BOUNDS.west - 1.6, UGANDA_BOUNDS.south - 1.5],
  [UGANDA_BOUNDS.east + 1.6, UGANDA_BOUNDS.north + 1.5],
];

/**
 * On a compact map of one hotspot, the hotspots around it are drawn smaller and
 * fainter, so the one being looked at stands out while the others keep their colours.
 */
const NEIGHBOUR_SCALE = 0.75;
const NEIGHBOUR_OPACITY = 0.7;

const reviewKey = (key: string) => `r_${key}`;
const dispenserKey = (key: string) => `d_${key}`;

/** A cluster property per category: how many of its hotspots fall in it. */
const CLUSTER_PROPERTIES = Object.fromEntries([
  ...REVIEW_CATEGORIES.map(({ key }) => [
    reviewKey(key),
    ['+', ['case', ['==', ['get', 'r'], key], 1, 0]],
  ]),
  ...DISPENSER_CATEGORIES.map(({ key }) => [
    dispenserKey(key),
    ['+', ['case', ['==', ['get', 'd'], key], 1, 0]],
  ]),
]) as Record<string, unknown>;

function properties(hotspot: PlacedHotspot) {
  return { id: hotspot.id, r: hotspot.review, d: hotspot.dispenser, v: hotspot.venue };
}

function toFeatures(hotspots: readonly PlacedHotspot[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: hotspots.map((hotspot) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [hotspot.longitude, hotspot.latitude] },
      properties: properties(hotspot),
    })),
  };
}

/** Twice the signed area of a ring: positive when it runs anticlockwise. */
function signedArea(ring: readonly Position[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi = 0, yi = 0] = ring[i] ?? [];
    const [xj = 0, yj = 0] = ring[j] ?? [];
    sum += (xj - xi) * (yj + yi);
  }
  return -sum;
}

/**
 * The world with Uganda cut out of it, to dim everything outside the country,
 * and the border itself. A hole must wind the other way from its outer ring.
 */
function ugandaShapes(): FeatureCollection {
  const border: Position[] = UGANDA_BORDER.map(([x, y]) => [x, y]);
  const [first] = border;
  if (first) border.push(first);
  const hole = signedArea(border) > 0 ? [...border].reverse() : border;
  const world: Position[] = [
    [-180, -85],
    [180, -85],
    [180, 85],
    [-180, 85],
    [-180, -85],
  ];
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [world, hole] },
        properties: { kind: 'mask' },
      },
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: border },
        properties: { kind: 'border' },
      },
    ],
  };
}

function colourExpression(colourBy: ColourBy, palette: MapPalette): ExpressionSpecification {
  const property = colourBy === 'review' ? 'r' : 'd';
  const pairs = categoriesFor(colourBy).flatMap((category) => [
    category.key,
    colourOf(palette, category),
  ]);
  return [
    'match',
    ['get', property],
    ...pairs,
    palette.mutedForeground,
  ] as unknown as ExpressionSpecification;
}

/** `pin|<colour>|<venue>`: the name of the pin image each hotspot needs (see `pins.ts`). */
function pinImage(colourBy: ColourBy, palette: MapPalette): ExpressionSpecification {
  return ['concat', 'pin|', colourExpression(colourBy, palette), '|', ['get', 'v']];
}

function withAlpha(colour: string, alpha: number): string {
  const hex = colour.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return colour;
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return `rgba(${String(r)}, ${String(g)}, ${String(b)}, ${String(alpha)})`;
}

const DOT_RADIUS: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['zoom'],
  5,
  3,
  9,
  4.5,
  13,
  6.5,
];

/** Pins grow a little as you zoom in, from country to street level. */
const pinSize = (scale: number): ExpressionSpecification => [
  'interpolate',
  ['linear'],
  ['zoom'],
  6,
  0.72 * scale,
  11,
  0.85 * scale,
  15,
  1 * scale,
];

function pinLayout(image: ExpressionSpecification, scale = 1): SymbolLayerSpecification['layout'] {
  return {
    'icon-image': image,
    'icon-size': pinSize(scale),
    'icon-anchor': 'bottom',
    'icon-offset': [0, PIN_TIP_SHIFT],
    // Every hotspot is drawn: hiding pins that overlap would hide hotspots.
    'icon-allow-overlap': true,
    'icon-ignore-placement': true,
  };
}

function basemapPaint(dark: boolean) {
  // Dark: invert the light tiles and turn the hues back, so water stays blue.
  return dark
    ? {
        'raster-brightness-min': 0.88,
        'raster-brightness-max': 0.06,
        'raster-hue-rotate': 180,
        'raster-saturation': -0.55,
        'raster-contrast': -0.1,
      }
    : {
        'raster-brightness-min': 0.04,
        'raster-brightness-max': 1,
        'raster-hue-rotate': 0,
        'raster-saturation': -0.6,
        'raster-contrast': -0.08,
      };
}

function applyBasemap(map: MapLibre, basemap: Basemap | null, dark: boolean) {
  if (map.getLayer(BASEMAP)) map.removeLayer(BASEMAP);
  if (map.getSource(BASEMAP)) map.removeSource(BASEMAP);
  if (!basemap) return;
  map.addSource(BASEMAP, {
    type: 'raster',
    tiles: [...basemap.tiles],
    tileSize: 256,
    maxzoom: basemap.maxZoom,
    attribution: basemap.attribution,
  });
  map.addLayer(
    { id: BASEMAP, type: 'raster', source: BASEMAP, paint: basemapPaint(dark) },
    map.getLayer(LAYERS.ugandaMask) ? LAYERS.ugandaMask : undefined,
  );
}

function sliceCounts(
  properties: Record<string, unknown>,
  colourBy: ColourBy,
  palette: MapPalette,
): ClusterSlice[] {
  return categoriesFor(colourBy).map((category: Category<string>) => {
    const name = colourBy === 'review' ? reviewKey(category.key) : dispenserKey(category.key);
    const value = properties[name];
    return {
      category,
      colour: colourOf(palette, category),
      count: typeof value === 'number' ? value : 0,
    };
  });
}

/** A map button that brings the whole country, or the place the map opened on, back into view. */
class HomeControl implements IControl {
  private container: HTMLDivElement | null = null;

  constructor(
    private readonly onClick: () => void,
    private readonly title = 'Show all of Uganda',
  ) {}

  onAdd(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hotspot-map__home';
    button.title = this.title;
    button.setAttribute('aria-label', this.title);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of HOME_ICON_PATHS) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    button.append(svg);
    button.addEventListener('click', this.onClick);
    container.append(button);
    this.container = container;
    return container;
  }

  onRemove(): void {
    this.container?.remove();
    this.container = null;
  }
}

/** Room left around a framed area, clear of the style card, the controls and the key. */
const FRAME_PADDING = { top: 96, right: 56, bottom: 170, left: 40 };
const COMPACT_PADDING = { top: 40, right: 56, bottom: 40, left: 40 };

/**
 * How far a popup stands off a point so it clears what is drawn there, for
 * whichever side MapLibre puts it on: `above` px over the point (a pin's head),
 * `beside` px to either side and `below` px under it.
 */
function clearOf(above: number, beside: number, below: number): Offset {
  const offsets: Record<PositionAnchor, [number, number]> = {
    center: [0, 0],
    top: [0, below],
    'top-left': [beside, below],
    'top-right': [-beside, below],
    bottom: [0, -above],
    'bottom-left': [beside, -above],
    'bottom-right': [-beside, -above],
    left: [beside, -above / 2],
    right: [-beside, -above / 2],
  };
  return offsets;
}
const CLEAR_OF_PIN = clearOf(38, 16, 6);
const CLEAR_OF_DOT = clearOf(10, 10, 10);

/** Each hotspot once, in the order the map returned them (topmost first). */
function distinctIds(features: readonly MapGeoJSONFeature[]): string[] {
  const ids = new Set<string>();
  for (const feature of features) {
    const id: unknown = feature.properties.id;
    if (typeof id === 'string') ids.add(id);
  }
  return [...ids];
}

export default function HotspotMapCanvas({
  handleRef,
  basemap,
  dark,
  palette,
  view,
  colourBy,
  hotspots,
  selected,
  highlightedId,
  initialBounds,
  describe,
  onSelect,
  onViewportChange,
  onFailure,
  onTilesFailing,
  onReady,
  renderStack,
  compact = false,
  label = 'Hotspot map of Uganda. Use the list beside it to browse hotspots by keyboard.',
  className,
}: HotspotMapCanvasProps) {
  const framePadding = compact ? COMPACT_PADDING : FRAME_PADDING;
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibre | null>(null);
  const [ready, setReady] = useState(false);
  // The list for a click on several hotspots, drawn into a MapLibre popup.
  const [stack, setStack] = useState<(HotspotStack & { container: HTMLElement }) | null>(null);
  const closeStack = useRef<(restoreFocus?: boolean) => void>(() => undefined);
  const stackPopupRef = useRef<Popup | null>(null);
  // Cluster rings are DOM elements, rebuilt when the data or colours change.
  const clusters = useRef({
    generation: 0,
    cache: new Map<string, Marker>(),
    onScreen: new Map<string, Marker>(),
  });
  const look = useRef({ view, colourBy, palette });

  const select = useEffectEvent((id: string | null) => {
    onSelect(id);
  });
  const viewportChanged = useEffectEvent((bounds: Bounds) => {
    onViewportChange(bounds);
  });
  const failed = useEffectEvent((error: unknown) => {
    onFailure(error);
  });
  const tilesFailing = useEffectEvent(() => {
    onTilesFailing();
  });
  const loaded = useEffectEvent(() => {
    onReady?.();
  });
  const wordsFor = useEffectEvent((id: string) => describe(id));
  const startingView = useEffectEvent(() => ({ basemap, dark, palette, initialBounds, compact }));

  useImperativeHandle(
    handleRef,
    () => ({
      fitTo: (bounds, maxZoom = 13) => {
        const map = mapRef.current;
        if (!map) return;
        if (bounds.west === bounds.east && bounds.south === bounds.north) {
          map.flyTo({ center: [bounds.west, bounds.south], zoom: Math.min(maxZoom, 15) });
          return;
        }
        map.fitBounds(
          [
            [bounds.west, bounds.south],
            [bounds.east, bounds.north],
          ],
          { padding: framePadding, maxZoom },
        );
      },
      flyTo: (point, zoom = 14) => {
        const map = mapRef.current;
        if (!map) return;
        map.flyTo({
          center: [point.longitude, point.latitude],
          zoom: Math.max(map.getZoom(), zoom),
        });
      },
    }),
    [framePadding],
  );

  // Create the map once; everything else updates it in place.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const start = startingView();
    let map: MapLibre;
    try {
      configureWorker();
      map = new MapLibre({
        container,
        style: {
          version: 8,
          sources: {},
          layers: [
            {
              id: 'background',
              type: 'background',
              paint: { 'background-color': start.palette.muted },
            },
          ],
        },
        bounds: [
          [start.initialBounds.west, start.initialBounds.south],
          [start.initialBounds.east, start.initialBounds.north],
        ],
        fitBoundsOptions: { padding: 24 },
        maxBounds: MAX_BOUNDS,
        maxZoom: 18,
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        renderWorldCopies: false,
        fadeDuration: 150,
      });
    } catch (error) {
      failed(error);
      return;
    }
    mapRef.current = map;
    // One finger pans and two pinch to zoom, on touch screens as with a mouse.
    // Rotation stays off: north is always up on this map.
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();

    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    const home = start.compact ? start.initialBounds : UGANDA_BOUNDS;
    map.addControl(
      new HomeControl(
        () => {
          map.fitBounds(
            [
              [home.west, home.south],
              [home.east, home.north],
            ],
            { padding: start.compact ? 24 : FRAME_PADDING },
          );
        },
        start.compact ? 'Back to this hotspot' : undefined,
      ),
      'top-right',
    );
    if (!start.compact) {
      map.addControl(
        new GeolocateControl({
          positionOptions: { enableHighAccuracy: true, timeout: 10_000 },
          fitBoundsOptions: { maxZoom: 14 },
        }),
        'top-right',
      );
    }
    map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-right');
    map.addControl(new AttributionControl({ compact: true }), 'bottom-right');

    let tileErrors = 0;
    map.on('error', (event) => {
      if ((event as { sourceId?: unknown }).sourceId !== BASEMAP) return;
      tileErrors += 1;
      if (tileErrors === 4) tilesFailing();
    });

    // Pins are drawn the first time a layer asks for one; the name says how.
    map.setMissingStyleImageResolver((id) => {
      const pin = parsePinImageId(id);
      if (!pin || map.hasImage(id)) return;
      const image = drawPin(pin.fill, pin.venue, 2);
      if (image) map.addImage(id, image, { pixelRatio: 2 });
    });

    map.on('load', () => {
      const { colourBy: initialColour, palette: initialPalette } = look.current;
      map.addSource(UGANDA_SOURCE, { type: 'geojson', data: ugandaShapes() });
      map.addLayer({
        id: LAYERS.ugandaMask,
        type: 'fill',
        source: UGANDA_SOURCE,
        filter: ['==', ['get', 'kind'], 'mask'],
        paint: { 'fill-color': initialPalette.background, 'fill-opacity': 0.6 },
      });
      map.addLayer({
        id: LAYERS.ugandaBorder,
        type: 'line',
        source: UGANDA_SOURCE,
        filter: ['==', ['get', 'kind'], 'border'],
        layout: { 'line-join': 'round' },
        paint: {
          'line-color': initialPalette.foreground,
          'line-opacity': 0.4,
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1, 10, 2.5],
        },
      });
      applyBasemap(map, start.basemap, start.dark);

      const empty = toFeatures([]);
      map.addSource(SOURCE, {
        type: 'geojson',
        data: empty,
        cluster: true,
        clusterRadius: 52,
        clusterMaxZoom: CLUSTER_MAX_ZOOM,
        clusterProperties: CLUSTER_PROPERTIES,
      });
      map.addSource(FLAT_SOURCE, { type: 'geojson', data: empty });
      map.addSource(FOCUS_SOURCE, { type: 'geojson', data: empty });

      const image = pinImage(initialColour, initialPalette);
      const dotPaint: CircleLayerSpecification['paint'] = {
        'circle-radius': DOT_RADIUS,
        'circle-color': colourExpression(initialColour, initialPalette),
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, 0.75, 10, 1.25],
        'circle-opacity': start.compact ? NEIGHBOUR_OPACITY : 1,
        'circle-stroke-opacity': start.compact ? NEIGHBOUR_OPACITY : 1,
      };

      map.addLayer({
        id: LAYERS.heat,
        type: 'heatmap',
        source: FLAT_SOURCE,
        maxzoom: 16,
        layout: { visibility: 'none' },
      });
      map.addLayer({
        id: LAYERS.flatDots,
        type: 'circle',
        source: FLAT_SOURCE,
        maxzoom: PIN_ZOOM,
        layout: { visibility: 'none' },
        paint: dotPaint,
      });
      map.addLayer({
        id: LAYERS.flatPins,
        type: 'symbol',
        source: FLAT_SOURCE,
        minzoom: PIN_ZOOM,
        layout: { ...pinLayout(image, start.compact ? NEIGHBOUR_SCALE : 1), visibility: 'none' },
      });
      map.addLayer({
        id: LAYERS.pins,
        type: 'symbol',
        source: SOURCE,
        filter: ['!', ['has', 'point_count']],
        layout: pinLayout(image),
      });
      // The selected hotspot: a soft spot on its exact position under a larger pin.
      map.addLayer({
        id: LAYERS.selectedSpot,
        type: 'circle',
        source: FOCUS_SOURCE,
        filter: ['==', ['get', 'kind'], 'selected'],
        paint: {
          'circle-radius': 9,
          'circle-color': initialPalette.foreground,
          'circle-opacity': 0.18,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': initialPalette.foreground,
          'circle-stroke-opacity': 0.6,
        },
      });
      map.addLayer({
        id: LAYERS.highlight,
        type: 'symbol',
        source: FOCUS_SOURCE,
        filter: ['==', ['get', 'kind'], 'highlight'],
        layout: pinLayout(image, 1.2),
      });
      map.addLayer({
        id: LAYERS.selected,
        type: 'symbol',
        source: FOCUS_SOURCE,
        filter: ['==', ['get', 'kind'], 'selected'],
        layout: pinLayout(image, 1.4),
      });
      setReady(true);
      loaded();
      const bounds = map.getBounds();
      viewportChanged({
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      });
    });

    map.on('moveend', () => {
      const bounds = map.getBounds();
      viewportChanged({
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      });
    });

    // Hover: a hotspot's or a ring's words, written as text (names are user input),
    // above what is pointed at.
    const hover = new Popup({
      closeButton: false,
      closeOnClick: false,
      anchor: 'bottom',
      className: 'hotspot-hover',
      maxWidth: '260px',
    });
    // Several hotspots under one click: the list to choose from (see `renderStack`).
    const stackPopup = new Popup({
      closeButton: false,
      closeOnClick: false,
      focusAfterOpen: false,
      className: 'hotspot-stack',
      maxWidth: '18rem',
    });
    stackPopup.on('close', () => {
      setStack(null);
    });
    stackPopupRef.current = stackPopup;
    const closeList = (restoreFocus = true) => {
      if (!stackPopup.isOpen()) return;
      const hadFocus = stackPopup.getElement().contains(document.activeElement);
      stackPopup.remove();
      if (hadFocus && restoreFocus) map.getCanvas().focus({ preventScroll: true });
    };
    closeStack.current = closeList;

    const showTip = (
      at: [number, number],
      offset: Offset,
      words: { title: string; detail: string; more?: string },
    ) => {
      if (stackPopup.isOpen()) return;
      const body = document.createElement('div');
      const lines: [string, string | undefined][] = [
        ['hotspot-hover__title', words.title],
        ['hotspot-hover__detail', words.detail],
        ['hotspot-hover__more', words.more],
      ];
      for (const [className, text] of lines) {
        if (!text) continue;
        const line = document.createElement('p');
        line.className = className;
        line.textContent = text;
        body.append(line);
      }
      hover.setOffset(offset).setLngLat(at).setDOMContent(body).addTo(map);
    };
    const showHover = (event: {
      features?: MapGeoJSONFeature[];
      lngLat: { lng: number; lat: number };
    }) => {
      const features = event.features ?? [];
      const [feature] = features;
      const id: unknown = feature?.properties.id;
      const words = typeof id === 'string' ? wordsFor(id) : null;
      if (!words || feature?.geometry.type !== 'Point') return;
      map.getCanvas().style.cursor = 'pointer';
      const others = distinctIds(features).length - 1;
      const [lng = event.lngLat.lng, lat = event.lngLat.lat] = feature.geometry.coordinates;
      showTip([lng, lat], feature.layer.id === LAYERS.flatDots ? [0, -8] : [0, -34], {
        ...words,
        more: others > 0 ? `${formatNumber(others)} more here. Click to choose.` : undefined,
      });
    };
    const hideHover = () => {
      map.getCanvas().style.cursor = '';
      hover.remove();
    };
    for (const layer of POINT_LAYERS) {
      map.on('mousemove', layer, showHover);
      map.on('mouseleave', layer, hideHover);
    }
    // A ring can vanish under the pointer as the map moves, without a mouseleave.
    map.on('movestart', hideHover);

    const openStack = (features: readonly MapGeoJSONFeature[], ids: readonly string[]) => {
      const [top] = features;
      if (top?.geometry.type !== 'Point') return;
      const [lng = 0, lat = 0] = top.geometry.coordinates;
      const samePlace = features.every(
        ({ geometry }) =>
          geometry.type === 'Point' &&
          geometry.coordinates[0] === lng &&
          geometry.coordinates[1] === lat,
      );
      hideHover();
      const container = document.createElement('div');
      stackPopup
        .setOffset(top.layer.id === LAYERS.flatDots ? CLEAR_OF_DOT : CLEAR_OF_PIN)
        .setLngLat([lng, lat])
        .setDOMContent(container)
        .addTo(map);
      setStack({ ids, samePlace, container, close: closeList });
    };

    // A click on one hotspot selects it; on several, lists them to choose from;
    // on the map, clears the selection (or only closes the list, if one is open).
    map.on('click', (event) => {
      const listOpen = stackPopup.isOpen();
      closeStack.current(false);
      const target = event.originalEvent.target;
      if (target instanceof Element && target.closest('.hotspot-cluster')) return;
      const visible = POINT_LAYERS.filter((layer) => map.getLayer(layer));
      const features = map.queryRenderedFeatures(event.point, { layers: visible });
      const ids = distinctIds(features);
      const [first] = ids;
      if (!first) {
        if (!listOpen) select(null);
      } else if (ids.length === 1) {
        select(first);
      } else {
        openStack(features, ids);
      }
    });

    // Cluster rings follow the clustered source as it re-tiles on every frame.
    const state = clusters.current;
    const renderClusters = () => {
      if (!map.getSource(SOURCE) || !map.isSourceLoaded(SOURCE)) return;
      const { view: currentView, colourBy: currentColour, palette: currentPalette } = look.current;
      const next = new Map<string, Marker>();
      if (currentView === 'clusters') {
        for (const feature of map.querySourceFeatures(SOURCE)) {
          const properties = feature.properties as Record<string, unknown>;
          const clusterId = properties.cluster_id;
          const total = properties.point_count;
          if (typeof clusterId !== 'number' || typeof total !== 'number') continue;
          const key = `${String(state.generation)}:${String(clusterId)}`;
          if (next.has(key)) continue;
          let marker = state.cache.get(key);
          if (!marker && feature.geometry.type === 'Point') {
            const [lng = 0, lat = 0] = feature.geometry.coordinates;
            const slices = sliceCounts(properties, currentColour, currentPalette);
            const element = createClusterElement(total, slices, currentPalette);
            // Pointed at or reached by Tab, a ring says what it holds.
            const words = clusterSummary(total, slices);
            const showRing = () => {
              showTip([lng, lat], [0, -(clusterSize(total) / 2 + 6)], words);
            };
            element.addEventListener('mouseenter', showRing);
            element.addEventListener('focus', showRing);
            element.addEventListener('mouseleave', hideHover);
            element.addEventListener('blur', hideHover);
            element.addEventListener('click', (click) => {
              click.stopPropagation();
              hideHover();
              const source = map.getSource<GeoJSONSource>(SOURCE);
              void source?.getClusterExpansionZoom(clusterId).then((zoom) => {
                map.easeTo({ center: [lng, lat], zoom: Math.min(zoom, CLUSTER_MAX_ZOOM + 1) });
              });
            });
            // MapLibre places a marker by setting its element's `position` and
            // `transform`. The ring has its own (a hover scale, a transition), so
            // it goes inside a bare wrapper that MapLibre is free to move.
            const anchor = document.createElement('div');
            anchor.append(element);
            marker = new Marker({ element: anchor }).setLngLat([lng, lat]);
            state.cache.set(key, marker);
          }
          if (!marker) continue;
          next.set(key, marker);
          if (!state.onScreen.has(key)) marker.addTo(map);
        }
      }
      for (const [key, marker] of state.onScreen) {
        if (!next.has(key)) marker.remove();
      }
      state.onScreen = next;
    };
    map.on('render', renderClusters);

    return () => {
      for (const marker of state.onScreen.values()) marker.remove();
      state.cache.clear();
      state.onScreen.clear();
      hover.remove();
      stackPopup.remove();
      stackPopupRef.current = null;
      closeStack.current = () => undefined;
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, []);

  /** Forgets every cluster ring, so the next frame draws them afresh. */
  const resetClusters = useEffectEvent(() => {
    const state = clusters.current;
    for (const marker of state.onScreen.values()) marker.remove();
    state.onScreen.clear();
    state.cache.clear();
    state.generation += 1;
    mapRef.current?.triggerRepaint();
  });

  // A list of stacked hotspots goes stale when the filters or the style change.
  useEffect(() => {
    closeStack.current();
  }, [hotspots, view]);

  // The popup opened empty, so MapLibre chose its side without knowing its size.
  // Once the list is drawn: place it again, on the side with room, and move the
  // map just enough that all of it is in view.
  useLayoutEffect(() => {
    const map = mapRef.current;
    const popup = stackPopupRef.current;
    if (!stack || !map || !popup?.isOpen()) return;
    popup.setLngLat(popup.getLngLat());
    const box = popup.getElement().getBoundingClientRect();
    const frame = map.getContainer().getBoundingClientRect();
    const gap = 12;
    const overflow = (start: number, end: number, frameStart: number, frameEnd: number) =>
      end > frameEnd - gap
        ? end - frameEnd + gap
        : start < frameStart + gap
          ? start - frameStart - gap
          : 0;
    const dx = overflow(box.left, box.right, frame.left, frame.right);
    const dy = overflow(box.top, box.bottom, frame.top, frame.bottom);
    if (dx !== 0 || dy !== 0) map.panBy([dx, dy], { duration: 250 });
  }, [stack]);

  // Only the source the current style draws from is fed; the other catches up
  // when the style changes. Each feed re-tiles in the worker.
  const fed = useRef<{ clustered: unknown; flat: unknown }>({ clustered: null, flat: null });
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const sourceId = view === 'clusters' ? SOURCE : FLAT_SOURCE;
    const slot = view === 'clusters' ? 'clustered' : 'flat';
    if (fed.current[slot] === hotspots) return;
    fed.current[slot] = hotspots;
    void map.getSource<GeoJSONSource>(sourceId)?.setData(toFeatures(hotspots));
    if (view === 'clusters') resetClusters();
  }, [ready, hotspots, view]);

  useEffect(() => {
    const map = mapRef.current;
    look.current = { view, colourBy, palette };
    if (!ready || !map) return;
    const image = pinImage(colourBy, palette);
    for (const layer of [LAYERS.pins, LAYERS.flatPins, LAYERS.highlight, LAYERS.selected]) {
      map.setLayoutProperty(layer, 'icon-image', image);
    }
    map.setPaintProperty(LAYERS.flatDots, 'circle-color', colourExpression(colourBy, palette));
    map.setPaintProperty(LAYERS.selectedSpot, 'circle-color', palette.foreground);
    map.setPaintProperty(LAYERS.selectedSpot, 'circle-stroke-color', palette.foreground);
    map.setPaintProperty('background', 'background-color', palette.muted);
    map.setPaintProperty(LAYERS.ugandaMask, 'fill-color', palette.background);
    map.setPaintProperty(LAYERS.ugandaBorder, 'line-color', palette.foreground);
    map.setPaintProperty(LAYERS.heat, 'heatmap-color', [
      'interpolate',
      ['linear'],
      ['heatmap-density'],
      0,
      'rgba(0, 0, 0, 0)',
      0.12,
      withAlpha(palette.heat1, 0.35),
      0.35,
      withAlpha(palette.heat1, 0.75),
      0.6,
      palette.heat2,
      0.82,
      palette.heat3,
      1,
      palette.heat4,
    ]);
    map.setPaintProperty(LAYERS.heat, 'heatmap-radius', [
      'interpolate',
      ['linear'],
      ['zoom'],
      5,
      7,
      9,
      14,
      13,
      26,
    ]);
    map.setPaintProperty(LAYERS.heat, 'heatmap-intensity', [
      'interpolate',
      ['linear'],
      ['zoom'],
      5,
      0.7,
      13,
      2.2,
    ]);
    map.setPaintProperty(LAYERS.heat, 'heatmap-opacity', [
      'interpolate',
      ['linear'],
      ['zoom'],
      11,
      0.85,
      15,
      0.25,
    ]);

    const show = (layer: string, visible: boolean) => {
      map.setLayoutProperty(layer, 'visibility', visible ? 'visible' : 'none');
    };
    show(LAYERS.pins, view === 'clusters');
    show(LAYERS.heat, view === 'heatmap');
    show(LAYERS.flatDots, view === 'points');
    show(LAYERS.flatPins, view !== 'clusters');
    // On the heatmap, pins fade in at town level as the heat fades out.
    map.setPaintProperty(
      LAYERS.flatPins,
      'icon-opacity',
      view === 'heatmap'
        ? ['interpolate', ['linear'], ['zoom'], PIN_ZOOM, 0, PIN_ZOOM + 2, 1]
        : compact
          ? NEIGHBOUR_OPACITY
          : 1,
    );
    resetClusters();
  }, [ready, view, colourBy, palette, compact]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    applyBasemap(map, basemap, dark);
    // The dimmed world is lighter in the dark theme, where the background is near black.
    map.setPaintProperty(LAYERS.ugandaMask, 'fill-opacity', dark ? 0.5 : 0.6);
  }, [ready, basemap, dark]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const features: Feature[] = [];
    const highlighted = highlightedId ? hotspots.find(({ id }) => id === highlightedId) : null;
    if (highlighted && highlighted.id !== selected?.id) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [highlighted.longitude, highlighted.latitude] },
        properties: { ...properties(highlighted), kind: 'highlight' },
      });
    }
    if (selected) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [selected.longitude, selected.latitude] },
        properties: { ...properties(selected), kind: 'selected' },
      });
    }
    void map
      .getSource<GeoJSONSource>(FOCUS_SOURCE)
      ?.setData({ type: 'FeatureCollection', features });
  }, [ready, selected, highlightedId, hotspots]);

  return (
    <>
      <div
        ref={containerRef}
        role="region"
        aria-label={label}
        className={cn('hotspot-map size-full', className)}
      />
      {stack && renderStack
        ? createPortal(
            renderStack({ ids: stack.ids, samePlace: stack.samePlace, close: stack.close }),
            stack.container,
          )
        : null}
    </>
  );
}
