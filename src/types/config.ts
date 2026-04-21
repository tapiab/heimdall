/**
 * Type definitions for application configuration
 */

// Basemap configuration
export interface BasemapConfig {
  url: string;
  attribution: string;
  name: string;
}

// Basemaps section of config
export interface BasemapsConfig {
  satellite: BasemapConfig;
  custom: BasemapConfig;
}

// STAC catalog entry
export interface StacCatalogEntry {
  url: string;
  name: string;
}

// STAC section of config
export interface StacConfig {
  catalogs: StacCatalogEntry[];
}

// Root configuration object
export interface AppConfig {
  version: string;
  basemaps: BasemapsConfig;
  stac: StacConfig;
}
