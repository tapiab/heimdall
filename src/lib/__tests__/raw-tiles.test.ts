/**
 * Tests for client-side raster display: colormaps, stretch, raw tile cache.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import {
  COLORMAPS,
  getColormapLut,
  isColormapName,
  type ColormapName,
} from '../layer-manager/colormaps';
import {
  TILE_SIZE,
  clearRawTileCache,
  fetchRawTile,
  invalidateRawTiles,
  parseRawTile,
  rawTileCacheStats,
  renderGrayscale,
  renderRgb,
  stretchToByte,
} from '../layer-manager/raw-tiles';

const PIXELS = TILE_SIZE * TILE_SIZE;
const linear = { min: 0, max: 100, gamma: 1 };

function plane(fill: (i: number) => number): Float32Array {
  return Float32Array.from({ length: PIXELS }, (_, i) => fill(i));
}

function lutColor(name: ColormapName, index: number): number[] {
  const lut = getColormapLut(name);
  return [lut[index * 3], lut[index * 3 + 1], lut[index * 3 + 2]];
}

function expectColorNear(actual: number[], expected: number[], tolerance: number): void {
  actual.forEach((v, c) => expect(Math.abs(v - expected[c])).toBeLessThanOrEqual(tolerance));
}

describe('colormaps', () => {
  it('builds a 256-entry RGB table for every colormap', () => {
    for (const name of COLORMAPS) {
      expect(getColormapLut(name)).toHaveLength(256 * 3);
    }
  });

  it('gray is the identity', () => {
    for (const i of [0, 1, 127, 255]) {
      expect(lutColor('gray', i)).toEqual([i, i, i]);
    }
  });

  it('matches matplotlib reference colors', () => {
    // matplotlib 8-bit values at 0, 0.5, 1
    expectColorNear(lutColor('viridis', 0), [68, 1, 84], 4);
    expectColorNear(lutColor('viridis', 128), [33, 145, 140], 4);
    expectColorNear(lutColor('viridis', 255), [253, 231, 37], 5);
    expectColorNear(lutColor('magma', 255), [252, 253, 191], 6);
    expectColorNear(lutColor('inferno', 128), [188, 55, 84], 4);
    expectColorNear(lutColor('plasma', 0), [13, 8, 135], 4);
    expectColorNear(lutColor('rdbu', 0), [103, 0, 31], 1);
    expectColorNear(lutColor('rdbu', 255), [5, 48, 97], 1);
    expectColorNear(lutColor('terrain', 255), [255, 255, 255], 1);
  });

  it('recognizes colormap names', () => {
    expect(isColormapName('viridis')).toBe(true);
    expect(isColormapName('jet')).toBe(false);
    expect(isColormapName(undefined)).toBe(false);
  });
});

describe('stretchToByte', () => {
  it('maps min..max linearly with truncation', () => {
    expect(stretchToByte(0, linear)).toBe(0);
    expect(stretchToByte(50, linear)).toBe(127);
    expect(stretchToByte(100, linear)).toBe(255);
  });

  it('clamps outside the range', () => {
    expect(stretchToByte(-10, linear)).toBe(0);
    expect(stretchToByte(150, linear)).toBe(255);
  });

  it('applies gamma as t^(1/gamma)', () => {
    expect(stretchToByte(25, { ...linear, gamma: 2 })).toBe(127);
    expect(stretchToByte(25, { ...linear, gamma: 0.5 })).toBeLessThan(20);
  });

  it('treats an empty range as width 1', () => {
    expect(stretchToByte(5, { min: 5, max: 5, gamma: 1 })).toBe(0);
    expect(stretchToByte(6, { min: 5, max: 5, gamma: 1 })).toBe(255);
  });
});

describe('renderGrayscale', () => {
  it('stretches through the colormap and keeps NaN transparent', () => {
    const band = plane(i => (i === 0 ? NaN : i === 1 ? 100 : 0));
    const rgba = renderGrayscale(band, linear, 'viridis');
    expect(rgba[3]).toBe(0);
    expect(Array.from(rgba.slice(4, 8))).toEqual([...lutColor('viridis', 255), 255]);
    expect(Array.from(rgba.slice(8, 12))).toEqual([...lutColor('viridis', 0), 255]);
  });

  it('renders a missing band as transparent', () => {
    expect(renderGrayscale(null, linear, 'gray').every(v => v === 0)).toBe(true);
  });
});

describe('renderRgb', () => {
  it('is transparent only where all three channels are NaN', () => {
    const r = plane(i => (i < 2 ? NaN : 100));
    const g = plane(i => (i === 0 ? NaN : 50));
    const b = plane(i => (i === 0 ? NaN : 0));
    const rgba = renderRgb([r, g, b], [linear, linear, linear]);
    expect(Array.from(rgba.slice(0, 4))).toEqual([0, 0, 0, 0]);
    // Pixel 1: red is NaN, rendered as 0 but opaque
    expect(Array.from(rgba.slice(4, 8))).toEqual([0, 127, 0, 255]);
    expect(Array.from(rgba.slice(8, 12))).toEqual([255, 127, 0, 255]);
  });

  it('uses a stretch per channel', () => {
    const v = plane(() => 50);
    const rgba = renderRgb(
      [v, v, v],
      [linear, { min: 50, max: 60, gamma: 1 }, { min: 0, max: 50, gamma: 1 }]
    );
    expect(Array.from(rgba.slice(0, 4))).toEqual([127, 0, 255, 255]);
  });
});

describe('parseRawTile', () => {
  it('splits band-sequential samples', () => {
    const samples = new Float32Array(2 * PIXELS);
    samples[0] = 1;
    samples[PIXELS] = 2;
    const planes = parseRawTile(samples.buffer, 2);
    expect(planes).toHaveLength(2);
    expect(planes?.[0][0]).toBe(1);
    expect(planes?.[1][0]).toBe(2);
  });

  it('returns null for an empty body', () => {
    expect(parseRawTile(new ArrayBuffer(0), 1)).toBeNull();
  });

  it('rejects a body of the wrong size', () => {
    expect(() => parseRawTile(new ArrayBuffer(16), 1)).toThrow();
  });
});

describe('fetchRawTile', () => {
  const coord = { z: 3, x: 1, y: 2 };
  const signal = new AbortController().signal;

  beforeEach(() => {
    clearRawTileCache();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async () => new Float32Array(PIXELS).fill(7).buffer);
  });

  it('requests the bands once and serves repeats from the cache', async () => {
    const source = { datasetId: 'ds', bands: [2], pixel: false };
    const [first] = await fetchRawTile(source, coord, signal);
    const [second] = await fetchRawTile(source, coord, signal);
    expect(first?.[0]).toBe(7);
    expect(second).toBe(first);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('get_raw_tile', {
      id: 'ds',
      x: 1,
      y: 2,
      z: 3,
      bands: [2],
      pixel: false,
    });
  });

  it('shares one backend call between concurrent requests', async () => {
    const source = { datasetId: 'ds', bands: [1], pixel: false };
    await Promise.all([fetchRawTile(source, coord, signal), fetchRawTile(source, coord, signal)]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('keys the cache by bands and coordinate mode', async () => {
    await fetchRawTile({ datasetId: 'ds', bands: [1], pixel: false }, coord, signal);
    await fetchRawTile({ datasetId: 'ds', bands: [2], pixel: false }, coord, signal);
    await fetchRawTile({ datasetId: 'ds', bands: [1], pixel: true }, coord, signal);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('caches tiles outside the raster as empty bands', async () => {
    vi.mocked(invoke).mockImplementation(async () => new ArrayBuffer(0));
    const source = { datasetId: 'ds', bands: [1, 2, 3], pixel: false };
    expect(await fetchRawTile(source, coord, signal)).toEqual([null, null, null]);
    expect(await fetchRawTile(source, coord, signal)).toEqual([null, null, null]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('refetches a dataset after invalidation', async () => {
    const source = { datasetId: 'ds', bands: [1], pixel: false };
    const other = { datasetId: 'other', bands: [1], pixel: false };
    await fetchRawTile(source, coord, signal);
    await fetchRawTile(other, coord, signal);
    invalidateRawTiles('ds');
    expect(rawTileCacheStats().tiles).toBe(1);
    await fetchRawTile(source, coord, signal);
    await fetchRawTile(other, coord, signal);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('does not call the backend once aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchRawTile({ datasetId: 'ds', bands: [1], pixel: false }, coord, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).not.toHaveBeenCalled();
  });
});
