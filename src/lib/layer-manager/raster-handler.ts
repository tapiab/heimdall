/**
 * Raster layer handling - loading, stretch, band selection
 * @module layer-manager/raster-handler
 */

import { invoke } from '@tauri-apps/api/core';
import { showToast, showError, showLoading, hideLoading } from '../notifications';
import { setupTileProtocol } from './tile-protocol';
import { logger } from '../logger';
import type { LayerManagerInterface, RasterLayer, BandStats, DisplayMode } from './types';

const log = logger.child('LayerManager:Raster');

/** Metadata returned from backend when opening a raster */
interface RasterMetadata {
  id: string;
  path: string;
  width: number;
  height: number;
  bands: number;
  bounds: [number, number, number, number];
  band_stats: BandStats[];
  is_georeferenced: boolean;
}

/**
 * Add a raster layer from a file path
 * @param manager - The LayerManager instance
 * @param filePath - Path to the raster file
 * @returns Layer metadata
 */
export async function addRasterLayer(
  manager: LayerManagerInterface,
  filePath: string
): Promise<RasterMetadata> {
  const fileName = filePath.split('/').pop()?.split('\\').pop() || 'Unknown';
  showLoading(`Loading ${fileName}...`);
  try {
    // Open the raster in the backend
    const metadata = await invoke<RasterMetadata>('open_raster', { path: filePath });
    log.debug('Opened raster', { id: metadata.id, fileName, bands: metadata.bands });

    // Get stats for first band (default)
    const defaultBandStats = metadata.band_stats[0] || { min: 0, max: 255 };

    // Store layer info with stretch parameters
    const layerData: RasterLayer = {
      ...metadata,
      visible: true,
      opacity: 1.0,
      type: 'raster',
      // Display mode: 'grayscale', 'rgb', or 'crossLayerRgb'
      displayMode: metadata.bands >= 3 ? 'rgb' : 'grayscale',
      // Grayscale settings
      band: 1,
      stretch: {
        min: defaultBandStats.min,
        max: defaultBandStats.max,
        gamma: 1.0,
      },
      // RGB settings
      rgbBands: { r: 1, g: 2, b: 3 },
      rgbStretch: {
        r: {
          min: metadata.band_stats[0]?.min || 0,
          max: metadata.band_stats[0]?.max || 255,
          gamma: 1.0,
        },
        g: {
          min: metadata.band_stats[1]?.min || 0,
          max: metadata.band_stats[1]?.max || 255,
          gamma: 1.0,
        },
        b: {
          min: metadata.band_stats[2]?.min || 0,
          max: metadata.band_stats[2]?.max || 255,
          gamma: 1.0,
        },
      },
    };

    // Handle non-georeferenced images
    if (!metadata.is_georeferenced) {
      // Auto-disable basemap for non-georeferenced images
      manager.mapManager.setBasemap('none');
      const basemapSelect = document.getElementById('basemap-select') as HTMLSelectElement | null;
      if (basemapSelect) basemapSelect.value = 'none';
    } else {
      // For geo-referenced images, exit pixel coordinate mode if we were in it
      if (manager.mapManager.isPixelCoordMode()) {
        manager.mapManager.setPixelCoordMode(false, null);
      }
    }

    manager.layers.set(metadata.id, layerData);

    // Add to layer order (on top)
    manager.layerOrder.push(metadata.id);

    // Create a unique protocol for this layer's current settings
    const protocolName = `raster-${metadata.id}`;
    setupTileProtocol(manager, protocolName, metadata.id, layerData);

    // Add to map
    const sourceId = `raster-source-${metadata.id}`;
    const layerId = `raster-layer-${metadata.id}`;

    // For non-georeferenced images, use pseudo-geographic bounds
    let mapBounds = metadata.bounds;
    if (!metadata.is_georeferenced) {
      // Scale image to fit within valid lat/lon bounds
      const scale = 0.01;
      const halfWidth = (metadata.width * scale) / 2;
      const halfHeight = (metadata.height * scale) / 2;
      const clampedHalfHeight = Math.min(halfHeight, 85);
      mapBounds = [-halfWidth, -clampedHalfHeight, halfWidth, clampedHalfHeight];
      // Store the scale for coordinate display
      layerData.pixelScale = scale;
      layerData.pixelOffset = { x: halfWidth, y: clampedHalfHeight };
      // Update layer bounds to use map coordinates
      layerData.bounds = mapBounds;
      // Set pixel coordinate mode with scale info
      manager.mapManager.setPixelCoordMode(true, {
        width: metadata.width,
        height: metadata.height,
        scale,
        offsetX: halfWidth,
        offsetY: clampedHalfHeight,
      });
    }

    manager.mapManager.addSource(sourceId, {
      type: 'raster',
      tiles: [`${protocolName}://{z}/{x}/{y}`],
      tileSize: 256,
      bounds: mapBounds,
      minzoom: 0,
      maxzoom: 22,
    });

    manager.mapManager.addLayer({
      id: layerId,
      type: 'raster',
      source: sourceId,
      paint: {
        'raster-opacity': 1,
      },
    });

    // Select this layer for controls
    manager.selectedLayerId = metadata.id;

    // Update UI
    manager.updateLayerPanel();
    manager.updateDynamicControls();

    // Fit to layer bounds
    if (!metadata.is_georeferenced) {
      manager.mapManager.fitBounds([
        [mapBounds[0], mapBounds[1]],
        [mapBounds[2], mapBounds[3]],
      ]);
    } else {
      manager.mapManager.fitBounds([
        [metadata.bounds[0], metadata.bounds[1]],
        [metadata.bounds[2], metadata.bounds[3]],
      ]);
    }

    showToast(`Loaded ${fileName}`, 'success', 2000);
    return metadata;
  } catch (error) {
    log.error('Failed to add raster layer', { error: String(error) });
    showError('Failed to load raster', error instanceof Error ? error : String(error));
    throw error;
  } finally {
    hideLoading();
  }
}

/**
 * Set layer stretch parameters
 * @param manager - The LayerManager instance
 * @param id - Layer ID
 * @param min - Min value
 * @param max - Max value
 * @param gamma - Gamma value
 */
export function setLayerStretch(
  manager: LayerManagerInterface,
  id: string,
  min: number,
  max: number,
  gamma: number
): void {
  const layer = manager.layers.get(id) as RasterLayer | undefined;
  if (!layer) return;

  layer.stretch = { min, max, gamma };
  manager.refreshLayerTiles(id);
}

/**
 * Set layer band
 * @param manager - The LayerManager instance
 * @param id - Layer ID
 * @param band - Band number
 */
export function setLayerBand(manager: LayerManagerInterface, id: string, band: number): void {
  const layer = manager.layers.get(id) as RasterLayer | undefined;
  if (!layer) return;

  layer.band = band;
  // Update stretch to match band stats
  const bandStats = layer.band_stats[band - 1];
  if (bandStats) {
    layer.stretch.min = bandStats.min;
    layer.stretch.max = bandStats.max;
  }
  manager.refreshLayerTiles(id);
  manager.updateDynamicControls();
}

/**
 * Set layer display mode
 * @param manager - The LayerManager instance
 * @param id - Layer ID
 * @param mode - Display mode ('grayscale', 'rgb', 'crossLayerRgb')
 */
export function setLayerDisplayMode(
  manager: LayerManagerInterface,
  id: string,
  mode: DisplayMode
): void {
  const layer = manager.layers.get(id) as RasterLayer | undefined;
  if (!layer) return;

  layer.displayMode = mode;
  manager.refreshLayerTiles(id);
  manager.updateDynamicControls();
}

/**
 * Set RGB bands for a layer
 * @param manager - The LayerManager instance
 * @param id - Layer ID
 * @param r - Red band
 * @param g - Green band
 * @param b - Blue band
 */
export function setRgbBands(
  manager: LayerManagerInterface,
  id: string,
  r: number,
  g: number,
  b: number
): void {
  const layer = manager.layers.get(id) as RasterLayer | undefined;
  if (!layer) return;

  layer.rgbBands = { r, g, b };

  // Update stretch values for new bands
  const rStats = layer.band_stats[r - 1];
  const gStats = layer.band_stats[g - 1];
  const bStats = layer.band_stats[b - 1];

  if (rStats) layer.rgbStretch.r = { min: rStats.min, max: rStats.max, gamma: 1.0 };
  if (gStats) layer.rgbStretch.g = { min: gStats.min, max: gStats.max, gamma: 1.0 };
  if (bStats) layer.rgbStretch.b = { min: bStats.min, max: bStats.max, gamma: 1.0 };

  manager.refreshLayerTiles(id);
  manager.updateDynamicControls();
}

/**
 * Set RGB stretch for a specific channel
 * @param manager - The LayerManager instance
 * @param id - Layer ID
 * @param channel - Channel ('r', 'g', 'b')
 * @param min - Min value
 * @param max - Max value
 * @param gamma - Gamma value
 */
export function setRgbStretch(
  manager: LayerManagerInterface,
  id: string,
  channel: 'r' | 'g' | 'b',
  min: number,
  max: number,
  gamma: number
): void {
  const layer = manager.layers.get(id) as RasterLayer | undefined;
  if (!layer) return;

  layer.rgbStretch[channel] = { min, max, gamma };
  manager.refreshLayerTiles(id);
}

/**
 * Refresh layer tiles (force reload)
 * @param manager - The LayerManager instance
 * @param id - Layer ID
 */
export function refreshLayerTiles(manager: LayerManagerInterface, id: string): void {
  const layer = manager.layers.get(id) as RasterLayer | undefined;
  if (!layer) return;

  // Handle composition layers separately
  if (layer.isComposition) {
    manager.refreshCompositionTiles(id);
    return;
  }

  const sourceId = `raster-source-${id}`;
  const protocolName = `raster-${id}`;

  // Update the protocol with new settings
  setupTileProtocol(manager, protocolName, id, layer);

  // Force map to reload tiles - update tiles URL with cache buster
  const source = manager.mapManager.map.getSource(sourceId) as
    | maplibregl.RasterTileSource
    | undefined;
  if (source) {
    const cacheBuster = Date.now();
    source.setTiles([`${protocolName}://{z}/{x}/{y}?v=${cacheBuster}`]);
  }
}

import type maplibregl from 'maplibre-gl';
