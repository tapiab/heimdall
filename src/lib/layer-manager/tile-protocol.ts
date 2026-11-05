/**
 * MapLibre tile protocol handlers for raster layers.
 *
 * Each handler fetches raw samples (`raw-tiles`) and renders them with the
 * layer's current stretch and colormap, handing MapLibre an ImageBitmap.
 * Display changes reload tiles through the same handlers, which hit the raw
 * tile cache instead of the backend.
 * @module layer-manager/tile-protocol
 */

import maplibregl from 'maplibre-gl';
import {
  registeredProtocols,
  type LayerManagerInterface,
  type RasterLayer,
  type Layer,
  type StretchSettings,
} from './types';
import { logger } from '../logger';
import {
  fetchRawTile,
  renderGrayscale,
  renderRgb,
  toImageBitmap,
  transparentTile,
  type RawBand,
} from './raw-tiles';

const log = logger.child('LayerManager:TileProtocol');

/** Protocol request parameters */
interface ProtocolParams {
  url: string;
}

/** Protocol response */
interface ProtocolResponse {
  data: ImageBitmap;
}

interface TileCoord {
  z: number;
  x: number;
  y: number;
}

/** Renders one tile to RGBA, or null for a fully transparent tile. */
type TileRenderer = (
  coord: TileCoord,
  signal: AbortSignal
) => Promise<Uint8ClampedArray<ArrayBuffer> | null>;

/** Fallback stretch from band statistics, gamma 1 */
function statsStretch(layer: RasterLayer): StretchSettings {
  return {
    min: layer.band_stats[0]?.min || 0,
    max: layer.band_stats[0]?.max || 255,
    gamma: 1.0,
  };
}

function registerProtocol(protocolName: string, label: string, render: TileRenderer): void {
  if (registeredProtocols.has(protocolName)) {
    maplibregl.removeProtocol(protocolName);
  }

  maplibregl.addProtocol(
    protocolName,
    async (params: ProtocolParams, abortController: AbortController): Promise<ProtocolResponse> => {
      const match = params.url.match(/raster-[^:]+:\/\/(\d+)\/(\d+)\/(\d+)/);
      if (!match) {
        throw new Error('Invalid raster URL format');
      }
      const coord = {
        z: parseInt(match[1], 10),
        x: parseInt(match[2], 10),
        y: parseInt(match[3], 10),
      };

      try {
        const rgba = (await render(coord, abortController.signal)) ?? transparentTile();
        return { data: await toImageBitmap(rgba) };
      } catch (error) {
        if ((error as Error)?.name !== 'AbortError') {
          log.error(`Failed to load ${label}`, { error: String(error) });
        }
        throw error;
      }
    }
  );

  registeredProtocols.add(protocolName);
}

/** RGB from three bands of one dataset, read in one backend pass. */
async function renderDatasetRgb(
  datasetId: string,
  layer: RasterLayer,
  pixel: boolean,
  coord: TileCoord,
  signal: AbortSignal
): Promise<Uint8ClampedArray<ArrayBuffer>> {
  const { r, g, b } = layer.rgbBands;
  const bands = await fetchRawTile({ datasetId, bands: [r, g, b], pixel }, coord, signal);
  const { rgbStretch } = layer;
  return renderRgb(bands as [RawBand, RawBand, RawBand], [
    rgbStretch.r,
    rgbStretch.g,
    rgbStretch.b,
  ]);
}

/** RGB from one band of each of three datasets. */
async function renderCrossLayerRgb(
  manager: LayerManagerInterface,
  layer: RasterLayer,
  stretches: (
    layers: [RasterLayer, RasterLayer, RasterLayer]
  ) => [StretchSettings, StretchSettings, StretchSettings],
  coord: TileCoord,
  signal: AbortSignal
): Promise<Uint8ClampedArray<ArrayBuffer> | null> {
  const cross = layer.crossLayerRgb;
  if (!cross) return null;
  const sources = [
    manager.layers.get(cross.rLayerId),
    manager.layers.get(cross.gLayerId),
    manager.layers.get(cross.bLayerId),
  ] as Array<RasterLayer | undefined>;
  if (sources.some(s => !s)) return null;
  const layers = sources as [RasterLayer, RasterLayer, RasterLayer];

  // Synthetic pixel coordinates unless all three are georeferenced
  const pixel = layers.some(l => !l.is_georeferenced);
  const bandNumbers = [cross.rBand || 1, cross.gBand || 1, cross.bBand || 1];
  const planes = await Promise.all(
    [cross.rLayerId, cross.gLayerId, cross.bLayerId].map(async (datasetId, i) => {
      const [plane] = await fetchRawTile(
        { datasetId, bands: [bandNumbers[i]], pixel },
        coord,
        signal
      );
      return plane;
    })
  );
  return renderRgb(planes as [RawBand, RawBand, RawBand], stretches(layers));
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
  registerProtocol(protocolName, 'tile', async (coord, signal) => {
    const layer = manager.layers.get(datasetId) as RasterLayer | undefined;
    if (!layer) {
      throw new Error('Layer not found');
    }
    const pixel = !layer.is_georeferenced;

    if (layer.displayMode === 'crossLayerRgb' && layer.crossLayerRgb) {
      // Per-source band statistics, as the cross-layer controls have no stretch
      return renderCrossLayerRgb(
        manager,
        layer,
        ([r, g, b]) => [statsStretch(r), statsStretch(g), statsStretch(b)],
        coord,
        signal
      );
    }
    if (layer.displayMode === 'rgb' && layer.bands >= 3) {
      return renderDatasetRgb(datasetId, layer, pixel, coord, signal);
    }
    const [band] = await fetchRawTile({ datasetId, bands: [layer.band], pixel }, coord, signal);
    return renderGrayscale(band, layer.stretch, layer.colormap ?? 'gray');
  });
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
  registerProtocol(protocolName, 'composition tile', (coord, signal) => {
    const layer = manager.layers.get(compositionId) as RasterLayer | undefined;
    if (!layer?.sourceLayerId) {
      throw new Error('Composition layer not found');
    }
    return renderDatasetRgb(layer.sourceLayerId, layer, !layer.is_georeferenced, coord, signal);
  });
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
  registerProtocol(protocolName, 'cross-layer composition tile', async (coord, signal) => {
    const layer = manager.layers.get(compositionId) as RasterLayer | undefined;
    if (!layer || !layer.crossLayerRgb) {
      throw new Error('Cross-layer composition not found');
    }
    const rendered = await renderCrossLayerRgb(
      manager,
      layer,
      ([r, g, b]) => [
        layer.rgbStretch?.r ?? statsStretch(r),
        layer.rgbStretch?.g ?? statsStretch(g),
        layer.rgbStretch?.b ?? statsStretch(b),
      ],
      coord,
      signal
    );
    if (!rendered) {
      throw new Error('Source layers for cross-layer RGB not found');
    }
    return rendered;
  });
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
