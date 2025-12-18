/**
 * Project Manager - Save and load project sessions
 */

import { save, open } from '@tauri-apps/plugin-dialog';
import { writeTextFile, readTextFile } from '@tauri-apps/plugin-fs';
import { showToast, showError, showLoading, hideLoading } from './notifications.js';

const PROJECT_VERSION = '1.0';

export class ProjectManager {
  constructor(mapManager, layerManager, annotationTool = null) {
    this.mapManager = mapManager;
    this.layerManager = layerManager;
    this.annotationTool = annotationTool;
    this.currentProjectPath = null;
  }

  async saveProject(filePath = null) {
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
      showError('Save failed', error);
      return null;
    }
  }

  async loadProject(filePath = null) {
    try {
      // If no path provided, show open dialog
      if (!filePath) {
        filePath = await open({
          filters: [
            {
              name: 'Heimdall Project',
              extensions: ['heimdall', 'json'],
            },
          ],
          multiple: false,
        });
      }

      if (!filePath) return false; // User cancelled

      showLoading('Loading project...');

      const jsonString = await readTextFile(filePath);
      const projectData = JSON.parse(jsonString);

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
      showError('Load failed', error);
      return false;
    }
  }

  serializeProject() {
    const project = {
      version: PROJECT_VERSION,
      savedAt: new Date().toISOString(),
      view: this.serializeView(),
      layers: this.serializeLayers(),
      annotations: this.serializeAnnotations(),
      settings: this.serializeSettings(),
    };

    return project;
  }

  serializeView() {
    const { map } = this.mapManager;
    return {
      center: map.getCenter().toArray(),
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
      basemap: this.mapManager.getBasemap(),
      terrainEnabled: this.mapManager.terrainEnabled,
      terrainExaggeration: this.mapManager.terrainExaggeration,
      pixelCoordMode: this.mapManager.isPixelCoordMode(),
    };
  }

  serializeLayers() {
    const layers = [];
    const layerOrder = this.layerManager.getLayerOrder();

    for (const id of layerOrder) {
      const layer = this.layerManager.layers.get(id);
      if (!layer) continue;

      const serialized = {
        id,
        type: layer.type,
        name: layer.name,
        filePath: layer.filePath,
        visible: layer.visible,
        opacity: layer.opacity,
      };

      if (layer.type === 'raster') {
        serialized.band = layer.band;
        serialized.colormap = layer.colormap;
        serialized.stretchMin = layer.stretchMin;
        serialized.stretchMax = layer.stretchMax;
        serialized.is_georeferenced = layer.is_georeferenced;
      }

      if (layer.type === 'vector') {
        serialized.style = layer.style;
      }

      layers.push(serialized);
    }

    return layers;
  }

  serializeAnnotations() {
    if (!this.annotationTool) return [];
    return this.annotationTool.getAnnotations();
  }

  serializeSettings() {
    return {
      // Add any other persistent settings here
    };
  }

  async deserializeProject(data) {
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

  async clearCurrentProject() {
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

  async deserializeView(view) {
    // Set basemap first if in pixel coord mode
    if (view.pixelCoordMode) {
      this.mapManager.setBasemap('pixel');
    } else if (view.basemap) {
      this.mapManager.setBasemap(view.basemap);
      const basemapSelect = document.getElementById('basemap-select');
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
        const slider = document.getElementById('exaggeration-slider');
        const value = document.getElementById('exaggeration-value');
        if (slider) slider.value = view.terrainExaggeration;
        if (value) value.textContent = view.terrainExaggeration.toFixed(1);
      }
      const terrainToggle = document.getElementById('terrain-toggle');
      const terrainExaggeration = document.getElementById('terrain-exaggeration');
      if (terrainToggle) terrainToggle.checked = true;
      if (terrainExaggeration) terrainExaggeration.classList.remove('hidden');
    }
  }

  async deserializeLayers(layers) {
    const vectorExtensions = ['shp', 'geojson', 'json', 'gpkg', 'kml', 'kmz', 'gml', 'gpx', 'fgb'];

    for (const layerData of layers) {
      try {
        // Load the layer from file
        const ext = layerData.filePath.split('.').pop().toLowerCase();
        let layer;

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
            if (layerData.band && layerData.band !== 1) {
              this.layerManager.setRasterBand(layer.id, layerData.band);
            }
            if (layerData.colormap) {
              this.layerManager.setColormap(layer.id, layerData.colormap);
            }
            if (layerData.stretchMin !== undefined || layerData.stretchMax !== undefined) {
              this.layerManager.setStretch(layer.id, layerData.stretchMin, layerData.stretchMax);
            }
          }
        }
      } catch (error) {
        console.warn(`Failed to restore layer ${layerData.filePath}:`, error);
        showToast(`Could not load ${layerData.name || layerData.filePath}`, 'error');
      }
    }
  }

  deserializeAnnotations(annotations) {
    if (this.annotationTool && annotations.length > 0) {
      this.annotationTool.loadAnnotations(annotations);
    }
  }

  deserializeSettings(_settings) {
    // Apply any saved settings
  }

  hasUnsavedChanges() {
    // Simple check - could be made more sophisticated
    return (
      this.layerManager.layers.size > 0 ||
      (this.annotationTool && this.annotationTool.getCount() > 0)
    );
  }

  getCurrentProjectPath() {
    return this.currentProjectPath;
  }

  async newProject() {
    if (this.hasUnsavedChanges()) {
      // In a real app, you'd prompt to save first
    }
    await this.clearCurrentProject();
    this.mapManager.resetView();
    showToast('New project created', 'info');
  }
}
