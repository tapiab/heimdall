import { describe, it, expect } from 'vitest';
import { getFeatureBounds, getUniqueFieldValues, boundsIntersect } from '../geo-utils.js';
import {
  samplePoint,
  sampleLine,
  samplePolygon,
  samplePolygonWithHole,
  sampleMultiPoint,
  sampleMultiPolygon,
  sampleFeatureCollection,
  sampleFeaturesWithNulls,
  sampleBounds,
} from './fixtures.js';

describe('getFeatureBounds with fixtures', () => {
  it('extracts bounds from San Francisco point', () => {
    const bounds = getFeatureBounds(samplePoint.geometry);
    // Point should have a small buffer added
    expect(bounds[0][0]).toBeCloseTo(-122.4204, 3);
    expect(bounds[0][1]).toBeCloseTo(37.7739, 3);
    expect(bounds[1][0]).toBeCloseTo(-122.4184, 3);
    expect(bounds[1][1]).toBeCloseTo(37.7759, 3);
  });

  it('extracts bounds from line feature', () => {
    const bounds = getFeatureBounds(sampleLine.geometry);
    expect(bounds[0][0]).toBeCloseTo(-122.4194, 4);
    expect(bounds[0][1]).toBeCloseTo(37.7749, 4);
    expect(bounds[1][0]).toBeCloseTo(-122.392, 3);
    expect(bounds[1][1]).toBeCloseTo(37.79, 2);
  });

  it('extracts bounds from polygon feature', () => {
    const bounds = getFeatureBounds(samplePolygon.geometry);
    expect(bounds).toEqual([
      [-122.45, 37.75],
      [-122.4, 37.8],
    ]);
  });

  it('extracts bounds from polygon with hole (uses outer ring)', () => {
    const bounds = getFeatureBounds(samplePolygonWithHole.geometry);
    expect(bounds).toEqual([
      [-122.5, 37.7],
      [-122.35, 37.85],
    ]);
  });

  it('extracts bounds from multipoint feature', () => {
    const bounds = getFeatureBounds(sampleMultiPoint.geometry);
    expect(bounds[0][0]).toBeCloseTo(-122.4194, 4);
    expect(bounds[1][0]).toBeCloseTo(-122.4, 4);
  });

  it('extracts bounds from multipolygon feature', () => {
    const bounds = getFeatureBounds(sampleMultiPolygon.geometry);
    expect(bounds[0][0]).toBeCloseTo(-122.5, 2);
    expect(bounds[0][1]).toBeCloseTo(37.7, 2);
    expect(bounds[1][0]).toBeCloseTo(-122.35, 2);
    expect(bounds[1][1]).toBeCloseTo(37.85, 2);
  });
});

describe('getUniqueFieldValues with fixtures', () => {
  it('extracts unique categories from feature collection', () => {
    const values = getUniqueFieldValues(sampleFeatureCollection.features, 'category');
    expect(values).toHaveLength(3);
    expect(values).toContain('A');
    expect(values).toContain('B');
    expect(values).toContain('C');
  });

  it('extracts unique numeric values', () => {
    const values = getUniqueFieldValues(sampleFeatureCollection.features, 'value');
    expect(values).toEqual([100, 200, 150, 300]);
  });

  it('handles features with null properties', () => {
    const values = getUniqueFieldValues(sampleFeaturesWithNulls.features, 'name');
    // Should only include non-null values: 'Complete', 'Partial'
    expect(values).toContain('Complete');
    expect(values).toContain('Partial');
    expect(values).not.toContain(null);
  });

  it('handles sparse value fields', () => {
    const values = getUniqueFieldValues(sampleFeaturesWithNulls.features, 'value');
    // Should include: 100, 200
    expect(values).toEqual([100, 200]);
  });
});

describe('boundsIntersect with sample bounds', () => {
  it('SF and Oakland share an edge', () => {
    const sf = sampleBounds.sanFrancisco;
    const { oakland } = sampleBounds;
    expect(boundsIntersect(sf, oakland)).toBe(true);
  });

  it('SF does not intersect Pacific', () => {
    const sf = sampleBounds.sanFrancisco;
    const { pacific } = sampleBounds;
    expect(boundsIntersect(sf, pacific)).toBe(false);
  });

  it('SF is contained within world bounds', () => {
    const sf = sampleBounds.sanFrancisco;
    const { world } = sampleBounds;
    expect(boundsIntersect(sf, world)).toBe(true);
  });
});
