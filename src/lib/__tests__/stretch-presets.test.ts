/**
 * Tests for stretch presets, equalization, colormaps and image statistics helpers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));
vi.mock('../logger', () => ({
  logger: { child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { invoke } from '@tauri-apps/api/core';
import {
  bitRange,
  equalizationLut,
  getBandHistogram,
  invalidateBandHistograms,
  peekBandHistogram,
  presetLimits,
} from '../layer-manager/stretch-presets';
import { COLORMAPS, getColormapLut } from '../layer-manager/colormaps';
import { renderGrayscale, TILE_SIZE } from '../layer-manager/raw-tiles';
import { bucketRange, findOutliers } from '../layer-manager/image-stats';
import type { HistogramData } from '../layer-manager/types';

/** Histogram over 0..100 with `counts` in equal bins */
function histogram(counts: number[], percentiles?: HistogramData['percentiles']): HistogramData {
  const width = 100 / counts.length;
  return {
    counts,
    bin_edges: counts.map((_, i) => i * width).concat(100),
    min: 0,
    max: 100,
    percentiles,
  };
}

const stats = { min: 0, max: 4000, significant_bits: 14 };
const percentiles = { p1: 10, p2: 20, p98: 3000, p99: 3500 };

describe('presetLimits', () => {
  it('reads percentile cuts from the histogram', () => {
    const h = histogram([1], percentiles);
    expect(presetLimits('p2', stats, h)).toEqual({ min: 20, max: 3000 });
    expect(presetLimits('p1', stats, h)).toEqual({ min: 10, max: 3500 });
  });

  it('uses band min/max and the bit range', () => {
    expect(presetLimits('minmax', stats, undefined)).toEqual({ min: 0, max: 4000 });
    expect(presetLimits('bits', stats, undefined)).toEqual({ min: 0, max: 16383 });
  });

  it('is null when the inputs are missing', () => {
    expect(presetLimits('p2', stats, undefined)).toBeNull();
    expect(presetLimits('p2', stats, histogram([1], null))).toBeNull();
    expect(presetLimits('bits', { min: 0, max: 1 }, undefined)).toBeNull();
    expect(presetLimits('custom', stats, undefined)).toBeNull();
  });

  it('falls back to min/max when the percentiles collapse', () => {
    const flat = histogram([1], { p1: 5, p2: 5, p98: 5, p99: 5 });
    expect(presetLimits('p2', stats, flat)).toEqual({ min: 0, max: 4000 });
  });
});

describe('bitRange', () => {
  it('covers unsigned bit depths only', () => {
    expect(bitRange({ min: 0, max: 1, significant_bits: 8 })).toEqual({ min: 0, max: 255 });
    expect(bitRange({ min: 0, max: 1, significant_bits: null })).toBeNull();
    expect(bitRange(undefined)).toBeNull();
  });
});

describe('equalizationLut', () => {
  const linear = { min: 0, max: 100, gamma: 1 };

  it('is the identity for a uniform histogram', () => {
    const lut = equalizationLut(histogram(new Array(256).fill(10)), linear);
    for (const k of [0, 64, 128, 255]) {
      expect(Math.abs(lut[k] - k)).toBeLessThanOrEqual(1);
    }
  });

  it('spreads values where samples concentrate', () => {
    // Everything in the lower quarter of the window
    const counts = new Array(256).fill(0).map((_, i) => (i < 64 ? 10 : 0));
    const lut = equalizationLut(histogram(counts), linear);
    expect(lut[32]).toBeGreaterThan(100);
    expect(lut[63]).toBe(255);
    expect(lut[200]).toBe(255);
  });

  it('ignores samples outside the stretch window', () => {
    const counts = [100, 0, 0, 1];
    const lut = equalizationLut(histogram(counts), { min: 50, max: 100, gamma: 1 });
    expect(lut[255]).toBe(255);
    expect(lut[0]).toBe(0);
  });

  it('falls back to identity when no samples are in the window', () => {
    const lut = equalizationLut(histogram([5]), { min: 200, max: 300, gamma: 1 });
    expect(lut[77]).toBe(77);
  });
});

describe('renderGrayscale with equalization', () => {
  it('maps the stretched value through the table before the colormap', () => {
    const band = new Float32Array(TILE_SIZE * TILE_SIZE).fill(50);
    const table = new Uint8Array(256);
    table[127] = 200;
    const rgba = renderGrayscale(band, { min: 0, max: 100, gamma: 1 }, 'gray', table);
    expect(Array.from(rgba.slice(0, 4))).toEqual([200, 200, 200, 255]);
  });
});

describe('getBandHistogram', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    invalidateBandHistograms('ds');
  });

  it('fetches once per dataset band and exposes the result', async () => {
    const h = histogram([1], percentiles);
    vi.mocked(invoke).mockResolvedValue(h);
    expect(peekBandHistogram('ds', 1)).toBeUndefined();
    await Promise.all([getBandHistogram('ds', 1), getBandHistogram('ds', 1)]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('get_histogram', { id: 'ds', band: 1, numBins: 1024 });
    expect(peekBandHistogram('ds', 1)).toBe(h);
    invalidateBandHistograms('ds');
    expect(peekBandHistogram('ds', 1)).toBeUndefined();
  });

  it('retries after a failure', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('boom'));
    await expect(getBandHistogram('ds', 2)).rejects.toThrow('boom');
    vi.mocked(invoke).mockResolvedValue(histogram([1]));
    await getBandHistogram('ds', 2);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

describe('colormaps', () => {
  it('builds valid tables for every colormap', () => {
    for (const name of COLORMAPS) {
      expect(getColormapLut(name)).toHaveLength(768);
    }
  });

  it('reverses gray and closes the hue circle', () => {
    const grayR = getColormapLut('gray_r');
    expect([grayR[0], grayR[765]]).toEqual([255, 0]);
    const hsv = getColormapLut('hsv');
    expect(Array.from(hsv.slice(0, 3))).toEqual(Array.from(hsv.slice(765, 768)));
    const red = getColormapLut('red');
    expect(Array.from(red.slice(765, 768))).toEqual([255, 0, 0]);
  });
});

describe('bucketRange', () => {
  it('keeps single spikes when squeezing a series', () => {
    const values = [1, 1, 1, 9, 1, 1, 1, 1];
    expect(bucketRange(values, 2)).toEqual([
      { min: 1, max: 9 },
      { min: 1, max: 1 },
    ]);
  });

  it('marks all-null buckets', () => {
    expect(bucketRange([null, null, 3], 3)).toEqual([null, null, { min: 3, max: 3 }]);
  });
});

describe('findOutliers', () => {
  it('finds a hot and a dead column against noise', () => {
    const values: Array<number | null> = Array.from({ length: 100 }, (_, i) => 100 + (i % 5));
    values[17] = 4000;
    values[60] = 0;
    values[70] = null;
    const outliers = findOutliers(values);
    expect(outliers.map(o => o.index)).toEqual([17, 60]);
    expect(outliers[0].deviation).toBeGreaterThan(0);
    expect(outliers[1].deviation).toBeLessThan(0);
  });

  it('flags any difference in an otherwise constant series', () => {
    const values = [5, 5, 5, 5, 6];
    expect(findOutliers(values).map(o => o.index)).toEqual([4]);
  });

  it('returns nothing for a clean series', () => {
    expect(findOutliers([1, 2, 3, 2, 1, 2, 3])).toEqual([]);
  });
});
