/**
 * Shared types, constants, and state for LayerManager
 * @module layer-manager/types
 */

import type { Map as MapLibreMap } from 'maplibre-gl';

// ==================== Shared State ====================

/** Track registered MapLibre protocols globally */
export const registeredProtocols = new Set<string>();

// ==================== Vector Styling ====================

/** Vector layer style configuration */
export interface VectorStyle {
  fillColor: string;
  fillOpacity: number;
  strokeColor: string;
  strokeWidth: number;
  pointRadius: number;
  colorByField?: string | null;
}

/** Default vector style */
export const DEFAULT_VECTOR_STYLE: VectorStyle = {
  fillColor: '#ff0000',
  fillOpacity: 0.5,
  strokeColor: '#ff0000',
  strokeWidth: 3,
  pointRadius: 8,
};

/** Categorical colors for vector styling */
export const CATEGORICAL_COLORS: readonly string[] = [
  '#e41a1c',
  '#377eb8',
  '#4daf4a',
  '#984ea3',
  '#ff7f00',
  '#ffff33',
  '#a65628',
  '#f781bf',
  '#999999',
  '#66c2a5',
] as const;

// ==================== Band Statistics ====================

/** Statistics for a single raster band */
export interface BandStats {
  min: number;
  max: number;
  mean?: number;
  std_dev?: number;
}

// ==================== Stretch Settings ====================

/** Stretch parameters for grayscale display */
export interface StretchSettings {
  min: number;
  max: number;
  gamma: number;
}

/** RGB stretch settings for each channel */
export interface RgbStretchSettings {
  r: StretchSettings;
  g: StretchSettings;
  b: StretchSettings;
}

/** RGB band assignments */
export interface RgbBands {
  r: number;
  g: number;
  b: number;
}

// ==================== Cross-Layer RGB ====================

/** Configuration for cross-layer RGB composition */
export interface CrossLayerRgbConfig {
  rLayerId: string;
  rBand: number;
  gLayerId: string;
  gBand: number;
  bLayerId: string;
  bBand: number;
}

// ==================== Layer Types ====================

/** Display mode for raster layers */
export type DisplayMode = 'grayscale' | 'rgb' | 'crossLayerRgb';

/** Base layer properties shared by all layer types */
interface BaseLayer {
  id: string;
  path: string;
  visible: boolean;
  opacity: number;
  bounds: [number, number, number, number];
  displayName?: string;
}

/** Raster layer data */
export interface RasterLayer extends BaseLayer {
  type: 'raster';
  width: number;
  height: number;
  bands: number;
  band_stats: BandStats[];
  is_georeferenced: boolean;
  displayMode: DisplayMode;
  /** Current band for grayscale display (1-indexed) */
  band: number;
  /** Grayscale stretch settings */
  stretch: StretchSettings;
  /** RGB band assignments */
  rgbBands: RgbBands;
  /** RGB stretch settings */
  rgbStretch: RgbStretchSettings;
  /** Whether this is a composition layer */
  isComposition?: boolean;
  /** Whether this is a cross-layer composition */
  isCrossLayerComposition?: boolean;
  /** Source layer ID for same-layer compositions */
  sourceLayerId?: string;
  /** Cross-layer RGB configuration */
  crossLayerRgb?: CrossLayerRgbConfig;
  /** Pixel scale for non-georeferenced images */
  pixelScale?: number;
  /** Pixel offset for non-georeferenced images */
  pixelOffset?: { x: number; y: number };
}

/** Vector layer field metadata */
export interface VectorField {
  name: string;
  type: string;
}

/** Vector layer data */
export interface VectorLayer extends BaseLayer {
  type: 'vector';
  feature_count: number;
  geometry_type: string;
  fields: VectorField[];
  geojson: GeoJSON.FeatureCollection;
  style: VectorStyle;
}

/** Union type for all layer types */
export type Layer = RasterLayer | VectorLayer;

// ==================== Manager Interfaces ====================

/** Pixel extent for non-georeferenced images */
export interface PixelExtent {
  width: number;
  height: number;
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** MapManager interface for layer operations */
export interface MapManagerInterface {
  map: MapLibreMap;
  addSource: (id: string, source: maplibregl.SourceSpecification) => void;
  addLayer: (layer: maplibregl.LayerSpecification) => void;
  fitBounds: (bounds: maplibregl.LngLatBoundsLike, options?: maplibregl.FitBoundsOptions) => void;
  setBasemap: (type: string) => void;
  isPixelCoordMode: () => boolean;
  setPixelCoordMode: (enabled: boolean, extent: PixelExtent | null) => void;
  pixelExtent: PixelExtent | null;
  setLayerVisibility: (layerId: string, visible: boolean) => void;
}

/** LayerManager interface for use by handlers */
export interface LayerManagerInterface {
  mapManager: MapManagerInterface;
  layers: Map<string, Layer>;
  layerOrder: string[];
  selectedLayerId: string | null;
  popup: maplibregl.Popup | null;
  currentHistogram?: HistogramData | null;
  updateLayerPanel: () => void;
  updateDynamicControls: () => void;
  refreshLayerTiles: (id: string) => void;
  refreshCompositionTiles: (id: string) => void;
}

// ==================== Histogram ====================

/** Histogram data from backend */
export interface HistogramData {
  counts: number[];
  bin_edges: number[];
  min: number;
  max: number;
}

// ==================== Import maplibregl types ====================

import type maplibregl from 'maplibre-gl';
