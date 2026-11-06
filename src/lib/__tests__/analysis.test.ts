/**
 * Tests for band math, analysis helpers (profile, region statistics, CSV,
 * coordinates) and grey-world white balance.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ writeTextFile: vi.fn() }));
vi.mock('../notifications', () => ({
  showToast: vi.fn(),
  showError: vi.fn(),
  showLoading: vi.fn(),
  hideLoading: vi.fn(),
}));
vi.mock('../logger', () => ({
  logger: { child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import {
  compileBandMath,
  overviewTiles,
  percentileStretch,
  BAND_MATH_TEMPLATES,
  bandMathPixelValue,
} from '../layer-manager/band-math';
import {
  displayedBands,
  findAnalysisTarget,
  seriesRange,
  toBackendCoords,
  toCsv,
  type AnalysisLayerManager,
  type AnalysisMapManager,
} from '../analysis-common';
import { normalizeSeries, profileCsv, summarizeProfile } from '../band-profile-panel';
import { regionStatsCsv } from '../region-stats-tool';
import { greyWorldStretch, histogramMean } from '../layer-manager/stretch-presets';

const planes = (entries: Array<[number, number[]]>) =>
  new Map(entries.map(([band, values]) => [band, Float32Array.from(values)]));

describe('band math', () => {
  it('evaluates a normalized difference per sample', () => {
    const ndvi = compileBandMath(BAND_MATH_TEMPLATES.nd.build(4, 3), 4);
    expect(ndvi.bands).toEqual([3, 4]);
    const out = ndvi.evaluate(
      planes([
        [3, [10, 20, 0]],
        [4, [30, 20, 0]],
      ]),
      3
    );
    expect(out[0]).toBeCloseTo(0.5);
    expect(out[1]).toBe(0);
    // 0/0 is not finite → NaN (transparent)
    expect(Number.isNaN(out[2])).toBe(true);
  });

  it('respects precedence, unary minus and right-associative power', () => {
    const run = (expr: string) => compileBandMath(expr, 1).evaluate(planes([[1, [2]]]), 1)[0];
    expect(run('1 + b1 * 3')).toBe(7);
    expect(run('(1 + b1) * 3')).toBe(9);
    expect(run('-b1^2')).toBe(-4);
    expect(run('2^b1^2')).toBe(16);
    expect(run('b1 - -1')).toBe(3);
    expect(run('max(b1, 5) + abs(-1.5e0)')).toBeCloseTo(6.5);
    expect(run('sqrt(b1 * 8)')).toBe(4);
  });

  it('does not modify the band planes it reads', () => {
    const input = planes([[1, [1, Infinity]]]);
    const out = compileBandMath('B1', 1).evaluate(input, 2);
    expect(Number.isNaN(out[1])).toBe(true);
    expect(input.get(1)?.[1]).toBe(Infinity);
  });

  it('reports readable errors', () => {
    expect(() => compileBandMath('b5 + 1', 4)).toThrow(/Band 5 does not exist/);
    expect(() => compileBandMath('foo(b1)', 4)).toThrow(/Unknown name "foo"/);
    expect(() => compileBandMath('b1 +', 4)).toThrow(/end of expression/);
    expect(() => compileBandMath('(b1', 4)).toThrow(/Expected "\)"/);
    expect(() => compileBandMath('b1 $ 2', 4)).toThrow(/Unexpected "\$"/);
    expect(() => compileBandMath('min(b1)', 4)).toThrow(/takes 2/);
    expect(() => compileBandMath('3 * 2', 4)).toThrow(/uses no band/);
    expect(() => compileBandMath('  ', 4)).toThrow(/empty/);
  });

  it('takes a 2–98 % stretch of finite values', () => {
    const values = Float32Array.from({ length: 101 }, (_, i) => i);
    values[0] = NaN;
    const s = percentileStretch([values]);
    expect(s?.min).toBe(3);
    expect(s?.max).toBe(98);
    expect(s?.range).toEqual([1, 100]);
    expect(percentileStretch([Float32Array.from([NaN])])).toBeNull();
    // Constant values still give a usable range
    const flat = percentileStretch([Float32Array.from([2, 2, 2])]);
    expect(flat && flat.max > flat.min).toBe(true);
  });

  it('covers the bounds with at most 9 overview tiles', () => {
    const tiles = overviewTiles([2.2, 48.8, 2.4, 48.9]);
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThanOrEqual(9);
    expect(new Set(tiles.map(t => t.z)).size).toBe(1);
    expect(tiles[0].z).toBeGreaterThan(8);
    expect(overviewTiles([-180, -85, 180, 85])).toEqual([
      { z: 1, x: 0, y: 0 },
      { z: 1, x: 1, y: 0 },
      { z: 1, x: 0, y: 1 },
      { z: 1, x: 1, y: 1 },
    ]);
  });
});

describe('analysis helpers', () => {
  const map = (pixel: boolean): AnalysisMapManager => ({
    map: {} as AnalysisMapManager['map'],
    isPixelCoordMode: () => pixel,
    pixelExtent: pixel ? { scale: 0.01, offsetX: 1, offsetY: 2 } : null,
  });

  it('converts map positions to pixel positions in pixel mode', () => {
    expect(toBackendCoords(map(false), [[3, 4]])).toEqual({ coords: [[3, 4]], pixel: false });
    const { coords, pixel } = toBackendCoords(map(true), [[0.5, 1.5]]);
    expect(pixel).toBe(true);
    expect(coords[0][0]).toBeCloseTo(150);
    expect(coords[0][1]).toBeCloseTo(50);
  });

  it('picks the topmost visible single-dataset raster', () => {
    const raster = (id: string, extra: object = {}) => ({
      id,
      type: 'raster' as const,
      visible: true,
      path: `/data/${id}.tif`,
      bands: 4,
      bounds: [0, 0, 10, 10] as [number, number, number, number],
      ...extra,
    });
    const manager: AnalysisLayerManager = {
      layerOrder: ['base', 'comp', 'cross', 'hidden', 'vec'],
      layers: new Map<string, { type: string }>([
        ['base', raster('base')],
        ['comp', raster('comp', { sourceLayerId: 'base', bands: 3 })],
        ['cross', raster('cross', { isCrossLayerComposition: true })],
        ['hidden', raster('hidden', { visible: false })],
        ['vec', { type: 'vector' }],
      ]),
    };
    const target = findAnalysisTarget(manager);
    expect(target?.layer.id).toBe('comp');
    expect(target?.datasetId).toBe('base');
    expect(target?.bandCount).toBe(4);
    expect(findAnalysisTarget(manager, { lng: 50, lat: 50 })).toBeNull();
  });

  it('defaults chart bands to the displayed ones', () => {
    const layer = { id: 'a', type: 'raster' as const, visible: true, path: 'a' };
    expect(displayedBands({ ...layer, band: 3 }, 4)).toEqual([3]);
    expect(
      displayedBands({ ...layer, displayMode: 'rgb', rgbBands: { r: 4, g: 3, b: 2 } }, 4)
    ).toEqual([4, 3, 2]);
    expect(displayedBands({ ...layer, band: 9 }, 4)).toEqual([1]);
  });

  it('writes CSV with quoting and empty cells for missing values', () => {
    expect(
      toCsv(
        ['a', 'b'],
        [
          [1, null],
          ['x,y', NaN],
          ['say "hi"', 2],
        ]
      )
    ).toBe('a,b\n1,\n"x,y",\n"say ""hi""",2\n');
  });

  it('pads the chart range and ignores gaps', () => {
    expect(seriesRange([{ color: '', values: [null, 0, 10] }])).toEqual({ lo: -0.5, hi: 10.5 });
    expect(seriesRange([{ color: '', values: [5] }])).toEqual({ lo: 4, hi: 6 });
    expect(seriesRange([{ color: '', values: [null] }])).toBeNull();
  });
});

describe('profile and region results', () => {
  it('summarizes a band along the profile', () => {
    const s = summarizeProfile([1, null, 4, 2, 5]);
    expect(s).toEqual({ min: 1, max: 5, mean: 3, gain: 6, loss: 2 });
    expect(summarizeProfile([null]).mean).toBeNull();
  });

  it('normalizes each band to its own range', () => {
    expect(normalizeSeries([10, null, 20, 15])).toEqual([0, null, 1, 0.5]);
    expect(normalizeSeries([3, 3])).toEqual([0.5, 0.5]);
  });

  it('exports every band of a profile', () => {
    const csv = profileCsv({
      unit: 'px',
      total_distance: 1,
      distance: [0, 1],
      x: [5, 6],
      y: [7, 7],
      values: [
        [1, 2],
        [null, 4],
      ],
    });
    expect(csv).toBe('distance_px,x,y,band_1,band_2\n0,5,7,1,\n1,6,7,2,4\n');
  });

  it('exports region statistics, one row per band', () => {
    const band = {
      band: 1,
      count: 4,
      nodata_count: 0,
      min: 1,
      max: 4,
      mean: 2.5,
      median: 2,
      sigma: 1.1,
      p2: 1,
      p98: 4,
      snr: 2.27,
    };
    const csv = regionStatsCsv({ x: 0, y: 0, width: 2, height: 2, step: 1, bands: [band] });
    expect(csv.split('\n')[1]).toBe('1,2.5,2,1.1,2.27,1,4,1,4,4,0');
  });
});

describe('grey-world white balance', () => {
  it('computes the histogram mean from bin centres', () => {
    expect(histogramMean({ counts: [1, 3], bin_edges: [0, 10, 20], min: 0, max: 20 })).toBe(12.5);
    expect(histogramMean({ counts: [0], bin_edges: [0, 1], min: 0, max: 1 })).toBeNull();
  });

  it('puts every channel mean on the same display level', () => {
    const s = (min: number, max: number) => ({ min, max, gamma: 1 });
    const balanced = greyWorldStretch([s(0, 100), s(0, 100), s(10, 100)], [50, 25, 55]);
    expect(balanced).not.toBeNull();
    const levels = balanced?.map((c, i) => ([50, 25, 55][i] - c.min) / (c.max - c.min));
    expect(levels?.[0]).toBeCloseTo(levels?.[1] ?? 0);
    expect(levels?.[1]).toBeCloseTo(levels?.[2] ?? 0);
    // Black points kept
    expect(balanced?.map(c => c.min)).toEqual([0, 0, 10]);
    // Mean at the black point can't be balanced
    expect(greyWorldStretch([s(0, 1), s(5, 9), s(0, 1)], [0.5, 5, 0.5])).toBeNull();
  });
});

describe('bandMathPixelValue', () => {
  const v = (band: number, value: number, is_nodata = false) => ({ band, value, is_nodata });

  it('evaluates the expression at one pixel', () => {
    expect(bandMathPixelValue('(b2 - b1) / (b2 + b1)', 2, [v(1, 1), v(2, 3)])).toBeCloseTo(0.5);
  });

  it('is NaN on no-data, a missing band or an invalid expression', () => {
    expect(bandMathPixelValue('b1 + b2', 2, [v(1, 1), v(2, 0, true)])).toBeNaN();
    expect(bandMathPixelValue('b1 + b3', 3, [v(1, 1), v(2, 2)])).toBeNaN();
    expect(bandMathPixelValue('b1 +', 2, [v(1, 1), v(2, 2)])).toBeNaN();
    expect(bandMathPixelValue('b1 / b2', 2, [v(1, 1), v(2, 0)])).toBeNaN();
  });
});
