/**
 * MapLibre tile protocol handlers for raster layers
 * @module layer-manager/tile-protocol
 */

import { invoke } from '@tauri-apps/api/core';
import maplibregl from 'maplibre-gl';
import {
  registeredProtocols,
  type LayerManagerInterface,
  type RasterLayer,
  type Layer,
} from './types';
import { logger } from '../logger';

const log = logger.child('LayerManager:TileProtocol');

/** Protocol request parameters */
interface ProtocolParams {
  url: string;
}

/** Protocol response */
interface ProtocolResponse {
  data: Uint8Array;
}

/**
 * Setup tile protocol for a raster layer
 * @param manager - The LayerManager instance
 * @param protocolName - Protocol name (e.g., 'raster-abc123')
 * @param datasetId - Dataset ID
 * @param _layerData - Layer data (unused but kept for signature consistency)
 */
export function setupTileProtocol(
  manager: LayerManagerInterface,
  protocolName: string,
  datasetId: string,
  _layerData: Layer
): void {
  // Remove existing protocol if any
  if (registeredProtocols.has(protocolName)) {
    maplibregl.removeProtocol(protocolName);
  }

  maplibregl.addProtocol(
    protocolName,
    async (
      params: ProtocolParams,
      _abortController: AbortController
    ): Promise<ProtocolResponse> => {
      const { url } = params;
      const match = url.match(/raster-[^:]+:\/\/(\d+)\/(\d+)\/(\d+)/);

      if (!match) {
        throw new Error('Invalid raster URL format');
      }

      const [, z, x, y] = match;
      const layer = manager.layers.get(datasetId) as RasterLayer | undefined;

      if (!layer) {
        throw new Error('Layer not found');
      }

      try {
        let tileData: number[];

        if (layer.displayMode === 'crossLayerRgb' && layer.crossLayerRgb) {
          // Cross-layer RGB: get bands from different datasets
          const cross = layer.crossLayerRgb;
          const rLayer = manager.layers.get(cross.rLayerId) as RasterLayer | undefined;
          const gLayer = manager.layers.get(cross.gLayerId) as RasterLayer | undefined;
          const bLayer = manager.layers.get(cross.bLayerId) as RasterLayer | undefined;

          if (rLayer && gLayer && bLayer) {
            // Use pixel version for non-georeferenced images
            const usePixelVersion =
              !rLayer.is_georeferenced || !gLayer.is_georeferenced || !bLayer.is_georeferenced;
            const command = usePixelVersion
              ? 'get_cross_layer_pixel_rgb_tile'
              : 'get_cross_layer_rgb_tile';

            tileData = await invoke<number[]>(command, {
              redId: cross.rLayerId,
              redBand: cross.rBand,
              greenId: cross.gLayerId,
              greenBand: cross.gBand,
              blueId: cross.bLayerId,
              blueBand: cross.bBand,
              x: parseInt(x, 10),
              y: parseInt(y, 10),
              z: parseInt(z, 10),
              redMin: rLayer.band_stats[0]?.min || 0,
              redMax: rLayer.band_stats[0]?.max || 255,
              redGamma: 1.0,
              greenMin: gLayer.band_stats[0]?.min || 0,
              greenMax: gLayer.band_stats[0]?.max || 255,
              greenGamma: 1.0,
              blueMin: bLayer.band_stats[0]?.min || 0,
              blueMax: bLayer.band_stats[0]?.max || 255,
              blueGamma: 1.0,
            });
          } else {
            // Missing layer, return empty
            return { data: new Uint8Array(0) };
          }
        } else if (layer.displayMode === 'rgb' && layer.bands >= 3) {
          // RGB mode
          tileData = await invoke<number[]>('get_rgb_tile', {
            id: datasetId,
            x: parseInt(x, 10),
            y: parseInt(y, 10),
            z: parseInt(z, 10),
            redBand: layer.rgbBands.r,
            greenBand: layer.rgbBands.g,
            blueBand: layer.rgbBands.b,
            redMin: layer.rgbStretch.r.min,
            redMax: layer.rgbStretch.r.max,
            redGamma: layer.rgbStretch.r.gamma,
            greenMin: layer.rgbStretch.g.min,
            greenMax: layer.rgbStretch.g.max,
            greenGamma: layer.rgbStretch.g.gamma,
            blueMin: layer.rgbStretch.b.min,
            blueMax: layer.rgbStretch.b.max,
            blueGamma: layer.rgbStretch.b.gamma,
          });
        } else {
          // Grayscale mode with stretch
          // Use pixel tile for non-georeferenced images
          if (!layer.is_georeferenced) {
            tileData = await invoke<number[]>('get_pixel_tile', {
              id: datasetId,
              x: parseInt(x, 10),
              y: parseInt(y, 10),
              z: parseInt(z, 10),
              band: layer.band,
              min: layer.stretch.min,
              max: layer.stretch.max,
              gamma: layer.stretch.gamma,
            });
          } else {
            tileData = await invoke<number[]>('get_tile_stretched', {
              id: datasetId,
              x: parseInt(x, 10),
              y: parseInt(y, 10),
              z: parseInt(z, 10),
              band: layer.band,
              min: layer.stretch.min,
              max: layer.stretch.max,
              gamma: layer.stretch.gamma,
            });
          }
        }

        return { data: new Uint8Array(tileData) };
      } catch (error) {
        log.error('Failed to load tile', { error: String(error) });
        throw error;
      }
    }
  );

  registeredProtocols.add(protocolName);
}

/**
 * Setup tile protocol for a composition layer (same-layer RGB)
 * @param manager - The LayerManager instance
 * @param protocolName - Protocol name
 * @param compositionId - Composition layer ID
 * @param _compositionLayer - Composition layer data
 */
export function setupCompositionTileProtocol(
  manager: LayerManagerInterface,
  protocolName: string,
  compositionId: string,
  _compositionLayer: RasterLayer
): void {
  // Remove existing protocol if any
  if (registeredProtocols.has(protocolName)) {
    maplibregl.removeProtocol(protocolName);
  }

  maplibregl.addProtocol(
    protocolName,
    async (
      params: ProtocolParams,
      _abortController: AbortController
    ): Promise<ProtocolResponse> => {
      const { url } = params;
      const match = url.match(/raster-[^:]+:\/\/(\d+)\/(\d+)\/(\d+)/);

      if (!match) {
        throw new Error('Invalid raster URL format');
      }

      const [, z, x, y] = match;
      const layer = manager.layers.get(compositionId) as RasterLayer | undefined;

      if (!layer) {
        throw new Error('Composition layer not found');
      }

      const sourceLayerId = layer.sourceLayerId;

      try {
        // Always use RGB mode for composition layers
        const tileData = await invoke<number[]>('get_rgb_tile', {
          id: sourceLayerId,
          x: parseInt(x, 10),
          y: parseInt(y, 10),
          z: parseInt(z, 10),
          redBand: layer.rgbBands.r,
          greenBand: layer.rgbBands.g,
          blueBand: layer.rgbBands.b,
          redMin: layer.rgbStretch.r.min,
          redMax: layer.rgbStretch.r.max,
          redGamma: layer.rgbStretch.r.gamma,
          greenMin: layer.rgbStretch.g.min,
          greenMax: layer.rgbStretch.g.max,
          greenGamma: layer.rgbStretch.g.gamma,
          blueMin: layer.rgbStretch.b.min,
          blueMax: layer.rgbStretch.b.max,
          blueGamma: layer.rgbStretch.b.gamma,
        });

        return { data: new Uint8Array(tileData) };
      } catch (error) {
        log.error('Failed to load composition tile', { error: String(error) });
        throw error;
      }
    }
  );

  registeredProtocols.add(protocolName);
}

/**
 * Setup tile protocol for a cross-layer composition
 * @param manager - The LayerManager instance
 * @param protocolName - Protocol name
 * @param compositionId - Composition layer ID
 * @param _compositionLayer - Composition layer data
 */
export function setupCrossLayerCompositionTileProtocol(
  manager: LayerManagerInterface,
  protocolName: string,
  compositionId: string,
  _compositionLayer: RasterLayer
): void {
  // Remove existing protocol if any
  if (registeredProtocols.has(protocolName)) {
    maplibregl.removeProtocol(protocolName);
  }

  maplibregl.addProtocol(
    protocolName,
    async (
      params: ProtocolParams,
      _abortController: AbortController
    ): Promise<ProtocolResponse> => {
      const { url } = params;
      const match = url.match(/raster-[^:]+:\/\/(\d+)\/(\d+)\/(\d+)/);

      if (!match) {
        throw new Error('Invalid raster URL format');
      }

      const [, z, x, y] = match;
      const layer = manager.layers.get(compositionId) as RasterLayer | undefined;

      if (!layer || !layer.crossLayerRgb) {
        throw new Error('Cross-layer composition not found');
      }

      const { rLayerId, gLayerId, bLayerId, rBand, gBand, bBand } = layer.crossLayerRgb;
      const rLayer = manager.layers.get(rLayerId) as RasterLayer | undefined;
      const gLayer = manager.layers.get(gLayerId) as RasterLayer | undefined;
      const bLayer = manager.layers.get(bLayerId) as RasterLayer | undefined;

      if (!rLayer || !gLayer || !bLayer) {
        throw new Error('Source layers for cross-layer RGB not found');
      }

      try {
        // Use pixel version for non-georeferenced images
        const usePixelVersion =
          !rLayer.is_georeferenced || !gLayer.is_georeferenced || !bLayer.is_georeferenced;
        const command = usePixelVersion
          ? 'get_cross_layer_pixel_rgb_tile'
          : 'get_cross_layer_rgb_tile';

        const tileData = await invoke<number[]>(command, {
          redId: rLayerId,
          redBand: rBand || 1,
          greenId: gLayerId,
          greenBand: gBand || 1,
          blueId: bLayerId,
          blueBand: bBand || 1,
          x: parseInt(x, 10),
          y: parseInt(y, 10),
          z: parseInt(z, 10),
          redMin: layer.rgbStretch?.r?.min ?? rLayer.band_stats[0]?.min ?? 0,
          redMax: layer.rgbStretch?.r?.max ?? rLayer.band_stats[0]?.max ?? 255,
          redGamma: layer.rgbStretch?.r?.gamma ?? 1.0,
          greenMin: layer.rgbStretch?.g?.min ?? gLayer.band_stats[0]?.min ?? 0,
          greenMax: layer.rgbStretch?.g?.max ?? gLayer.band_stats[0]?.max ?? 255,
          greenGamma: layer.rgbStretch?.g?.gamma ?? 1.0,
          blueMin: layer.rgbStretch?.b?.min ?? bLayer.band_stats[0]?.min ?? 0,
          blueMax: layer.rgbStretch?.b?.max ?? bLayer.band_stats[0]?.max ?? 255,
          blueGamma: layer.rgbStretch?.b?.gamma ?? 1.0,
        });

        return { data: new Uint8Array(tileData) };
      } catch (error) {
        log.error('Failed to load cross-layer composition tile', { error: String(error) });
        throw error;
      }
    }
  );

  registeredProtocols.add(protocolName);
}

/**
 * Remove a registered protocol
 * @param protocolName - Protocol name to remove
 */
export function removeProtocol(protocolName: string): void {
  if (registeredProtocols.has(protocolName)) {
    maplibregl.removeProtocol(protocolName);
    registeredProtocols.delete(protocolName);
  }
}
