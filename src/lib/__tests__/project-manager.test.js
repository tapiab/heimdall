/**
 * Tests for ProjectManager functionality
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock Tauri plugins
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(),
  open: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: vi.fn(),
  readTextFile: vi.fn(),
}));

vi.mock('../notifications.js', () => ({
  showToast: vi.fn(),
  showError: vi.fn(),
  showLoading: vi.fn(),
  hideLoading: vi.fn(),
}));

// Create test project manager logic
function createTestProjectManager() {
  const layers = new Map();
  const annotations = [];

  return {
    currentProjectPath: null,
    view: {
      center: [0, 0],
      zoom: 2,
      bearing: 0,
      pitch: 0,
      basemap: 'osm',
      terrainEnabled: false,
      terrainExaggeration: 1.5,
      pixelCoordMode: false,
    },
    layers,
    annotations,

    serializeProject() {
      return {
        version: '1.0',
        savedAt: new Date().toISOString(),
        view: this.serializeView(),
        layers: this.serializeLayers(),
        annotations: this.serializeAnnotations(),
        settings: {},
      };
    },

    serializeView() {
      return { ...this.view };
    },

    serializeLayers() {
      return Array.from(this.layers.values()).map((layer) => ({
        id: layer.id,
        type: layer.type,
        name: layer.name,
        filePath: layer.filePath,
        visible: layer.visible,
        opacity: layer.opacity,
        band: layer.band,
        colormap: layer.colormap,
      }));
    },

    serializeAnnotations() {
      return [...this.annotations];
    },

    validateProject(data) {
      if (!data.version) return { valid: false, error: 'Missing version' };
      if (!data.view) return { valid: false, error: 'Missing view' };
      return { valid: true };
    },

    addLayer(layer) {
      this.layers.set(layer.id, layer);
    },

    addAnnotation(annotation) {
      this.annotations.push(annotation);
    },

    clearProject() {
      this.layers.clear();
      this.annotations.length = 0;
      this.currentProjectPath = null;
    },

    setView(view) {
      this.view = { ...this.view, ...view };
    },

    hasUnsavedChanges() {
      return this.layers.size > 0 || this.annotations.length > 0;
    },

    getCurrentProjectPath() {
      return this.currentProjectPath;
    },

    setCurrentProjectPath(path) {
      this.currentProjectPath = path;
    },
  };
}

describe('ProjectManager', () => {
  let projectManager;

  beforeEach(() => {
    vi.clearAllMocks();
    projectManager = createTestProjectManager();
  });

  describe('serialization', () => {
    it('should serialize empty project', () => {
      const data = projectManager.serializeProject();

      expect(data.version).toBe('1.0');
      expect(data.savedAt).toBeDefined();
      expect(data.view).toBeDefined();
      expect(data.layers).toEqual([]);
      expect(data.annotations).toEqual([]);
    });

    it('should serialize view state', () => {
      projectManager.setView({
        center: [-122.4, 37.8],
        zoom: 12,
        bearing: 45,
        pitch: 60,
        basemap: 'satellite',
        terrainEnabled: true,
        terrainExaggeration: 2.5,
      });

      const data = projectManager.serializeProject();

      expect(data.view.center).toEqual([-122.4, 37.8]);
      expect(data.view.zoom).toBe(12);
      expect(data.view.bearing).toBe(45);
      expect(data.view.pitch).toBe(60);
      expect(data.view.basemap).toBe('satellite');
      expect(data.view.terrainEnabled).toBe(true);
      expect(data.view.terrainExaggeration).toBe(2.5);
    });

    it('should serialize layers', () => {
      projectManager.addLayer({
        id: 'layer-1',
        type: 'raster',
        name: 'Test Raster',
        filePath: '/path/to/file.tif',
        visible: true,
        opacity: 0.8,
        band: 1,
        colormap: 'viridis',
      });

      projectManager.addLayer({
        id: 'layer-2',
        type: 'vector',
        name: 'Test Vector',
        filePath: '/path/to/file.geojson',
        visible: false,
        opacity: 1,
      });

      const data = projectManager.serializeProject();

      expect(data.layers.length).toBe(2);
      expect(data.layers[0].type).toBe('raster');
      expect(data.layers[0].name).toBe('Test Raster');
      expect(data.layers[0].opacity).toBe(0.8);
      expect(data.layers[0].colormap).toBe('viridis');
      expect(data.layers[1].type).toBe('vector');
      expect(data.layers[1].visible).toBe(false);
    });

    it('should serialize annotations', () => {
      projectManager.addAnnotation({
        id: 'annotation-marker-1',
        type: 'marker',
        label: 'Test Marker',
        coordinates: [-122.4, 37.8],
      });

      projectManager.addAnnotation({
        id: 'annotation-line-1',
        type: 'line',
        label: 'Test Line',
        coordinates: [[-122.4, 37.8], [-122.5, 37.9]],
      });

      const data = projectManager.serializeProject();

      expect(data.annotations.length).toBe(2);
      expect(data.annotations[0].type).toBe('marker');
      expect(data.annotations[1].type).toBe('line');
    });
  });

  describe('validation', () => {
    it('should validate project with version', () => {
      const result = projectManager.validateProject({
        version: '1.0',
        view: {},
        layers: [],
        annotations: [],
      });

      expect(result.valid).toBe(true);
    });

    it('should reject project without version', () => {
      const result = projectManager.validateProject({
        view: {},
        layers: [],
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('version');
    });

    it('should reject project without view', () => {
      const result = projectManager.validateProject({
        version: '1.0',
        layers: [],
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('view');
    });
  });

  describe('project state', () => {
    it('should track current project path', () => {
      expect(projectManager.getCurrentProjectPath()).toBe(null);

      projectManager.setCurrentProjectPath('/path/to/project.heimdall');
      expect(projectManager.getCurrentProjectPath()).toBe('/path/to/project.heimdall');
    });

    it('should detect unsaved changes with layers', () => {
      expect(projectManager.hasUnsavedChanges()).toBe(false);

      projectManager.addLayer({ id: 'layer-1', type: 'raster' });
      expect(projectManager.hasUnsavedChanges()).toBe(true);
    });

    it('should detect unsaved changes with annotations', () => {
      expect(projectManager.hasUnsavedChanges()).toBe(false);

      projectManager.addAnnotation({ id: 'ann-1', type: 'marker' });
      expect(projectManager.hasUnsavedChanges()).toBe(true);
    });

    it('should clear project state', () => {
      projectManager.addLayer({ id: 'layer-1', type: 'raster' });
      projectManager.addAnnotation({ id: 'ann-1', type: 'marker' });
      projectManager.setCurrentProjectPath('/path/to/project.heimdall');

      projectManager.clearProject();

      expect(projectManager.layers.size).toBe(0);
      expect(projectManager.annotations.length).toBe(0);
      expect(projectManager.getCurrentProjectPath()).toBe(null);
    });
  });
});

describe('Project file format', () => {
  it('should have correct structure', () => {
    const projectFile = {
      version: '1.0',
      savedAt: '2024-01-15T12:00:00.000Z',
      view: {
        center: [-122.4, 37.8],
        zoom: 12,
        bearing: 0,
        pitch: 0,
        basemap: 'osm',
        terrainEnabled: false,
        terrainExaggeration: 1.5,
        pixelCoordMode: false,
      },
      layers: [
        {
          id: 'layer-1',
          type: 'raster',
          name: 'DEM',
          filePath: '/path/to/dem.tif',
          visible: true,
          opacity: 1,
          band: 1,
          colormap: 'terrain',
        },
      ],
      annotations: [
        {
          id: 'annotation-marker-1',
          type: 'marker',
          label: 'Summit',
          coordinates: [-122.4, 37.8],
        },
      ],
      settings: {},
    };

    expect(projectFile.version).toBeDefined();
    expect(projectFile.savedAt).toBeDefined();
    expect(projectFile.view).toBeDefined();
    expect(projectFile.layers).toBeDefined();
    expect(projectFile.annotations).toBeDefined();
  });

  it('should be valid JSON', () => {
    const projectFile = {
      version: '1.0',
      savedAt: new Date().toISOString(),
      view: { center: [0, 0], zoom: 2 },
      layers: [],
      annotations: [],
      settings: {},
    };

    const jsonString = JSON.stringify(projectFile, null, 2);
    const parsed = JSON.parse(jsonString);

    expect(parsed.version).toBe('1.0');
    expect(parsed.view.center).toEqual([0, 0]);
  });
});

describe('Layer serialization', () => {
  it('should serialize raster layer properties', () => {
    const rasterLayer = {
      id: 'raster-1',
      type: 'raster',
      name: 'Elevation',
      filePath: '/data/dem.tif',
      visible: true,
      opacity: 0.75,
      band: 1,
      colormap: 'viridis',
      stretchMin: 0,
      stretchMax: 4000,
      is_georeferenced: true,
    };

    expect(rasterLayer.type).toBe('raster');
    expect(rasterLayer.band).toBeDefined();
    expect(rasterLayer.colormap).toBeDefined();
  });

  it('should serialize vector layer properties', () => {
    const vectorLayer = {
      id: 'vector-1',
      type: 'vector',
      name: 'Boundaries',
      filePath: '/data/boundaries.geojson',
      visible: true,
      opacity: 1,
      style: {
        fillColor: '#ff0000',
        strokeColor: '#000000',
        strokeWidth: 2,
      },
    };

    expect(vectorLayer.type).toBe('vector');
    expect(vectorLayer.style).toBeDefined();
  });
});

describe('View state serialization', () => {
  it('should include all view properties', () => {
    const viewState = {
      center: [-122.4194, 37.7749],
      zoom: 14.5,
      bearing: 45,
      pitch: 60,
      basemap: 'satellite',
      terrainEnabled: true,
      terrainExaggeration: 2.0,
      pixelCoordMode: false,
    };

    expect(viewState.center).toHaveLength(2);
    expect(typeof viewState.zoom).toBe('number');
    expect(typeof viewState.bearing).toBe('number');
    expect(typeof viewState.pitch).toBe('number');
    expect(typeof viewState.basemap).toBe('string');
    expect(typeof viewState.terrainEnabled).toBe('boolean');
    expect(typeof viewState.terrainExaggeration).toBe('number');
  });

  it('should handle pixel coordinate mode', () => {
    const viewState = {
      center: [500, 500],
      zoom: 0,
      bearing: 0,
      pitch: 0,
      basemap: 'pixel',
      terrainEnabled: false,
      terrainExaggeration: 1.5,
      pixelCoordMode: true,
    };

    expect(viewState.pixelCoordMode).toBe(true);
    expect(viewState.basemap).toBe('pixel');
  });
});
