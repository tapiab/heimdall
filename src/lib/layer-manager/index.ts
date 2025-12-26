/**
 * LayerManager - Main orchestrator for layer management
 * @module layer-manager
 *
 * This module coordinates raster and vector layer operations,
 * delegating to specialized handlers for specific functionality.
 *
 * @example
 * ```typescript
 * const layerManager = new LayerManager(mapManager);
 * await layerManager.addRasterLayer('/path/to/raster.tif');
 * await layerManager.addVectorLayer('/path/to/shapefile.shp');
 * ```
 */

import maplibregl from 'maplibre-gl';
import { invoke } from '@tauri-apps/api/core';
import { LRUCache } from '../lru-cache';
import { logger } from '../logger';
import type {
  Layer,
  RasterLayer,
  VectorLayer,
  MapManagerInterface,
  HistogramData,
  DisplayMode,
  VectorStyle,
} from './types';

// Import handlers
import {
  addRasterLayer,
  setLayerStretch,
  setLayerBand,
  setLayerDisplayMode,
  setRgbBands,
  setRgbStretch,
  refreshLayerTiles,
} from './raster-handler';
import {
  addVectorLayer,
  setVectorStyle,
  setColorByField,
  showFeaturePopup,
  showAttributeTable,
  getFeatureBounds,
} from './vector-handler';
import {
  createRgbCompositionLayer,
  createCrossLayerRgbCompositionLayer,
  refreshCompositionTiles,
} from './composition-handler';
import {
  setupTileProtocol,
  setupCompositionTileProtocol,
  setupCrossLayerCompositionTileProtocol,
  removeProtocol,
} from './tile-protocol';
import { showHistogram, setupHistogramHover, drawHistogram } from './histogram';
import { updateLayerPanel, updateDynamicControls } from './layer-ui';

const log = logger.child('LayerManager');

/** GeoJSON feature with layer info from MapLibre */
interface MapFeature {
  properties: Record<string, unknown>;
  layer: { id: string };
}

/**
 * LayerManager handles raster and vector layer management for the map.
 *
 * Provides methods for:
 * - Loading and displaying raster layers (GeoTIFF, COG)
 * - Loading and styling vector layers (GeoJSON, Shapefile)
 * - RGB composition and band manipulation
 * - Layer ordering, visibility, and opacity
 * - Feature interaction and attribute tables
 */
export class LayerManager {
  /** MapManager instance for map operations */
  mapManager: MapManagerInterface;

  /** Map of layer ID to layer data */
  layers: Map<string, Layer>;

  /** Array of layer IDs in display order (bottom to top) */
  layerOrder: string[];

  /** LRU cache for tiles (max 500 tiles) */
  tileCache: LRUCache<Uint8Array>;

  /** Currently dragged layer item element */
  draggedItem: HTMLElement | null;

  /** Currently selected layer ID for controls */
  selectedLayerId: string | null;

  /** Feature info popup */
  popup: maplibregl.Popup | null;

  /** Last zoom level for COG overview invalidation */
  lastZoomLevel: number | null;

  /** Zoom end handler reference for cleanup */
  private _zoomEndHandler: (() => void) | null;

  /** Current histogram data for redraws */
  currentHistogram: HistogramData | null;

  /**
   * Create a new LayerManager instance.
   * @param mapManager - The MapManager instance to use for map operations
   */
  constructor(mapManager: MapManagerInterface) {
    this.mapManager = mapManager;
    this.layers = new Map();
    this.layerOrder = [];
    this.tileCache = new LRUCache(500);
    this.draggedItem = null;
    this.selectedLayerId = null;
    this.popup = null;
    this.lastZoomLevel = null;
    this._zoomEndHandler = null;
    this.currentHistogram = null;
    this.setupFeatureInteraction();
    this.setupZoomTracking();
  }

  /**
   * Setup zoom level tracking to invalidate remote COG tiles when zoom changes.
   * This ensures proper overview level selection for remote imagery.
   */
  setupZoomTracking(): void {
    const { map } = this.mapManager;

    this._zoomEndHandler = (): void => {
      const currentZoom = Math.floor(map.getZoom());

      // If zoom level changed significantly, invalidate remote layer tiles
      if (this.lastZoomLevel !== null && this.lastZoomLevel !== currentZoom) {
        this.invalidateRemoteLayerTiles();
      }

      this.lastZoomLevel = currentZoom;
    };

    map.on('zoomend', this._zoomEndHandler);

    // Initialize zoom level
    this.lastZoomLevel = Math.floor(map.getZoom());
  }

  /**
   * Clean up event listeners and resources.
   * Call this method before destroying the LayerManager instance to prevent memory leaks.
   */
  destroy(): void {
    const { map } = this.mapManager;

    // Remove zoom tracking listener
    if (this._zoomEndHandler) {
      map.off('zoomend', this._zoomEndHandler);
      this._zoomEndHandler = null;
    }

    // Remove popup if present
    if (this.popup) {
      this.popup.remove();
      this.popup = null;
    }

    // Clear tile cache
    this.tileCache.clear();

    // Clear layer data
    this.layers.clear();
    this.layerOrder = [];
  }

  /**
   * Invalidate tiles for all remote COG layers to force reload at correct overview level.
   */
  invalidateRemoteLayerTiles(): void {
    for (const [id, layer] of this.layers) {
      // Check if this is a remote layer (vsicurl path)
      if (layer.path && layer.path.startsWith('/vsicurl/')) {
        const sourceId = `raster-source-${id}`;
        const source = this.mapManager.map.getSource(sourceId) as
          | maplibregl.RasterTileSource
          | undefined;

        if (source) {
          // Add cache buster to force tile reload
          const protocolName = `raster-${id}`;
          const cacheBuster = Date.now();
          source.setTiles([`${protocolName}://{z}/{x}/{y}?v=${cacheBuster}`]);
        }
      }
    }
  }

  /**
   * Setup mouse interaction handlers for vector features.
   * Enables cursor changes and popup display on click.
   */
  setupFeatureInteraction(): void {
    const { map } = this.mapManager;

    // Change cursor to pointer when hovering over vector features
    map.on('mouseenter', (e: maplibregl.MapMouseEvent) => {
      const features = map.queryRenderedFeatures(e.point);
      const vectorFeature = features.find(
        f =>
          f.layer.id.startsWith('vector-fill-') ||
          f.layer.id.startsWith('vector-line-') ||
          f.layer.id.startsWith('vector-circle-')
      );
      if (vectorFeature) {
        map.getCanvas().style.cursor = 'pointer';
      }
    });

    map.on('mouseleave', () => {
      map.getCanvas().style.cursor = '';
    });

    map.on('mousemove', (e: maplibregl.MapMouseEvent) => {
      const features = map.queryRenderedFeatures(e.point);
      const vectorFeature = features.find(
        f =>
          f.layer.id.startsWith('vector-fill-') ||
          f.layer.id.startsWith('vector-line-') ||
          f.layer.id.startsWith('vector-circle-')
      );
      map.getCanvas().style.cursor = vectorFeature ? 'pointer' : '';
    });

    // Show popup on click for vector features only
    map.on('click', (e: maplibregl.MapMouseEvent) => {
      const features = map.queryRenderedFeatures(e.point);
      const vectorFeature = features.find(
        f =>
          f.layer.id.startsWith('vector-fill-') ||
          f.layer.id.startsWith('vector-line-') ||
          f.layer.id.startsWith('vector-circle-')
      );

      if (vectorFeature) {
        this.showFeaturePopup(vectorFeature as unknown as MapFeature, e.lngLat);
      } else if (this.popup) {
        // Only remove our own popup (feature popup), not inspect tool popups
        this.popup.remove();
        this.popup = null;
      }
    });
  }

  // ==================== Raster Operations ====================

  /**
   * Add a raster layer from a file path.
   * @param filePath - Path to the raster file (GeoTIFF, etc.)
   * @returns Layer metadata from the backend
   */
  async addRasterLayer(filePath: string): Promise<RasterLayer> {
    return addRasterLayer(this, filePath) as Promise<RasterLayer>;
  }

  /**
   * Set layer stretch parameters for grayscale display.
   * @param id - Layer ID
   * @param min - Minimum stretch value
   * @param max - Maximum stretch value
   * @param gamma - Gamma correction value (1.0 = no correction)
   */
  setLayerStretch(id: string, min: number, max: number, gamma: number): void {
    setLayerStretch(this, id, min, max, gamma);
  }

  /**
   * Set the displayed band for a raster layer.
   * @param id - Layer ID
   * @param band - Band number (1-indexed)
   */
  setLayerBand(id: string, band: number): void {
    setLayerBand(this, id, band);
  }

  /**
   * Set the display mode for a raster layer.
   * @param id - Layer ID
   * @param mode - Display mode ('grayscale', 'rgb', 'crossLayerRgb')
   */
  setLayerDisplayMode(id: string, mode: DisplayMode): void {
    setLayerDisplayMode(this, id, mode);
  }

  /**
   * Set RGB band assignments for a layer.
   * @param id - Layer ID
   * @param r - Red band number (1-indexed)
   * @param g - Green band number (1-indexed)
   * @param b - Blue band number (1-indexed)
   */
  setRgbBands(id: string, r: number, g: number, b: number): void {
    setRgbBands(this, id, r, g, b);
  }

  /**
   * Set RGB stretch parameters for a specific channel.
   * @param id - Layer ID
   * @param channel - Channel ('r', 'g', 'b')
   * @param min - Minimum stretch value
   * @param max - Maximum stretch value
   * @param gamma - Gamma correction value
   */
  setRgbStretch(
    id: string,
    channel: 'r' | 'g' | 'b',
    min: number,
    max: number,
    gamma: number
  ): void {
    setRgbStretch(this, id, channel, min, max, gamma);
  }

  /**
   * Refresh tiles for a raster layer (force reload).
   * @param id - Layer ID
   */
  refreshLayerTiles(id: string): void {
    refreshLayerTiles(this, id);
  }

  // ==================== Vector Operations ====================

  /**
   * Add a vector layer from a file path.
   * @param filePath - Path to the vector file (GeoJSON, Shapefile, etc.)
   * @returns Layer metadata from the backend
   */
  async addVectorLayer(filePath: string): Promise<VectorLayer> {
    return addVectorLayer(this, filePath) as Promise<VectorLayer>;
  }

  /**
   * Set a style property for a vector layer.
   * @param id - Layer ID
   * @param property - Style property name
   * @param value - Property value
   */
  setVectorStyle(id: string, property: keyof VectorStyle, value: string | number): void {
    setVectorStyle(this, id, property, value);
  }

  /**
   * Set color-by-field styling for a vector layer.
   * @param id - Layer ID
   * @param fieldName - Field name to color by (null to reset to solid color)
   */
  setColorByField(id: string, fieldName: string | null): void {
    setColorByField(this, id, fieldName);
  }

  /**
   * Show a popup with feature attributes.
   * @param feature - GeoJSON feature
   * @param lngLat - Click location
   */
  showFeaturePopup(feature: MapFeature, lngLat: maplibregl.LngLat): void {
    showFeaturePopup(this, feature, lngLat);
  }

  /**
   * Show the attribute table for a vector layer.
   * @param layerId - Layer ID
   */
  showAttributeTable(layerId: string): void {
    showAttributeTable(this, layerId);
  }

  /**
   * Get the bounding box of a GeoJSON geometry.
   * @param geometry - GeoJSON geometry object
   * @returns Bounds as [[minX, minY], [maxX, maxY]] or null
   */
  getFeatureBounds(geometry: GeoJSON.Geometry | null): [[number, number], [number, number]] | null {
    return getFeatureBounds(geometry);
  }

  // ==================== Composition Operations ====================

  /**
   * Create a new RGB composition layer from the current RGB settings.
   * @param sourceLayerId - Source layer ID
   * @returns Composition layer ID or null
   */
  async createRgbCompositionLayer(sourceLayerId: string): Promise<string | null> {
    return createRgbCompositionLayer(this, sourceLayerId);
  }

  /**
   * Create a cross-layer RGB composition from multiple layers.
   * @param sourceLayerId - Source layer ID (with crossLayerRgb config)
   * @returns Composition layer ID or null
   */
  async createCrossLayerRgbCompositionLayer(sourceLayerId: string): Promise<string | null> {
    return createCrossLayerRgbCompositionLayer(this, sourceLayerId);
  }

  /**
   * Refresh tiles for a composition layer.
   * @param id - Composition layer ID
   */
  refreshCompositionTiles(id: string): void {
    refreshCompositionTiles(this, id);
  }

  // ==================== Tile Protocol Operations ====================

  /**
   * Setup tile protocol for a raster layer.
   * @param protocolName - Protocol name
   * @param datasetId - Dataset ID
   * @param layerData - Layer data
   */
  setupTileProtocol(protocolName: string, datasetId: string, layerData: Layer): void {
    setupTileProtocol(this, protocolName, datasetId, layerData);
  }

  /**
   * Setup tile protocol for a composition layer.
   * @param protocolName - Protocol name
   * @param compositionId - Composition layer ID
   * @param compositionLayer - Composition layer data
   */
  setupCompositionTileProtocol(
    protocolName: string,
    compositionId: string,
    compositionLayer: RasterLayer
  ): void {
    setupCompositionTileProtocol(this, protocolName, compositionId, compositionLayer);
  }

  /**
   * Setup tile protocol for a cross-layer composition.
   * @param protocolName - Protocol name
   * @param compositionId - Composition layer ID
   * @param compositionLayer - Composition layer data
   */
  setupCrossLayerCompositionTileProtocol(
    protocolName: string,
    compositionId: string,
    compositionLayer: RasterLayer
  ): void {
    setupCrossLayerCompositionTileProtocol(this, protocolName, compositionId, compositionLayer);
  }

  // ==================== Histogram Operations ====================

  /**
   * Show histogram for a layer's band.
   * @param layerId - Layer ID
   * @param band - Band number
   */
  async showHistogram(layerId: string, band: number): Promise<void> {
    return showHistogram(this, layerId, band);
  }

  /**
   * Setup hover interaction for histogram canvas.
   * @param canvas - Canvas element
   * @param tooltip - Tooltip element
   * @param histogram - Histogram data
   * @param useLogScale - Whether to use log scale
   */
  setupHistogramHover(
    canvas: HTMLCanvasElement,
    tooltip: HTMLElement | null,
    histogram: HistogramData,
    useLogScale: boolean
  ): void {
    setupHistogramHover(this, canvas, tooltip, histogram, useLogScale);
  }

  /**
   * Draw histogram on canvas.
   * @param canvas - Canvas element
   * @param histogram - Histogram data
   * @param layer - Layer data
   * @param useLogScale - Whether to use log scale
   */
  drawHistogram(
    canvas: HTMLCanvasElement,
    histogram: HistogramData,
    layer: RasterLayer | null,
    useLogScale = false
  ): void {
    drawHistogram(canvas, histogram, layer, useLogScale);
  }

  // ==================== UI Operations ====================

  /**
   * Update the layer panel with current layers.
   */
  updateLayerPanel(): void {
    updateLayerPanel(this as unknown as Parameters<typeof updateLayerPanel>[0]);
  }

  /**
   * Update the dynamic controls panel for the selected layer.
   */
  updateDynamicControls(): void {
    updateDynamicControls(this as unknown as Parameters<typeof updateDynamicControls>[0]);
  }

  // ==================== Layer Management ====================

  /**
   * Remove a layer from the map.
   * @param id - Layer ID to remove
   */
  async removeLayer(id: string): Promise<void> {
    const layer = this.layers.get(id);
    if (!layer) return;

    if (layer.type === 'vector') {
      const sourceId = `vector-source-${id}`;
      const possibleLayerIds = [`vector-fill-${id}`, `vector-line-${id}`, `vector-circle-${id}`];

      for (const layerId of possibleLayerIds) {
        try {
          this.mapManager.map.removeLayer(layerId);
        } catch (_e) {
          // Layer might not exist for this geometry type
        }
      }
      try {
        this.mapManager.map.removeSource(sourceId);
      } catch (_e) {
        // Source might already be removed
      }
    } else {
      // Raster layer
      const sourceId = `raster-source-${id}`;
      const layerId = `raster-layer-${id}`;

      try {
        this.mapManager.map.removeLayer(layerId);
        this.mapManager.map.removeSource(sourceId);
      } catch (_e) {
        // Already removed
      }

      // Close the dataset in the backend (if not a composition)
      const rasterLayer = layer as RasterLayer;
      if (!rasterLayer.isComposition) {
        try {
          await invoke('close_dataset', { id });
        } catch (error) {
          log.error('Failed to close dataset in backend', { error: String(error) });
        }
      }

      // Remove protocol
      const protocolName = `raster-${id}`;
      removeProtocol(protocolName);
    }

    this.layers.delete(id);
    this.layerOrder = this.layerOrder.filter(lid => lid !== id);

    if (this.selectedLayerId === id) {
      this.selectedLayerId = this.layerOrder[this.layerOrder.length - 1] || null;
    }

    this.updateLayerPanel();
    this.updateDynamicControls();
  }

  /**
   * Select a layer for controls.
   * @param id - Layer ID to select
   */
  selectLayer(id: string): void {
    this.selectedLayerId = id;
    this.updateLayerPanel();
    this.updateDynamicControls();
  }

  /**
   * Rename a layer.
   * @param id - Layer ID
   * @param newName - New display name
   */
  renameLayer(id: string, newName: string): void {
    const layer = this.layers.get(id);
    if (layer) {
      layer.displayName = newName;
      this.updateLayerPanel();
    }
  }

  /**
   * Start inline rename editing for a layer.
   * @param id - Layer ID
   * @param nameElement - The name span element
   * @param currentName - Current name
   */
  startRenameLayer(id: string, nameElement: HTMLElement, currentName: string): void {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentName;
    input.className = 'layer-rename-input';

    const finishRename = (): void => {
      const newName = input.value.trim();
      if (newName && newName !== currentName) {
        this.renameLayer(id, newName);
      } else {
        this.updateLayerPanel();
      }
    };

    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finishRename();
      } else if (e.key === 'Escape') {
        this.updateLayerPanel();
      }
    });

    nameElement.textContent = '';
    nameElement.appendChild(input);
    input.focus();
    input.select();
  }

  /**
   * Toggle layer visibility.
   * @param id - Layer ID
   */
  toggleLayerVisibility(id: string): void {
    const layer = this.layers.get(id);
    if (!layer) return;

    layer.visible = !layer.visible;

    if (layer.type === 'vector') {
      const layerIds = [`vector-fill-${id}`, `vector-line-${id}`, `vector-circle-${id}`];
      for (const layerId of layerIds) {
        try {
          this.mapManager.setLayerVisibility(layerId, layer.visible);
        } catch (_e) {
          // Layer might not exist
        }
      }
    } else {
      const layerId = `raster-layer-${id}`;
      this.mapManager.setLayerVisibility(layerId, layer.visible);
    }

    this.updateLayerPanel();
  }

  /**
   * Set layer opacity.
   * @param id - Layer ID
   * @param opacity - Opacity value (0-1)
   */
  setLayerOpacity(id: string, opacity: number): void {
    const layer = this.layers.get(id);
    if (!layer) return;

    layer.opacity = opacity;

    if (layer.type === 'vector') {
      const vectorLayer = layer as VectorLayer;
      try {
        this.mapManager.map.setPaintProperty(
          `vector-fill-${id}`,
          'fill-opacity',
          opacity * vectorLayer.style.fillOpacity
        );
      } catch (_e) {
        // Layer might not exist
      }
      try {
        this.mapManager.map.setPaintProperty(`vector-line-${id}`, 'line-opacity', opacity);
      } catch (_e) {
        // Layer might not exist
      }
      try {
        this.mapManager.map.setPaintProperty(`vector-circle-${id}`, 'circle-opacity', opacity);
      } catch (_e) {
        // Layer might not exist
      }
    } else {
      const layerId = `raster-layer-${id}`;
      this.mapManager.map.setPaintProperty(layerId, 'raster-opacity', opacity);
    }
  }

  /**
   * Reorder layers in the stack.
   * @param fromIndex - Index to move from
   * @param toIndex - Index to move to
   */
  reorderLayers(fromIndex: number, toIndex: number): void {
    const [movedId] = this.layerOrder.splice(fromIndex, 1);
    this.layerOrder.splice(toIndex, 0, movedId);
    this.applyLayerOrder();
    this.updateLayerPanel();
  }

  /**
   * Apply the current layer order to the map.
   */
  applyLayerOrder(): void {
    for (let i = 1; i < this.layerOrder.length; i++) {
      const id = this.layerOrder[i];
      const prevId = this.layerOrder[i - 1];
      const layer = this.layers.get(id);
      const prevLayer = this.layers.get(prevId);

      if (!layer || !prevLayer) continue;

      try {
        if (layer.type === 'vector') {
          // Move all vector sublayers
          const layerIds = [`vector-fill-${id}`, `vector-line-${id}`, `vector-circle-${id}`];
          let beforeId: string;
          if (prevLayer.type === 'vector') {
            beforeId = `vector-circle-${prevId}`;
          } else {
            beforeId = `raster-layer-${prevId}`;
          }
          for (const layerId of layerIds) {
            try {
              this.mapManager.map.moveLayer(layerId, beforeId);
            } catch (_e) {
              // Layer might not exist
            }
          }
        } else {
          // Raster layer
          let beforeId: string;
          if (prevLayer.type === 'vector') {
            beforeId = `vector-circle-${prevId}`;
          } else {
            beforeId = `raster-layer-${prevId}`;
          }
          try {
            this.mapManager.map.moveLayer(`raster-layer-${id}`, beforeId);
          } catch (_e) {
            // Layer might not exist
          }
        }
      } catch (error) {
        log.error('Failed to reorder layer', { id, error: String(error) });
      }
    }
  }

  // ==================== Drag and Drop ====================

  /**
   * Handle drag start for layer reordering.
   * @param e - Drag event
   * @param item - Dragged item element
   */
  handleDragStart(e: DragEvent, item: HTMLElement): void {
    this.draggedItem = item;
    item.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
    }
  }

  /**
   * Handle drag over for layer reordering.
   * @param e - Drag event
   * @param item - Item being dragged over
   */
  handleDragOver(e: DragEvent, item: HTMLElement): void {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }

    if (item !== this.draggedItem) {
      const rect = item.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;

      if (e.clientY < midY) {
        item.classList.add('drag-over-top');
        item.classList.remove('drag-over-bottom');
      } else {
        item.classList.add('drag-over-bottom');
        item.classList.remove('drag-over-top');
      }
    }
  }

  /**
   * Handle drop for layer reordering.
   * @param e - Drop event
   * @param item - Drop target item
   */
  handleDrop(e: DragEvent, item: HTMLElement): void {
    e.preventDefault();
    if (!this.draggedItem || item === this.draggedItem) return;

    const fromIndex = parseInt(this.draggedItem.dataset.index || '0', 10);
    let toIndex = parseInt(item.dataset.index || '0', 10);

    const rect = item.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;

    if (e.clientY > midY && toIndex > fromIndex) {
      toIndex++;
    } else if (e.clientY < midY && toIndex < fromIndex) {
      toIndex--;
    }

    toIndex = Math.max(0, Math.min(toIndex, this.layerOrder.length - 1));

    this.reorderLayers(fromIndex, toIndex);
  }

  /**
   * Handle drag end for layer reordering.
   */
  handleDragEnd(): void {
    if (this.draggedItem) {
      this.draggedItem.classList.remove('dragging');
      this.draggedItem = null;
    }

    document.querySelectorAll('.layer-item').forEach(item => {
      item.classList.remove('drag-over-top', 'drag-over-bottom');
    });
  }

  // ==================== Utility ====================

  /**
   * Fit map view to all loaded layers.
   */
  fitToAllLayers(): void {
    if (this.layerOrder.length === 0) return;

    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;

    for (const id of this.layerOrder) {
      const layer = this.layers.get(id);
      if (layer?.bounds) {
        const [bMinX, bMinY, bMaxX, bMaxY] = layer.bounds;
        minX = Math.min(minX, bMinX);
        minY = Math.min(minY, bMinY);
        maxX = Math.max(maxX, bMaxX);
        maxY = Math.max(maxY, bMaxY);
      }
    }

    if (minX !== Infinity) {
      this.mapManager.fitBounds([
        [minX, minY],
        [maxX, maxY],
      ]);
    }
  }
}
