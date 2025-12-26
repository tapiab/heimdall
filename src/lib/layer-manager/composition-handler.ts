/**
 * RGB composition layer handling - same-layer and cross-layer RGB compositions
 * @module layer-manager/composition-handler
 */

import { setupCompositionTileProtocol, setupCrossLayerCompositionTileProtocol } from './tile-protocol';
import { logger } from '../logger';
import type { LayerManagerInterface, RasterLayer } from './types';
import type maplibregl from 'maplibre-gl';

const log = logger.child('LayerManager:Composition');

/**
 * Create a new virtual RGB composition layer from the current RGB settings.
 * This creates a persistent layer that preserves the current RGB band combination.
 * @param manager - The LayerManager instance
 * @param sourceLayerId - Source layer ID to create composition from
 * @returns Composition layer ID or null if creation failed
 */
export async function createRgbCompositionLayer(
  manager: LayerManagerInterface,
  sourceLayerId: string
): Promise<string | null> {
  const sourceLayer = manager.layers.get(sourceLayerId) as RasterLayer | undefined;
  if (!sourceLayer || sourceLayer.type !== 'raster') {
    log.error('Source layer not found or not a raster');
    return null;
  }

  // Generate a unique ID for the new composition layer
  const compositionId = `rgb-comp-${Date.now()}`;
  const sourceName = sourceLayer.path.split('/').pop()?.split('\\').pop() || 'Unknown';

  // Create the composition layer data
  const compositionLayer: RasterLayer = {
    id: compositionId,
    path: `RGB Composite: ${sourceName}`,
    type: 'raster',
    isComposition: true,
    sourceLayerId,
    // Copy relevant metadata from source
    width: sourceLayer.width,
    height: sourceLayer.height,
    bands: 3, // Virtual 3-band layer
    bounds: sourceLayer.bounds,
    is_georeferenced: sourceLayer.is_georeferenced,
    band_stats: [
      sourceLayer.band_stats[sourceLayer.rgbBands.r - 1] || { min: 0, max: 255 },
      sourceLayer.band_stats[sourceLayer.rgbBands.g - 1] || { min: 0, max: 255 },
      sourceLayer.band_stats[sourceLayer.rgbBands.b - 1] || { min: 0, max: 255 },
    ],
    visible: true,
    opacity: 1.0,
    displayMode: 'rgb',
    // Store the RGB configuration
    rgbBands: { ...sourceLayer.rgbBands },
    rgbStretch: {
      r: { ...sourceLayer.rgbStretch.r },
      g: { ...sourceLayer.rgbStretch.g },
      b: { ...sourceLayer.rgbStretch.b },
    },
    // For grayscale fallback
    band: 1,
    stretch: { min: 0, max: 255, gamma: 1.0 },
    // Non-geo support
    pixelScale: sourceLayer.pixelScale,
    pixelOffset: sourceLayer.pixelOffset,
  };

  manager.layers.set(compositionId, compositionLayer);
  manager.layerOrder.push(compositionId);

  // Create protocol for the composition layer
  const protocolName = `raster-${compositionId}`;
  setupCompositionTileProtocol(manager, protocolName, compositionId, compositionLayer);

  // Add to map
  const sourceId = `raster-source-${compositionId}`;
  const layerId = `raster-layer-${compositionId}`;

  let mapBounds = compositionLayer.bounds;
  if (!compositionLayer.is_georeferenced && compositionLayer.pixelScale) {
    const scale = compositionLayer.pixelScale;
    const halfWidth = (compositionLayer.width * scale) / 2;
    const halfHeight = (compositionLayer.height * scale) / 2;
    const clampedHalfHeight = Math.min(halfHeight, 85);
    mapBounds = [-halfWidth, -clampedHalfHeight, halfWidth, clampedHalfHeight];
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

  // Select the new composition layer
  manager.selectedLayerId = compositionId;

  // Update UI
  manager.updateLayerPanel();
  manager.updateDynamicControls();

  return compositionId;
}

/**
 * Create a cross-layer RGB composition layer from multiple raster layers.
 * Each RGB channel can source from a different layer's band.
 * @param manager - The LayerManager instance
 * @param sourceLayerId - Source layer ID (must have crossLayerRgb config)
 * @returns Composition layer ID or null if creation failed
 */
export async function createCrossLayerRgbCompositionLayer(
  manager: LayerManagerInterface,
  sourceLayerId: string
): Promise<string | null> {
  const sourceLayer = manager.layers.get(sourceLayerId) as RasterLayer | undefined;
  if (!sourceLayer || sourceLayer.type !== 'raster' || !sourceLayer.crossLayerRgb) {
    log.error('Source layer not found or not configured for cross-layer RGB');
    return null;
  }

  const { rLayerId, gLayerId, bLayerId, rBand, gBand, bBand } = sourceLayer.crossLayerRgb;
  const rLayer = manager.layers.get(rLayerId) as RasterLayer | undefined;
  const gLayer = manager.layers.get(gLayerId) as RasterLayer | undefined;
  const bLayer = manager.layers.get(bLayerId) as RasterLayer | undefined;

  if (!rLayer || !gLayer || !bLayer) {
    log.error('One or more source layers for cross-layer RGB not found');
    return null;
  }

  // Generate a unique ID for the new composition layer
  const compositionId = `cross-rgb-comp-${Date.now()}`;

  // Get names for the composition
  const rName = rLayer.path.split('/').pop()?.split('\\').pop() || 'Unknown';
  const gName = gLayer.path.split('/').pop()?.split('\\').pop() || 'Unknown';
  const bName = bLayer.path.split('/').pop()?.split('\\').pop() || 'Unknown';

  // Create the composition layer data
  const compositionLayer: RasterLayer = {
    id: compositionId,
    path: `Cross RGB: ${rName}/${gName}/${bName}`,
    type: 'raster',
    isComposition: true,
    isCrossLayerComposition: true,
    // Store references to source layers
    crossLayerRgb: {
      rLayerId,
      rBand: rBand || 1,
      gLayerId,
      gBand: gBand || 1,
      bLayerId,
      bBand: bBand || 1,
    },
    // Use the red layer as reference for dimensions/bounds
    width: rLayer.width,
    height: rLayer.height,
    bands: 3,
    bounds: rLayer.bounds,
    is_georeferenced: rLayer.is_georeferenced,
    band_stats: [
      rLayer.band_stats[0] || { min: 0, max: 255 },
      gLayer.band_stats[0] || { min: 0, max: 255 },
      bLayer.band_stats[0] || { min: 0, max: 255 },
    ],
    visible: true,
    opacity: 1.0,
    displayMode: 'crossLayerRgb',
    // RGB stretch settings
    rgbBands: { r: 1, g: 1, b: 1 },
    rgbStretch: {
      r: {
        min: rLayer.band_stats[0]?.min || 0,
        max: rLayer.band_stats[0]?.max || 255,
        gamma: 1.0,
      },
      g: {
        min: gLayer.band_stats[0]?.min || 0,
        max: gLayer.band_stats[0]?.max || 255,
        gamma: 1.0,
      },
      b: {
        min: bLayer.band_stats[0]?.min || 0,
        max: bLayer.band_stats[0]?.max || 255,
        gamma: 1.0,
      },
    },
    // For grayscale fallback
    band: 1,
    stretch: { min: 0, max: 255, gamma: 1.0 },
    // Non-geo support
    pixelScale: rLayer.pixelScale,
    pixelOffset: rLayer.pixelOffset,
  };

  manager.layers.set(compositionId, compositionLayer);
  manager.layerOrder.push(compositionId);

  // Create protocol for the composition layer
  const protocolName = `raster-${compositionId}`;
  setupCrossLayerCompositionTileProtocol(manager, protocolName, compositionId, compositionLayer);

  // Add to map
  const sourceId = `raster-source-${compositionId}`;
  const layerId = `raster-layer-${compositionId}`;

  let mapBounds = compositionLayer.bounds;
  if (!compositionLayer.is_georeferenced && compositionLayer.pixelScale) {
    const scale = compositionLayer.pixelScale;
    const halfWidth = (compositionLayer.width * scale) / 2;
    const halfHeight = (compositionLayer.height * scale) / 2;
    const clampedHalfHeight = Math.min(halfHeight, 85);
    mapBounds = [-halfWidth, -clampedHalfHeight, halfWidth, clampedHalfHeight];
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

  // Select the new composition layer
  manager.selectedLayerId = compositionId;

  // Update UI
  manager.updateLayerPanel();
  manager.updateDynamicControls();

  return compositionId;
}

/**
 * Refresh tiles for a composition layer, forcing a reload with current settings.
 * @param manager - The LayerManager instance
 * @param id - Composition layer ID
 */
export function refreshCompositionTiles(
  manager: LayerManagerInterface,
  id: string
): void {
  const layer = manager.layers.get(id) as RasterLayer | undefined;
  if (!layer || !layer.isComposition) return;

  const sourceId = `raster-source-${id}`;
  const protocolName = `raster-${id}`;

  // Update the protocol with new settings
  if (layer.isCrossLayerComposition) {
    setupCrossLayerCompositionTileProtocol(manager, protocolName, id, layer);
  } else {
    setupCompositionTileProtocol(manager, protocolName, id, layer);
  }

  // Force map to reload tiles
  const source = manager.mapManager.map.getSource(sourceId) as maplibregl.RasterTileSource | undefined;
  if (source) {
    const cacheBuster = Date.now();
    source.setTiles([`${protocolName}://{z}/{x}/{y}?v=${cacheBuster}`]);
  }
}
