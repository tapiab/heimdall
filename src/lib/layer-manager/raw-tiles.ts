/**
 * Raw raster tiles and client-side display.
 *
 * The backend returns raw `f32` samples per tile (`get_raw_tile`); stretch,
 * gamma and colormap are applied here. Raw tiles are cached independently of
 * display settings, so changing them re-renders from memory without a backend
 * call.
 * @module layer-manager/raw-tiles
 */

import { invoke } from '@tauri-apps/api/core';
import { scheduleTile } from './tile-queue';
import { getColormapLut, type ColormapName } from './colormaps';
import type { StretchSettings } from './types';

/** Tile edge in pixels, fixed by the backend */
export const TILE_SIZE = 256;
const TILE_PIXELS = TILE_SIZE * TILE_SIZE;

/** Raw tile cache budget in bytes */
const CACHE_BUDGET_BYTES = 256 * 1024 * 1024;

/** One band of one tile; `null` when the tile misses the raster. */
export type RawBand = Float32Array | null;

/** Which dataset bands to read for a tile */
export interface RawTileSource {
  datasetId: string;
  /** 1-indexed band numbers, read in one backend pass */
  bands: number[];
  /** Read through synthetic pixel coordinates (non-georeferenced image) */
  pixel: boolean;
}

interface TileCoord {
  z: number;
  x: number;
  y: number;
}

/** Cached planes per key, `null` for a tile outside the raster. */
const cache = new Map<string, Float32Array[] | null>();
let cachedBytes = 0;
/** Requests already sent to the backend, shared by identical tiles */
const inflight = new Map<string, Promise<Float32Array[] | null>>();

function cacheKey(source: RawTileSource, { z, x, y }: TileCoord): string {
  return `${source.datasetId}|${source.pixel ? 'p' : 'g'}|${source.bands.join(',')}|${z}/${x}/${y}`;
}

function entryBytes(planes: Float32Array[] | null): number {
  return planes ? planes.length * TILE_PIXELS * 4 : 0;
}

function cacheGet(key: string): Float32Array[] | null | undefined {
  const value = cache.get(key);
  if (value === undefined) return undefined;
  // Re-insert as most recently used
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function cacheSet(key: string, planes: Float32Array[] | null): void {
  const previous = cache.get(key);
  if (previous !== undefined) {
    cachedBytes -= entryBytes(previous);
    cache.delete(key);
  }
  cache.set(key, planes);
  cachedBytes += entryBytes(planes);
  for (const [oldKey, oldPlanes] of cache) {
    if (cachedBytes <= CACHE_BUDGET_BYTES || oldKey === key) break;
    cache.delete(oldKey);
    cachedBytes -= entryBytes(oldPlanes);
  }
}

/** Split a `get_raw_tile` body into one plane per band. */
export function parseRawTile(buffer: ArrayBuffer, bandCount: number): Float32Array[] | null {
  if (buffer.byteLength === 0) return null;
  const expected = bandCount * TILE_PIXELS * 4;
  if (buffer.byteLength !== expected) {
    throw new Error(`Raw tile is ${buffer.byteLength} bytes, expected ${expected}`);
  }
  const samples = new Float32Array(buffer);
  return Array.from({ length: bandCount }, (_, i) =>
    samples.subarray(i * TILE_PIXELS, (i + 1) * TILE_PIXELS)
  );
}

/**
 * Raw samples of `source.bands` for one tile, from the cache or the backend.
 * Waiting requests are dropped when `signal` aborts; a request already sent
 * still completes and fills the cache.
 */
export async function fetchRawTile(
  source: RawTileSource,
  coord: TileCoord,
  signal: AbortSignal
): Promise<RawBand[]> {
  const key = cacheKey(source, coord);
  const cached = cacheGet(key);
  if (cached !== undefined) return cached ?? source.bands.map(() => null);

  const planes = await scheduleTile(signal, () => {
    // Another request may have filled or started this tile while we queued.
    const hit = cacheGet(key);
    if (hit !== undefined) return Promise.resolve(hit);
    let pending = inflight.get(key);
    if (!pending) {
      pending = invoke<ArrayBuffer>('get_raw_tile', {
        id: source.datasetId,
        x: coord.x,
        y: coord.y,
        z: coord.z,
        bands: source.bands,
        pixel: source.pixel,
      })
        .then(buffer => {
          const parsed = parseRawTile(buffer, source.bands.length);
          cacheSet(key, parsed);
          return parsed;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    return pending;
  });
  return planes ?? source.bands.map(() => null);
}

/** Drop cached tiles of a dataset (closed, or its pixels changed). */
export function invalidateRawTiles(datasetId: string): void {
  const prefix = `${datasetId}|`;
  for (const [key, planes] of cache) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
      cachedBytes -= entryBytes(planes);
    }
  }
}

/** Cached tile count and size (for tests and diagnostics). */
export function rawTileCacheStats(): { tiles: number; bytes: number } {
  return { tiles: cache.size, bytes: cachedBytes };
}

/** Empty the raw tile cache (for tests). */
export function clearRawTileCache(): void {
  cache.clear();
  inflight.clear();
  cachedBytes = 0;
}

/**
 * Stretch one sample to 0..255: linear between min and max, clamped, then
 * gamma (`t^(1/gamma)`). Truncates like the former backend stretch.
 */
export function stretchToByte(value: number, stretch: StretchSettings): number {
  const range = stretch.max > stretch.min ? stretch.max - stretch.min : 1;
  let t = (value - stretch.min) / range;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  if (stretch.gamma !== 1) t = Math.pow(t, 1 / stretch.gamma);
  return Math.floor(t * 255);
}

/** A fully transparent RGBA tile */
export function transparentTile(): Uint8ClampedArray<ArrayBuffer> {
  return new Uint8ClampedArray(TILE_PIXELS * 4);
}

/**
 * Render one band through a stretch and colormap into RGBA. NaN samples and
 * a missing band are transparent.
 */
export function renderGrayscale(
  band: RawBand,
  stretch: StretchSettings,
  colormap: ColormapName
): Uint8ClampedArray<ArrayBuffer> {
  const rgba = transparentTile();
  if (!band) return rgba;
  const lut = getColormapLut(colormap);
  const { min, gamma } = stretch;
  const range = stretch.max > stretch.min ? stretch.max - stretch.min : 1;
  const invGamma = 1 / gamma;
  for (let i = 0; i < TILE_PIXELS; i++) {
    const v = band[i];
    if (Number.isNaN(v)) continue; // nodata or outside
    let t = (v - min) / range;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    if (gamma !== 1) t = Math.pow(t, invGamma);
    const k = Math.floor(t * 255) * 3;
    const o = i * 4;
    rgba[o] = lut[k];
    rgba[o + 1] = lut[k + 1];
    rgba[o + 2] = lut[k + 2];
    rgba[o + 3] = 255;
  }
  return rgba;
}

/**
 * Render three bands as RGB into RGBA. A pixel is transparent only when all
 * three samples are NaN; a single NaN channel renders as 0.
 */
export function renderRgb(
  bands: [RawBand, RawBand, RawBand],
  stretches: [StretchSettings, StretchSettings, StretchSettings]
): Uint8ClampedArray<ArrayBuffer> {
  const rgba = transparentTile();
  if (!bands[0] && !bands[1] && !bands[2]) return rgba;
  for (let i = 0; i < TILE_PIXELS; i++) {
    const o = i * 4;
    let valid = false;
    for (let c = 0; c < 3; c++) {
      const v = bands[c]?.[i] ?? NaN;
      if (Number.isNaN(v)) continue;
      valid = true;
      rgba[o + c] = stretchToByte(v, stretches[c]);
    }
    if (valid) rgba[o + 3] = 255;
  }
  return rgba;
}

/** Wrap RGBA tile pixels as an ImageBitmap, which MapLibre takes directly. */
export function toImageBitmap(rgba: Uint8ClampedArray<ArrayBuffer>): Promise<ImageBitmap> {
  return createImageBitmap(new ImageData(rgba, TILE_SIZE, TILE_SIZE));
}
