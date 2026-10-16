/**
 * Raster layer handling - loading, stretch, band selection
 * @module layer-manager/raster-handler
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { ask } from '@tauri-apps/plugin-dialog';
import { showToast, showError, showLoading, hideLoading } from '../notifications';
import { setupTileProtocol } from './tile-protocol';
import { logger } from '../logger';
import type {
  LayerManagerInterface,
  RasterLayer,
  BandStats,
  DisplayMode,
  RpcElevation,
} from './types';

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
  georef_method?: 'geotransform' | 'rpc' | 'none';
  rpc_default_height?: number | null;
  suggest_overviews?: boolean;
}

/** Paths whose overview prompt was declined this session (don't nag on reopen). */
const declinedOverviewPaths = new Set<string>();

/**
 * Margin added around an RPC footprint for the map source bounds. Picking a
 * DEM or height shifts the footprint; tiles outside source bounds are never
 * requested, so leave room rather than rebuilding the source.
 */
const RPC_BOUNDS_MARGIN = 0.1;

function padBounds(
  bounds: [number, number, number, number],
  ratio: number
): [number, number, number, number] {
  const dx = (bounds[2] - bounds[0]) * ratio;
  const dy = (bounds[3] - bounds[1]) * ratio;
  return [
    Math.max(bounds[0] - dx, -180),
    Math.max(bounds[1] - dy, -85.0511),
    Math.min(bounds[2] + dx, 180),
    Math.min(bounds[3] + dy, 85.0511),
  ];
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
    log.debug('Band stats', { band_stats: metadata.band_stats });

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
    if (metadata.georef_method === 'rpc') {
      mapBounds = padBounds(metadata.bounds, RPC_BOUNDS_MARGIN);
    } else if (!metadata.is_georeferenced) {
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
    if (metadata.georef_method === 'rpc') {
      void applyDefaultRpcElevation(manager, metadata.id);
    }
    if (metadata.suggest_overviews) {
      // Not awaited: the layer is usable meanwhile, and callers restoring
      // several layers shouldn't block on the prompt.
      void offerOverviews(manager, metadata.id);
    }
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
 * Ask whether to build overviews for a large raster that has none, unless
 * already declined for this file this session.
 */
export async function offerOverviews(manager: LayerManagerInterface, id: string): Promise<void> {
  const layer = manager.layers.get(id) as RasterLayer | undefined;
  if (!layer?.suggest_overviews || declinedOverviewPaths.has(layer.path)) return;

  const fileName = layer.path.split('/').pop()?.split('\\').pop() || layer.path;
  const accepted = await ask(
    `${fileName} has no overviews, so it will be slow when zoomed out.\n\n` +
      'Build them now? This writes a .ovr file next to the image and leaves the image itself unchanged.',
    { title: 'Build Overviews', kind: 'info', okLabel: 'Build Overviews', cancelLabel: 'Not Now' }
  );
  if (accepted) {
    await buildOverviews(manager, id);
  } else {
    declinedOverviewPaths.add(layer.path);
  }
}

/**
 * Build external overviews (.ovr) for a raster layer, showing progress, then
 * redraw it and anything composed from it.
 */
export async function buildOverviews(manager: LayerManagerInterface, id: string): Promise<void> {
  const layer = manager.layers.get(id) as RasterLayer | undefined;
  if (!layer) return;

  const loadingText = document.getElementById('loading-indicator')?.querySelector('span');
  let unlisten: UnlistenFn | null = null;
  showLoading('Building overviews... 0%');
  try {
    unlisten = await listen<{ id: string; progress: number }>('overview-progress', event => {
      if (event.payload.id === id && loadingText) {
        loadingText.textContent = `Building overviews... ${Math.round(event.payload.progress * 100)}%`;
      }
    });
    await invoke('build_overviews', { id });
    layer.suggest_overviews = false;
    refreshDependentTiles(manager, id);
    manager.updateDynamicControls();
    showToast('Overviews built', 'success', 2000);
  } catch (error) {
    showError('Failed to build overviews', error as Error);
  } finally {
    unlisten?.();
    hideLoading();
  }
}

/** Reload tiles of a layer and of compositions built on its dataset. */
function refreshDependentTiles(manager: LayerManagerInterface, id: string): void {
  for (const [otherId, other] of manager.layers) {
    if (other.type !== 'raster') continue;
    const rgb = other.crossLayerRgb;
    const dependsOnLayer =
      otherId === id ||
      other.sourceLayerId === id ||
      (rgb && [rgb.rLayerId, rgb.gLayerId, rgb.bLayerId].includes(id));
    if (dependsOnLayer) manager.refreshLayerTiles(otherId);
  }
}

/**
 * Recreate a raster layer's map source with new bounds, keeping its tile URL,
 * stacking position, opacity and visibility. MapLibre can't change a source's
 * bounds in place, and tiles outside them are never requested; recreating also
 * drops every cached tile, so the whole view redraws from the backend.
 */
function rebuildRasterSource(
  manager: LayerManagerInterface,
  id: string,
  bounds: [number, number, number, number]
): void {
  const { map } = manager.mapManager;
  const sourceId = `raster-source-${id}`;
  const layerId = `raster-layer-${id}`;
  const source = map.getSource(sourceId) as maplibregl.RasterTileSource | undefined;
  if (!source || !map.getLayer(layerId)) return;

  const tileUrl = (source.tiles?.[0] ?? `raster-${id}://{z}/{x}/{y}`).split('?')[0];
  const layers = map.getStyle().layers ?? [];
  const beforeId = layers[layers.findIndex(l => l.id === layerId) + 1]?.id;
  const opacity = map.getPaintProperty(layerId, 'raster-opacity') as number | undefined;
  const visibility = map.getLayoutProperty(layerId, 'visibility') as 'visible' | 'none' | undefined;

  map.removeLayer(layerId);
  map.removeSource(sourceId);
  map.addSource(sourceId, {
    type: 'raster',
    tiles: [`${tileUrl}?v=${Date.now()}`],
    tileSize: 256,
    bounds,
    minzoom: 0,
    maxzoom: 22,
  });
  map.addLayer(
    {
      id: layerId,
      type: 'raster',
      source: sourceId,
      paint: { 'raster-opacity': opacity ?? 1 },
      layout: { visibility: visibility ?? 'visible' },
    },
    beforeId
  );
}

/**
 * Redraw an RPC layer and the compositions built on it after its terrain
 * changed: new footprint (with margin for further terrain changes), fresh tiles.
 */
function redrawReprojectedLayer(
  manager: LayerManagerInterface,
  id: string,
  bounds: [number, number, number, number]
): void {
  const mapBounds = padBounds(bounds, RPC_BOUNDS_MARGIN);
  for (const [otherId, other] of manager.layers) {
    if (other.type !== 'raster') continue;
    if (otherId === id || other.sourceLayerId === id) {
      other.bounds = bounds;
      // The layer's protocol reads settings at request time; re-register so
      // anything captured at setup is current, then rebuild the source.
      if (otherId === id) setupTileProtocol(manager, `raster-${id}`, id, other);
      rebuildRasterSource(manager, otherId, mapBounds);
    } else if (other.crossLayerRgb) {
      const rgb = other.crossLayerRgb;
      if ([rgb.rLayerId, rgb.gLayerId, rgb.bLayerId].includes(id)) {
        manager.refreshLayerTiles(otherId);
      }
    }
  }
  manager.mapManager.map.triggerRepaint();
}

/** Online DEM applied by the backend */
interface OnlineDemResult {
  dem_path: string;
  dem_height_offset: number | null;
  bounds: [number, number, number, number];
}

/**
 * Set the terrain used to project an RPC layer and redraw it (and any
 * composition built on it, since they share the backend dataset).
 * @param manager - The LayerManager instance
 * @param id - Layer ID
 * @param elevation - Elevation source and constant height (null = model default)
 * @returns Whether the elevation was applied
 */
export async function setRpcElevation(
  manager: LayerManagerInterface,
  id: string,
  elevation: RpcElevation,
  options: { notifyErrors?: boolean } = {}
): Promise<boolean> {
  const layer = manager.layers.get(id) as RasterLayer | undefined;
  if (!layer || layer.georef_method !== 'rpc') return false;

  const messages: Record<RpcElevation['source'], string> = {
    online: 'Fetching Copernicus DEM...',
    file: 'Projecting with DEM...',
    none: 'Updating projection...',
  };
  showLoading(messages[elevation.source]);
  try {
    let applied: RpcElevation;
    let bounds: [number, number, number, number];
    if (elevation.source === 'online') {
      const result = await invoke<OnlineDemResult>('use_online_dem', {
        id,
        height: elevation.height,
      });
      applied = {
        source: 'online',
        demPath: result.dem_path,
        height: elevation.height,
        demHeightOffset: result.dem_height_offset,
      };
      ({ bounds } = result);
      if (result.dem_height_offset === null) {
        showToast(
          'Geoid correction unavailable: terrain heights may be off by tens of meters',
          'info',
          5000
        );
      }
    } else {
      applied = {
        source: elevation.source,
        demPath: elevation.source === 'file' ? elevation.demPath : null,
        height: elevation.height,
        demHeightOffset: null,
      };
      bounds = await invoke<[number, number, number, number]>('set_rpc_elevation', {
        id,
        demPath: applied.demPath,
        height: applied.height,
        demHeightOffset: null,
      });
    }
    layer.rpcElevation = applied;
    log.debug('RPC elevation set', { id, ...applied, bounds });

    redrawReprojectedLayer(manager, id, bounds);
    manager.updateDynamicControls();
    const labels: Record<RpcElevation['source'], string> = {
      online: 'Copernicus DEM',
      file: 'local DEM',
      none: 'constant height',
    };
    showToast(`Re-projected with ${labels[applied.source]}`, 'success', 2000);
    return true;
  } catch (error) {
    if (options.notifyErrors !== false) {
      showError('Failed to set elevation', error as Error);
    }
    log.warn('RPC elevation not applied', { id, error: String(error) });
    return false;
  } finally {
    hideLoading();
  }
}

/**
 * Default terrain for a newly opened RPC layer: the online Copernicus DEM,
 * falling back to the model's constant height when it can't be reached.
 */
export async function applyDefaultRpcElevation(
  manager: LayerManagerInterface,
  id: string
): Promise<void> {
  const ok = await setRpcElevation(
    manager,
    id,
    { source: 'online', demPath: null, height: null },
    { notifyErrors: false }
  );
  if (!ok) {
    showToast('Online DEM unavailable: projecting at constant height', 'info', 5000);
  }
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
