/**
 * Utility functions for geospatial operations
 */

/**
 * Extract bounding box from GeoJSON geometry
 * @param {Object} geometry - GeoJSON geometry object
 * @returns {Array|null} [[minX, minY], [maxX, maxY]] or null
 */
export function getFeatureBounds(geometry) {
  if (!geometry || !geometry.coordinates) return null;

  let coords = [];
  const extractCoords = (c) => {
    if (typeof c[0] === 'number') {
      coords.push(c);
    } else {
      c.forEach(extractCoords);
    }
  };
  extractCoords(geometry.coordinates);

  if (coords.length === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
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

  return [[minX, minY], [maxX, maxY]];
}

/**
 * Merge multiple bounding boxes into one
 * @param {Array} boundsArray - Array of [[minX, minY], [maxX, maxY]] bounds
 * @returns {Array|null} Combined bounds or null
 */
export function mergeBounds(boundsArray) {
  if (!boundsArray || boundsArray.length === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const bounds of boundsArray) {
    if (!bounds) continue;
    minX = Math.min(minX, bounds[0][0]);
    minY = Math.min(minY, bounds[0][1]);
    maxX = Math.max(maxX, bounds[1][0]);
    maxY = Math.max(maxY, bounds[1][1]);
  }

  if (!isFinite(minX)) return null;

  return [[minX, minY], [maxX, maxY]];
}

/**
 * Check if two bounding boxes intersect
 * @param {Array} a - First bounds [minX, minY, maxX, maxY]
 * @param {Array} b - Second bounds [minX, minY, maxX, maxY]
 * @returns {boolean}
 */
export function boundsIntersect(a, b) {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

/**
 * Build categorical color expression for MapLibre
 * @param {string} fieldName - Field name to color by
 * @param {Array} values - Unique values
 * @returns {Array} MapLibre match expression
 */
export function buildCategoricalColorExpression(fieldName, values) {
  const colors = [
    '#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00',
    '#ffff33', '#a65628', '#f781bf', '#999999', '#66c2a5'
  ];

  const matchExpr = ['match', ['get', fieldName]];
  values.forEach((val, idx) => {
    matchExpr.push(val);
    matchExpr.push(colors[idx % colors.length]);
  });
  matchExpr.push('#888888'); // Default color

  return matchExpr;
}

/**
 * Build graduated color expression for MapLibre (numeric values)
 * @param {string} fieldName - Field name to color by
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {Array} MapLibre interpolate expression
 */
export function buildGraduatedColorExpression(fieldName, min, max) {
  return [
    'interpolate',
    ['linear'],
    ['get', fieldName],
    min, '#2166ac',        // Blue
    (min + max) / 2, '#f7f7f7',  // White
    max, '#b2182b'         // Red
  ];
}

/**
 * Determine if an array of values is numeric
 * @param {Array} values - Values to check
 * @returns {boolean}
 */
export function isNumericArray(values) {
  return values.every(v => typeof v === 'number');
}

/**
 * Get unique values from a field across features
 * @param {Array} features - GeoJSON features
 * @param {string} fieldName - Field name to extract
 * @returns {Array} Unique non-null values
 */
export function getUniqueFieldValues(features, fieldName) {
  return [...new Set(
    features
      .map(f => f.properties?.[fieldName])
      .filter(v => v !== null && v !== undefined)
  )];
}

/**
 * Calculate pseudo-geographic bounds for non-georeferenced images
 * @param {number} width - Image width in pixels
 * @param {number} height - Image height in pixels
 * @param {number} scale - Degrees per pixel (default 0.01)
 * @returns {Object} { bounds, pixelScale, pixelOffset }
 */
export function calculatePseudoGeoBounds(width, height, scale = 0.01) {
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
 * @param {string} path - Full file path
 * @returns {string} Filename
 */
export function parseFilename(path) {
  if (!path) return '';
  return path.split('/').pop().split('\\').pop();
}

/**
 * Get file extension from path
 * @param {string} path - File path
 * @returns {string} Extension (lowercase, without dot)
 */
export function getFileExtension(path) {
  if (!path) return '';
  return path.split('.').pop().toLowerCase();
}

/**
 * Check if file extension is a vector format
 * @param {string} ext - File extension
 * @returns {boolean}
 */
export function isVectorExtension(ext) {
  const vectorExtensions = ['shp', 'geojson', 'json', 'gpkg', 'kml', 'kmz', 'gml', 'gpx', 'fgb', 'tab', 'mif'];
  return vectorExtensions.includes(ext.toLowerCase());
}

// ==================== Histogram Utilities ====================

/**
 * Determine if log scale should be used for histogram display
 * @param {number} maxCount - Maximum bin count
 * @param {number} threshold - Threshold for switching to log scale (default 1000)
 * @returns {boolean}
 */
export function shouldUseLogScale(maxCount, threshold = 1000) {
  return maxCount > threshold;
}

/**
 * Apply log scale transformation to a count value
 * @param {number} count - Original count
 * @returns {number} Log-scaled value (log10(count + 1))
 */
export function logScaleValue(count) {
  return Math.log10(count + 1);
}

/**
 * Calculate histogram bar heights normalized to canvas height
 * @param {Array<number>} counts - Array of bin counts
 * @param {number} canvasHeight - Height of canvas in pixels
 * @param {number} padding - Padding from top and bottom (default 10)
 * @param {boolean} useLogScale - Whether to use log scale
 * @returns {Array<number>} Array of bar heights in pixels
 */
export function calculateHistogramBarHeights(counts, canvasHeight, padding = 10, useLogScale = false) {
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
 * @param {number} value - The value to position
 * @param {number} min - Histogram minimum
 * @param {number} max - Histogram maximum
 * @param {number} canvasWidth - Width of canvas in pixels
 * @param {number} padding - Padding from left and right (default 10)
 * @returns {number} X position in pixels
 */
export function calculateHistogramXPosition(value, min, max, canvasWidth, padding = 10) {
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
 * @param {number} value - Value to format
 * @returns {string} Formatted string
 */
export function formatHistogramValue(value) {
  if (value === null || value === undefined || !isFinite(value)) {
    return '--';
  }

  // Use compact notation for large numbers
  if (Math.abs(value) >= 1000000) {
    return (value / 1000000).toFixed(1) + 'M';
  }
  if (Math.abs(value) >= 1000) {
    return (value / 1000).toFixed(1) + 'K';
  }

  // For small numbers, show appropriate precision
  if (Number.isInteger(value)) {
    return value.toString();
  }

  // For decimals, show up to 2 decimal places
  return value.toFixed(2);
}
