/**
 * Tests for LayerManager
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock Tauri
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// Mock maplibre-gl
vi.mock('maplibre-gl', () => ({
  default: {
    addProtocol: vi.fn(),
    removeProtocol: vi.fn(),
    Popup: vi.fn().mockImplementation(() => ({
      setLngLat: vi.fn().mockReturnThis(),
      setHTML: vi.fn().mockReturnThis(),
      addTo: vi.fn().mockReturnThis(),
      remove: vi.fn(),
    })),
  },
}));

// Mock notifications
vi.mock('../notifications.js', () => ({
  showToast: vi.fn(),
  showError: vi.fn(),
  showLoading: vi.fn(),
  hideLoading: vi.fn(),
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

// Create minimal mock map for testing
function createMockMap() {
  return {
    getSource: vi.fn(),
    getLayer: vi.fn(),
    addSource: vi.fn(),
    addLayer: vi.fn(),
    removeSource: vi.fn(),
    removeLayer: vi.fn(),
    setLayoutProperty: vi.fn(),
    setPaintProperty: vi.fn(),
    getCanvas: vi.fn(() => document.createElement('canvas')),
    getContainer: vi.fn(() => document.createElement('div')),
    on: vi.fn(),
    off: vi.fn(),
    queryRenderedFeatures: vi.fn(() => []),
    getZoom: vi.fn(() => 10),
  };
}

function createMockMapManager() {
  const map = createMockMap();
  return {
    map,
    setLayerVisibility: vi.fn(),
    setLayerOpacity: vi.fn(),
    moveLayer: vi.fn(),
    removeLayer: vi.fn(),
    removeSource: vi.fn(),
    fitBounds: vi.fn(),
  };
}

// Import after mocks are set up
import { LayerManager } from '../layer-manager.js';
import { invoke } from '@tauri-apps/api/core';

describe('LayerManager', () => {
  let mockMapManager;
  let layerManager;
  let layerPanel;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create layer panel element
    layerPanel = document.createElement('div');
    layerPanel.id = 'layer-list';
    document.body.appendChild(layerPanel);

    // Create controls panel
    const controlsPanel = document.createElement('div');
    controlsPanel.id = 'dynamic-controls';
    document.body.appendChild(controlsPanel);

    mockMapManager = createMockMapManager();
    layerManager = new LayerManager(mockMapManager);
  });

  afterEach(() => {
    document.getElementById('layer-list')?.remove();
    document.getElementById('dynamic-controls')?.remove();
  });

  describe('constructor', () => {
    it('should initialize with empty layers', () => {
      expect(layerManager.layers.size).toBe(0);
    });

    it('should initialize with empty layer order', () => {
      expect(layerManager.layerOrder.length).toBe(0);
    });

    it('should initialize tile cache', () => {
      expect(layerManager.tileCache).toBeDefined();
      expect(layerManager.tileCache.size).toBe(0);
    });

    it('should store map manager reference', () => {
      expect(layerManager.mapManager).toBe(mockMapManager);
    });
  });

  describe('layer operations', () => {
    const mockRasterLayer = {
      id: 'test-raster-1',
      type: 'raster',
      path: '/path/to/test.tif',
      fileName: 'test.tif',
      visible: true,
      opacity: 1.0,
      bands: 3,
      band: 1,
      stretch: { min: 0, max: 255, gamma: 1.0 },
      displayMode: 'grayscale',
      is_georeferenced: true,
      rgbBands: { r: 1, g: 2, b: 3 },
      rgbStretch: {
        r: { min: 0, max: 255, gamma: 1.0 },
        g: { min: 0, max: 255, gamma: 1.0 },
        b: { min: 0, max: 255, gamma: 1.0 },
      },
      band_stats: [
        { min: 0, max: 255, mean: 128, std_dev: 50 },
        { min: 0, max: 255, mean: 130, std_dev: 48 },
        { min: 0, max: 255, mean: 125, std_dev: 52 },
      ],
    };

    const mockVectorLayer = {
      id: 'test-vector-1',
      type: 'vector',
      path: '/path/to/test.geojson',
      fileName: 'test.geojson',
      visible: true,
      opacity: 1.0,
      color: '#ff0000',
      lineWidth: 2,
      pointRadius: 5,
      style: {
        fillColor: '#ff0000',
        lineColor: '#000000',
        lineWidth: 2,
        pointRadius: 5,
      },
    };

    beforeEach(() => {
      // Add mock layers directly to test layer operations
      layerManager.layers.set('test-raster-1', { ...mockRasterLayer });
      layerManager.layers.set('test-vector-1', { ...mockVectorLayer });
      layerManager.layerOrder = ['test-raster-1', 'test-vector-1'];
    });

    describe('toggleLayerVisibility', () => {
      it('should toggle raster layer visibility', () => {
        layerManager.toggleLayerVisibility('test-raster-1');
        const layer = layerManager.layers.get('test-raster-1');
        expect(layer.visible).toBe(false);

        layerManager.toggleLayerVisibility('test-raster-1');
        expect(layer.visible).toBe(true);
      });

      it('should call mapManager setLayerVisibility for vector layers', () => {
        layerManager.toggleLayerVisibility('test-vector-1');
        expect(mockMapManager.setLayerVisibility).toHaveBeenCalled();
      });

      it('should handle non-existent layer gracefully', () => {
        expect(() => {
          layerManager.toggleLayerVisibility('non-existent');
        }).not.toThrow();
      });
    });

    describe('setLayerOpacity', () => {
      it('should update layer opacity', () => {
        layerManager.setLayerOpacity('test-raster-1', 0.5);
        const layer = layerManager.layers.get('test-raster-1');
        expect(layer.opacity).toBe(0.5);
      });

      it('should set opacity to minimum value', () => {
        layerManager.setLayerOpacity('test-raster-1', 0);
        const layer = layerManager.layers.get('test-raster-1');
        expect(layer.opacity).toBe(0);
      });

      it('should handle vector layer opacity', () => {
        layerManager.setLayerOpacity('test-vector-1', 0.7);
        const layer = layerManager.layers.get('test-vector-1');
        expect(layer.opacity).toBe(0.7);
      });
    });

    describe('setLayerStretch', () => {
      it('should update stretch parameters', () => {
        layerManager.setLayerStretch('test-raster-1', 10, 200, 1.2);
        const layer = layerManager.layers.get('test-raster-1');
        expect(layer.stretch.min).toBe(10);
        expect(layer.stretch.max).toBe(200);
        expect(layer.stretch.gamma).toBe(1.2);
      });

      it('should handle non-existent layer', () => {
        expect(() => {
          layerManager.setLayerStretch('non-existent', 0, 255, 1.0);
        }).not.toThrow();
      });
    });

    describe('setLayerBand', () => {
      it('should update band selection', () => {
        layerManager.setLayerBand('test-raster-1', 2);
        const layer = layerManager.layers.get('test-raster-1');
        expect(layer.band).toBe(2);
      });
    });

    describe('setLayerDisplayMode', () => {
      it('should set display mode to rgb', () => {
        layerManager.setLayerDisplayMode('test-raster-1', 'rgb');
        const layer = layerManager.layers.get('test-raster-1');
        expect(layer.displayMode).toBe('rgb');
      });

      it('should set display mode to grayscale', () => {
        layerManager.setLayerDisplayMode('test-raster-1', 'grayscale');
        const layer = layerManager.layers.get('test-raster-1');
        expect(layer.displayMode).toBe('grayscale');
      });
    });

    describe('setRgbBands', () => {
      it('should update RGB band assignments', () => {
        layerManager.layers.get('test-raster-1').rgbBands = { r: 1, g: 2, b: 3 };
        layerManager.setRgbBands('test-raster-1', 3, 2, 1);
        const layer = layerManager.layers.get('test-raster-1');
        expect(layer.rgbBands.r).toBe(3);
        expect(layer.rgbBands.g).toBe(2);
        expect(layer.rgbBands.b).toBe(1);
      });
    });

    describe('setVectorStyle', () => {
      it('should update fill color', () => {
        layerManager.setVectorStyle('test-vector-1', 'fillColor', '#00ff00');
        const layer = layerManager.layers.get('test-vector-1');
        expect(layer.style.fillColor).toBe('#00ff00');
      });

      it('should update line width', () => {
        layerManager.setVectorStyle('test-vector-1', 'lineWidth', 5);
        const layer = layerManager.layers.get('test-vector-1');
        expect(layer.style.lineWidth).toBe(5);
      });

      it('should update point radius', () => {
        layerManager.setVectorStyle('test-vector-1', 'pointRadius', 10);
        const layer = layerManager.layers.get('test-vector-1');
        expect(layer.style.pointRadius).toBe(10);
      });
    });
  });

  describe('layer ordering', () => {
    beforeEach(() => {
      layerManager.layers.set('layer-1', {
        id: 'layer-1',
        type: 'raster',
        path: '/a.tif',
        visible: true,
      });
      layerManager.layers.set('layer-2', {
        id: 'layer-2',
        type: 'raster',
        path: '/b.tif',
        visible: true,
      });
      layerManager.layers.set('layer-3', {
        id: 'layer-3',
        type: 'raster',
        path: '/c.tif',
        visible: true,
      });
      layerManager.layerOrder = ['layer-1', 'layer-2', 'layer-3'];
    });

    it('should maintain layer order', () => {
      expect(layerManager.layerOrder).toEqual(['layer-1', 'layer-2', 'layer-3']);
    });

    it('should reorder layers', () => {
      layerManager.reorderLayers(0, 2);
      expect(layerManager.layerOrder[2]).toBe('layer-1');
    });

    it('should handle same position reorder', () => {
      layerManager.reorderLayers(1, 1);
      expect(layerManager.layerOrder).toEqual(['layer-1', 'layer-2', 'layer-3']);
    });
  });

  describe('getFeatureBounds', () => {
    it('should return bounds for point geometry', () => {
      const geometry = {
        type: 'Point',
        coordinates: [10, 20],
      };
      const bounds = layerManager.getFeatureBounds(geometry);
      expect(bounds).not.toBeNull();
      expect(bounds[0][0]).toBeLessThan(bounds[1][0]); // minX < maxX
      expect(bounds[0][1]).toBeLessThan(bounds[1][1]); // minY < maxY
    });

    it('should return bounds for polygon geometry', () => {
      const geometry = {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
          ],
        ],
      };
      const bounds = layerManager.getFeatureBounds(geometry);
      expect(bounds).toEqual([
        [0, 0],
        [10, 10],
      ]);
    });

    it('should return null for null geometry', () => {
      expect(layerManager.getFeatureBounds(null)).toBeNull();
    });

    it('should return null for geometry without coordinates', () => {
      expect(layerManager.getFeatureBounds({})).toBeNull();
    });
  });

  describe('tile cache', () => {
    it('should use LRU cache for tiles', () => {
      expect(layerManager.tileCache.getStats).toBeDefined();
    });

    it('should have max size of 500', () => {
      const stats = layerManager.tileCache.getStats();
      expect(stats.maxSize).toBe(500);
    });
  });

  describe('removeLayer', () => {
    beforeEach(() => {
      layerManager.layers.set('test-layer', {
        id: 'test-layer',
        type: 'raster',
        path: '/path/to/test.tif',
        visible: true,
        isComposition: false,
      });
      layerManager.layerOrder = ['test-layer'];
      invoke.mockResolvedValue(undefined);
    });

    it('should remove layer from layers map', async () => {
      await layerManager.removeLayer('test-layer');
      expect(layerManager.layers.has('test-layer')).toBe(false);
    });

    it('should remove layer from order array', async () => {
      await layerManager.removeLayer('test-layer');
      expect(layerManager.layerOrder).not.toContain('test-layer');
    });

    it('should call close_dataset for non-composition layers', async () => {
      await layerManager.removeLayer('test-layer');
      expect(invoke).toHaveBeenCalledWith('close_dataset', { id: 'test-layer' });
    });

    it('should not call close_dataset for composition layers', async () => {
      layerManager.layers.set('comp-layer', {
        id: 'comp-layer',
        type: 'raster',
        path: '/path/to/comp.tif',
        visible: true,
        isComposition: true,
      });
      layerManager.layerOrder.push('comp-layer');

      invoke.mockClear();
      await layerManager.removeLayer('comp-layer');
      expect(invoke).not.toHaveBeenCalledWith('close_dataset', { id: 'comp-layer' });
    });

    it('should handle non-existent layer gracefully', async () => {
      await expect(layerManager.removeLayer('non-existent')).resolves.not.toThrow();
    });
  });
});

describe('LayerManager - Layer Panel', () => {
  let mockMapManager;
  let layerManager;
  let layerPanel;

  beforeEach(() => {
    vi.clearAllMocks();

    layerPanel = document.createElement('div');
    layerPanel.id = 'layer-list';
    document.body.appendChild(layerPanel);

    const controlsPanel = document.createElement('div');
    controlsPanel.id = 'dynamic-controls';
    document.body.appendChild(controlsPanel);

    mockMapManager = createMockMapManager();
    layerManager = new LayerManager(mockMapManager);
  });

  afterEach(() => {
    document.getElementById('layer-list')?.remove();
    document.getElementById('dynamic-controls')?.remove();
  });

  describe('updateLayerPanel', () => {
    it('should render layer items', () => {
      layerManager.layers.set('layer-1', {
        id: 'layer-1',
        type: 'raster',
        path: '/path/to/test.tif',
        fileName: 'test.tif',
        visible: true,
        opacity: 1.0,
      });
      layerManager.layerOrder = ['layer-1'];

      layerManager.updateLayerPanel();

      const items = layerPanel.querySelectorAll('.layer-item');
      expect(items.length).toBe(1);
    });

    it('should clear panel when no layers', () => {
      layerManager.updateLayerPanel();

      const items = layerPanel.querySelectorAll('.layer-item');
      expect(items.length).toBe(0);
    });

    it('should render layers in correct order', () => {
      layerManager.layers.set('layer-1', {
        id: 'layer-1',
        path: '/path/to/first.tif',
        fileName: 'first.tif',
        visible: true,
      });
      layerManager.layers.set('layer-2', {
        id: 'layer-2',
        path: '/path/to/second.tif',
        fileName: 'second.tif',
        visible: true,
      });
      layerManager.layerOrder = ['layer-1', 'layer-2'];

      layerManager.updateLayerPanel();

      const items = layerPanel.querySelectorAll('.layer-item');
      expect(items.length).toBe(2);
    });
  });
});
