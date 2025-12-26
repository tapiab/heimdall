/**
 * Project Manager - Save and load project sessions
 *
 * Handles saving and loading of Heimdall project files (.heimdall),
 * which preserve the complete state of a mapping session including:
 * - Map view (center, zoom, bearing, pitch)
 * - Loaded layers with their styling and settings
 * - Annotations (markers, lines, polygons)
 * - Application settings
 *
 * @module project-manager
 */

import { save, open } from '@tauri-apps/plugin-dialog';
import { writeTextFile, readTextFile } from '@tauri-apps/plugin-fs';
import { showToast, showError, showLoading, hideLoading } from './notifications';
import type { Map as MapLibreMap } from 'maplibre-gl';

const PROJECT_VERSION = '1.0';

// Interface for MapManager (will be fully typed when MapManager is migrated)
interface MapManager {
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

// Interface for LayerManager (will be fully typed when LayerManager is migrated)
interface RasterLayerData {
  id: string;
  type: 'raster';
  name: string;
  filePath: string;
  visible: boolean;
  opacity: number;
  band?: number;
  colormap?: string;
  stretchMin?: number;
  stretchMax?: number;
  is_georeferenced?: boolean;
}

interface VectorLayerData {
  id: string;
  type: 'vector';
  name: string;
  filePath: string;
  visible: boolean;
  opacity: number;
  style?: Record<string, unknown>;
}

type LayerData = RasterLayerData | VectorLayerData;

interface Layer {
  id: string;
  type: 'raster' | 'vector';
  name: string;
  filePath: string;
  visible: boolean;
  opacity: number;
  band?: number;
  colormap?: string;
  stretchMin?: number;
  stretchMax?: number;
  is_georeferenced?: boolean;
  style?: Record<string, unknown>;
}

interface LayerManager {
  layers: Map<string, Layer>;
  getLayerOrder: () => string[];
  addRasterLayer: (filePath: string) => Promise<Layer>;
  addVectorLayer: (filePath: string) => Promise<Layer>;
  removeLayer: (id: string) => void;
  renameLayer: (id: string, name: string) => void;
  setLayerOpacity: (id: string, opacity: number) => void;
  toggleLayerVisibility: (id: string) => void;
  setRasterBand: (id: string, band: number) => void;
  setColormap: (id: string, colormap: string) => void;
  setStretch: (id: string, min: number, max: number) => void;
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

// Empty for now - add any persistent settings here
type ProjectSettings = Record<string, never>;

interface ProjectData {
  version: string;
  savedAt: string;
  view: ViewData;
  layers: LayerData[];
  annotations: SerializedAnnotation[];
  settings: ProjectSettings;
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
  private mapManager: MapManager;
  private layerManager: LayerManager;
  private annotationTool: AnnotationTool | null;
  private currentProjectPath: string | null;

  /**
   * Create a new ProjectManager instance
   * @param mapManager - The MapManager instance for view state
   * @param layerManager - The LayerManager instance for layer state
   * @param annotationTool - Optional AnnotationTool for annotation state
   */
  constructor(
    mapManager: MapManager,
    layerManager: LayerManager,
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
          defaultPath: 'project.heimdall',
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
      console.error('Failed to save project:', error);
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
      if (!projectData.version) {
        throw new Error('Invalid project file format');
      }

      await this.deserializeProject(projectData);
      this.currentProjectPath = filePath;

      hideLoading();
      showToast('Project loaded', 'success');

      return true;
    } catch (error) {
      hideLoading();
      console.error('Failed to load project:', error);
      showError('Load failed', error instanceof Error ? error : String(error));
      return false;
    }
  }

  private serializeProject(): ProjectData {
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

  private serializeLayers(): LayerData[] {
    const layers: LayerData[] = [];
    const layerOrder = this.layerManager.getLayerOrder();

    for (const id of layerOrder) {
      const layer = this.layerManager.layers.get(id);
      if (!layer) continue;

      if (layer.type === 'raster') {
        const serialized: RasterLayerData = {
          id,
          type: 'raster',
          name: layer.name,
          filePath: layer.filePath,
          visible: layer.visible,
          opacity: layer.opacity,
          band: layer.band,
          colormap: layer.colormap,
          stretchMin: layer.stretchMin,
          stretchMax: layer.stretchMax,
          is_georeferenced: layer.is_georeferenced,
        };
        layers.push(serialized);
      } else {
        const serialized: VectorLayerData = {
          id,
          type: 'vector',
          name: layer.name,
          filePath: layer.filePath,
          visible: layer.visible,
          opacity: layer.opacity,
          style: layer.style,
        };
        layers.push(serialized);
      }
    }

    return layers;
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

  private async deserializeProject(data: ProjectData): Promise<void> {
    // Clear existing state
    await this.clearCurrentProject();

    // Restore view
    if (data.view) {
      await this.deserializeView(data.view);
    }

    // Restore layers
    if (data.layers && data.layers.length > 0) {
      await this.deserializeLayers(data.layers);
    }

    // Restore annotations
    if (data.annotations && data.annotations.length > 0) {
      this.deserializeAnnotations(data.annotations);
    }

    // Restore settings
    if (data.settings) {
      this.deserializeSettings(data.settings);
    }
  }

  /**
   * Clear the current project, removing all layers and annotations
   * Resets the project path to null
   */
  async clearCurrentProject(): Promise<void> {
    // Remove all layers
    const layerIds = Array.from(this.layerManager.layers.keys());
    for (const id of layerIds) {
      this.layerManager.removeLayer(id);
    }

    // Clear annotations
    if (this.annotationTool) {
      this.annotationTool.clearAll();
    }

    this.currentProjectPath = null;
  }

  private async deserializeView(view: ViewData): Promise<void> {
    // Set basemap first if in pixel coord mode
    if (view.pixelCoordMode) {
      this.mapManager.setBasemap('pixel');
    } else if (view.basemap) {
      this.mapManager.setBasemap(view.basemap);
      const basemapSelect = document.getElementById('basemap-select') as HTMLSelectElement | null;
      if (basemapSelect) basemapSelect.value = view.basemap;
    }

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

  private async deserializeLayers(layers: LayerData[]): Promise<void> {
    const vectorExtensions = ['shp', 'geojson', 'json', 'gpkg', 'kml', 'kmz', 'gml', 'gpx', 'fgb'];

    for (const layerData of layers) {
      try {
        // Load the layer from file
        const ext = layerData.filePath.split('.').pop()?.toLowerCase() || '';
        let layer: Layer;

        if (layerData.type === 'vector' || vectorExtensions.includes(ext)) {
          layer = await this.layerManager.addVectorLayer(layerData.filePath);
        } else {
          layer = await this.layerManager.addRasterLayer(layerData.filePath);
        }

        if (layer) {
          // Restore layer properties
          if (layerData.name && layerData.name !== layer.name) {
            this.layerManager.renameLayer(layer.id, layerData.name);
          }

          if (layerData.opacity !== undefined && layerData.opacity !== 1) {
            this.layerManager.setLayerOpacity(layer.id, layerData.opacity);
          }

          if (!layerData.visible) {
            this.layerManager.toggleLayerVisibility(layer.id);
          }

          // Restore raster-specific properties
          if (layerData.type === 'raster') {
            const rasterData = layerData as RasterLayerData;
            if (rasterData.band && rasterData.band !== 1) {
              this.layerManager.setRasterBand(layer.id, rasterData.band);
            }
            if (rasterData.colormap) {
              this.layerManager.setColormap(layer.id, rasterData.colormap);
            }
            if (rasterData.stretchMin !== undefined || rasterData.stretchMax !== undefined) {
              this.layerManager.setStretch(
                layer.id,
                rasterData.stretchMin ?? 0,
                rasterData.stretchMax ?? 255
              );
            }
          }
        }
      } catch (error) {
        console.warn(`Failed to restore layer ${layerData.filePath}:`, error);
        showToast(`Could not load ${layerData.name || layerData.filePath}`, 'error');
      }
    }
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
