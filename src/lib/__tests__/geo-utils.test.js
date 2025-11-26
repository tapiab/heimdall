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
