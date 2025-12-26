/**
 * ConfigManager - Manages application configuration stored in a JSON file
 */

import { readTextFile, writeTextFile, mkdir, exists } from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';
import { logger } from './logger';
import type { AppConfig, BasemapConfig } from '../types/config';

const log = logger.child('ConfigManager');

const CONFIG_FILENAME = 'config.json';

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
};

export class ConfigManager {
  private config: AppConfig | null;
  private configPath: string | null;
  private loaded: boolean;

  constructor() {
    this.config = null;
    this.configPath = null;
    this.loaded = false;
  }

  /**
   * Initialize the config manager by loading or creating the config file
   */
  async init(): Promise<AppConfig> {
    try {
      const dataDir = await appDataDir();
      this.configPath = await join(dataDir, CONFIG_FILENAME);

      // Check if config file exists
      const configExists = await exists(this.configPath);

      if (configExists) {
        await this.load();
      } else {
        // Create default config
        this.config = structuredClone(DEFAULT_CONFIG);
        await this.ensureDataDir(dataDir);
        await this.save();
        log.info('Created default config file');
      }

      this.loaded = true;
      return this.config!;
    } catch (error) {
      log.error('Failed to initialize config', { error: String(error) });
      // Fall back to default config in memory
      this.config = structuredClone(DEFAULT_CONFIG);
      this.loaded = true;
      return this.config;
    }
  }

  /**
   * Ensure the app data directory exists
   */
  private async ensureDataDir(dataDir: string): Promise<void> {
    try {
      const dirExists = await exists(dataDir);
      if (!dirExists) {
        await mkdir(dataDir, { recursive: true });
      }
    } catch (error) {
      log.warn('Could not create data directory', { error: String(error) });
    }
  }

  /**
   * Load configuration from file
   */
  private async load(): Promise<void> {
    try {
      const content = await readTextFile(this.configPath!);
      const parsed = JSON.parse(content) as Partial<AppConfig>;

      // Merge with defaults to ensure all fields exist
      this.config = this.mergeWithDefaults(parsed);
      log.info('Loaded config from file');
    } catch (error) {
      log.error('Failed to load config', { error: String(error) });
      this.config = structuredClone(DEFAULT_CONFIG);
    }
  }

  /**
   * Save configuration to file
   */
  async save(): Promise<boolean> {
    if (!this.configPath) {
      log.warn('Config path not set, cannot save');
      return false;
    }

    try {
      const content = JSON.stringify(this.config, null, 2);
      await writeTextFile(this.configPath, content);
      log.info('Saved config to file');
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
    return !!(this.config?.basemaps?.custom?.url);
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
