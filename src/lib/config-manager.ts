/**
 * ConfigManager - Manages application configuration stored in a JSON file
 *
 * Config is stored at ~/.config/heimdall/config.json on all platforms.
 * Uses Rust backend commands for file I/O to avoid Tauri FS scope issues.
 */

import { invoke } from '@tauri-apps/api/core';
import { logger } from './logger';
import type { AppConfig, BasemapConfig, StacCatalogEntry } from '../types/config';

const log = logger.child('ConfigManager');

// Default configuration
const DEFAULT_CONFIG: AppConfig = {
  version: '1.0',
  basemaps: {
    satellite: {
      url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg',
      attribution: 'Sentinel-2 cloudless by EOX - CC BY 4.0',
      name: 'Sentinel-2 Cloudless',
    },
    custom: {
      url: '',
      attribution: '',
      name: 'Custom',
    },
  },
  stac: {
    catalogs: [
      {
        url: 'https://earth-search.aws.element84.com/v1',
        name: 'Earth Search (AWS) - Sentinel-2, Landsat',
      },
      {
        url: 'https://planetarycomputer.microsoft.com/api/stac/v1',
        name: 'Planetary Computer - Landsat, NAIP, more',
      },
    ],
  },
};

export class ConfigManager {
  private config: AppConfig | null;
  private loaded: boolean;

  constructor() {
    this.config = null;
    this.loaded = false;
  }

  /**
   * Initialize the config manager by loading or creating the config file
   */
  async init(): Promise<AppConfig> {
    try {
      const content = await invoke<string>('read_config');

      if (content) {
        const parsed = JSON.parse(content) as Partial<AppConfig>;
        this.config = this.mergeWithDefaults(parsed);
        log.info('Loaded config from ~/.config/heimdall/config.json');
      } else {
        // File doesn't exist — create with defaults
        this.config = structuredClone(DEFAULT_CONFIG);
        await this.save();
        log.info('Created default config at ~/.config/heimdall/config.json');
      }

      this.loaded = true;
      return this.config;
    } catch (error) {
      log.error('Failed to initialize config', { error: String(error) });
      this.config = structuredClone(DEFAULT_CONFIG);
      this.loaded = true;
      return this.config;
    }
  }

  /**
   * Save configuration to file
   */
  async save(): Promise<boolean> {
    try {
      const content = JSON.stringify(this.config, null, 2);
      await invoke('write_config', { content });
      return true;
    } catch (error) {
      log.error('Failed to save config', { error: String(error) });
      return false;
    }
  }

  /**
   * Merge loaded config with defaults to ensure all fields exist
   */
  private mergeWithDefaults(loaded: Partial<AppConfig>): AppConfig {
    const merged = structuredClone(DEFAULT_CONFIG);

    if (loaded.version) {
      merged.version = loaded.version;
    }

    if (loaded.basemaps) {
      if (loaded.basemaps.satellite) {
        merged.basemaps.satellite = {
          ...merged.basemaps.satellite,
          ...loaded.basemaps.satellite,
        };
      }
      if (loaded.basemaps.custom) {
        merged.basemaps.custom = {
          ...merged.basemaps.custom,
          ...loaded.basemaps.custom,
        };
      }
    }

    if (loaded.stac?.catalogs) {
      merged.stac.catalogs = loaded.stac.catalogs;
    }

    return merged;
  }

  /**
   * Get the satellite basemap configuration
   */
  getSatelliteConfig(): BasemapConfig {
    return this.config?.basemaps?.satellite || DEFAULT_CONFIG.basemaps.satellite;
  }

  /**
   * Get the custom basemap configuration
   */
  getCustomConfig(): BasemapConfig {
    return this.config?.basemaps?.custom || DEFAULT_CONFIG.basemaps.custom;
  }

  /**
   * Set the custom basemap URL
   */
  async setCustomBasemap(
    url: string,
    attribution: string = '',
    name: string = 'Custom'
  ): Promise<boolean> {
    if (!this.config) {
      this.config = structuredClone(DEFAULT_CONFIG);
    }

    this.config.basemaps.custom = { url, attribution, name };
    return await this.save();
  }

  /**
   * Check if custom basemap is configured
   */
  hasCustomBasemap(): boolean {
    return !!this.config?.basemaps?.custom?.url;
  }

  /**
   * Get the STAC catalog entries
   */
  getStacCatalogs(): StacCatalogEntry[] {
    return this.config?.stac?.catalogs || DEFAULT_CONFIG.stac.catalogs;
  }

  /**
   * Get the full config object
   */
  getConfig(): AppConfig | null {
    return this.config;
  }

  /**
   * Check if config has been loaded
   */
  isLoaded(): boolean {
    return this.loaded;
  }
}

// Singleton instance
let instance: ConfigManager | null = null;

export function getConfigManager(): ConfigManager {
  if (!instance) {
    instance = new ConfigManager();
  }
  return instance;
}
