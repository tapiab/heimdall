import { describe, it, expect } from 'vitest';
import {
  getFeatureBounds,
  mergeBounds,
  boundsIntersect,
  buildCategoricalColorExpression,
  buildGraduatedColorExpression,
  isNumericArray,
  getUniqueFieldValues,
  calculatePseudoGeoBounds,
  parseFilename,
  getFileExtension,
  isVectorExtension,
  shouldUseLogScale,
  logScaleValue,
  calculateHistogramBarHeights,
  calculateHistogramXPosition,
  formatHistogramValue,
} from '../geo-utils.js';

describe('getFeatureBounds', () => {
  it('returns null for null geometry', () => {
    expect(getFeatureBounds(null)).toBeNull();
  });

  it('returns null for geometry without coordinates', () => {
    expect(getFeatureBounds({ type: 'Point' })).toBeNull();
  });

  it('returns null for empty coordinates', () => {
    expect(getFeatureBounds({ type: 'Point', coordinates: [] })).toBeNull();
  });

  it('extracts bounds from Point geometry with buffer', () => {
    const geometry = { type: 'Point', coordinates: [10, 20] };
    const bounds = getFeatureBounds(geometry);
    expect(bounds[0][0]).toBeCloseTo(9.999, 3);
    expect(bounds[0][1]).toBeCloseTo(19.999, 3);
    expect(bounds[1][0]).toBeCloseTo(10.001, 3);
    expect(bounds[1][1]).toBeCloseTo(20.001, 3);
  });

  it('extracts bounds from LineString geometry', () => {
    const geometry = {
      type: 'LineString',
      coordinates: [[0, 0], [10, 5], [20, 10]],
    };
    const bounds = getFeatureBounds(geometry);
    expect(bounds).toEqual([[0, 0], [20, 10]]);
  });

  it('extracts bounds from Polygon geometry', () => {
    const geometry = {
      type: 'Polygon',
      coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
    };
    const bounds = getFeatureBounds(geometry);
    expect(bounds).toEqual([[0, 0], [10, 10]]);
  });

  it('extracts bounds from Polygon with holes', () => {
    const geometry = {
      type: 'Polygon',
      coordinates: [
        [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]],
        [[5, 5], [15, 5], [15, 15], [5, 15], [5, 5]],
      ],
    };
    const bounds = getFeatureBounds(geometry);
    expect(bounds).toEqual([[0, 0], [20, 20]]);
  });

  it('extracts bounds from MultiPoint geometry', () => {
    const geometry = {
      type: 'MultiPoint',
      coordinates: [[-5, -5], [5, 5], [10, 0]],
    };
    const bounds = getFeatureBounds(geometry);
    expect(bounds).toEqual([[-5, -5], [10, 5]]);
  });

  it('extracts bounds from MultiPolygon geometry', () => {
    const geometry = {
      type: 'MultiPolygon',
      coordinates: [
        [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
        [[[20, 20], [30, 20], [30, 30], [20, 30], [20, 20]]],
      ],
    };
    const bounds = getFeatureBounds(geometry);
    expect(bounds).toEqual([[0, 0], [30, 30]]);
  });

  it('handles negative coordinates', () => {
    const geometry = {
      type: 'LineString',
      coordinates: [[-180, -90], [180, 90]],
    };
    const bounds = getFeatureBounds(geometry);
    expect(bounds).toEqual([[-180, -90], [180, 90]]);
  });
});

describe('mergeBounds', () => {
  it('returns null for empty array', () => {
    expect(mergeBounds([])).toBeNull();
  });

  it('returns null for null input', () => {
    expect(mergeBounds(null)).toBeNull();
  });

  it('handles array with null entries', () => {
    const bounds = mergeBounds([null, [[0, 0], [10, 10]], null]);
    expect(bounds).toEqual([[0, 0], [10, 10]]);
  });

  it('returns null for array of all nulls', () => {
    expect(mergeBounds([null, null])).toBeNull();
  });

  it('merges two bounds', () => {
    const bounds = mergeBounds([
      [[0, 0], [10, 10]],
      [[5, 5], [20, 20]],
    ]);
    expect(bounds).toEqual([[0, 0], [20, 20]]);
  });

  it('merges multiple non-overlapping bounds', () => {
    const bounds = mergeBounds([
      [[-10, -10], [0, 0]],
      [[10, 10], [20, 20]],
      [[5, 0], [15, 10]],
    ]);
    expect(bounds).toEqual([[-10, -10], [20, 20]]);
  });
});

describe('boundsIntersect', () => {
  it('returns true for overlapping bounds', () => {
    expect(boundsIntersect([0, 0, 10, 10], [5, 5, 15, 15])).toBe(true);
  });

  it('returns true for contained bounds', () => {
    expect(boundsIntersect([0, 0, 20, 20], [5, 5, 15, 15])).toBe(true);
  });

  it('returns false for horizontally separate bounds', () => {
    expect(boundsIntersect([0, 0, 10, 10], [20, 0, 30, 10])).toBe(false);
  });

  it('returns false for vertically separate bounds', () => {
    expect(boundsIntersect([0, 0, 10, 10], [0, 20, 10, 30])).toBe(false);
  });

  it('returns false for diagonally separate bounds', () => {
    expect(boundsIntersect([0, 0, 10, 10], [20, 20, 30, 30])).toBe(false);
  });

  it('returns true for edge-touching bounds (non-strict)', () => {
    expect(boundsIntersect([0, 0, 10, 10], [10, 0, 20, 10])).toBe(true);
  });
});

describe('buildCategoricalColorExpression', () => {
  it('builds match expression with values', () => {
    const expr = buildCategoricalColorExpression('status', ['active', 'inactive']);
    expect(expr[0]).toBe('match');
    expect(expr[1]).toEqual(['get', 'status']);
    expect(expr[2]).toBe('active');
    expect(expr[3]).toBe('#e41a1c');
    expect(expr[4]).toBe('inactive');
    expect(expr[5]).toBe('#377eb8');
    expect(expr[6]).toBe('#888888'); // Default
  });

  it('cycles colors for many values', () => {
    const values = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'];
    const expr = buildCategoricalColorExpression('field', values);
    // Structure: ['match', ['get', 'field'], val1, color1, val2, color2, ...]
    // 11th value 'k' is at index 22 (2 + 10*2), its color at index 23
    expect(expr[22]).toBe('k');
    expect(expr[23]).toBe('#e41a1c'); // Same as first (10 % 10 = 0)
  });
});

describe('buildGraduatedColorExpression', () => {
  it('builds interpolate expression', () => {
    const expr = buildGraduatedColorExpression('value', 0, 100);
    expect(expr[0]).toBe('interpolate');
    expect(expr[1]).toEqual(['linear']);
    expect(expr[2]).toEqual(['get', 'value']);
    expect(expr[3]).toBe(0);      // min
    expect(expr[4]).toBe('#2166ac'); // blue
    expect(expr[5]).toBe(50);     // mid
    expect(expr[6]).toBe('#f7f7f7'); // white
    expect(expr[7]).toBe(100);    // max
    expect(expr[8]).toBe('#b2182b'); // red
  });

  it('handles negative ranges', () => {
    const expr = buildGraduatedColorExpression('temp', -10, 10);
    expect(expr[3]).toBe(-10);
    expect(expr[5]).toBe(0);
    expect(expr[7]).toBe(10);
  });
});

describe('isNumericArray', () => {
  it('returns true for array of numbers', () => {
    expect(isNumericArray([1, 2, 3, 4.5])).toBe(true);
  });

  it('returns true for empty array', () => {
    expect(isNumericArray([])).toBe(true);
  });

  it('returns false for array with strings', () => {
    expect(isNumericArray([1, 2, 'three'])).toBe(false);
  });

  it('returns false for array with null', () => {
    expect(isNumericArray([1, null, 3])).toBe(false);
  });

  it('returns false for array with objects', () => {
    expect(isNumericArray([1, {}, 3])).toBe(false);
  });
});

describe('getUniqueFieldValues', () => {
  const features = [
    { properties: { name: 'A', value: 1 } },
    { properties: { name: 'B', value: 2 } },
    { properties: { name: 'A', value: 3 } },
    { properties: { name: null, value: 4 } },
    { properties: { name: 'C' } },
  ];

  it('extracts unique values', () => {
    const values = getUniqueFieldValues(features, 'name');
    expect(values).toEqual(['A', 'B', 'C']);
  });

  it('excludes null and undefined values', () => {
    const values = getUniqueFieldValues(features, 'name');
    expect(values).not.toContain(null);
    expect(values).not.toContain(undefined);
  });

  it('returns empty array for non-existent field', () => {
    const values = getUniqueFieldValues(features, 'nonexistent');
    expect(values).toEqual([]);
  });

  it('handles features without properties', () => {
    const badFeatures = [{ properties: { a: 1 } }, {}, { properties: null }];
    const values = getUniqueFieldValues(badFeatures, 'a');
    expect(values).toEqual([1]);
  });
});

describe('calculatePseudoGeoBounds', () => {
  it('calculates bounds for 1000x1000 image', () => {
    const result = calculatePseudoGeoBounds(1000, 1000, 0.01);
    expect(result.bounds[0]).toBe(-5);
    expect(result.bounds[1]).toBe(-5);
    expect(result.bounds[2]).toBe(5);
    expect(result.bounds[3]).toBe(5);
  });

  it('clamps height to 85 degrees for tall images', () => {
    const result = calculatePseudoGeoBounds(1000, 20000, 0.01);
    expect(result.bounds[1]).toBe(-85);
    expect(result.bounds[3]).toBe(85);
  });

  it('returns correct pixel scale and offset', () => {
    const result = calculatePseudoGeoBounds(1000, 1000, 0.02);
    expect(result.pixelScale).toBe(0.02);
    expect(result.pixelOffset.x).toBe(10);
    expect(result.pixelOffset.y).toBe(10);
  });

  it('uses default scale of 0.01', () => {
    const result = calculatePseudoGeoBounds(100, 100);
    expect(result.pixelScale).toBe(0.01);
  });
});

describe('parseFilename', () => {
  it('extracts filename from Unix path', () => {
    expect(parseFilename('/path/to/file.tif')).toBe('file.tif');
  });

  it('extracts filename from Windows path', () => {
    expect(parseFilename('C:\\Users\\test\\file.tif')).toBe('file.tif');
  });

  it('handles filename only', () => {
    expect(parseFilename('file.tif')).toBe('file.tif');
  });

  it('returns empty string for null', () => {
    expect(parseFilename(null)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(parseFilename('')).toBe('');
  });
});

describe('getFileExtension', () => {
  it('extracts extension', () => {
    expect(getFileExtension('/path/to/file.tif')).toBe('tif');
  });

  it('returns lowercase extension', () => {
    expect(getFileExtension('/path/to/file.TIF')).toBe('tif');
  });

  it('handles multiple dots', () => {
    expect(getFileExtension('/path/to/file.tar.gz')).toBe('gz');
  });

  it('returns empty for null', () => {
    expect(getFileExtension(null)).toBe('');
  });
});

describe('isVectorExtension', () => {
  it('returns true for vector extensions', () => {
    expect(isVectorExtension('shp')).toBe(true);
    expect(isVectorExtension('geojson')).toBe(true);
    expect(isVectorExtension('gpkg')).toBe(true);
    expect(isVectorExtension('kml')).toBe(true);
  });

  it('returns false for raster extensions', () => {
    expect(isVectorExtension('tif')).toBe(false);
    expect(isVectorExtension('png')).toBe(false);
    expect(isVectorExtension('jpg')).toBe(false);
  });

  it('is case insensitive', () => {
    expect(isVectorExtension('SHP')).toBe(true);
    expect(isVectorExtension('GeoJSON')).toBe(true);
  });
});

// ==================== Histogram Utility Tests ====================

describe('shouldUseLogScale', () => {
  it('returns false for small counts', () => {
    expect(shouldUseLogScale(100)).toBe(false);
    expect(shouldUseLogScale(500)).toBe(false);
    expect(shouldUseLogScale(1000)).toBe(false);
  });

  it('returns true for large counts', () => {
    expect(shouldUseLogScale(1001)).toBe(true);
    expect(shouldUseLogScale(10000)).toBe(true);
    expect(shouldUseLogScale(1000000)).toBe(true);
  });

  it('uses custom threshold', () => {
    expect(shouldUseLogScale(500, 100)).toBe(true);
    expect(shouldUseLogScale(500, 1000)).toBe(false);
  });

  it('returns false for zero', () => {
    expect(shouldUseLogScale(0)).toBe(false);
  });
});

describe('logScaleValue', () => {
  it('returns 0 for count of 0', () => {
    expect(logScaleValue(0)).toBe(0);
  });

  it('returns 1 for count of 9', () => {
    expect(logScaleValue(9)).toBeCloseTo(1, 5);
  });

  it('returns 2 for count of 99', () => {
    expect(logScaleValue(99)).toBeCloseTo(2, 5);
  });

  it('returns 3 for count of 999', () => {
    expect(logScaleValue(999)).toBeCloseTo(3, 5);
  });

  it('handles large values', () => {
    expect(logScaleValue(999999)).toBeCloseTo(6, 5);
  });
});

describe('calculateHistogramBarHeights', () => {
  it('returns empty array for empty counts', () => {
    expect(calculateHistogramBarHeights([], 200)).toEqual([]);
  });

  it('returns empty array for null counts', () => {
    expect(calculateHistogramBarHeights(null, 200)).toEqual([]);
  });

  it('returns all zeros for all-zero counts', () => {
    const heights = calculateHistogramBarHeights([0, 0, 0], 200);
    expect(heights).toEqual([0, 0, 0]);
  });

  it('normalizes heights to canvas height minus padding', () => {
    // canvas height 200, padding 10 each side = 180 drawable
    // max count is 100, so 100 should be full height (180)
    const heights = calculateHistogramBarHeights([50, 100, 25], 200, 10, false);
    expect(heights[0]).toBe(90);  // 50/100 * 180
    expect(heights[1]).toBe(180); // 100/100 * 180
    expect(heights[2]).toBe(45);  // 25/100 * 180
  });

  it('applies log scale when requested', () => {
    const counts = [1, 10, 100, 1000];
    const heights = calculateHistogramBarHeights(counts, 220, 10, true);
    const drawHeight = 200;

    // log10(1001) is the max (~3.0004)
    const maxLog = Math.log10(1001);
    expect(heights[0]).toBeCloseTo((Math.log10(2) / maxLog) * drawHeight, 1);
    expect(heights[3]).toBeCloseTo(drawHeight, 1); // max value = full height
  });

  it('uses default padding of 10', () => {
    const heights = calculateHistogramBarHeights([100], 200);
    expect(heights[0]).toBe(180); // 200 - 10*2 = 180
  });
});

describe('calculateHistogramXPosition', () => {
  it('returns center for zero range', () => {
    // canvas 400, padding 10, drawable 380, center = 10 + 190 = 200
    const x = calculateHistogramXPosition(5, 5, 5, 400, 10);
    expect(x).toBe(200);
  });

  it('returns left edge for min value', () => {
    const x = calculateHistogramXPosition(0, 0, 100, 420, 10);
    expect(x).toBe(10);
  });

  it('returns right edge for max value', () => {
    // canvas 420, padding 10, drawable 400
    const x = calculateHistogramXPosition(100, 0, 100, 420, 10);
    expect(x).toBe(410); // 10 + 400
  });

  it('returns middle for mid value', () => {
    const x = calculateHistogramXPosition(50, 0, 100, 420, 10);
    expect(x).toBe(210); // 10 + 200
  });

  it('handles negative ranges', () => {
    const x = calculateHistogramXPosition(0, -100, 100, 420, 10);
    expect(x).toBe(210); // middle
  });

  it('uses default padding of 10', () => {
    const x = calculateHistogramXPosition(0, 0, 100, 420);
    expect(x).toBe(10);
  });
});

describe('formatHistogramValue', () => {
  it('returns -- for null', () => {
    expect(formatHistogramValue(null)).toBe('--');
  });

  it('returns -- for undefined', () => {
    expect(formatHistogramValue(undefined)).toBe('--');
  });

  it('returns -- for NaN', () => {
    expect(formatHistogramValue(NaN)).toBe('--');
  });

  it('returns -- for Infinity', () => {
    expect(formatHistogramValue(Infinity)).toBe('--');
  });

  it('formats millions with M suffix', () => {
    expect(formatHistogramValue(1000000)).toBe('1.0M');
    expect(formatHistogramValue(2500000)).toBe('2.5M');
    expect(formatHistogramValue(-1500000)).toBe('-1.5M');
  });

  it('formats thousands with K suffix', () => {
    expect(formatHistogramValue(1000)).toBe('1.0K');
    expect(formatHistogramValue(2500)).toBe('2.5K');
    expect(formatHistogramValue(-1500)).toBe('-1.5K');
  });

  it('formats integers without decimals', () => {
    expect(formatHistogramValue(42)).toBe('42');
    expect(formatHistogramValue(0)).toBe('0');
    expect(formatHistogramValue(-7)).toBe('-7');
  });

  it('formats decimals with up to 2 places', () => {
    expect(formatHistogramValue(3.14159)).toBe('3.14');
    expect(formatHistogramValue(0.5)).toBe('0.50');
    expect(formatHistogramValue(-2.7)).toBe('-2.70');
  });
});
