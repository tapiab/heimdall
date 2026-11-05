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
  georef_method: 'geotransform' | 'rpc' | 'none'; // how pixels are placed on the map
  rpc_default_height?: number | null; // RPC HEIGHT_OFF (m), used when no DEM/override is set
  suggest_overviews?: boolean; // large local raster without overviews
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

/** Catalog type - API with search or static with links */
export type StacCatalogType = 'Api' | 'Static';

/** STAC Catalog metadata */
export interface StacCatalog {
  id: string;
  title?: string;
  description: string;
  type: string;
  stac_version?: string;
  conformsTo?: string[];
  links?: StacLink[];
}

/** Extended catalog info returned from connect */
export interface StacCatalogInfo {
  id: string;
  title?: string;
  description: string;
  catalog_type: StacCatalogType;
  base_url: string;
  links?: StacLink[];
}

/** STAC Link */
export interface StacLink {
  href: string;
  rel: string;
  type?: string;
  title?: string;
}

/** Child entry from a static catalog */
export interface StacChildEntry {
  href: string;
  title?: string;
  entry_type?: string;
}

export interface StacCollection {
  id: string;
  title?: string;
  description?: string;
  links?: StacLink[];
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
  /** Little-endian f32, band-sequential, 256×256 per band, NaN = nodata; empty = no overlap */
  get_raw_tile(
    id: string,
    x: number,
    y: number,
    z: number,
    bands: number[],
    pixel: boolean
  ): Promise<ArrayBuffer>;
  get_raster_stats(id: string, band: number): Promise<BandStats>;
  get_histogram(id: string, band: number, num_bins?: number): Promise<HistogramData>;
  /** Whole-band summary and per-column / per-line series (reads the full band) */
  get_image_statistics(id: string, band: number): Promise<unknown>;
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
