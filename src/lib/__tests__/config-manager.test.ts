/**
 * Tests for ConfigManager functionality
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock Tauri plugins
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: vi.fn(),
  readTextFile: vi.fn(),
  mkdir: vi.fn(),
  exists: vi.fn(),
}));

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn(() => Promise.resolve('/mock/app/data')),
  join: vi.fn((...parts) => Promise.resolve(parts.join('/'))),
}));

vi.mock('../logger.js', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

import { writeTextFile, readTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';

// Default config structure for testing
const DEFAULT_CONFIG = {
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

// Create a fresh ConfigManager for each test (not using singleton)
function createTestConfigManager() {
  return {
    config: null,
    configPath: null,
    loaded: false,

    async init() {
      const { appDataDir, join } = await import('@tauri-apps/api/path');
      const dataDir = await appDataDir();
      this.configPath = await join(dataDir, 'config.json');

      const configExists = await exists(this.configPath);

      if (configExists) {
        await this.load();
      } else {
        this.config = structuredClone(DEFAULT_CONFIG);
        await this.ensureDataDir(dataDir);
        await this.save();
      }

      this.loaded = true;
      return this.config;
    },

    async ensureDataDir(dataDir) {
      const dirExists = await exists(dataDir);
      if (!dirExists) {
        await mkdir(dataDir, { recursive: true });
      }
    },

    async load() {
      const content = await readTextFile(this.configPath);
      const parsed = JSON.parse(content);
      this.config = this.mergeWithDefaults(parsed);
    },

    async save() {
      if (!this.configPath) return false;
      const content = JSON.stringify(this.config, null, 2);
      await writeTextFile(this.configPath, content);
      return true;
    },

    mergeWithDefaults(loaded) {
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
    },

    getSatelliteConfig() {
      return this.config?.basemaps?.satellite || DEFAULT_CONFIG.basemaps.satellite;
    },

    getCustomConfig() {
      return this.config?.basemaps?.custom || DEFAULT_CONFIG.basemaps.custom;
    },

    async setCustomBasemap(url, attribution = '', name = 'Custom') {
      if (!this.config) {
        this.config = structuredClone(DEFAULT_CONFIG);
      }
      this.config.basemaps.custom = { url, attribution, name };
      return await this.save();
    },

    hasCustomBasemap() {
      return !!(this.config?.basemaps?.custom?.url);
    },

    getConfig() {
      return this.config;
    },

    isLoaded() {
      return this.loaded;
    },
  };
}

describe('ConfigManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('init', () => {
    it('should create default config when no config file exists', async () => {
      exists.mockResolvedValue(false);
      writeTextFile.mockResolvedValue(undefined);

      const configManager = createTestConfigManager();
      const config = await configManager.init();

      expect(config).toBeDefined();
      expect(config.version).toBe('1.0');
      expect(config.basemaps.satellite.url).toContain('tiles.maps.eox.at');
      expect(writeTextFile).toHaveBeenCalled();
    });

    it('should load existing config file', async () => {
      const existingConfig = {
        version: '1.0',
        basemaps: {
          satellite: {
            url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg',
            attribution: 'Sentinel-2 cloudless by EOX - CC BY 4.0',
            name: 'Sentinel-2 Cloudless',
          },
          custom: {
            url: 'https://custom.example.com/{z}/{x}/{y}.png',
            attribution: 'Custom Attribution',
            name: 'My Custom Map',
          },
        },
      };

      exists.mockResolvedValue(true);
      readTextFile.mockResolvedValue(JSON.stringify(existingConfig));

      const configManager = createTestConfigManager();
      const config = await configManager.init();

      expect(config.basemaps.custom.url).toBe('https://custom.example.com/{z}/{x}/{y}.png');
      expect(config.basemaps.custom.attribution).toBe('Custom Attribution');
    });

    it('should mark as loaded after init', async () => {
      exists.mockResolvedValue(false);
      writeTextFile.mockResolvedValue(undefined);

      const configManager = createTestConfigManager();
      expect(configManager.isLoaded()).toBe(false);

      await configManager.init();

      expect(configManager.isLoaded()).toBe(true);
    });
  });

  describe('getSatelliteConfig', () => {
    it('should return default satellite config', async () => {
      exists.mockResolvedValue(false);
      writeTextFile.mockResolvedValue(undefined);

      const configManager = createTestConfigManager();
      await configManager.init();

      const satelliteConfig = configManager.getSatelliteConfig();

      expect(satelliteConfig.url).toContain('tiles.maps.eox.at');
      expect(satelliteConfig.url).toContain('s2cloudless');
      expect(satelliteConfig.attribution).toContain('Sentinel-2');
      expect(satelliteConfig.attribution).toContain('CC BY 4.0');
    });
  });

  describe('getCustomConfig', () => {
    it('should return empty custom config by default', async () => {
      exists.mockResolvedValue(false);
      writeTextFile.mockResolvedValue(undefined);

      const configManager = createTestConfigManager();
      await configManager.init();

      const customConfig = configManager.getCustomConfig();

      expect(customConfig.url).toBe('');
      expect(customConfig.attribution).toBe('');
    });

    it('should return configured custom basemap', async () => {
      const existingConfig = {
        version: '1.0',
        basemaps: {
          custom: {
            url: 'https://my-tiles.com/{z}/{x}/{y}.png',
            attribution: 'My Tiles',
            name: 'Custom',
          },
        },
      };

      exists.mockResolvedValue(true);
      readTextFile.mockResolvedValue(JSON.stringify(existingConfig));

      const configManager = createTestConfigManager();
      await configManager.init();

      const customConfig = configManager.getCustomConfig();

      expect(customConfig.url).toBe('https://my-tiles.com/{z}/{x}/{y}.png');
      expect(customConfig.attribution).toBe('My Tiles');
    });
  });

  describe('setCustomBasemap', () => {
    it('should save custom basemap configuration', async () => {
      exists.mockResolvedValue(false);
      writeTextFile.mockResolvedValue(undefined);

      const configManager = createTestConfigManager();
      await configManager.init();

      // Clear the mock to only count subsequent calls
      writeTextFile.mockClear();

      const result = await configManager.setCustomBasemap(
        'https://new-tiles.com/{z}/{x}/{y}.png',
        'New Attribution'
      );

      expect(result).toBe(true);
      expect(configManager.config.basemaps.custom.url).toBe(
        'https://new-tiles.com/{z}/{x}/{y}.png'
      );
      expect(configManager.config.basemaps.custom.attribution).toBe('New Attribution');
      expect(writeTextFile).toHaveBeenCalledTimes(1);
    });

    it('should update hasCustomBasemap after setting URL', async () => {
      exists.mockResolvedValue(false);
      writeTextFile.mockResolvedValue(undefined);

      const configManager = createTestConfigManager();
      await configManager.init();

      expect(configManager.hasCustomBasemap()).toBe(false);

      await configManager.setCustomBasemap('https://tiles.example.com/{z}/{x}/{y}.png');

      expect(configManager.hasCustomBasemap()).toBe(true);
    });
  });

  describe('hasCustomBasemap', () => {
    it('should return false when no custom URL is set', async () => {
      exists.mockResolvedValue(false);
      writeTextFile.mockResolvedValue(undefined);

      const configManager = createTestConfigManager();
      await configManager.init();

      expect(configManager.hasCustomBasemap()).toBe(false);
    });

    it('should return true when custom URL is set', async () => {
      const existingConfig = {
        version: '1.0',
        basemaps: {
          custom: {
            url: 'https://tiles.example.com/{z}/{x}/{y}.png',
            attribution: '',
            name: 'Custom',
          },
        },
      };

      exists.mockResolvedValue(true);
      readTextFile.mockResolvedValue(JSON.stringify(existingConfig));

      const configManager = createTestConfigManager();
      await configManager.init();

      expect(configManager.hasCustomBasemap()).toBe(true);
    });
  });

  describe('mergeWithDefaults', () => {
    it('should fill in missing fields from defaults', async () => {
      // Config with only custom basemap set
      const partialConfig = {
        version: '1.0',
        basemaps: {
          custom: {
            url: 'https://custom.com/{z}/{x}/{y}.png',
          },
        },
      };

      exists.mockResolvedValue(true);
      readTextFile.mockResolvedValue(JSON.stringify(partialConfig));

      const configManager = createTestConfigManager();
      await configManager.init();

      // Should have default satellite config
      expect(configManager.config.basemaps.satellite.url).toContain('tiles.maps.eox.at');

      // Should have merged custom config with defaults
      expect(configManager.config.basemaps.custom.url).toBe('https://custom.com/{z}/{x}/{y}.png');
      expect(configManager.config.basemaps.custom.name).toBe('Custom'); // Default value
    });

    it('should preserve existing values when merging', async () => {
      const fullConfig = {
        version: '2.0',
        basemaps: {
          satellite: {
            url: 'https://custom-satellite.com/{z}/{x}/{y}.png',
            attribution: 'Custom Satellite',
            name: 'My Satellite',
          },
          custom: {
            url: 'https://custom.com/{z}/{x}/{y}.png',
            attribution: 'Custom',
            name: 'My Custom',
          },
        },
      };

      exists.mockResolvedValue(true);
      readTextFile.mockResolvedValue(JSON.stringify(fullConfig));

      const configManager = createTestConfigManager();
      await configManager.init();

      expect(configManager.config.version).toBe('2.0');
      expect(configManager.config.basemaps.satellite.url).toBe(
        'https://custom-satellite.com/{z}/{x}/{y}.png'
      );
      expect(configManager.config.basemaps.custom.name).toBe('My Custom');
    });
  });

  describe('save', () => {
    it('should write config to file', async () => {
      exists.mockResolvedValue(false);
      writeTextFile.mockResolvedValue(undefined);

      const configManager = createTestConfigManager();
      await configManager.init();

      writeTextFile.mockClear();
      const result = await configManager.save();

      expect(result).toBe(true);
      expect(writeTextFile).toHaveBeenCalledWith(
        '/mock/app/data/config.json',
        expect.stringContaining('"version"')
      );
    });

    it('should return false if configPath is not set', async () => {
      const configManager = createTestConfigManager();
      // Don't call init, so configPath remains null

      const result = await configManager.save();

      expect(result).toBe(false);
    });
  });

  describe('default satellite URL', () => {
    it('should use Sentinel-2 Cloudless as default (open source friendly)', async () => {
      exists.mockResolvedValue(false);
      writeTextFile.mockResolvedValue(undefined);

      const configManager = createTestConfigManager();
      await configManager.init();

      const satelliteConfig = configManager.getSatelliteConfig();

      // Verify it's NOT using Esri/ArcGIS
      expect(satelliteConfig.url).not.toContain('arcgisonline');
      expect(satelliteConfig.url).not.toContain('esri');

      // Verify it's using Sentinel-2 Cloudless from EOX
      expect(satelliteConfig.url).toContain('tiles.maps.eox.at');
      expect(satelliteConfig.url).toContain('s2cloudless');

      // Verify CC BY 4.0 license is mentioned
      expect(satelliteConfig.attribution).toContain('CC BY 4.0');
    });
  });
});
