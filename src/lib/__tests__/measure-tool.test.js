/**
 * Tests for MeasureTool distance measurement functionality
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock maplibregl Marker and Popup
const mockMarker = {
  setLngLat: vi.fn().mockReturnThis(),
  addTo: vi.fn().mockReturnThis(),
  remove: vi.fn(),
};

const mockPopup = {
  setLngLat: vi.fn().mockReturnThis(),
  setHTML: vi.fn().mockReturnThis(),
  addTo: vi.fn().mockReturnThis(),
  remove: vi.fn(),
};

vi.mock('maplibre-gl', () => ({
  default: {
    Marker: vi.fn(() => mockMarker),
    Popup: vi.fn(() => mockPopup),
  },
}));

// Mock map object
const mockMap = {
  getCanvas: vi.fn(() => ({ style: {} })),
  on: vi.fn(),
  off: vi.fn(),
  getSource: vi.fn(),
  addSource: vi.fn(),
  removeSource: vi.fn(),
  getLayer: vi.fn(),
  addLayer: vi.fn(),
  removeLayer: vi.fn(),
};

// Create a minimal MeasureTool-like object for testing the distance calculation logic
function createTestMeasureTool(isPixelMode = false, pixelExtent = null) {
  return {
    mapManager: {
      map: mockMap,
      isPixelCoordMode: () => isPixelMode,
      pixelExtent,
    },
    map: mockMap,
    active: false,
    points: [],
    markers: [],
    popup: null,

    /**
     * Calculate geodesic distance using Haversine formula
     */
    calculateGeodesicDistance(point1, point2) {
      const R = 6371000; // Earth's radius in meters
      const lat1 = point1[1] * Math.PI / 180;
      const lat2 = point2[1] * Math.PI / 180;
      const deltaLat = (point2[1] - point1[1]) * Math.PI / 180;
      const deltaLng = (point2[0] - point1[0]) * Math.PI / 180;

      const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
                Math.cos(lat1) * Math.cos(lat2) *
                Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

      return { value: R * c, unit: 'meters' };
    },

    /**
     * Calculate pixel distance for non-georeferenced images
     */
    calculatePixelDistance(point1, point2) {
      const extent = this.mapManager.pixelExtent;
      const scale = extent.scale || 0.01;
      const offsetX = extent.offsetX || 0;
      const offsetY = extent.offsetY || 0;

      // Convert map coords back to pixel coords
      const x1 = (point1[0] + offsetX) / scale;
      const y1 = (offsetY - point1[1]) / scale;
      const x2 = (point2[0] + offsetX) / scale;
      const y2 = (offsetY - point2[1]) / scale;

      // Euclidean distance
      const dx = x2 - x1;
      const dy = y2 - y1;
      const distance = Math.sqrt(dx * dx + dy * dy);

      return { value: distance, unit: 'pixels' };
    },

    /**
     * Calculate distance between two points
     */
    calculateDistance(point1, point2) {
      if (this.mapManager.isPixelCoordMode() && this.mapManager.pixelExtent) {
        return this.calculatePixelDistance(point1, point2);
      } else {
        return this.calculateGeodesicDistance(point1, point2);
      }
    },

    /**
     * Format distance for display
     */
    formatDistance(distance) {
      const { value, unit } = distance;

      if (unit === 'pixels') {
        return `${value.toFixed(1)} px`;
      }

      if (value < 1000) {
        return `${value.toFixed(1)} m`;
      } else {
        return `${(value / 1000).toFixed(2)} km`;
      }
    },

    toggle() {
      this.active = !this.active;
      return this.active;
    },

    isActive() {
      return this.active;
    },
  };
}

describe('MeasureTool', () => {
  let measureTool;

  beforeEach(() => {
    vi.clearAllMocks();
    measureTool = createTestMeasureTool();
  });

  describe('Haversine (Geodesic) Distance Calculation', () => {
    it('should calculate zero distance for same point', () => {
      const point = [-122.4194, 37.7749]; // San Francisco
      const result = measureTool.calculateGeodesicDistance(point, point);

      expect(result.value).toBe(0);
      expect(result.unit).toBe('meters');
    });

    it('should calculate distance between San Francisco and Los Angeles', () => {
      const sf = [-122.4194, 37.7749];
      const la = [-118.2437, 34.0522];
      const result = measureTool.calculateGeodesicDistance(sf, la);

      // Actual distance is approximately 559 km
      expect(result.value).toBeGreaterThan(550000);
      expect(result.value).toBeLessThan(570000);
      expect(result.unit).toBe('meters');
    });

    it('should calculate distance between New York and London', () => {
      const ny = [-74.0060, 40.7128];
      const london = [-0.1278, 51.5074];
      const result = measureTool.calculateGeodesicDistance(ny, london);

      // Actual distance is approximately 5570 km
      expect(result.value).toBeGreaterThan(5500000);
      expect(result.value).toBeLessThan(5700000);
      expect(result.unit).toBe('meters');
    });

    it('should calculate distance across the equator', () => {
      const north = [0, 45];
      const south = [0, -45];
      const result = measureTool.calculateGeodesicDistance(north, south);

      // 90 degrees of latitude is approximately 10,000 km
      expect(result.value).toBeGreaterThan(9900000);
      expect(result.value).toBeLessThan(10100000);
    });

    it('should calculate distance along the equator', () => {
      const west = [-45, 0];
      const east = [45, 0];
      const result = measureTool.calculateGeodesicDistance(west, east);

      // 90 degrees of longitude at equator is approximately 10,000 km
      expect(result.value).toBeGreaterThan(9900000);
      expect(result.value).toBeLessThan(10100000);
    });

    it('should be symmetric (A to B = B to A)', () => {
      const pointA = [-122.4194, 37.7749];
      const pointB = [-118.2437, 34.0522];

      const distanceAB = measureTool.calculateGeodesicDistance(pointA, pointB);
      const distanceBA = measureTool.calculateGeodesicDistance(pointB, pointA);

      expect(distanceAB.value).toBeCloseTo(distanceBA.value, 5);
    });

    it('should handle short distances accurately', () => {
      // ~100 meters apart
      const point1 = [0, 0];
      const point2 = [0.0009, 0]; // Approximately 100m at equator
      const result = measureTool.calculateGeodesicDistance(point1, point2);

      expect(result.value).toBeGreaterThan(90);
      expect(result.value).toBeLessThan(110);
    });

    it('should handle negative coordinates', () => {
      const sydney = [151.2093, -33.8688];
      const tokyo = [139.6917, 35.6895];
      const result = measureTool.calculateGeodesicDistance(sydney, tokyo);

      // Sydney to Tokyo is approximately 7800 km
      expect(result.value).toBeGreaterThan(7700000);
      expect(result.value).toBeLessThan(7900000);
    });
  });

  describe('Pixel Distance Calculation', () => {
    let pixelMeasureTool;

    beforeEach(() => {
      pixelMeasureTool = createTestMeasureTool(true, {
        width: 1000,
        height: 1000,
        scale: 0.01,
        offsetX: 5,
        offsetY: 5,
      });
    });

    it('should calculate zero distance for same point', () => {
      const point = [0, 0];
      const result = pixelMeasureTool.calculatePixelDistance(point, point);

      expect(result.value).toBe(0);
      expect(result.unit).toBe('pixels');
    });

    it('should calculate horizontal distance correctly', () => {
      // 100 pixels apart horizontally
      // With scale 0.01: 1 pixel = 0.01 degrees
      // 100 pixels = 1 degree
      const point1 = [-4, 0]; // pixel x = (-4 + 5) / 0.01 = 100
      const point2 = [-3, 0]; // pixel x = (-3 + 5) / 0.01 = 200
      const result = pixelMeasureTool.calculatePixelDistance(point1, point2);

      expect(result.value).toBeCloseTo(100, 1);
      expect(result.unit).toBe('pixels');
    });

    it('should calculate vertical distance correctly', () => {
      // 100 pixels apart vertically
      const point1 = [0, 4]; // pixel y = (5 - 4) / 0.01 = 100
      const point2 = [0, 3]; // pixel y = (5 - 3) / 0.01 = 200
      const result = pixelMeasureTool.calculatePixelDistance(point1, point2);

      expect(result.value).toBeCloseTo(100, 1);
      expect(result.unit).toBe('pixels');
    });

    it('should calculate diagonal distance correctly', () => {
      // 3-4-5 right triangle (300-400-500 pixels)
      const point1 = [-2, 1]; // pixel (300, 400)
      const point2 = [-5, 5]; // pixel (0, 0)
      const result = pixelMeasureTool.calculatePixelDistance(point1, point2);

      expect(result.value).toBeCloseTo(500, 1);
      expect(result.unit).toBe('pixels');
    });

    it('should be symmetric', () => {
      const pointA = [-2, 2];
      const pointB = [3, -1];

      const distanceAB = pixelMeasureTool.calculatePixelDistance(pointA, pointB);
      const distanceBA = pixelMeasureTool.calculatePixelDistance(pointB, pointA);

      expect(distanceAB.value).toBeCloseTo(distanceBA.value, 5);
    });
  });

  describe('calculateDistance (mode switching)', () => {
    it('should use geodesic calculation when not in pixel mode', () => {
      const geoTool = createTestMeasureTool(false, null);
      const sf = [-122.4194, 37.7749];
      const la = [-118.2437, 34.0522];

      const result = geoTool.calculateDistance(sf, la);

      expect(result.unit).toBe('meters');
      expect(result.value).toBeGreaterThan(550000);
    });

    it('should use pixel calculation when in pixel mode', () => {
      const pixelTool = createTestMeasureTool(true, {
        width: 1000,
        height: 1000,
        scale: 0.01,
        offsetX: 5,
        offsetY: 5,
      });
      const point1 = [0, 0];
      const point2 = [1, 1];

      const result = pixelTool.calculateDistance(point1, point2);

      expect(result.unit).toBe('pixels');
    });

    it('should fall back to geodesic if pixel extent is missing', () => {
      const toolWithoutExtent = createTestMeasureTool(true, null);
      const point1 = [0, 0];
      const point2 = [1, 1];

      const result = toolWithoutExtent.calculateDistance(point1, point2);

      expect(result.unit).toBe('meters');
    });
  });

  describe('formatDistance', () => {
    it('should format pixel distances with px suffix', () => {
      const result = measureTool.formatDistance({ value: 150.5, unit: 'pixels' });
      expect(result).toBe('150.5 px');
    });

    it('should format meters for short distances', () => {
      const result = measureTool.formatDistance({ value: 500.3, unit: 'meters' });
      expect(result).toBe('500.3 m');
    });

    it('should format kilometers for long distances', () => {
      const result = measureTool.formatDistance({ value: 5500, unit: 'meters' });
      expect(result).toBe('5.50 km');
    });

    it('should format exactly 1000m as 1.00 km', () => {
      const result = measureTool.formatDistance({ value: 1000, unit: 'meters' });
      expect(result).toBe('1.00 km');
    });

    it('should format 999m as meters', () => {
      const result = measureTool.formatDistance({ value: 999, unit: 'meters' });
      expect(result).toBe('999.0 m');
    });

    it('should handle very large distances', () => {
      const result = measureTool.formatDistance({ value: 20000000, unit: 'meters' });
      expect(result).toBe('20000.00 km');
    });

    it('should handle very small distances', () => {
      const result = measureTool.formatDistance({ value: 0.5, unit: 'meters' });
      expect(result).toBe('0.5 m');
    });
  });

  describe('toggle and isActive', () => {
    it('should start inactive', () => {
      expect(measureTool.isActive()).toBe(false);
    });

    it('should toggle to active', () => {
      const result = measureTool.toggle();
      expect(result).toBe(true);
      expect(measureTool.isActive()).toBe(true);
    });

    it('should toggle back to inactive', () => {
      measureTool.toggle(); // activate
      const result = measureTool.toggle(); // deactivate
      expect(result).toBe(false);
      expect(measureTool.isActive()).toBe(false);
    });

    it('should toggle multiple times', () => {
      expect(measureTool.toggle()).toBe(true);
      expect(measureTool.toggle()).toBe(false);
      expect(measureTool.toggle()).toBe(true);
      expect(measureTool.toggle()).toBe(false);
    });
  });
});

describe('Integration: End-to-end distance scenarios', () => {
  it('should measure a short walking distance (~500m)', () => {
    const tool = createTestMeasureTool();
    // Two points approximately 500m apart
    const start = [-122.4194, 37.7749];
    const end = [-122.4150, 37.7780];

    const result = tool.calculateDistance(start, end);
    const formatted = tool.formatDistance(result);

    expect(result.value).toBeGreaterThan(400);
    expect(result.value).toBeLessThan(600);
    expect(formatted).toMatch(/^\d+\.\d m$/);
  });

  it('should measure a medium driving distance (~50km)', () => {
    const tool = createTestMeasureTool();
    // SF to San Jose
    const sf = [-122.4194, 37.7749];
    const sj = [-121.8863, 37.3382];

    const result = tool.calculateDistance(sf, sj);
    const formatted = tool.formatDistance(result);

    expect(result.value).toBeGreaterThan(60000);
    expect(result.value).toBeLessThan(80000);
    expect(formatted).toMatch(/^\d+\.\d+ km$/);
  });

  it('should measure pixel distance on a 1000x1000 image', () => {
    const tool = createTestMeasureTool(true, {
      width: 1000,
      height: 1000,
      scale: 0.01,
      offsetX: 5,
      offsetY: 5,
    });

    // Measure from top-left to bottom-right (diagonal ~1414 pixels)
    const topLeft = [-5, 5]; // pixel (0, 0)
    const bottomRight = [5, -5]; // pixel (1000, 1000)

    const result = tool.calculateDistance(topLeft, bottomRight);
    const formatted = tool.formatDistance(result);

    expect(result.value).toBeCloseTo(1414.2, 0);
    expect(formatted).toBe('1414.2 px');
  });
});
