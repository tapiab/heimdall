/**
 * Tests for MapManager terrain functionality
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock maplibregl
const mockMap = {
  getSource: vi.fn(),
  addSource: vi.fn(),
  setTerrain: vi.fn(),
  getLayer: vi.fn(),
  addLayer: vi.fn(),
  removeLayer: vi.fn(),
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
