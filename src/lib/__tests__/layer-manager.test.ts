/**
 * Tests for LayerManager
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock Tauri
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// Mock Tauri events and dialogs
const eventHandlers: Record<string, (event: { payload: unknown }) => void> = {};
const unlistenSpy = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    eventHandlers[name] = handler;
    return unlistenSpy;
  }),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn(),
  open: vi.fn(),
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
    moveLayer: vi.fn(),
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
import { LayerManager } from '../layer-manager/index.js';
import { invoke } from '@tauri-apps/api/core';
import { ask } from '@tauri-apps/plugin-dialog';
import { offerOverviews, applyDefaultRpcElevation } from '../layer-manager/raster-handler.js';
import { showToast, showError } from '../notifications.js';

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
      strokeWidth: 2,
      pointRadius: 5,
      style: {
        fillColor: '#ff0000',
        fillOpacity: 0.5,
        strokeColor: '#000000',
        strokeWidth: 2,
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

      it('should update stroke width', () => {
        layerManager.setVectorStyle('test-vector-1', 'strokeWidth', 5);
        const layer = layerManager.layers.get('test-vector-1');
        expect(layer.style.strokeWidth).toBe(5);
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

    it('should move layer up (toward front)', () => {
      // layer-2 is at index 1, move it to index 2 (toward front/top)
      layerManager.reorderLayers(1, 2);
      expect(layerManager.layerOrder).toEqual(['layer-1', 'layer-3', 'layer-2']);
    });

    it('should move layer down (toward back)', () => {
      // layer-3 is at index 2, move it to index 1 (toward back/bottom)
      layerManager.reorderLayers(2, 1);
      expect(layerManager.layerOrder).toEqual(['layer-1', 'layer-3', 'layer-2']);
    });

    it('should call moveLayer on map for each layer when applying order', () => {
      const mockMap = layerManager.mapManager.map;
      mockMap.moveLayer.mockClear();

      layerManager.applyLayerOrder();

      // Should call moveLayer for each raster layer (3 layers)
      expect(mockMap.moveLayer).toHaveBeenCalledTimes(3);
      // Layers should be moved in order: layer-1, layer-2, layer-3
      expect(mockMap.moveLayer).toHaveBeenNthCalledWith(1, 'raster-layer-layer-1');
      expect(mockMap.moveLayer).toHaveBeenNthCalledWith(2, 'raster-layer-layer-2');
      expect(mockMap.moveLayer).toHaveBeenNthCalledWith(3, 'raster-layer-layer-3');
    });

    it('should apply correct map order after reordering', () => {
      const mockMap = layerManager.mapManager.map;
      mockMap.moveLayer.mockClear();

      // Move layer-1 from bottom to top
      layerManager.reorderLayers(0, 2);

      // Order should now be: layer-2, layer-3, layer-1
      expect(layerManager.layerOrder).toEqual(['layer-2', 'layer-3', 'layer-1']);

      // moveLayer should be called in the new order
      expect(mockMap.moveLayer).toHaveBeenNthCalledWith(1, 'raster-layer-layer-2');
      expect(mockMap.moveLayer).toHaveBeenNthCalledWith(2, 'raster-layer-layer-3');
      expect(mockMap.moveLayer).toHaveBeenNthCalledWith(3, 'raster-layer-layer-1');
    });

    it('should handle vector layers in applyLayerOrder', () => {
      // Add a vector layer
      layerManager.layers.set('vector-1', {
        id: 'vector-1',
        type: 'vector',
        path: '/v.geojson',
        visible: true,
      });
      layerManager.layerOrder = ['layer-1', 'vector-1', 'layer-2'];

      const mockMap = layerManager.mapManager.map;
      mockMap.moveLayer.mockClear();

      layerManager.applyLayerOrder();

      // Raster layer-1 moved once
      expect(mockMap.moveLayer).toHaveBeenCalledWith('raster-layer-layer-1');
      // Vector layer has 3 sublayers (fill, line, circle)
      expect(mockMap.moveLayer).toHaveBeenCalledWith('vector-fill-vector-1');
      expect(mockMap.moveLayer).toHaveBeenCalledWith('vector-line-vector-1');
      expect(mockMap.moveLayer).toHaveBeenCalledWith('vector-circle-vector-1');
      // Raster layer-2 moved once
      expect(mockMap.moveLayer).toHaveBeenCalledWith('raster-layer-layer-2');
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

  describe('display controls for an RPC scene', () => {
    it('should render overview and RPC elevation sections above the stretch controls', () => {
      layerManager.layers.set('scene', {
        id: 'scene',
        type: 'raster',
        path: '/data/scene.tif',
        bands: 3,
        band: 1,
        displayMode: 'rgb',
        is_georeferenced: true,
        georef_method: 'rpc',
        rpc_default_height: 178.5,
        suggest_overviews: true,
        band_stats: [
          { band: 1, min: 0, max: 4000 },
          { band: 2, min: 0, max: 4000 },
          { band: 3, min: 0, max: 4000 },
        ],
        stretch: { min: 0, max: 4000, gamma: 1 },
        rgbBands: { r: 1, g: 2, b: 3 },
        rgbStretch: {
          r: { min: 0, max: 4000, gamma: 1 },
          g: { min: 0, max: 4000, gamma: 1 },
          b: { min: 0, max: 4000, gamma: 1 },
        },
      });
      layerManager.selectedLayerId = 'scene';
      layerManager.updateDynamicControls();

      const panel = document.getElementById('dynamic-controls');
      const html = panel.innerHTML;
      expect(panel.querySelector('#build-overviews')).not.toBeNull();
      const source = panel.querySelector('#rpc-source');
      expect(source).not.toBeNull();
      // Nothing applied yet (the online DEM is applied asynchronously after open).
      expect(source.value).toBe('none');
      expect([...source.options].map(o => o.value)).toEqual(['online', 'file', 'none']);
      expect(panel.querySelector('#rpc-height').getAttribute('placeholder')).toContain('178.5');
      expect(html.indexOf('rpc-source')).toBeLessThan(html.indexOf('id="rgb-r"'));
    });
  });

  describe('overviews', () => {
    beforeEach(() => {
      layerManager.layers.set('big', {
        id: 'big',
        type: 'raster',
        path: '/data/big.tif',
        suggest_overviews: true,
      });
      layerManager.layers.set('big-comp', {
        id: 'big-comp',
        type: 'raster',
        isComposition: true,
        sourceLayerId: 'big',
      });
      layerManager.refreshLayerTiles = vi.fn();
      layerManager.updateDynamicControls = vi.fn();
      const indicator = document.createElement('div');
      indicator.id = 'loading-indicator';
      indicator.appendChild(document.createElement('span'));
      document.body.appendChild(indicator);
    });

    afterEach(() => {
      document.getElementById('loading-indicator')?.remove();
    });

    it('should build overviews and redraw the layer and its compositions', async () => {
      invoke.mockImplementation(async () => {
        eventHandlers['overview-progress']({ payload: { id: 'big', progress: 0.42 } });
        expect(document.querySelector('#loading-indicator span').textContent).toBe(
          'Building overviews... 42%'
        );
      });
      await layerManager.buildOverviews('big');

      expect(invoke).toHaveBeenCalledWith('build_overviews', { id: 'big' });
      expect(layerManager.layers.get('big').suggest_overviews).toBe(false);
      expect(layerManager.refreshLayerTiles).toHaveBeenCalledWith('big');
      expect(layerManager.refreshLayerTiles).toHaveBeenCalledWith('big-comp');
      expect(unlistenSpy).toHaveBeenCalled();
    });

    it('should ignore progress events for other layers', async () => {
      invoke.mockImplementation(async () => {
        eventHandlers['overview-progress']({ payload: { id: 'other', progress: 0.9 } });
      });
      await layerManager.buildOverviews('big');
      expect(document.querySelector('#loading-indicator span').textContent).not.toContain('90%');
    });

    it('should keep the suggestion when building fails', async () => {
      invoke.mockRejectedValue(new Error('Permission denied'));
      await layerManager.buildOverviews('big');
      expect(layerManager.layers.get('big').suggest_overviews).toBe(true);
      expect(layerManager.refreshLayerTiles).not.toHaveBeenCalled();
      expect(unlistenSpy).toHaveBeenCalled();
    });

    it('should build when the prompt is accepted', async () => {
      ask.mockResolvedValue(true);
      invoke.mockResolvedValue(undefined);
      await offerOverviews(layerManager, 'big');
      expect(invoke).toHaveBeenCalledWith('build_overviews', { id: 'big' });
    });

    it('should not ask again for a declined file', async () => {
      layerManager.layers.set('declined', {
        id: 'declined',
        type: 'raster',
        path: '/data/declined.tif',
        suggest_overviews: true,
      });
      ask.mockResolvedValue(false);
      await offerOverviews(layerManager, 'declined');
      await offerOverviews(layerManager, 'declined');
      expect(ask).toHaveBeenCalledTimes(1);
      expect(invoke).not.toHaveBeenCalledWith('build_overviews', expect.anything());
    });

    it('should not ask when overviews are not suggested', async () => {
      layerManager.layers.get('big').suggest_overviews = false;
      await offerOverviews(layerManager, 'big');
      expect(ask).not.toHaveBeenCalled();
    });
  });

  describe('setRpcElevation', () => {
    const newBounds = [9.4, 44.4, 10.6, 45.6];

    beforeEach(() => {
      layerManager.layers.set('rpc-layer', {
        id: 'rpc-layer',
        type: 'raster',
        path: '/path/to/scene.tif',
        visible: true,
        georef_method: 'rpc',
        bounds: [9.5, 44.5, 10.5, 45.5],
      });
      layerManager.layers.set('rpc-comp', {
        id: 'rpc-comp',
        type: 'raster',
        isComposition: true,
        sourceLayerId: 'rpc-layer',
      });
      layerManager.layers.set('other', { id: 'other', type: 'raster' });
      layerManager.refreshLayerTiles = vi.fn();
      layerManager.updateDynamicControls = vi.fn();
      invoke.mockResolvedValue(newBounds);

      // Map state: rpc-layer sits below rpc-comp, half transparent, hidden.
      const { map } = mockMapManager;
      map.getSource.mockImplementation(id => ({
        tiles: [`${id.replace('raster-source-', 'raster-')}://{z}/{x}/{y}?v=1`],
      }));
      map.getLayer.mockReturnValue({});
      map.getStyle = vi.fn(() => ({
        layers: [
          { id: 'basemap' },
          { id: 'raster-layer-rpc-layer' },
          { id: 'raster-layer-rpc-comp' },
        ],
      }));
      map.getPaintProperty = vi.fn(() => 0.5);
      map.getLayoutProperty = vi.fn(() => 'none');
      map.triggerRepaint = vi.fn();
    });

    it('should send a local DEM and height to the backend', async () => {
      await layerManager.setRpcElevation('rpc-layer', {
        source: 'file',
        demPath: '/dem.tif',
        height: 120,
      });
      expect(invoke).toHaveBeenCalledWith('set_rpc_elevation', {
        id: 'rpc-layer',
        demPath: '/dem.tif',
        height: 120,
        demHeightOffset: null,
      });
    });

    it('should drop the DEM path for constant height', async () => {
      await layerManager.setRpcElevation('rpc-layer', {
        source: 'none',
        demPath: '/stale.tif',
        height: 50,
      });
      expect(invoke).toHaveBeenCalledWith('set_rpc_elevation', {
        id: 'rpc-layer',
        demPath: null,
        height: 50,
        demHeightOffset: null,
      });
    });

    it('should store elevation and updated footprint on the layer', async () => {
      await layerManager.setRpcElevation('rpc-layer', {
        source: 'file',
        demPath: '/dem.tif',
        height: null,
      });
      const layer = layerManager.layers.get('rpc-layer');
      expect(layer.rpcElevation).toEqual({
        source: 'file',
        demPath: '/dem.tif',
        height: null,
        demHeightOffset: null,
      });
      expect(layer.bounds).toEqual(newBounds);
    });

    it('should apply the online DEM with its geoid offset', async () => {
      invoke.mockResolvedValue({
        dem_path: '/cache/copernicus_glo30_-98_32.vrt',
        dem_height_offset: -28.8,
        bounds: newBounds,
      });
      const ok = await layerManager.setRpcElevation('rpc-layer', {
        source: 'online',
        demPath: null,
        height: 150,
      });
      expect(ok).toBe(true);
      expect(invoke).toHaveBeenCalledWith('use_online_dem', { id: 'rpc-layer', height: 150 });
      const layer = layerManager.layers.get('rpc-layer');
      expect(layer.rpcElevation).toEqual({
        source: 'online',
        demPath: '/cache/copernicus_glo30_-98_32.vrt',
        height: 150,
        demHeightOffset: -28.8,
      });
      expect(layer.bounds).toEqual(newBounds);
    });

    it('should warn when the online DEM has no geoid correction', async () => {
      invoke.mockResolvedValue({ dem_path: '/c.vrt', dem_height_offset: null, bounds: newBounds });
      await layerManager.setRpcElevation('rpc-layer', {
        source: 'online',
        demPath: null,
        height: null,
      });
      expect(showToast).toHaveBeenCalledWith(
        expect.stringContaining('Geoid correction unavailable'),
        'info',
        5000
      );
    });

    it('should rebuild the map sources of the layer and its compositions with the new footprint', async () => {
      await layerManager.setRpcElevation('rpc-layer', {
        source: 'none',
        demPath: null,
        height: 50,
      });
      const { map } = mockMapManager;

      expect(map.removeSource).toHaveBeenCalledWith('raster-source-rpc-layer');
      expect(map.removeSource).toHaveBeenCalledWith('raster-source-rpc-comp');
      expect(map.removeSource).not.toHaveBeenCalledWith('raster-source-other');

      const [, layerSource] = map.addSource.mock.calls.find(
        ([id]) => id === 'raster-source-rpc-layer'
      );
      expect(layerSource.tiles[0]).toMatch(/^raster-rpc-layer:\/\/\{z\}\/\{x\}\/\{y\}\?v=\d+$/);
      // New footprint, padded so a further terrain change stays inside.
      expect(layerSource.bounds[0]).toBeLessThan(newBounds[0]);
      expect(layerSource.bounds[2]).toBeGreaterThan(newBounds[2]);

      const [layerSpec, beforeId] = map.addLayer.mock.calls.find(
        ([spec]) => spec.id === 'raster-layer-rpc-layer'
      );
      expect(beforeId).toBe('raster-layer-rpc-comp');
      expect(layerSpec.paint['raster-opacity']).toBe(0.5);
      expect(layerSpec.layout.visibility).toBe('none');

      expect(layerManager.layers.get('rpc-comp').bounds).toEqual(newBounds);
      expect(map.triggerRepaint).toHaveBeenCalled();
      expect(showToast).toHaveBeenCalledWith('Re-projected with constant height', 'success', 2000);
    });

    it('should keep previous settings when the backend rejects', async () => {
      invoke.mockRejectedValue(new Error('Failed to open DEM'));
      const ok = await layerManager.setRpcElevation('rpc-layer', {
        source: 'file',
        demPath: '/bad.tif',
        height: null,
      });
      expect(ok).toBe(false);
      const layer = layerManager.layers.get('rpc-layer');
      expect(layer.rpcElevation).toBeUndefined();
      expect(layer.bounds).toEqual([9.5, 44.5, 10.5, 45.5]);
      expect(mockMapManager.map.removeSource).not.toHaveBeenCalled();
      expect(showError).toHaveBeenCalled();
    });

    it('should fall back quietly to constant height when the online DEM is unreachable', async () => {
      invoke.mockRejectedValue(new Error('No Copernicus DEM tiles for this area'));
      await applyDefaultRpcElevation(layerManager, 'rpc-layer');
      expect(invoke).toHaveBeenCalledWith('use_online_dem', { id: 'rpc-layer', height: null });
      expect(showError).not.toHaveBeenCalled();
      expect(showToast).toHaveBeenCalledWith(
        expect.stringContaining('Online DEM unavailable'),
        'info',
        5000
      );
      expect(layerManager.layers.get('rpc-layer').rpcElevation).toBeUndefined();
    });

    it('should ignore non-RPC layers', async () => {
      await layerManager.setRpcElevation('other', {
        source: 'file',
        demPath: '/dem.tif',
        height: null,
      });
      expect(invoke).not.toHaveBeenCalledWith('set_rpc_elevation', expect.anything());
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
