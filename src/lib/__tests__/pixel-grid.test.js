/**
 * Tests for pixel grid basemap functionality
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock map object
const mockMap = {
  getLayer: vi.fn(),
  getSource: vi.fn(),
  addLayer: vi.fn(),
  addSource: vi.fn(),
  removeLayer: vi.fn(),
  removeSource: vi.fn(),
  setLayoutProperty: vi.fn(),
};

/**
 * Calculate appropriate grid spacing based on image dimensions.
 * Extracted from map-manager.js for testing.
 */
function calculateGridSpacing(width, height) {
  const maxDim = Math.max(width, height);
  // Target roughly 10 major grid lines
  const targetLines = 10;
  const rawSpacing = maxDim / targetLines;

  // Round to a nice number (1, 2, 5, 10, 20, 50, 100, 200, 500, etc.)
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawSpacing)));
  const normalized = rawSpacing / magnitude;

  let niceSpacing;
  if (normalized <= 1) niceSpacing = magnitude;
  else if (normalized <= 2) niceSpacing = 2 * magnitude;
  else if (normalized <= 5) niceSpacing = 5 * magnitude;
  else niceSpacing = 10 * magnitude;

  return niceSpacing;
}

// Create a minimal MapManager-like object for testing pixel grid logic
function createTestMapManager() {
  return {
    map: mockMap,
    pixelCoordMode: false,
    pixelExtent: null,
    pixelGridCanvas: null,
    currentBasemap: 'osm',
    previousBasemap: 'osm',
    basemapVisible: true,
    terrainEnabled: false,

    calculateGridSpacing,

    setLayerVisibility(id, visible) {
      if (this.map.getLayer(id)) {
        this.map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
      }
    },

    setBasemap(type) {
      this.currentBasemap = type;
      if (type === 'none') {
        this.basemapVisible = false;
        this.setLayerVisibility('osm-tiles', false);
        this.setLayerVisibility('satellite-tiles', false);
        this.setLayerVisibility('pixel-grid', false);
      } else if (type === 'pixel') {
        this.basemapVisible = true;
        this.setLayerVisibility('osm-tiles', false);
        this.setLayerVisibility('satellite-tiles', false);
        this.setLayerVisibility('pixel-grid', true);
      } else {
        this.basemapVisible = true;
        this.setLayerVisibility('osm-tiles', type === 'osm');
        this.setLayerVisibility('satellite-tiles', type === 'satellite');
        this.setLayerVisibility('pixel-grid', false);
      }
    },

    removePixelGridBasemap() {
      if (this.map.getLayer('pixel-grid')) {
        this.map.removeLayer('pixel-grid');
      }
      if (this.map.getSource('pixel-grid-source')) {
        this.map.removeSource('pixel-grid-source');
      }
      this.pixelGridCanvas = null;
    },

    isPixelCoordMode() {
      return this.pixelCoordMode;
    },

    setPixelCoordMode(enabled, extent = null) {
      this.pixelCoordMode = enabled;
      this.pixelExtent = extent;

      if (enabled) {
        if (this.currentBasemap !== 'pixel' && this.currentBasemap !== 'none') {
          this.previousBasemap = this.currentBasemap;
        }
        if (extent) {
          // Would create pixel grid here
          this.setBasemap('pixel');
        }
      } else {
        this.removePixelGridBasemap();
        if (this.previousBasemap && this.previousBasemap !== 'pixel') {
          this.setBasemap(this.previousBasemap);
        }
      }
    },
  };
}

describe('calculateGridSpacing', () => {
  it('should return 100 for 1000x1000 image', () => {
    const spacing = calculateGridSpacing(1000, 1000);
    expect(spacing).toBe(100);
  });

  it('should return 500 for 5000x5000 image', () => {
    const spacing = calculateGridSpacing(5000, 5000);
    expect(spacing).toBe(500);
  });

  it('should return 10 for 100x100 image', () => {
    const spacing = calculateGridSpacing(100, 100);
    expect(spacing).toBe(10);
  });

  it('should use largest dimension for non-square images', () => {
    const spacing = calculateGridSpacing(1000, 500);
    expect(spacing).toBe(100); // Based on 1000, not 500
  });

  it('should return 1 for 10x10 image', () => {
    const spacing = calculateGridSpacing(10, 10);
    expect(spacing).toBe(1);
  });

  it('should return nice number for arbitrary dimensions', () => {
    const spacing = calculateGridSpacing(1234, 987);
    // 1234 / 10 = 123.4, magnitude = 100, normalized = 1.234
    // normalized <= 2, so result is 2 * 100 = 200
    expect(spacing).toBe(200);
  });

  it('should handle large images', () => {
    const spacing = calculateGridSpacing(10000, 10000);
    expect(spacing).toBe(1000);
  });

  it('should handle very large images', () => {
    const spacing = calculateGridSpacing(50000, 50000);
    expect(spacing).toBe(5000);
  });

  it('should return 2 for 20x20 image', () => {
    const spacing = calculateGridSpacing(20, 20);
    expect(spacing).toBe(2);
  });

  it('should return 5 for 50x50 image', () => {
    const spacing = calculateGridSpacing(50, 50);
    expect(spacing).toBe(5);
  });

  it('should return 200 for 2000x2000 image', () => {
    const spacing = calculateGridSpacing(2000, 2000);
    expect(spacing).toBe(200);
  });

  it('should handle dimensions that result in exactly 5 normalized value', () => {
    // 500 / 10 = 50, magnitude = 10, normalized = 5
    const spacing = calculateGridSpacing(500, 500);
    expect(spacing).toBe(50);
  });
});

describe('MapManager Pixel Grid', () => {
  let mapManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMap.getLayer.mockReturnValue(null);
    mockMap.getSource.mockReturnValue(null);
    mapManager = createTestMapManager();
  });

  describe('setPixelCoordMode', () => {
    it('should enable pixel coord mode', () => {
      mapManager.setPixelCoordMode(true, { width: 1000, height: 1000, scale: 0.01 });

      expect(mapManager.pixelCoordMode).toBe(true);
      expect(mapManager.pixelExtent).toEqual({ width: 1000, height: 1000, scale: 0.01 });
    });

    it('should disable pixel coord mode', () => {
      mapManager.setPixelCoordMode(true, { width: 1000, height: 1000, scale: 0.01 });
      mapManager.setPixelCoordMode(false);

      expect(mapManager.pixelCoordMode).toBe(false);
      expect(mapManager.pixelExtent).toBeNull();
    });

    it('should store previous basemap when entering pixel mode', () => {
      mapManager.currentBasemap = 'satellite';
      mapManager.setPixelCoordMode(true, { width: 1000, height: 1000, scale: 0.01 });

      expect(mapManager.previousBasemap).toBe('satellite');
    });

    it('should restore previous basemap when leaving pixel mode', () => {
      mapManager.currentBasemap = 'satellite';
      mapManager.previousBasemap = 'satellite';
      mapManager.setPixelCoordMode(true, { width: 1000, height: 1000, scale: 0.01 });
      mapManager.setPixelCoordMode(false);

      expect(mapManager.currentBasemap).toBe('satellite');
    });

    it('should switch to pixel basemap when extent is provided', () => {
      mapManager.setPixelCoordMode(true, { width: 1000, height: 1000, scale: 0.01 });

      expect(mapManager.currentBasemap).toBe('pixel');
    });

    it('should not switch to pixel basemap if extent is null', () => {
      mapManager.currentBasemap = 'osm';
      mapManager.setPixelCoordMode(true, null);

      // Basemap should not change without extent
      expect(mapManager.currentBasemap).toBe('osm');
    });

    it('should call removePixelGridBasemap when leaving pixel mode', () => {
      mockMap.getLayer.mockReturnValue({ id: 'pixel-grid' });
      mockMap.getSource.mockReturnValue({ id: 'pixel-grid-source' });

      mapManager.setPixelCoordMode(true, { width: 1000, height: 1000, scale: 0.01 });
      mapManager.setPixelCoordMode(false);

      expect(mockMap.removeLayer).toHaveBeenCalledWith('pixel-grid');
      expect(mockMap.removeSource).toHaveBeenCalledWith('pixel-grid-source');
    });
  });

  describe('setBasemap', () => {
    beforeEach(() => {
      mockMap.getLayer.mockReturnValue({ id: 'test' });
    });

    it('should set basemap to osm', () => {
      mapManager.setBasemap('osm');

      expect(mapManager.currentBasemap).toBe('osm');
      expect(mapManager.basemapVisible).toBe(true);
    });

    it('should set basemap to satellite', () => {
      mapManager.setBasemap('satellite');

      expect(mapManager.currentBasemap).toBe('satellite');
      expect(mapManager.basemapVisible).toBe(true);
    });

    it('should set basemap to pixel', () => {
      mapManager.setBasemap('pixel');

      expect(mapManager.currentBasemap).toBe('pixel');
      expect(mapManager.basemapVisible).toBe(true);
    });

    it('should set basemap to none', () => {
      mapManager.setBasemap('none');

      expect(mapManager.currentBasemap).toBe('none');
      expect(mapManager.basemapVisible).toBe(false);
    });

    it('should hide osm and satellite when pixel is selected', () => {
      mapManager.setBasemap('pixel');

      expect(mockMap.setLayoutProperty).toHaveBeenCalledWith('osm-tiles', 'visibility', 'none');
      expect(mockMap.setLayoutProperty).toHaveBeenCalledWith('satellite-tiles', 'visibility', 'none');
      expect(mockMap.setLayoutProperty).toHaveBeenCalledWith('pixel-grid', 'visibility', 'visible');
    });

    it('should hide pixel grid when osm is selected', () => {
      mapManager.setBasemap('osm');

      expect(mockMap.setLayoutProperty).toHaveBeenCalledWith('pixel-grid', 'visibility', 'none');
      expect(mockMap.setLayoutProperty).toHaveBeenCalledWith('osm-tiles', 'visibility', 'visible');
    });
  });

  describe('removePixelGridBasemap', () => {
    it('should remove layer and source when they exist', () => {
      mockMap.getLayer.mockReturnValue({ id: 'pixel-grid' });
      mockMap.getSource.mockReturnValue({ id: 'pixel-grid-source' });

      mapManager.removePixelGridBasemap();

      expect(mockMap.removeLayer).toHaveBeenCalledWith('pixel-grid');
      expect(mockMap.removeSource).toHaveBeenCalledWith('pixel-grid-source');
    });

    it('should not call remove if layer does not exist', () => {
      mockMap.getLayer.mockReturnValue(null);
      mockMap.getSource.mockReturnValue(null);

      mapManager.removePixelGridBasemap();

      expect(mockMap.removeLayer).not.toHaveBeenCalled();
      expect(mockMap.removeSource).not.toHaveBeenCalled();
    });

    it('should clear pixelGridCanvas reference', () => {
      mapManager.pixelGridCanvas = document.createElement('canvas');
      mapManager.removePixelGridBasemap();

      expect(mapManager.pixelGridCanvas).toBeNull();
    });
  });

  describe('isPixelCoordMode', () => {
    it('should return false by default', () => {
      expect(mapManager.isPixelCoordMode()).toBe(false);
    });

    it('should return true when in pixel coord mode', () => {
      mapManager.setPixelCoordMode(true, { width: 1000, height: 1000, scale: 0.01 });
      expect(mapManager.isPixelCoordMode()).toBe(true);
    });

    it('should return false after leaving pixel coord mode', () => {
      mapManager.setPixelCoordMode(true, { width: 1000, height: 1000, scale: 0.01 });
      mapManager.setPixelCoordMode(false);
      expect(mapManager.isPixelCoordMode()).toBe(false);
    });
  });
});

describe('Grid spacing nice numbers', () => {
  // Test the "nice number" algorithm produces expected values
  const testCases = [
    { input: [10, 10], expected: 1 },
    { input: [15, 15], expected: 2 },
    { input: [25, 25], expected: 5 },
    { input: [50, 50], expected: 5 },
    { input: [75, 75], expected: 10 },
    { input: [100, 100], expected: 10 },
    { input: [150, 150], expected: 20 },
    { input: [250, 250], expected: 50 },
    { input: [500, 500], expected: 50 },
    { input: [750, 750], expected: 100 },
    { input: [1000, 1000], expected: 100 },
    { input: [1500, 1500], expected: 200 },
    { input: [2500, 2500], expected: 500 },
    { input: [5000, 5000], expected: 500 },
    { input: [7500, 7500], expected: 1000 },
    { input: [10000, 10000], expected: 1000 },
  ];

  testCases.forEach(({ input, expected }) => {
    it(`should return ${expected} for ${input[0]}x${input[1]}`, () => {
      const spacing = calculateGridSpacing(input[0], input[1]);
      expect(spacing).toBe(expected);
    });
  });
});

describe('Pixel coordinate conversion', () => {
  /**
   * Convert map coordinates to pixel coordinates.
   * This simulates the conversion used in map-manager.js coordinate display.
   */
  function mapToPixel(lng, lat, extent) {
    const scale = extent.scale || 0.01;
    const offsetX = extent.offsetX || 0;
    const offsetY = extent.offsetY || 0;

    const x = Math.round((lng + offsetX) / scale);
    const y = Math.round((offsetY - lat) / scale);

    return { x, y };
  }

  it('should convert origin (0,0) to center pixel', () => {
    const extent = {
      width: 1000,
      height: 1000,
      scale: 0.01,
      offsetX: 5,
      offsetY: 5,
    };

    const { x, y } = mapToPixel(0, 0, extent);

    expect(x).toBe(500);
    expect(y).toBe(500);
  });

  it('should convert top-left corner', () => {
    const extent = {
      width: 1000,
      height: 1000,
      scale: 0.01,
      offsetX: 5,
      offsetY: 5,
    };

    const { x, y } = mapToPixel(-5, 5, extent);

    expect(x).toBe(0);
    expect(y).toBe(0);
  });

  it('should convert bottom-right corner', () => {
    const extent = {
      width: 1000,
      height: 1000,
      scale: 0.01,
      offsetX: 5,
      offsetY: 5,
    };

    const { x, y } = mapToPixel(5, -5, extent);

    expect(x).toBe(1000);
    expect(y).toBe(1000);
  });

  it('should handle different scales', () => {
    const extent = {
      width: 2000,
      height: 2000,
      scale: 0.005,
      offsetX: 5,
      offsetY: 5,
    };

    const { x, y } = mapToPixel(0, 0, extent);

    expect(x).toBe(1000);
    expect(y).toBe(1000);
  });

  it('should handle non-square images', () => {
    const extent = {
      width: 800,
      height: 600,
      scale: 0.01,
      offsetX: 4,
      offsetY: 3,
    };

    // Origin should map to center
    const { x, y } = mapToPixel(0, 0, extent);

    expect(x).toBe(400);
    expect(y).toBe(300);
  });
});
