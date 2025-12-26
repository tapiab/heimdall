/**
 * Utility functions for geospatial operations
 */

import type { Geometry, Feature, GeoJsonProperties } from 'geojson';

// Type for coordinate arrays (can be nested)
type Coordinate = number[];
type CoordinateArray = Coordinate | CoordinateArray[];

// Bounds in [[minX, minY], [maxX, maxY]] format
type Bounds = [[number, number], [number, number]];

// Bounds in [minX, minY, maxX, maxY] format
type FlatBounds = [number, number, number, number];

// MapLibre expression types
type MapLibreExpression = (string | number | MapLibreExpression)[];

interface PseudoGeoBounds {
  bounds: FlatBounds;
  pixelScale: number;
  pixelOffset: { x: number; y: number };
}

/**
 * Extract bounding box from GeoJSON geometry
 * @param geometry - GeoJSON geometry object
 * @returns [[minX, minY], [maxX, maxY]] or null
 */
export function getFeatureBounds(geometry: Geometry | null | undefined): Bounds | null {
  if (!geometry || !('coordinates' in geometry)) return null;

  const coords: Coordinate[] = [];
  const extractCoords = (c: CoordinateArray): void => {
    if (typeof c[0] === 'number') {
      coords.push(c as Coordinate);
    } else {
      (c as CoordinateArray[]).forEach(extractCoords);
    }
  };
  extractCoords(geometry.coordinates as CoordinateArray);

  if (coords.length === 0) return null;

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of coords) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  // Add small buffer for points
  if (minX === maxX && minY === maxY) {
    const buffer = 0.001;
    minX -= buffer;
    minY -= buffer;
    maxX += buffer;
    maxY += buffer;
  }

  return [
    [minX, minY],
    [maxX, maxY],
  ];
}

/**
 * Merge multiple bounding boxes into one
 * @param boundsArray - Array of [[minX, minY], [maxX, maxY]] bounds
 * @returns Combined bounds or null
 */
export function mergeBounds(boundsArray: (Bounds | null)[]): Bounds | null {
  if (!boundsArray || boundsArray.length === 0) return null;

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  for (const bounds of boundsArray) {
    if (!bounds) continue;
    minX = Math.min(minX, bounds[0][0]);
    minY = Math.min(minY, bounds[0][1]);
    maxX = Math.max(maxX, bounds[1][0]);
    maxY = Math.max(maxY, bounds[1][1]);
  }

  if (!isFinite(minX)) return null;

  return [
    [minX, minY],
    [maxX, maxY],
  ];
}

/**
 * Check if two bounding boxes intersect
 * @param a - First bounds [minX, minY, maxX, maxY]
 * @param b - Second bounds [minX, minY, maxX, maxY]
 * @returns True if bounds intersect
 */
export function boundsIntersect(a: FlatBounds, b: FlatBounds): boolean {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

/**
 * Build categorical color expression for MapLibre
 * @param fieldName - Field name to color by
 * @param values - Unique values
 * @returns MapLibre match expression
 */
export function buildCategoricalColorExpression(
  fieldName: string,
  values: (string | number)[]
): MapLibreExpression {
  const colors = [
    '#e41a1c',
    '#377eb8',
    '#4daf4a',
    '#984ea3',
    '#ff7f00',
    '#ffff33',
    '#a65628',
    '#f781bf',
    '#999999',
    '#66c2a5',
  ];

  const matchExpr: MapLibreExpression = ['match', ['get', fieldName]];
  values.forEach((val, idx) => {
    matchExpr.push(val);
    matchExpr.push(colors[idx % colors.length]);
  });
  matchExpr.push('#888888'); // Default color

  return matchExpr;
}

/**
 * Build graduated color expression for MapLibre (numeric values)
 * @param fieldName - Field name to color by
 * @param min - Minimum value
 * @param max - Maximum value
 * @returns MapLibre interpolate expression
 */
export function buildGraduatedColorExpression(
  fieldName: string,
  min: number,
  max: number
): MapLibreExpression {
  return [
    'interpolate',
    ['linear'],
    ['get', fieldName],
    min,
    '#2166ac', // Blue
    (min + max) / 2,
    '#f7f7f7', // White
    max,
    '#b2182b', // Red
  ];
}

/**
 * Determine if an array of values is numeric
 * @param values - Values to check
 * @returns True if all values are numbers
 */
export function isNumericArray(values: unknown[]): values is number[] {
  return values.every(v => typeof v === 'number');
}

/**
 * Get unique values from a field across features
 * @param features - GeoJSON features
 * @param fieldName - Field name to extract
 * @returns Unique non-null values
 */
export function getUniqueFieldValues(
  features: Feature<Geometry, GeoJsonProperties>[],
  fieldName: string
): unknown[] {
  return [
    ...new Set(
      features.map(f => f.properties?.[fieldName]).filter(v => v !== null && v !== undefined)
    ),
  ];
}

/**
 * Calculate pseudo-geographic bounds for non-georeferenced images
 * @param width - Image width in pixels
 * @param height - Image height in pixels
 * @param scale - Degrees per pixel (default 0.01)
 * @returns { bounds, pixelScale, pixelOffset }
 */
export function calculatePseudoGeoBounds(
  width: number,
  height: number,
  scale: number = 0.01
): PseudoGeoBounds {
  const halfWidth = (width * scale) / 2;
  const halfHeight = (height * scale) / 2;
  // Clamp to valid ranges for Web Mercator
  const clampedHalfHeight = Math.min(halfHeight, 85);

  return {
    bounds: [-halfWidth, -clampedHalfHeight, halfWidth, clampedHalfHeight],
    pixelScale: scale,
    pixelOffset: { x: halfWidth, y: clampedHalfHeight },
  };
}

/**
 * Parse filename from file path
 * @param path - Full file path
 * @returns Filename
 */
export function parseFilename(path: string | null | undefined): string {
  if (!path) return '';
  return path.split('/').pop()?.split('\\').pop() ?? '';
}

/**
 * Get file extension from path
 * @param path - File path
 * @returns Extension (lowercase, without dot)
 */
export function getFileExtension(path: string | null | undefined): string {
  if (!path) return '';
  return path.split('.').pop()?.toLowerCase() ?? '';
}

/**
 * Check if file extension is a vector format
 * @param ext - File extension
 * @returns True if extension is a vector format
 */
export function isVectorExtension(ext: string): boolean {
  const vectorExtensions = [
    'shp',
    'geojson',
    'json',
    'gpkg',
    'kml',
    'kmz',
    'gml',
    'gpx',
    'fgb',
    'tab',
    'mif',
  ];
  return vectorExtensions.includes(ext.toLowerCase());
}

// ==================== Histogram Utilities ====================

/**
 * Determine if log scale should be used for histogram display
 * @param maxCount - Maximum bin count
 * @param threshold - Threshold for switching to log scale (default 1000)
 * @returns True if log scale should be used
 */
export function shouldUseLogScale(maxCount: number, threshold: number = 1000): boolean {
  return maxCount > threshold;
}

/**
 * Apply log scale transformation to a count value
 * @param count - Original count
 * @returns Log-scaled value (log10(count + 1))
 */
export function logScaleValue(count: number): number {
  return Math.log10(count + 1);
}

/**
 * Calculate histogram bar heights normalized to canvas height
 * @param counts - Array of bin counts
 * @param canvasHeight - Height of canvas in pixels
 * @param padding - Padding from top and bottom (default 10)
 * @param useLogScale - Whether to use log scale
 * @returns Array of bar heights in pixels
 */
export function calculateHistogramBarHeights(
  counts: number[],
  canvasHeight: number,
  padding: number = 10,
  useLogScale: boolean = false
): number[] {
  if (!counts || counts.length === 0) return [];

  const drawHeight = canvasHeight - padding * 2;
  const maxCount = Math.max(...counts);

  if (maxCount === 0) {
    return counts.map(() => 0);
  }

  const maxValue = useLogScale ? logScaleValue(maxCount) : maxCount;

  return counts.map(count => {
    const value = useLogScale ? logScaleValue(count) : count;
    return (value / maxValue) * drawHeight;
  });
}

/**
 * Calculate the x position for a value on the histogram
 * @param value - The value to position
 * @param min - Histogram minimum
 * @param max - Histogram maximum
 * @param canvasWidth - Width of canvas in pixels
 * @param padding - Padding from left and right (default 10)
 * @returns X position in pixels
 */
export function calculateHistogramXPosition(
  value: number,
  min: number,
  max: number,
  canvasWidth: number,
  padding: number = 10
): number {
  const drawWidth = canvasWidth - padding * 2;
  const range = max - min;

  if (range === 0) {
    return padding + drawWidth / 2;
  }

  const normalizedPosition = (value - min) / range;
  return padding + normalizedPosition * drawWidth;
}

/**
 * Format a number for histogram display (compact notation for large numbers)
 * @param value - Value to format
 * @returns Formatted string
 */
export function formatHistogramValue(value: number | null | undefined): string {
  if (value === null || value === undefined || !isFinite(value)) {
    return '--';
  }

  // Use compact notation for large numbers
  if (Math.abs(value) >= 1000000) {
    return `${(value / 1000000).toFixed(1)}M`;
  }
  if (Math.abs(value) >= 1000) {
    return `${(value / 1000).toFixed(1)}K`;
  }

  // For small numbers, show appropriate precision
  if (Number.isInteger(value)) {
    return value.toString();
  }

  // For decimals, show up to 2 decimal places
  return value.toFixed(2);
}

// Export types
export type { Bounds, FlatBounds, PseudoGeoBounds, MapLibreExpression };
