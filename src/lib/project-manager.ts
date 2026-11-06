/**
 * Project Manager - Save and load project sessions
 *
 * Handles saving and loading of Heimdall project files (.heimdall),
 * which preserve the complete state of a mapping session including:
 * - Map view (center, zoom, bearing, pitch)
 * - Loaded layers in order, with their display settings (band, stretch,
 *   colormap, RGB bands, band math, adjustments, vector style and filters)
 * - Layers derived from others: RGB compositions and band math layers
 * - Annotations (markers, lines, polygons)
 *
 * Layers are reopened from their file paths, so a project only works where
 * those files are.
 *
 * @module project-manager
 */

import { save, open } from '@tauri-apps/plugin-dialog';
import { writeTextFile, readTextFile } from '@tauri-apps/plugin-fs';
import { showToast, showError, showLoading, hideLoading } from './notifications';
import { logger } from './logger';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type {
  BandMathSettings,
  CrossLayerRgbConfig,
  DisplayMode,
  Layer,
  RasterAdjust,
  RasterLayer,
  RgbBands,
  RgbStretchSettings,
  StretchPreset,
  StretchSettings,
  VectorLayer,
  VectorStyle,
} from './layer-manager/types';
import type { ColormapName } from './layer-manager/colormaps';

const PROJECT_VERSION = '2.0';

const log = logger.child('ProjectManager');

/** The MapManager members a project uses */
export interface ProjectMapManager {
  map: MapLibreMap;
  getBasemap: () => string;
  setBasemap: (type: string) => void;
  terrainEnabled: boolean;
  terrainExaggeration: number;
  enableTerrain: () => void;
  disableTerrain: () => void;
  setTerrainExaggeration: (value: number) => void;
  isPixelCoordMode: () => boolean;
  resetView: () => void;
}

/** The LayerManager members a project uses */
export interface ProjectLayerManager {
  layers: Map<string, Layer>;
  layerOrder: string[];
  addRasterLayer: (filePath: string) => Promise<RasterLayer>;
  addVectorLayer: (filePath: string) => Promise<VectorLayer>;
  removeLayer: (id: string) => Promise<void>;
  renameLayer: (id: string, name: string) => void;
  setLayerOpacity: (id: string, opacity: number) => void;
  toggleLayerVisibility: (id: string) => void;
  setLayerAdjust: (id: string, patch: Partial<RasterAdjust>) => void;
  setLayerEqualize: (id: string, enabled: boolean) => Promise<void>;
  setVectorStyle: (id: string, property: keyof VectorStyle, value: string | number) => void;
  setColorByField: (id: string, fieldName: string | null) => void;
  setVectorFeatureFilter: (
    id: string,
    fieldName: string,
    allowedValues: Array<string | number> | null
  ) => void;
  createRgbCompositionLayer: (sourceLayerId: string) => Promise<string | null>;
  createCrossLayerRgbCompositionLayer: (sourceLayerId: string) => Promise<string | null>;
  createBandMathLayer: (
    sourceLayerId: string,
    settings: Omit<BandMathSettings, 'range'>
  ) => Promise<string>;
  refreshLayerTiles: (id: string) => void;
  applyLayerOrder: () => void;
  updateLayerPanel: () => void;
  updateDynamicControls: () => void;
}

// Interface for AnnotationTool
interface SerializedAnnotation {
  id: string;
  type: 'marker' | 'line' | 'polygon';
  label: string;
  coordinates: [number, number] | [number, number][];
}

interface AnnotationTool {
  getAnnotations: () => SerializedAnnotation[];
  loadAnnotations: (annotations: SerializedAnnotation[]) => void;
  clearAll: () => void;
  getCount: () => number;
}

// Project data structures
interface ViewData {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
  basemap: string;
  terrainEnabled: boolean;
  terrainExaggeration: number;
  pixelCoordMode: boolean;
}

/** How a raster layer was made: opened from a file, or derived from another layer */
export type RasterLayerKind = 'file' | 'rgbComposition' | 'crossLayerComposition' | 'bandMath';

/** Raster display settings, all optional so older or partial files load */
export interface RasterDisplayData {
  displayMode?: DisplayMode;
  band?: number;
  colormap?: ColormapName;
  stretch?: StretchSettings;
  stretchPreset?: StretchPreset;
  equalize?: boolean;
  bandMath?: BandMathSettings | null;
  rgbBands?: RgbBands;
  rgbStretch?: RgbStretchSettings;
  crossLayerRgb?: CrossLayerRgbConfig;
  adjust?: RasterAdjust;
}

export interface RasterLayerData {
  id: string;
  type: 'raster';
  name?: string;
  path: string;
  visible: boolean;
  opacity: number;
  kind?: RasterLayerKind;
  /** Saved ID of the layer a derived layer reads */
  sourceId?: string;
  display?: RasterDisplayData;
  // Version 1.0 fields
  filePath?: string;
  band?: number;
  colormap?: string;
  stretchMin?: number;
  stretchMax?: number;
}

export interface VectorLayerData {
  id: string;
  type: 'vector';
  name?: string;
  path: string;
  visible: boolean;
  opacity: number;
  style?: Partial<VectorStyle>;
  // Version 1.0 field
  filePath?: string;
}

export type LayerData = RasterLayerData | VectorLayerData;

// Empty for now - add any persistent settings here
type ProjectSettings = Record<string, never>;

export interface ProjectData {
  version: string;
  savedAt: string;
  view: ViewData;
  layers: LayerData[];
  annotations: SerializedAnnotation[];
  settings: ProjectSettings;
}

const VECTOR_EXTENSIONS = ['shp', 'geojson', 'json', 'gpkg', 'kml', 'kmz', 'gml', 'gpx', 'fgb'];

const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

function rasterKind(layer: RasterLayer): RasterLayerKind {
  if (layer.isBandMathLayer) return 'bandMath';
  if (layer.isCrossLayerComposition) return 'crossLayerComposition';
  if (layer.isComposition) return 'rgbComposition';
  return 'file';
}

/** Layer name to restore, if it differs from the file name */
function layerName(layer: Layer): string | undefined {
  return layer.displayName || undefined;
}

/** Saved state of one layer */
export function serializeLayer(layer: Layer): LayerData {
  if (layer.type === 'vector') {
    return {
      id: layer.id,
      type: 'vector',
      name: layerName(layer),
      path: layer.path,
      visible: layer.visible,
      opacity: layer.opacity,
      style: clone(layer.style),
    };
  }
  return {
    id: layer.id,
    type: 'raster',
    name: layerName(layer),
    path: layer.path,
    visible: layer.visible,
    opacity: layer.opacity,
    kind: rasterKind(layer),
    sourceId: layer.sourceLayerId,
    display: clone({
      displayMode: layer.displayMode,
      band: layer.band,
      colormap: layer.colormap,
      stretch: layer.stretch,
      stretchPreset: layer.stretchPreset,
      equalize: layer.equalize,
      bandMath: layer.bandMath ?? null,
      rgbBands: layer.rgbBands,
      rgbStretch: layer.rgbStretch,
      crossLayerRgb: layer.crossLayerRgb,
      adjust: layer.adjust,
    }),
  };
}

/** Bring a version 1.0 layer entry to the current shape */
export function upgradeLayerData(data: LayerData): LayerData {
  const path = data.path ?? data.filePath ?? '';
  if (data.type !== 'raster' || data.display) return { ...data, path };
  const display: RasterDisplayData = {};
  if (data.band) display.band = data.band;
  if (data.colormap) display.colormap = data.colormap as ColormapName;
  if (data.stretchMin !== undefined || data.stretchMax !== undefined) {
    display.stretch = { min: data.stretchMin ?? 0, max: data.stretchMax ?? 255, gamma: 1 };
  }
  return { ...data, path, kind: data.kind ?? 'file', display };
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function validStretch(s: StretchSettings | undefined): s is StretchSettings {
  return !!s && isFiniteNumber(s.min) && isFiniteNumber(s.max) && isFiniteNumber(s.gamma);
}

/**
 * ProjectManager handles saving and loading of Heimdall project files.
 *
 * Projects are JSON files that store the complete application state,
 * allowing users to save their work and resume later with all layers,
 * annotations, and settings preserved.
 *
 * @example
 * ```typescript
 * const projectManager = new ProjectManager(mapManager, layerManager, annotationTool);
 *
 * // Save current project
 * await projectManager.saveProject();
 *
 * // Load a project file
 * await projectManager.loadProject('/path/to/project.heimdall');
 *
 * // Create new empty project
 * await projectManager.newProject();
 * ```
 */
export class ProjectManager {
  private mapManager: ProjectMapManager;
  private layerManager: ProjectLayerManager;
  private annotationTool: AnnotationTool | null;
  private currentProjectPath: string | null;

  /**
   * Create a new ProjectManager instance
   * @param mapManager - The MapManager instance for view state
   * @param layerManager - The LayerManager instance for layer state
   * @param annotationTool - Optional AnnotationTool for annotation state
   */
  constructor(
    mapManager: ProjectMapManager,
    layerManager: ProjectLayerManager,
    annotationTool: AnnotationTool | null = null
  ) {
    this.mapManager = mapManager;
    this.layerManager = layerManager;
    this.annotationTool = annotationTool;
    this.currentProjectPath = null;
  }

  /**
   * Save the current project to a file
   *
   * If no path is provided, shows a save dialog for the user to choose location.
   * Saves all layers, annotations, view state, and settings to a JSON file.
   *
   * @param filePath - Optional path to save to (shows dialog if null)
   * @returns The path where the file was saved, or null if cancelled
   */
  async saveProject(filePath: string | null = null): Promise<string | null> {
    try {
      // If no path provided, show save dialog
      if (!filePath) {
        filePath = await save({
          filters: [
            {
              name: 'Heimdall Project',
              extensions: ['heimdall', 'json'],
            },
          ],
          defaultPath: this.currentProjectPath ?? 'project.heimdall',
        });
      }

      if (!filePath) return null; // User cancelled

      showLoading('Saving project...');

      const projectData = this.serializeProject();
      const jsonString = JSON.stringify(projectData, null, 2);

      await writeTextFile(filePath, jsonString);
      this.currentProjectPath = filePath;

      hideLoading();
      showToast('Project saved', 'success');

      return filePath;
    } catch (error) {
      hideLoading();
      log.error('Failed to save project', { error: String(error) });
      showError('Save failed', error instanceof Error ? error : String(error));
      return null;
    }
  }

  /**
   * Load a project from a file
   *
   * If no path is provided, shows an open dialog for the user to select a file.
   * Clears the current project state and restores all layers, annotations,
   * view state, and settings from the file.
   *
   * @param filePath - Optional path to load from (shows dialog if null)
   * @returns True if project was loaded successfully, false if cancelled or failed
   */
  async loadProject(filePath: string | null = null): Promise<boolean> {
    try {
      // If no path provided, show open dialog
      if (!filePath) {
        const selected = await open({
          filters: [
            {
              name: 'Heimdall Project',
              extensions: ['heimdall', 'json'],
            },
          ],
          multiple: false,
        });
        filePath = selected as string | null;
      }

      if (!filePath) return false; // User cancelled

      showLoading('Loading project...');

      const jsonString = await readTextFile(filePath);
      const projectData = JSON.parse(jsonString) as ProjectData;

      // Validate project version
      if (!projectData || typeof projectData !== 'object' || !projectData.version) {
        throw new Error('Invalid project file format');
      }

      const failed = await this.deserializeProject(projectData);
      this.currentProjectPath = filePath;

      hideLoading();
      if (failed.length > 0) {
        showToast(
          `Project loaded, ${failed.length} layer(s) missing: ${failed.join(', ')}`,
          'error',
          6000
        );
      } else {
        showToast('Project loaded', 'success');
      }

      return true;
    } catch (error) {
      hideLoading();
      log.error('Failed to load project', { error: String(error) });
      showError('Load failed', error instanceof Error ? error : String(error));
      return false;
    }
  }

  /** The current state as project data */
  serializeProject(): ProjectData {
    return {
      version: PROJECT_VERSION,
      savedAt: new Date().toISOString(),
      view: this.serializeView(),
      layers: this.serializeLayers(),
      annotations: this.serializeAnnotations(),
      settings: this.serializeSettings(),
    };
  }

  private serializeView(): ViewData {
    const { map } = this.mapManager;
    return {
      center: map.getCenter().toArray() as [number, number],
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
      basemap: this.mapManager.getBasemap(),
      terrainEnabled: this.mapManager.terrainEnabled,
      terrainExaggeration: this.mapManager.terrainExaggeration,
      pixelCoordMode: this.mapManager.isPixelCoordMode(),
    };
  }

  /** Layers bottom to top */
  private serializeLayers(): LayerData[] {
    const { layers, layerOrder } = this.layerManager;
    return layerOrder
      .map(id => layers.get(id))
      .filter((layer): layer is Layer => !!layer)
      .map(serializeLayer);
  }

  private serializeAnnotations(): SerializedAnnotation[] {
    if (!this.annotationTool) return [];
    return this.annotationTool.getAnnotations();
  }

  private serializeSettings(): ProjectSettings {
    return {
      // Add any other persistent settings here
    };
  }

  /**
   * Replace the current state with a project's.
   * @returns Names of the layers that couldn't be restored
   */
  async deserializeProject(data: ProjectData): Promise<string[]> {
    // Clear existing state
    await this.clearCurrentProject();

    // Basemap first: pixel mode decides how layers are placed
    if (data.view) {
      this.deserializeBasemap(data.view);
    }

    // Restore layers (they fit the map to themselves as they open)
    const failed =
      Array.isArray(data.layers) && data.layers.length > 0
        ? await this.deserializeLayers(data.layers)
        : [];

    // Then the saved view on top
    if (data.view) {
      this.deserializeView(data.view);
    }

    // Restore annotations
    if (data.annotations && data.annotations.length > 0) {
      this.deserializeAnnotations(data.annotations);
    }

    // Restore settings
    if (data.settings) {
      this.deserializeSettings(data.settings);
    }
    return failed;
  }

  /**
   * Clear the current project, removing all layers and annotations
   * Resets the project path to null
   */
  async clearCurrentProject(): Promise<void> {
    // Top first, so derived layers go before the layers they read
    const layerIds = [...this.layerManager.layerOrder].reverse();
    for (const id of layerIds) {
      await this.layerManager.removeLayer(id);
    }

    // Clear annotations
    if (this.annotationTool) {
      this.annotationTool.clearAll();
    }

    this.currentProjectPath = null;
  }

  private deserializeBasemap(view: ViewData): void {
    if (view.pixelCoordMode) {
      this.mapManager.setBasemap('pixel');
    } else if (view.basemap) {
      this.mapManager.setBasemap(view.basemap);
      const basemapSelect = document.getElementById('basemap-select') as HTMLSelectElement | null;
      if (basemapSelect) basemapSelect.value = view.basemap;
    }
  }

  private deserializeView(view: ViewData): void {
    // Set view state
    if (view.center && view.zoom !== undefined) {
      this.mapManager.map.jumpTo({
        center: view.center,
        zoom: view.zoom,
        bearing: view.bearing || 0,
        pitch: view.pitch || 0,
      });
    }

    // Set terrain
    if (view.terrainEnabled) {
      this.mapManager.enableTerrain();
      if (view.terrainExaggeration) {
        this.mapManager.setTerrainExaggeration(view.terrainExaggeration);
        const slider = document.getElementById('exaggeration-slider') as HTMLInputElement | null;
        const value = document.getElementById('exaggeration-value');
        if (slider) slider.value = String(view.terrainExaggeration);
        if (value) value.textContent = view.terrainExaggeration.toFixed(1);
      }
      const terrainToggle = document.getElementById('terrain-toggle') as HTMLInputElement | null;
      const terrainExaggeration = document.getElementById('terrain-exaggeration');
      if (terrainToggle) terrainToggle.checked = true;
      if (terrainExaggeration) terrainExaggeration.classList.remove('hidden');
    }
  }

  /**
   * Reopen file layers, then rebuild derived layers from them, then restore
   * the saved order. Layer IDs change on reload, so references go through
   * a saved-to-new ID map.
   * @returns Names of the layers that couldn't be restored
   */
  private async deserializeLayers(saved: LayerData[]): Promise<string[]> {
    const lm = this.layerManager;
    const entries = saved.filter(d => d && typeof d === 'object').map(upgradeLayerData);
    const newIds = new Map<string, string>();
    const failed: string[] = [];
    const label = (d: LayerData) => d.name || d.path.split(/[/\\]/).pop() || d.id;

    const isFileLayer = (d: LayerData) => d.type === 'vector' || !d.kind || d.kind === 'file';

    for (const data of entries.filter(isFileLayer)) {
      try {
        if (!data.path) throw new Error('No file path');
        const ext = data.path.split('.').pop()?.toLowerCase() || '';
        const layer =
          data.type === 'vector' || VECTOR_EXTENSIONS.includes(ext)
            ? await lm.addVectorLayer(data.path)
            : await lm.addRasterLayer(data.path);
        newIds.set(data.id, layer.id);
      } catch (error) {
        log.warn('Failed to restore layer', { path: data.path, error: String(error) });
        failed.push(label(data));
      }
    }

    // Cross-layer RGB references other layers by ID
    const remapCross = (cross: CrossLayerRgbConfig | undefined) => {
      if (!cross) return undefined;
      const r = newIds.get(cross.rLayerId);
      const g = newIds.get(cross.gLayerId);
      const b = newIds.get(cross.bLayerId);
      return r && g && b ? { ...cross, rLayerId: r, gLayerId: g, bLayerId: b } : undefined;
    };

    for (const data of entries.filter(d => !isFileLayer(d)) as RasterLayerData[]) {
      try {
        const id = await this.createDerivedLayer(data, newIds, remapCross);
        newIds.set(data.id, id);
      } catch (error) {
        log.warn('Failed to restore layer', { layer: label(data), error: String(error) });
        failed.push(label(data));
      }
    }

    // Display settings, names, visibility and opacity
    for (const data of entries) {
      const id = newIds.get(data.id);
      if (!id) continue;
      try {
        if (data.type === 'raster' && data.display) {
          await this.applyRasterDisplay(id, data.display, remapCross);
        } else if (data.type === 'vector' && data.style) {
          this.applyVectorStyle(id, data.style);
        }
        if (data.name) lm.renameLayer(id, data.name);
        if (isFiniteNumber(data.opacity) && data.opacity !== 1) {
          lm.setLayerOpacity(id, data.opacity);
        }
        if (data.visible === false) lm.toggleLayerVisibility(id);
      } catch (error) {
        log.warn('Failed to restore layer settings', { layer: label(data), error: String(error) });
      }
    }

    // Saved order, bottom to top; anything else stays on top
    const ordered = entries.map(d => newIds.get(d.id)).filter((id): id is string => !!id);
    const rest = lm.layerOrder.filter(id => !ordered.includes(id));
    lm.layerOrder.splice(0, lm.layerOrder.length, ...ordered, ...rest);
    lm.applyLayerOrder();
    lm.updateLayerPanel();
    lm.updateDynamicControls();
    return failed;
  }

  private async createDerivedLayer(
    data: RasterLayerData,
    newIds: Map<string, string>,
    remapCross: (cross: CrossLayerRgbConfig | undefined) => CrossLayerRgbConfig | undefined
  ): Promise<string> {
    const lm = this.layerManager;
    if (data.kind === 'crossLayerComposition') {
      const cross = remapCross(data.display?.crossLayerRgb);
      const host = cross && (lm.layers.get(cross.rLayerId) as RasterLayer | undefined);
      if (!cross || !host) throw new Error('Source layers missing');
      // The composition is built from a layer's cross-layer setting
      const previous = host.crossLayerRgb;
      host.crossLayerRgb = cross;
      try {
        const id = await lm.createCrossLayerRgbCompositionLayer(host.id);
        if (!id) throw new Error('Composition failed');
        return id;
      } finally {
        host.crossLayerRgb = previous;
      }
    }

    const sourceId = data.sourceId && newIds.get(data.sourceId);
    if (!sourceId) throw new Error('Source layer missing');
    if (data.kind === 'bandMath') {
      const math = data.display?.bandMath;
      if (!math?.expression) throw new Error('No expression');
      return lm.createBandMathLayer(sourceId, {
        expression: math.expression,
        template: math.template,
        a: math.a,
        b: math.b,
      });
    }
    const id = await lm.createRgbCompositionLayer(sourceId);
    if (!id) throw new Error('Composition failed');
    return id;
  }

  /** Set saved raster display settings, keeping the layer's own where invalid */
  private async applyRasterDisplay(
    id: string,
    display: RasterDisplayData,
    remapCross: (cross: CrossLayerRgbConfig | undefined) => CrossLayerRgbConfig | undefined
  ): Promise<void> {
    const lm = this.layerManager;
    const layer = lm.layers.get(id) as RasterLayer | undefined;
    if (!layer || layer.type !== 'raster') return;
    // RGB compositions are 3 bands wide but pick from their source's bands
    const source = layer.isComposition && layer.sourceLayerId && lm.layers.get(layer.sourceLayerId);
    const bandCount = source && source.type === 'raster' ? source.bands : layer.bands;
    const validBand = (b: unknown): b is number =>
      Number.isInteger(b) && (b as number) >= 1 && (b as number) <= bandCount;

    if (validBand(display.band)) layer.band = display.band;
    if (display.colormap) layer.colormap = display.colormap;
    if (validStretch(display.stretch)) layer.stretch = { ...display.stretch };
    if (display.stretchPreset) layer.stretchPreset = display.stretchPreset;
    const rgb = display.rgbBands;
    if (rgb && validBand(rgb.r) && validBand(rgb.g) && validBand(rgb.b)) {
      layer.rgbBands = { ...rgb };
    }
    const { rgbStretch } = display;
    if (rgbStretch && validStretch(rgbStretch.r) && validStretch(rgbStretch.g)) {
      if (validStretch(rgbStretch.b)) layer.rgbStretch = structuredClone(rgbStretch);
    }
    if (!layer.isComposition) {
      const math = display.bandMath;
      layer.bandMath = math?.expression && Array.isArray(math.range) ? structuredClone(math) : null;
    }
    const cross = remapCross(display.crossLayerRgb);
    if (cross) layer.crossLayerRgb = cross;

    const mode = display.displayMode;
    if (mode === 'grayscale' || (mode === 'rgb' && layer.bands >= 3)) {
      layer.displayMode = mode;
    } else if (mode === 'crossLayerRgb' && layer.crossLayerRgb) {
      layer.displayMode = mode;
    }

    if (display.adjust) lm.setLayerAdjust(id, display.adjust);
    if (display.equalize && !layer.bandMath) {
      await lm.setLayerEqualize(id, true);
    } else {
      layer.equalize = false;
      lm.refreshLayerTiles(id);
    }
  }

  private applyVectorStyle(id: string, style: Partial<VectorStyle>): void {
    const lm = this.layerManager;
    const keys = ['fillColor', 'fillOpacity', 'strokeColor', 'strokeWidth', 'pointRadius'] as const;
    for (const key of keys) {
      const value = style[key];
      if (typeof value === 'string' || isFiniteNumber(value)) lm.setVectorStyle(id, key, value);
    }
    for (const [field, values] of Object.entries(style.featureFilters ?? {})) {
      if (Array.isArray(values)) lm.setVectorFeatureFilter(id, field, values);
    }
    if (style.colorByField) lm.setColorByField(id, style.colorByField);
  }

  private deserializeAnnotations(annotations: SerializedAnnotation[]): void {
    if (this.annotationTool && annotations.length > 0) {
      this.annotationTool.loadAnnotations(annotations);
    }
  }

  private deserializeSettings(_settings: ProjectSettings): void {
    // Apply any saved settings
  }

  /**
   * Check if there are unsaved changes in the current project
   *
   * Returns true if there are any layers loaded or annotations created
   * that haven't been saved to a project file.
   *
   * @returns True if there are unsaved changes
   */
  hasUnsavedChanges(): boolean {
    // Simple check - could be made more sophisticated
    return (
      this.layerManager.layers.size > 0 ||
      (this.annotationTool !== null && this.annotationTool.getCount() > 0)
    );
  }

  /**
   * Get the file path of the currently open project
   * @returns Path to current project file, or null if no project is open
   */
  getCurrentProjectPath(): string | null {
    return this.currentProjectPath;
  }

  /**
   * Create a new empty project
   *
   * Clears all layers and annotations, resets the map view to defaults.
   * Shows a warning if there are unsaved changes (in a full implementation).
   */
  async newProject(): Promise<void> {
    if (this.hasUnsavedChanges()) {
      // In a real app, you'd prompt to save first
    }
    await this.clearCurrentProject();
    this.mapManager.resetView();
    showToast('New project created', 'info');
  }
}
