/**
 * Save → load round trips through the real ProjectManager, against an
 * in-memory layer manager.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeTextFile, readTextFile } from '@tauri-apps/plugin-fs';
import {
  ProjectManager,
  type ProjectData,
  type ProjectLayerManager,
  type ProjectMapManager,
} from '../project-manager';
import type { Layer, RasterLayer, VectorLayer } from '../layer-manager/types';

vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ writeTextFile: vi.fn(), readTextFile: vi.fn() }));
vi.mock('../notifications', () => ({
  showToast: vi.fn(),
  showError: vi.fn(),
  showLoading: vi.fn(),
  hideLoading: vi.fn(),
}));

const stretch = (min: number, max: number, gamma = 1) => ({ min, max, gamma });

function rasterLayer(id: string, path: string): RasterLayer {
  return {
    id,
    path,
    type: 'raster',
    visible: true,
    opacity: 1,
    bounds: [0, 0, 1, 1],
    width: 100,
    height: 100,
    bands: 4,
    band_stats: [],
    is_georeferenced: true,
    displayMode: 'grayscale',
    band: 1,
    stretch: stretch(0, 255),
    rgbBands: { r: 1, g: 2, b: 3 },
    rgbStretch: { r: stretch(0, 255), g: stretch(0, 255), b: stretch(0, 255) },
  } as RasterLayer;
}

/** In-memory layer manager; `missing` paths fail to open */
function createLayerManager(missing: string[] = []) {
  let next = 0;
  const layers = new Map<string, Layer>();
  const layerOrder: string[] = [];
  const add = (layer: Layer) => {
    layers.set(layer.id, layer);
    layerOrder.push(layer.id);
    return layer;
  };
  const raster = (id: string) => layers.get(id) as RasterLayer;
  const lm: ProjectLayerManager = {
    layers,
    layerOrder,
    addRasterLayer: async path => {
      if (missing.includes(path)) throw new Error('not found');
      return add(rasterLayer(`r${next++}`, path)) as RasterLayer;
    },
    addVectorLayer: async path => {
      if (missing.includes(path)) throw new Error('not found');
      return add({
        id: `v${next++}`,
        path,
        type: 'vector',
        visible: true,
        opacity: 1,
        bounds: [0, 0, 1, 1],
        feature_count: 1,
        geometry_type: 'Point',
        fields: [],
        geojson: { type: 'FeatureCollection', features: [] },
        style: {
          fillColor: '#ff0000',
          fillOpacity: 0.5,
          strokeColor: '#ff0000',
          strokeWidth: 3,
          pointRadius: 6,
        },
      }) as VectorLayer;
    },
    removeLayer: async id => {
      layers.delete(id);
      const i = layerOrder.indexOf(id);
      if (i >= 0) layerOrder.splice(i, 1);
    },
    renameLayer: (id, name) => {
      layers.get(id)!.displayName = name;
    },
    setLayerOpacity: (id, opacity) => {
      layers.get(id)!.opacity = opacity;
    },
    toggleLayerVisibility: id => {
      const layer = layers.get(id)!;
      layer.visible = !layer.visible;
    },
    setLayerAdjust: (id, patch) => {
      const layer = raster(id);
      layer.adjust = { brightness: 0, contrast: 0, saturation: 0, resampling: 'linear', ...patch };
    },
    setLayerEqualize: async (id, enabled) => {
      raster(id).equalize = enabled;
    },
    setVectorStyle: (id, property, value) => {
      ((layers.get(id) as VectorLayer).style as unknown as Record<string, unknown>)[property] =
        value;
    },
    setColorByField: (id, field) => {
      (layers.get(id) as VectorLayer).style.colorByField = field;
    },
    setVectorFeatureFilter: (id, field, values) => {
      const { style } = layers.get(id) as VectorLayer;
      style.featureFilters = { ...style.featureFilters, [field]: values ?? [] };
    },
    createRgbCompositionLayer: async sourceId => {
      const source = raster(sourceId);
      return add({
        ...rasterLayer(`c${next++}`, `RGB Composite`),
        isComposition: true,
        sourceLayerId: sourceId,
        bands: 3,
        displayMode: 'rgb',
        rgbBands: { ...source.rgbBands },
      }).id;
    },
    createCrossLayerRgbCompositionLayer: async () => null,
    createBandMathLayer: async (sourceId, settings) =>
      add({
        ...rasterLayer(`m${next++}`, raster(sourceId).path),
        isBandMathLayer: true,
        sourceLayerId: sourceId,
        bandMath: { ...settings, range: [-1, 1] },
        stretch: stretch(-0.5, 0.5),
      }).id,
    refreshLayerTiles: vi.fn(),
    applyLayerOrder: vi.fn(),
    updateLayerPanel: vi.fn(),
    updateDynamicControls: vi.fn(),
  };
  return lm;
}

function createMapManager(): ProjectMapManager {
  return {
    map: {
      getCenter: () => ({ toArray: () => [2, 48] }),
      getZoom: () => 10,
      getBearing: () => 0,
      getPitch: () => 0,
      jumpTo: vi.fn(),
    } as unknown as ProjectMapManager['map'],
    getBasemap: () => 'osm',
    setBasemap: vi.fn(),
    terrainEnabled: false,
    terrainExaggeration: 1.5,
    enableTerrain: vi.fn(),
    disableTerrain: vi.fn(),
    setTerrainExaggeration: vi.fn(),
    isPixelCoordMode: () => false,
    resetView: vi.fn(),
  };
}

/** A session: image (band 3, viridis), band math over it, RGB composite, points */
async function buildSession(lm: ProjectLayerManager) {
  const image = await lm.addRasterLayer('/data/image.tif');
  image.band = 3;
  image.colormap = 'viridis';
  image.stretch = stretch(10, 200, 1.4);
  image.rgbBands = { r: 4, g: 3, b: 2 };
  image.adjust = { brightness: 0.2, contrast: 0, saturation: 0, resampling: 'nearest' };
  const ndvi = await lm.createBandMathLayer(image.id, {
    expression: '(b4 - b3) / (b4 + b3)',
    template: 'nd',
    a: 4,
    b: 3,
  });
  (lm.layers.get(ndvi) as RasterLayer).colormap = 'magma';
  lm.renameLayer(ndvi, 'NDVI');
  const rgb = await lm.createRgbCompositionLayer(image.id);
  lm.setLayerOpacity(rgb!, 0.5);
  const points = await lm.addVectorLayer('/data/points.geojson');
  lm.setVectorStyle(points.id, 'fillColor', '#00ff00');
  lm.toggleLayerVisibility(points.id);
  // Band math below its source
  lm.layerOrder.splice(lm.layerOrder.indexOf(ndvi), 1);
  lm.layerOrder.unshift(ndvi);
}

const saveToJson = (pm: ProjectManager) =>
  JSON.parse(JSON.stringify(pm.serializeProject())) as ProjectData;

describe('project save and load', () => {
  beforeEach(() => vi.clearAllMocks());

  it('restores layers, derived layers, settings and order', async () => {
    const before = createLayerManager();
    await buildSession(before);
    const data = saveToJson(new ProjectManager(createMapManager(), before));

    const after = createLayerManager();
    await after.addRasterLayer('/data/previous.tif');
    const mapManager = createMapManager();
    const failed = await new ProjectManager(mapManager, after).deserializeProject(data);

    expect(failed).toEqual([]);
    const layers = after.layerOrder.map(id => after.layers.get(id)!);
    expect(layers.map(l => l.displayName ?? l.path)).toEqual([
      'NDVI',
      '/data/image.tif',
      'RGB Composite',
      '/data/points.geojson',
    ]);
    const [ndvi, image, rgb, points] = layers as [
      RasterLayer,
      RasterLayer,
      RasterLayer,
      VectorLayer,
    ];

    expect(image.band).toBe(3);
    expect(image.colormap).toBe('viridis');
    expect(image.stretch).toEqual(stretch(10, 200, 1.4));
    expect(image.rgbBands).toEqual({ r: 4, g: 3, b: 2 });
    expect(image.adjust?.resampling).toBe('nearest');

    expect(ndvi.isBandMathLayer).toBe(true);
    expect(ndvi.sourceLayerId).toBe(image.id);
    expect(ndvi.bandMath?.expression).toBe('(b4 - b3) / (b4 + b3)');
    expect(ndvi.colormap).toBe('magma');

    expect(rgb.isComposition).toBe(true);
    expect(rgb.sourceLayerId).toBe(image.id);
    expect(rgb.opacity).toBe(0.5);
    // Copied from the source when created, before the source's bands were restored
    expect(rgb.rgbBands).toEqual({ r: 4, g: 3, b: 2 });

    expect(points.style.fillColor).toBe('#00ff00');
    expect(points.visible).toBe(false);
    expect(mapManager.map.jumpTo).toHaveBeenCalledWith(
      expect.objectContaining({ center: [2, 48], zoom: 10 })
    );
  });

  it('reports missing files and the layers built on them', async () => {
    const before = createLayerManager();
    await buildSession(before);
    const data = saveToJson(new ProjectManager(createMapManager(), before));

    const after = createLayerManager(['/data/image.tif']);
    const failed = await new ProjectManager(createMapManager(), after).deserializeProject(data);

    expect(failed).toEqual(['image.tif', 'NDVI', 'RGB Composite']);
    expect([...after.layers.values()].map(l => l.path)).toEqual(['/data/points.geojson']);
  });

  it('loads version 1.0 files', async () => {
    const lm = createLayerManager();
    const failed = await new ProjectManager(createMapManager(), lm).deserializeProject({
      version: '1.0',
      savedAt: '',
      view: undefined as unknown as ProjectData['view'],
      annotations: [],
      settings: {},
      layers: [
        {
          id: 'old',
          type: 'raster',
          name: 'Old',
          filePath: '/data/old.tif',
          visible: true,
          opacity: 0.8,
          band: 2,
          stretchMin: 5,
          stretchMax: 50,
        } as unknown as ProjectData['layers'][number],
      ],
    });

    expect(failed).toEqual([]);
    const layer = [...lm.layers.values()][0] as RasterLayer;
    expect(layer.path).toBe('/data/old.tif');
    expect(layer.displayName).toBe('Old');
    expect(layer.band).toBe(2);
    expect(layer.stretch).toEqual(stretch(5, 50));
    expect(layer.opacity).toBe(0.8);
  });

  it('saves and loads through the file system', async () => {
    const before = createLayerManager();
    await buildSession(before);
    const pm = new ProjectManager(createMapManager(), before);
    expect(await pm.saveProject('/tmp/p.heimdall')).toBe('/tmp/p.heimdall');

    const written = vi.mocked(writeTextFile).mock.calls[0][1] as string;
    vi.mocked(readTextFile).mockResolvedValue(written);
    const after = createLayerManager();
    expect(await new ProjectManager(createMapManager(), after).loadProject('/tmp/p.heimdall')).toBe(
      true
    );
    expect(after.layers.size).toBe(4);
  });
});
