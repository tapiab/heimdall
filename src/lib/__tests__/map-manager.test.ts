/**
 * Tests for MapManager terrain and basemap functionality
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock maplibregl
const mockMap = {
  getSource: vi.fn(),
  addSource: vi.fn(),
  removeSource: vi.fn(),
  setTerrain: vi.fn(),
  getLayer: vi.fn(),
  addLayer: vi.fn(),
  removeLayer: vi.fn(),
  setLayoutProperty: vi.fn(),
  on: vi.fn(),
  getPitch: vi.fn(() => 0),
  getBearing: vi.fn(() => 0),
  easeTo: vi.fn(),
};

// Create a minimal MapManager-like object for testing terrain logic
function createTestMapManager() {
  return {
    map: mockMap,
    terrainEnabled: false,
    terrainExaggeration: 1.5,
    pixelCoordMode: false,

    initTerrain() {
      if (this.map.getSource('terrain-dem')) {
        return true;
      }

      try {
        this.map.addSource('terrain-dem', {
          type: 'raster-dem',
          tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
          encoding: 'terrarium',
          tileSize: 256,
          maxzoom: 15,
        });
        this.map.on('error', this.handleTerrainError.bind(this));
        return true;
      } catch (_error) {
        return false;
      }
    },

    handleTerrainError(e) {
      if (e.sourceId === 'terrain-dem' || (e.source && e.source.id === 'terrain-dem')) {
        console.warn('Terrain tile loading failed:', e.error?.message || 'Unknown error');
      }
    },

    enableTerrain(exaggeration = null) {
      if (this.pixelCoordMode) {
        return { success: false, error: 'Terrain not available for non-georeferenced images' };
      }

      if (!this.map.getSource('terrain-dem')) {
        const initialized = this.initTerrain();
        if (!initialized) {
          return { success: false, error: 'Failed to initialize terrain source' };
        }
      }

      try {
        const exag = exaggeration !== null ? exaggeration : this.terrainExaggeration;
        this.map.setTerrain({
          source: 'terrain-dem',
          exaggeration: exag,
        });
        this.terrainEnabled = true;
        this.terrainExaggeration = exag;
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    disableTerrain() {
      this.map.setTerrain(null);
      this.terrainEnabled = false;
    },

    toggleTerrain() {
      if (this.terrainEnabled) {
        this.disableTerrain();
        return { success: true, enabled: false };
      } else {
        const result = this.enableTerrain();
        if (result.success) {
          return { success: true, enabled: true };
        }
        return result;
      }
    },

    setTerrainExaggeration(value) {
      this.terrainExaggeration = value;
      if (this.terrainEnabled) {
        this.map.setTerrain({
          source: 'terrain-dem',
          exaggeration: value,
        });
      }
    },

    getTerrainExaggeration() {
      return this.terrainExaggeration;
    },

    isTerrainEnabled() {
      return this.terrainEnabled;
    },

    setPixelCoordMode(enabled) {
      this.pixelCoordMode = enabled;
      if (enabled && this.terrainEnabled) {
        this.disableTerrain();
      }
    },
  };
}

describe('MapManager Terrain', () => {
  let mapManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMap.getSource.mockReturnValue(null);
    mockMap.getLayer.mockReturnValue(null);
    mapManager = createTestMapManager();
  });

  describe('initTerrain', () => {
    it('should add terrain source when not already present', () => {
      const result = mapManager.initTerrain();

      expect(result).toBe(true);
      expect(mockMap.addSource).toHaveBeenCalledWith('terrain-dem', {
        type: 'raster-dem',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 15,
      });
    });

    it('should not add terrain source if already present', () => {
      mockMap.getSource.mockReturnValue({ id: 'terrain-dem' });

      const result = mapManager.initTerrain();

      expect(result).toBe(true);
      expect(mockMap.addSource).not.toHaveBeenCalled();
    });

    it('should register error handler', () => {
      mapManager.initTerrain();

      expect(mockMap.on).toHaveBeenCalledWith('error', expect.any(Function));
    });
  });

  describe('enableTerrain', () => {
    it('should enable terrain with default exaggeration', () => {
      const result = mapManager.enableTerrain();

      expect(result).toEqual({ success: true });
      expect(mapManager.terrainEnabled).toBe(true);
      expect(mockMap.setTerrain).toHaveBeenCalledWith({
        source: 'terrain-dem',
        exaggeration: 1.5,
      });
    });

    it('should enable terrain with custom exaggeration', () => {
      const result = mapManager.enableTerrain(3.0);

      expect(result).toEqual({ success: true });
      expect(mapManager.terrainExaggeration).toBe(3.0);
      expect(mockMap.setTerrain).toHaveBeenCalledWith({
        source: 'terrain-dem',
        exaggeration: 3.0,
      });
    });

    it('should fail when in pixel coordinate mode', () => {
      mapManager.pixelCoordMode = true;

      const result = mapManager.enableTerrain();

      expect(result).toEqual({
        success: false,
        error: 'Terrain not available for non-georeferenced images',
      });
      expect(mapManager.terrainEnabled).toBe(false);
      expect(mockMap.setTerrain).not.toHaveBeenCalled();
    });

    it('should reuse existing terrain source', () => {
      mockMap.getSource.mockReturnValue({ id: 'terrain-dem' });

      mapManager.enableTerrain();

      expect(mockMap.addSource).not.toHaveBeenCalled();
      expect(mockMap.setTerrain).toHaveBeenCalled();
    });
  });

  describe('disableTerrain', () => {
    it('should disable terrain', () => {
      mapManager.terrainEnabled = true;

      mapManager.disableTerrain();

      expect(mapManager.terrainEnabled).toBe(false);
      expect(mockMap.setTerrain).toHaveBeenCalledWith(null);
    });
  });

  describe('toggleTerrain', () => {
    it('should enable terrain when disabled', () => {
      mapManager.terrainEnabled = false;

      const result = mapManager.toggleTerrain();

      expect(result).toEqual({ success: true, enabled: true });
      expect(mapManager.terrainEnabled).toBe(true);
    });

    it('should disable terrain when enabled', () => {
      mapManager.terrainEnabled = true;

      const result = mapManager.toggleTerrain();

      expect(result).toEqual({ success: true, enabled: false });
      expect(mapManager.terrainEnabled).toBe(false);
    });

    it('should return error when toggle fails', () => {
      mapManager.pixelCoordMode = true;

      const result = mapManager.toggleTerrain();

      expect(result).toEqual({
        success: false,
        error: 'Terrain not available for non-georeferenced images',
      });
    });
  });

  describe('setTerrainExaggeration', () => {
    it('should update exaggeration when terrain is enabled', () => {
      mapManager.terrainEnabled = true;

      mapManager.setTerrainExaggeration(2.5);

      expect(mapManager.terrainExaggeration).toBe(2.5);
      expect(mockMap.setTerrain).toHaveBeenCalledWith({
        source: 'terrain-dem',
        exaggeration: 2.5,
      });
    });

    it('should store exaggeration but not update map when terrain is disabled', () => {
      mapManager.terrainEnabled = false;

      mapManager.setTerrainExaggeration(2.5);

      expect(mapManager.terrainExaggeration).toBe(2.5);
      expect(mockMap.setTerrain).not.toHaveBeenCalled();
    });
  });

  describe('setPixelCoordMode', () => {
    it('should disable terrain when entering pixel coord mode', () => {
      mapManager.terrainEnabled = true;

      mapManager.setPixelCoordMode(true);

      expect(mapManager.pixelCoordMode).toBe(true);
      expect(mapManager.terrainEnabled).toBe(false);
      expect(mockMap.setTerrain).toHaveBeenCalledWith(null);
    });

    it('should not affect terrain when leaving pixel coord mode', () => {
      mapManager.pixelCoordMode = true;
      mapManager.terrainEnabled = false;

      mapManager.setPixelCoordMode(false);

      expect(mapManager.pixelCoordMode).toBe(false);
      // Terrain should still be disabled - user must manually enable
      expect(mapManager.terrainEnabled).toBe(false);
    });
  });

  describe('getTerrainExaggeration', () => {
    it('should return current exaggeration', () => {
      mapManager.terrainExaggeration = 2.0;

      expect(mapManager.getTerrainExaggeration()).toBe(2.0);
    });
  });

  describe('isTerrainEnabled', () => {
    it('should return terrain enabled state', () => {
      expect(mapManager.isTerrainEnabled()).toBe(false);

      mapManager.terrainEnabled = true;

      expect(mapManager.isTerrainEnabled()).toBe(true);
    });
  });

  describe('handleTerrainError', () => {
    it('should log warning for terrain-related errors', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      mapManager.handleTerrainError({
        sourceId: 'terrain-dem',
        error: { message: 'Network error' },
      });

      expect(consoleSpy).toHaveBeenCalledWith('Terrain tile loading failed:', 'Network error');

      consoleSpy.mockRestore();
    });

    it('should ignore non-terrain errors', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      mapManager.handleTerrainError({
        sourceId: 'other-source',
        error: { message: 'Some error' },
      });

      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });
});

// Default satellite basemap (matches the real implementation)
const DEFAULT_SATELLITE = {
  url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg',
  attribution: 'Sentinel-2 cloudless by EOX - CC BY 4.0',
};

// Create a MapManager-like object for testing basemap functionality
function createBasemapTestMapManager(configManager = null) {
  return {
    map: mockMap,
    configManager,
    basemapVisible: true,
    currentBasemap: 'osm',

    setLayerVisibility(id, visible) {
      if (this.map.getLayer(id)) {
        this.map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
      }
    },

    toggleBasemap() {
      this.basemapVisible = !this.basemapVisible;
      if (this.basemapVisible) {
        this.setBasemap(this.currentBasemap);
      } else {
        this.setLayerVisibility('osm-tiles', false);
        this.setLayerVisibility('satellite-tiles', false);
        this.setLayerVisibility('custom-tiles', false);
      }
      return this.basemapVisible;
    },

    setBasemap(type) {
      this.currentBasemap = type;

      if (type === 'none') {
        this.basemapVisible = false;
        this.setLayerVisibility('osm-tiles', false);
        this.setLayerVisibility('satellite-tiles', false);
        this.setLayerVisibility('custom-tiles', false);
        this.setLayerVisibility('pixel-grid', false);
      } else if (type === 'pixel') {
        this.basemapVisible = true;
        this.setLayerVisibility('osm-tiles', false);
        this.setLayerVisibility('satellite-tiles', false);
        this.setLayerVisibility('custom-tiles', false);
        this.setLayerVisibility('pixel-grid', true);
      } else {
        this.basemapVisible = true;
        this.setLayerVisibility('osm-tiles', type === 'osm');
        this.setLayerVisibility('satellite-tiles', type === 'satellite');
        this.setLayerVisibility('custom-tiles', type === 'custom');
        this.setLayerVisibility('pixel-grid', false);
      }
    },

    getBasemap() {
      return this.basemapVisible ? this.currentBasemap : 'none';
    },

    hasCustomBasemap() {
      return !!this.map?.getSource('custom');
    },

    setCustomBasemapSource(url, attribution = '') {
      if (!url) return;

      // Remove existing custom source and layer if they exist
      if (this.map.getLayer('custom-tiles')) {
        this.map.removeLayer('custom-tiles');
      }
      if (this.map.getSource('custom')) {
        this.map.removeSource('custom');
      }

      // Add new custom source
      this.map.addSource('custom', {
        type: 'raster',
        tiles: [url],
        tileSize: 256,
        attribution,
      });

      // Add custom layer
      this.map.addLayer({
        id: 'custom-tiles',
        type: 'raster',
        source: 'custom',
        minzoom: 0,
        maxzoom: 19,
        layout: { visibility: 'none' },
      });
    },

    getSatelliteConfig() {
      return this.configManager?.getSatelliteConfig() || DEFAULT_SATELLITE;
    },
  };
}

describe('MapManager Basemap', () => {
  let mapManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMap.getSource.mockReturnValue(null);
    mockMap.getLayer.mockReturnValue(null);
    mapManager = createBasemapTestMapManager();
  });

  describe('setBasemap', () => {
    it('should set basemap to osm', () => {
      mockMap.getLayer.mockReturnValue({ id: 'osm-tiles' });

      mapManager.setBasemap('osm');

      expect(mapManager.currentBasemap).toBe('osm');
      expect(mapManager.basemapVisible).toBe(true);
    });

    it('should set basemap to satellite', () => {
      mockMap.getLayer.mockReturnValue({ id: 'satellite-tiles' });

      mapManager.setBasemap('satellite');

      expect(mapManager.currentBasemap).toBe('satellite');
      expect(mapManager.basemapVisible).toBe(true);
    });

    it('should set basemap to custom', () => {
      mockMap.getLayer.mockReturnValue({ id: 'custom-tiles' });

      mapManager.setBasemap('custom');

      expect(mapManager.currentBasemap).toBe('custom');
      expect(mapManager.basemapVisible).toBe(true);
    });

    it('should set basemap to none', () => {
      mapManager.setBasemap('none');

      expect(mapManager.currentBasemap).toBe('none');
      expect(mapManager.basemapVisible).toBe(false);
    });

    it('should set basemap to pixel grid', () => {
      mockMap.getLayer.mockReturnValue({ id: 'pixel-grid' });

      mapManager.setBasemap('pixel');

      expect(mapManager.currentBasemap).toBe('pixel');
      expect(mapManager.basemapVisible).toBe(true);
    });
  });

  describe('getBasemap', () => {
    it('should return current basemap when visible', () => {
      mapManager.currentBasemap = 'satellite';
      mapManager.basemapVisible = true;

      expect(mapManager.getBasemap()).toBe('satellite');
    });

    it('should return none when basemap is not visible', () => {
      mapManager.currentBasemap = 'satellite';
      mapManager.basemapVisible = false;

      expect(mapManager.getBasemap()).toBe('none');
    });
  });

  describe('toggleBasemap', () => {
    it('should toggle basemap visibility', () => {
      mapManager.basemapVisible = true;

      const result = mapManager.toggleBasemap();

      expect(result).toBe(false);
      expect(mapManager.basemapVisible).toBe(false);
    });

    it('should restore previous basemap when toggling back on', () => {
      mapManager.currentBasemap = 'satellite';
      mapManager.basemapVisible = false;
      mockMap.getLayer.mockReturnValue({ id: 'satellite-tiles' });

      const result = mapManager.toggleBasemap();

      expect(result).toBe(true);
      expect(mapManager.basemapVisible).toBe(true);
    });
  });

  describe('hasCustomBasemap', () => {
    it('should return false when custom source does not exist', () => {
      mockMap.getSource.mockReturnValue(null);

      expect(mapManager.hasCustomBasemap()).toBe(false);
    });

    it('should return true when custom source exists', () => {
      mockMap.getSource.mockReturnValue({ id: 'custom' });

      expect(mapManager.hasCustomBasemap()).toBe(true);
    });
  });

  describe('setCustomBasemapSource', () => {
    it('should add custom basemap source and layer', () => {
      mapManager.setCustomBasemapSource(
        'https://custom.tiles.com/{z}/{x}/{y}.png',
        'Custom Attribution'
      );

      expect(mockMap.addSource).toHaveBeenCalledWith('custom', {
        type: 'raster',
        tiles: ['https://custom.tiles.com/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: 'Custom Attribution',
      });

      expect(mockMap.addLayer).toHaveBeenCalledWith({
        id: 'custom-tiles',
        type: 'raster',
        source: 'custom',
        minzoom: 0,
        maxzoom: 19,
        layout: { visibility: 'none' },
      });
    });

    it('should remove existing custom source before adding new one', () => {
      mockMap.getLayer.mockReturnValue({ id: 'custom-tiles' });
      mockMap.getSource.mockReturnValue({ id: 'custom' });

      mapManager.setCustomBasemapSource('https://new-tiles.com/{z}/{x}/{y}.png');

      expect(mockMap.removeLayer).toHaveBeenCalledWith('custom-tiles');
      expect(mockMap.removeSource).toHaveBeenCalledWith('custom');
    });

    it('should not add source if url is empty', () => {
      mapManager.setCustomBasemapSource('');

      expect(mockMap.addSource).not.toHaveBeenCalled();
    });
  });

  describe('getSatelliteConfig', () => {
    it('should return default Sentinel-2 Cloudless config when no configManager', () => {
      const config = mapManager.getSatelliteConfig();

      expect(config.url).toContain('tiles.maps.eox.at');
      expect(config.url).toContain('s2cloudless');
      expect(config.attribution).toContain('Sentinel-2');
      expect(config.attribution).toContain('CC BY 4.0');
    });

    it('should return config from configManager when available', () => {
      const mockConfigManager = {
        getSatelliteConfig: vi.fn(() => ({
          url: 'https://custom-satellite.com/{z}/{x}/{y}.jpg',
          attribution: 'Custom Satellite',
        })),
      };

      const managerWithConfig = createBasemapTestMapManager(mockConfigManager);
      const config = managerWithConfig.getSatelliteConfig();

      expect(config.url).toBe('https://custom-satellite.com/{z}/{x}/{y}.jpg');
      expect(config.attribution).toBe('Custom Satellite');
    });

    it('should NOT use Esri/ArcGIS URLs (open source compliance)', () => {
      const config = mapManager.getSatelliteConfig();

      expect(config.url).not.toContain('arcgisonline');
      expect(config.url).not.toContain('esri');
      expect(config.url.toLowerCase()).not.toContain('arcgis');
    });
  });
});
