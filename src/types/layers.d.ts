/**
 * Type definitions for layer management
 */

import type { FeatureCollection } from 'geojson';
import type { BandStats, VectorField } from './tauri';

// Layer types
export type LayerType = 'raster' | 'vector';

// Display modes for raster layers
export type DisplayMode = 'grayscale' | 'rgb' | 'crossLayerRgb';

// Stretch parameters for band visualization
export interface StretchParams {
  min: number;
  max: number;
  gamma: number;
}

// RGB band selection
export interface RgbBands {
  r: number;
  g: number;
  b: number;
}

// RGB stretch parameters (one per channel)
export interface RgbStretchParams {
  r: StretchParams;
  g: StretchParams;
  b: StretchParams;
}

// Cross-layer RGB source configuration
export interface CrossLayerSources {
  r: string; // layer ID
  g: string; // layer ID
  b: string; // layer ID
}

// Base layer interface
export interface BaseLayer {
  id: string;
  type: LayerType;
  path: string;
  fileName: string;
  visible: boolean;
  opacity: number;
  bounds: [number, number, number, number]; // [minX, minY, maxX, maxY]
}

// Raster layer
export interface RasterLayer extends BaseLayer {
  type: 'raster';
  bands: number;
  band: number;
  stretch: StretchParams;
  displayMode: DisplayMode;
  is_georeferenced: boolean;
  rgbBands: RgbBands;
  rgbStretch: RgbStretchParams;
  band_stats: BandStats[];
  width: number;
  height: number;
  datasetId: string;
  // Composition properties
  isComposition?: boolean;
  compositionType?: 'singleLayer' | 'crossLayer';
  sourceLayerId?: string;
  crossLayerSources?: CrossLayerSources;
}

// Vector style options
export interface VectorStyle {
  fillColor: string;
  fillOpacity: number;
  lineColor: string;
  lineWidth: number;
  pointRadius: number;
  pointColor: string;
}

// Categorical color mapping
export interface CategoryColorMap {
  [value: string]: string;
}

// Vector layer
export interface VectorLayer extends BaseLayer {
  type: 'vector';
  geojson: FeatureCollection;
  geometryType: string;
  style: VectorStyle;
  fields: VectorField[];
  featureCount: number;
  colorByField?: string;
  categoryColors?: CategoryColorMap;
}

// Union type for all layers
export type Layer = RasterLayer | VectorLayer;

// Type guard functions
export function isRasterLayer(layer: Layer): layer is RasterLayer {
  return layer.type === 'raster';
}

export function isVectorLayer(layer: Layer): layer is VectorLayer {
  return layer.type === 'vector';
}
