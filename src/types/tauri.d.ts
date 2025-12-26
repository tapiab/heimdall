/**
 * Type definitions for Tauri command interfaces
 * These types define the contract between frontend and backend
 */

import type { FeatureCollection } from 'geojson';

// Band statistics
export interface BandStats {
  min: number;
  max: number;
  mean: number;
  std_dev: number;
}

// Histogram data
export interface HistogramData {
  band: number;
  min: number;
  max: number;
  bin_count: number;
  counts: number[];
  bin_edges: number[];
}

// Raster metadata returned from open_raster command
export interface RasterMetadata {
  id: string;
  path: string;
  width: number;
  height: number;
  bands: number;
  bounds: [number, number, number, number]; // [minX, minY, maxX, maxY] in EPSG:4326
  native_bounds: [number, number, number, number];
  projection: string;
  pixel_size: [number, number];
  nodata?: number;
  band_stats: BandStats[];
  is_georeferenced: boolean;
}

// Vector field definition
export interface VectorField {
  name: string;
  field_type: string;
}

// Vector metadata
export interface VectorMetadata {
  id: string;
  path: string;
  layer_name: string;
  geometry_type: string;
  feature_count: number;
  bounds: [number, number, number, number];
  fields: VectorField[];
}

// Vector layer data returned from open_vector command
export interface VectorLayerData {
  metadata: VectorMetadata;
  geojson: FeatureCollection;
}

// STAC types
export interface StacCollection {
  id: string;
  title?: string;
  description?: string;
}

export interface StacAsset {
  href: string;
  type?: string;
  title?: string;
  roles?: string[];
}

export interface StacItem {
  id: string;
  geometry: GeoJSON.Geometry;
  bbox?: [number, number, number, number];
  properties: Record<string, unknown>;
  assets: Record<string, StacAsset>;
  collection?: string;
}

export interface StacSearchResult {
  type: 'FeatureCollection';
  features: StacItem[];
  context?: {
    returned: number;
    limit: number;
    matched?: number;
  };
}

// Tauri command function signatures
export interface TauriCommands {
  // Raster commands
  open_raster(path: string): Promise<RasterMetadata>;
  close_dataset(id: string): Promise<void>;
  get_tile(
    id: string,
    z: number,
    x: number,
    y: number,
    band: number
  ): Promise<Uint8Array>;
  get_tile_stretched(
    id: string,
    z: number,
    x: number,
    y: number,
    band: number,
    min: number,
    max: number,
    gamma: number
  ): Promise<Uint8Array>;
  get_rgb_tile(
    id: string,
    z: number,
    x: number,
    y: number,
    r: number,
    g: number,
    b: number,
    r_min: number,
    r_max: number,
    r_gamma: number,
    g_min: number,
    g_max: number,
    g_gamma: number,
    b_min: number,
    b_max: number,
    b_gamma: number
  ): Promise<Uint8Array>;
  get_cross_layer_rgb_tile(
    r_id: string,
    g_id: string,
    b_id: string,
    z: number,
    x: number,
    y: number,
    r_band: number,
    g_band: number,
    b_band: number,
    r_min: number,
    r_max: number,
    r_gamma: number,
    g_min: number,
    g_max: number,
    g_gamma: number,
    b_min: number,
    b_max: number,
    b_gamma: number
  ): Promise<Uint8Array>;
  get_pixel_tile(
    id: string,
    z: number,
    x: number,
    y: number,
    band: number,
    min: number,
    max: number,
    gamma: number
  ): Promise<Uint8Array>;
  get_raster_stats(id: string, band: number): Promise<BandStats>;
  get_histogram(id: string, band: number, bin_count: number): Promise<HistogramData>;
  query_pixel_value(id: string, lon: number, lat: number, band: number): Promise<number | null>;
  get_elevation_profile(id: string, coords: [number, number][]): Promise<number[]>;

  // Vector commands
  open_vector(path: string): Promise<VectorLayerData>;

  // STAC commands
  get_stac_collections(api_url: string): Promise<StacCollection[]>;
  search_stac_items(
    api_url: string,
    params: {
      collections?: string[];
      bbox?: [number, number, number, number];
      datetime?: string;
      limit?: number;
    }
  ): Promise<StacSearchResult>;
  open_stac_asset(href: string): Promise<RasterMetadata>;

  // Utility commands
  get_version(): Promise<string>;
}
