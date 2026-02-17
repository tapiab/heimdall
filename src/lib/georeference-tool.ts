/**
 * Georeference Tool - Manual GCP-based image georeferencing
 *
 * Workflow:
 * 1. User activates tool and selects a non-georeferenced layer
 * 2. User clicks on image to set source (pixel) coordinate
 * 3. User clicks on basemap (or enters manually) to set target (geo) coordinate
 * 4. Repeat until enough GCPs are collected
 * 5. Calculate transformation and view RMS error
 * 6. Apply and save georeferenced output
 */

import maplibregl, {
  type Map as MapLibreMap,
  type MapMouseEvent,
  type Marker,
} from 'maplibre-gl';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';
import { showToast, showLoading, hideLoading } from './notifications';

/** Progress event payload from Rust backend */
interface GeoreferenceProgress {
  stage: string;
  progress: number;
  message: string;
}
import type {
  GCP,
  GCPCollectionState,
  TransformationType,
  TransformResult,
  GeoreferenceResult,
} from './georeference-types';
import { getMinGcps, TRANSFORMATIONS } from './georeference-types';

/** Interface for MapManager */
interface MapManager {
  map: MapLibreMap;
  isPixelCoordMode(): boolean;
}

/** Interface for LayerManager */
interface LayerManager {
  layers: Map<string, {
    type: string;
    path: string;
    is_georeferenced?: boolean;
    width?: number;
    height?: number;
    pixelScale?: number;
    pixelOffset?: { x: number; y: number };
  }>;
  selectedLayerId: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addRasterLayer: (path: string) => Promise<any>;
}

type Coordinate = [number, number];

export class GeoreferenceTool {
  private mapManager: MapManager;
  private layerManager: LayerManager;
  private secondaryLayerManager: LayerManager | null;
  private secondaryMap: MapLibreMap | null;
  private map: MapLibreMap;
  private active: boolean;
  private state: GCPCollectionState;
  private gcps: GCP[];
  private sourceLayerId: string | null;
  private sourceLayerManagerId: 'primary' | 'secondary';
  private transformationType: TransformationType;
  private nextGcpId: number;

  // Markers for visualization
  private sourceMarkers: Map<string, Marker>;
  private targetMarkers: Map<string, Marker>;

  // Temporary marker while collecting
  private tempSourceMarker: Marker | null;
  private pendingSourceCoord: Coordinate | null;

  // Panel reference
  private panel: HTMLElement | null;

  // Callbacks
  private onGcpChange: (() => void) | null;

  constructor(mapManager: MapManager, layerManager: LayerManager) {
    this.mapManager = mapManager;
    this.layerManager = layerManager;
    this.secondaryLayerManager = null;
    this.secondaryMap = null;
    this.map = mapManager.map;
    this.active = false;
    this.state = 'idle';
    this.gcps = [];
    this.sourceLayerId = null;
    this.sourceLayerManagerId = 'primary';
    this.transformationType = 'polynomial1';
    this.nextGcpId = 1;
    this.sourceMarkers = new Map();
    this.targetMarkers = new Map();
    this.tempSourceMarker = null;
    this.pendingSourceCoord = null;
    this.panel = null;
    this.onGcpChange = null;

    // Bind handlers
    this.handleClick = this.handleClick.bind(this);
    this.handleSecondaryClick = this.handleSecondaryClick.bind(this);
  }

  /** Get the map where the source layer is displayed */
  private getSourceMap(): MapLibreMap {
    if (this.sourceLayerManagerId === 'secondary' && this.secondaryMap) {
      return this.secondaryMap;
    }
    return this.map;
  }

  /** Get the other map (for target coordinates) */
  private getTargetMap(): MapLibreMap {
    if (this.sourceLayerManagerId === 'secondary') {
      return this.map; // Primary map for target when source is secondary
    }
    return this.secondaryMap || this.map; // Secondary map for target when source is primary
  }

  /** Convert map coordinates to actual pixel coordinates for the source layer */
  private mapToPixelCoords(mapX: number, mapY: number): { pixelX: number; pixelY: number } {
    const layerManager = this.getSourceLayerManager();
    const layer = this.sourceLayerId ? layerManager.layers.get(this.sourceLayerId) : null;

    if (!layer || layer.type !== 'raster') {
      // No conversion if no layer selected
      return { pixelX: mapX, pixelY: mapY };
    }

    const width = layer.width || 0;
    const height = layer.height || 0;
    const scale = layer.pixelScale || 0.01;
    const offsetX = layer.pixelOffset?.x || 0;
    const offsetY = layer.pixelOffset?.y || 0;

    // Convert from pseudo-geographic coords back to pixel coords
    // Pseudo-geo formula: geo_x = (pixel_x - width/2 + offsetX) * scale
    //                     geo_y = (height/2 - pixel_y + offsetY) * scale
    // Inverse: pixel_x = geo_x / scale + width/2 - offsetX
    //          pixel_y = height/2 - geo_y / scale + offsetY
    const pixelX = mapX / scale + width / 2 - offsetX;
    const pixelY = height / 2 - mapY / scale + offsetY;

    return { pixelX, pixelY };
  }

  /** Convert GCPs to backend format with proper pixel coordinates */
  private gcpsToBackendFormat(): Array<{ pixel_x: number; pixel_y: number; geo_x: number; geo_y: number }> {
    return this.getEnabledGcps().map(gcp => {
      const { pixelX, pixelY } = this.mapToPixelCoords(gcp.sourceX, gcp.sourceY);
      return {
        pixel_x: pixelX,
        pixel_y: pixelY,
        geo_x: gcp.targetLng,
        geo_y: gcp.targetLat,
      };
    });
  }

  /** Activate the georeferencing tool */
  activate(): void {
    if (this.active) return;

    this.active = true;
    this.state = 'idle';
    this.map.getCanvas().style.cursor = 'crosshair';
    this.map.on('click', this.handleClick);

    // Also listen to secondary map if available
    if (this.secondaryMap) {
      this.secondaryMap.getCanvas().style.cursor = 'crosshair';
      this.secondaryMap.on('click', this.handleSecondaryClick);
    }

    // Show the georeference panel
    this.showPanel();

    showToast('Georeference mode: Click "Add GCP" to start', 'info', 3000);
  }

  /** Deactivate the georeferencing tool */
  deactivate(): void {
    if (!this.active) return;

    this.active = false;
    this.state = 'idle';
    this.map.getCanvas().style.cursor = '';
    this.map.off('click', this.handleClick);

    // Also clean up secondary map
    if (this.secondaryMap) {
      this.secondaryMap.getCanvas().style.cursor = '';
      this.secondaryMap.off('click', this.handleSecondaryClick);
    }

    // Clear temp marker
    if (this.tempSourceMarker) {
      this.tempSourceMarker.remove();
      this.tempSourceMarker = null;
    }
    this.pendingSourceCoord = null;

    // Hide the panel
    this.hidePanel();
  }

  /** Toggle active state */
  toggle(): boolean {
    if (this.active) {
      this.deactivate();
    } else {
      this.activate();
    }
    return this.active;
  }

  /** Check if tool is active */
  isActive(): boolean {
    return this.active;
  }

  /** Start collecting a new GCP */
  startGcpCollection(): void {
    if (!this.sourceLayerId) {
      showToast('Please select a source layer first', 'error');
      return;
    }

    this.state = 'collecting_source';
    this.map.getCanvas().style.cursor = 'crosshair';
    showToast('Click on the image to set source point', 'info', 3000);
  }

  /** Handle click events from primary map */
  private handleClick(e: MapMouseEvent): void {
    this.processClick(e, 'primary');
  }

  /** Handle click events from secondary map */
  private handleSecondaryClick(e: MapMouseEvent): void {
    this.processClick(e, 'secondary');
  }

  /** Process click from either map */
  private processClick(e: MapMouseEvent, clickedMap: 'primary' | 'secondary'): void {
    if (!this.active) return;

    const { lng, lat } = e.lngLat;
    const sourceMap = this.getSourceMap();
    const isSourceMap = (clickedMap === 'primary' && sourceMap === this.map) ||
                        (clickedMap === 'secondary' && sourceMap === this.secondaryMap);

    if (this.state === 'collecting_source') {
      // Only accept source clicks on the map where the image is
      if (!isSourceMap) {
        showToast('Click on the image in the correct panel', 'info', 2000);
        return;
      }

      const layerManager = this.getSourceLayerManager();
      const layer = layerManager.layers.get(this.sourceLayerId || '');
      if (!layer) return;

      this.pendingSourceCoord = [lng, lat];

      // Create temp marker on the source map
      if (this.tempSourceMarker) {
        this.tempSourceMarker.remove();
      }

      const el = this.createSourceMarkerElement('?');
      this.tempSourceMarker = new maplibregl.Marker({ element: el, draggable: true })
        .setLngLat([lng, lat])
        .addTo(sourceMap);

      // Update state
      this.state = 'collecting_target';
      showToast('Now click on the basemap to set target coordinates, or enter manually', 'info', 4000);

      // Update panel to show pending GCP
      this.updatePanelState();
    } else if (this.state === 'collecting_target') {
      // Accept target clicks on the OTHER map (or same map if no split view)
      // If split view is active, prefer clicks on the other map
      if (this.secondaryMap && isSourceMap) {
        showToast('Click on the other map panel for target coordinates', 'info', 2000);
        return;
      }

      if (!this.pendingSourceCoord) return;

      this.addGcp(this.pendingSourceCoord[0], this.pendingSourceCoord[1], lng, lat);

      // Clear temp marker
      if (this.tempSourceMarker) {
        this.tempSourceMarker.remove();
        this.tempSourceMarker = null;
      }
      this.pendingSourceCoord = null;

      this.state = 'idle';
      showToast(`GCP ${this.gcps.length} added`, 'success', 1500);

      this.updatePanelState();
    }
  }

  /** Add a GCP with given coordinates */
  addGcp(sourceX: number, sourceY: number, targetLng: number, targetLat: number): void {
    const id = `gcp-${this.nextGcpId++}`;
    const gcp: GCP = {
      id,
      sourceX,
      sourceY,
      targetLng,
      targetLat,
      enabled: true,
    };

    this.gcps.push(gcp);

    // Create visual markers
    this.createMarkers(gcp);

    // Notify listeners
    if (this.onGcpChange) {
      this.onGcpChange();
    }
  }

  /** Create source and target markers for a GCP */
  private createMarkers(gcp: GCP): void {
    const index = this.gcps.indexOf(gcp) + 1;
    const sourceMap = this.getSourceMap();
    const targetMap = this.getTargetMap();

    // Source marker (red) - on the map with the non-georeferenced image
    const srcEl = this.createSourceMarkerElement(String(index));
    const srcMarker = new maplibregl.Marker({ element: srcEl, draggable: true })
      .setLngLat([gcp.sourceX, gcp.sourceY])
      .addTo(sourceMap);

    srcMarker.on('dragend', () => {
      const pos = srcMarker.getLngLat();
      gcp.sourceX = pos.lng;
      gcp.sourceY = pos.lat;
      if (this.onGcpChange) this.onGcpChange();
    });

    this.sourceMarkers.set(gcp.id, srcMarker);

    // Target marker (green) - on the basemap (other map)
    const tgtEl = this.createTargetMarkerElement(String(index));
    const tgtMarker = new maplibregl.Marker({ element: tgtEl, draggable: true })
      .setLngLat([gcp.targetLng, gcp.targetLat])
      .addTo(targetMap);

    tgtMarker.on('dragend', () => {
      const pos = tgtMarker.getLngLat();
      gcp.targetLng = pos.lng;
      gcp.targetLat = pos.lat;
      if (this.onGcpChange) this.onGcpChange();
    });

    this.targetMarkers.set(gcp.id, tgtMarker);
  }

  /** Create source marker element (red circle with number) */
  private createSourceMarkerElement(label: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'gcp-marker gcp-source';
    el.textContent = label;
    return el;
  }

  /** Create target marker element (green circle with number) */
  private createTargetMarkerElement(label: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'gcp-marker gcp-target';
    el.textContent = label;
    return el;
  }

  /** Update GCP coordinates */
  updateGcp(id: string, updates: Partial<GCP>): void {
    const gcp = this.gcps.find(g => g.id === id);
    if (!gcp) return;

    Object.assign(gcp, updates);

    // Update markers
    const srcMarker = this.sourceMarkers.get(id);
    if (srcMarker && (updates.sourceX !== undefined || updates.sourceY !== undefined)) {
      srcMarker.setLngLat([gcp.sourceX, gcp.sourceY]);
    }

    const tgtMarker = this.targetMarkers.get(id);
    if (tgtMarker && (updates.targetLng !== undefined || updates.targetLat !== undefined)) {
      tgtMarker.setLngLat([gcp.targetLng, gcp.targetLat]);
    }

    if (this.onGcpChange) {
      this.onGcpChange();
    }
  }

  /** Delete a GCP */
  deleteGcp(id: string): void {
    const index = this.gcps.findIndex(g => g.id === id);
    if (index === -1) return;

    this.gcps.splice(index, 1);

    // Remove markers
    const srcMarker = this.sourceMarkers.get(id);
    if (srcMarker) {
      srcMarker.remove();
      this.sourceMarkers.delete(id);
    }

    const tgtMarker = this.targetMarkers.get(id);
    if (tgtMarker) {
      tgtMarker.remove();
      this.targetMarkers.delete(id);
    }

    // Re-number remaining markers
    this.renumberMarkers();

    if (this.onGcpChange) {
      this.onGcpChange();
    }
  }

  /** Re-number all markers after deletion */
  private renumberMarkers(): void {
    this.gcps.forEach((gcp, idx) => {
      const num = String(idx + 1);

      const srcMarker = this.sourceMarkers.get(gcp.id);
      if (srcMarker) {
        srcMarker.getElement().textContent = num;
      }

      const tgtMarker = this.targetMarkers.get(gcp.id);
      if (tgtMarker) {
        tgtMarker.getElement().textContent = num;
      }
    });
  }

  /** Clear all GCPs */
  clearGcps(): void {
    // Remove all markers
    for (const marker of this.sourceMarkers.values()) {
      marker.remove();
    }
    for (const marker of this.targetMarkers.values()) {
      marker.remove();
    }
    this.sourceMarkers.clear();
    this.targetMarkers.clear();

    this.gcps = [];
    this.nextGcpId = 1;

    if (this.onGcpChange) {
      this.onGcpChange();
    }
  }

  /** Get all GCPs */
  getGcps(): GCP[] {
    return [...this.gcps];
  }

  /** Get enabled GCPs */
  getEnabledGcps(): GCP[] {
    return this.gcps.filter(g => g.enabled);
  }

  /** Set source layer ID */
  setSourceLayer(layerId: string | null): void {
    this.sourceLayerId = layerId;
  }

  /** Get source layer ID */
  getSourceLayerId(): string | null {
    return this.sourceLayerId;
  }

  /** Set transformation type */
  setTransformationType(type: TransformationType): void {
    this.transformationType = type;
  }

  /** Get transformation type */
  getTransformationType(): TransformationType {
    return this.transformationType;
  }

  /** Set callback for GCP changes */
  setOnGcpChange(callback: () => void): void {
    this.onGcpChange = callback;
  }

  /** Calculate transformation and get RMS error */
  async calculateTransformation(): Promise<TransformResult> {
    const enabledGcps = this.getEnabledGcps();
    const minGcps = getMinGcps(this.transformationType);

    if (enabledGcps.length < minGcps) {
      return {
        success: false,
        error: `Need at least ${minGcps} GCPs for ${this.transformationType}, have ${enabledGcps.length}`,
      };
    }

    try {
      // Convert to backend format with proper pixel coordinates
      const gcpData = this.gcpsToBackendFormat();
      const result = await invoke<TransformResult>('calculate_transformation', {
        gcps: gcpData,
        transformType: this.transformationType,
      });

      // Update residuals on GCPs
      if (result.success && result.residuals) {
        enabledGcps.forEach((gcp, i) => {
          gcp.residual = result.residuals![i];
        });
        if (this.onGcpChange) {
          this.onGcpChange();
        }
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: String(error),
      };
    }
  }

  /** Apply georeferencing and save output */
  async applyGeoreference(): Promise<GeoreferenceResult> {
    if (!this.sourceLayerId) {
      return { success: false, error: 'No source layer selected' };
    }

    const layerManager = this.getSourceLayerManager();
    const layer = layerManager.layers.get(this.sourceLayerId);
    if (!layer) {
      return { success: false, error: 'Source layer not found' };
    }

    const enabledGcps = this.getEnabledGcps();
    const minGcps = getMinGcps(this.transformationType);

    if (enabledGcps.length < minGcps) {
      return {
        success: false,
        error: `Need at least ${minGcps} GCPs for ${this.transformationType}`,
      };
    }

    // Ask user for output path
    const outputPath = await save({
      title: 'Save Georeferenced Image',
      defaultPath: layer.path.replace(/\.[^.]+$/, '_georef.tif'),
      filters: [{ name: 'GeoTIFF', extensions: ['tif', 'tiff'] }],
    });

    if (!outputPath) {
      return { success: false, error: 'No output path selected' };
    }

    // Set up progress listener
    const loadingEl = document.getElementById('loading-indicator');
    const loadingText = loadingEl?.querySelector('span');
    let unlisten: UnlistenFn | null = null;

    try {
      // Listen for progress events
      unlisten = await listen<GeoreferenceProgress>('georef-progress', event => {
        const { message, progress } = event.payload;
        if (loadingText) {
          loadingText.textContent = `${message} (${Math.round(progress * 100)}%)`;
        }
      });

      showLoading('Starting georeferencing...');

      // Convert to backend format with proper pixel coordinates
      const gcpData = this.gcpsToBackendFormat();
      const result = await invoke<GeoreferenceResult>('apply_georeference', {
        inputPath: layer.path,
        outputPath,
        gcps: gcpData,
        transformType: this.transformationType,
        targetCrs: 'EPSG:4326',
      });

      // Clean up listener
      if (unlisten) unlisten();
      hideLoading();

      if (result.success && result.output_path) {
        showToast(`Georeferenced image saved to ${result.output_path}`, 'success', 5000);
        // Add the georeferenced result as a new layer
        try {
          await this.layerManager.addRasterLayer(result.output_path);
          showToast('Georeferenced layer added to map', 'success', 2000);
        } catch (e) {
          console.error('Failed to add georeferenced layer:', e);
        }
      } else {
        showToast(`Failed: ${result.error}`, 'error');
      }

      return result;
    } catch (error) {
      if (unlisten) unlisten();
      hideLoading();
      return {
        success: false,
        error: String(error),
      };
    }
  }

  /** Get current collection state */
  getState(): GCPCollectionState {
    return this.state;
  }

  /** Cancel current GCP collection */
  cancelCollection(): void {
    if (this.tempSourceMarker) {
      this.tempSourceMarker.remove();
      this.tempSourceMarker = null;
    }
    this.pendingSourceCoord = null;
    this.state = 'idle';
    this.updatePanelState();
  }

  /** Set target coordinates manually for pending GCP */
  setTargetManually(lng: number, lat: number): void {
    if (this.state !== 'collecting_target' || !this.pendingSourceCoord) {
      showToast('No pending GCP to set target for', 'error');
      return;
    }

    this.addGcp(this.pendingSourceCoord[0], this.pendingSourceCoord[1], lng, lat);

    // Clear temp marker
    if (this.tempSourceMarker) {
      this.tempSourceMarker.remove();
      this.tempSourceMarker = null;
    }
    this.pendingSourceCoord = null;

    this.state = 'idle';
    showToast(`GCP ${this.gcps.length} added`, 'success', 1500);

    this.updatePanelState();
  }

  /** Show the georeference panel */
  private showPanel(): void {
    const panel = document.getElementById('georef-panel');
    if (panel) {
      panel.classList.add('visible');
      this.panel = panel;
      this.updatePanelState();
    }
  }

  /** Hide the georeference panel */
  private hidePanel(): void {
    const panel = document.getElementById('georef-panel');
    if (panel) {
      panel.classList.remove('visible');
    }
    this.panel = null;
  }

  /** Update panel state (implemented by georeference-panel.ts) */
  private updatePanelState(): void {
    // This will be called by the panel to refresh itself
    if (this.onGcpChange) {
      this.onGcpChange();
    }
  }

  /** Set secondary LayerManager and Map for split view support */
  setSecondaryLayerManager(manager: LayerManager | null, secondaryMap: MapLibreMap | null = null): void {
    // Remove old click handler if switching
    if (this.secondaryMap && this.active) {
      this.secondaryMap.off('click', this.handleSecondaryClick);
    }

    this.secondaryLayerManager = manager;
    this.secondaryMap = secondaryMap;

    // Add click handler to new secondary map if active
    if (this.secondaryMap && this.active) {
      this.secondaryMap.on('click', this.handleSecondaryClick);
    }
  }

  /** Get non-georeferenced layers for selection (includes both primary and secondary) */
  getNonGeoreferencedLayers(): Array<{ id: string; name: string; source: 'primary' | 'secondary' }> {
    const layers: Array<{ id: string; name: string; source: 'primary' | 'secondary' }> = [];

    // Primary LayerManager layers
    for (const [id, layer] of this.layerManager.layers) {
      if (layer.type === 'raster' && layer.is_georeferenced === false) {
        const name = layer.path.split('/').pop() || id;
        layers.push({ id, name, source: 'primary' });
      }
    }

    // Secondary LayerManager layers (if split view is active)
    if (this.secondaryLayerManager) {
      for (const [id, layer] of this.secondaryLayerManager.layers) {
        if (layer.type === 'raster' && layer.is_georeferenced === false) {
          const name = layer.path.split('/').pop() || id;
          layers.push({ id, name: `${name} (2nd panel)`, source: 'secondary' });
        }
      }
    }

    return layers;
  }

  /** Get the appropriate LayerManager for the selected source layer */
  private getSourceLayerManager(): LayerManager {
    return this.sourceLayerManagerId === 'secondary' && this.secondaryLayerManager
      ? this.secondaryLayerManager
      : this.layerManager;
  }

  /** Set source layer with its manager identifier */
  setSourceLayerWithManager(layerId: string | null, source: 'primary' | 'secondary'): void {
    this.sourceLayerId = layerId;
    this.sourceLayerManagerId = source;
  }
}
