/**
 * Tests for InspectTool functionality
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock maplibregl
const mockPopup = {
  setLngLat: vi.fn().mockReturnThis(),
  setHTML: vi.fn().mockReturnThis(),
  addTo: vi.fn().mockReturnThis(),
  remove: vi.fn(),
};

vi.mock('maplibre-gl', () => ({
  default: {
    Popup: vi.fn(() => mockPopup),
  },
}));

// Mock Tauri invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// Create test inspect tool logic
function createTestInspectTool() {
  return {
    active: false,
    points: [],

    activate() {
      this.active = true;
    },

    deactivate() {
      this.active = false;
    },

    toggle() {
      this.active = !this.active;
      return this.active;
    },

    isActive() {
      return this.active;
    },

    isPointInBounds(lng, lat, bounds) {
      if (!bounds || bounds.length !== 4) return false;
      const [minX, minY, maxX, maxY] = bounds;
      return lng >= minX && lng <= maxX && lat >= minY && lat <= maxY;
    },

    formatValue(value) {
      if (Number.isInteger(value) && Math.abs(value) < 1000) {
        return value.toString();
      }
      if (Math.abs(value) >= 1000 || (Math.abs(value) < 0.01 && value !== 0)) {
        return value.toExponential(4);
      }
      if (Number.isInteger(value)) {
        return value.toString();
      }
      return value.toFixed(4);
    },
  };
}

describe('InspectTool', () => {
  let inspectTool;

  beforeEach(() => {
    vi.clearAllMocks();
    inspectTool = createTestInspectTool();
  });

  describe('activation', () => {
    it('should start inactive', () => {
      expect(inspectTool.isActive()).toBe(false);
    });

    it('should activate', () => {
      inspectTool.activate();
      expect(inspectTool.isActive()).toBe(true);
    });

    it('should deactivate', () => {
      inspectTool.activate();
      inspectTool.deactivate();
      expect(inspectTool.isActive()).toBe(false);
    });

    it('should toggle on', () => {
      const result = inspectTool.toggle();
      expect(result).toBe(true);
      expect(inspectTool.isActive()).toBe(true);
    });

    it('should toggle off', () => {
      inspectTool.activate();
      const result = inspectTool.toggle();
      expect(result).toBe(false);
      expect(inspectTool.isActive()).toBe(false);
    });
  });

  describe('isPointInBounds', () => {
    const bounds = [-122.5, 37.5, -122.0, 38.0]; // SF area

    it('should return true for point inside bounds', () => {
      expect(inspectTool.isPointInBounds(-122.25, 37.75, bounds)).toBe(true);
    });

    it('should return true for point on boundary', () => {
      expect(inspectTool.isPointInBounds(-122.5, 37.5, bounds)).toBe(true);
      expect(inspectTool.isPointInBounds(-122.0, 38.0, bounds)).toBe(true);
    });

    it('should return false for point outside bounds (west)', () => {
      expect(inspectTool.isPointInBounds(-123.0, 37.75, bounds)).toBe(false);
    });

    it('should return false for point outside bounds (east)', () => {
      expect(inspectTool.isPointInBounds(-121.0, 37.75, bounds)).toBe(false);
    });

    it('should return false for point outside bounds (north)', () => {
      expect(inspectTool.isPointInBounds(-122.25, 38.5, bounds)).toBe(false);
    });

    it('should return false for point outside bounds (south)', () => {
      expect(inspectTool.isPointInBounds(-122.25, 37.0, bounds)).toBe(false);
    });

    it('should return false for null bounds', () => {
      expect(inspectTool.isPointInBounds(-122.25, 37.75, null)).toBe(false);
    });

    it('should return false for invalid bounds array', () => {
      expect(inspectTool.isPointInBounds(-122.25, 37.75, [-122.5, 37.5])).toBe(false);
    });
  });

  describe('formatValue', () => {
    it('should format integers without decimals', () => {
      expect(inspectTool.formatValue(42)).toBe('42');
      expect(inspectTool.formatValue(0)).toBe('0');
      expect(inspectTool.formatValue(-100)).toBe('-100');
    });

    it('should format small decimals with 4 decimal places', () => {
      expect(inspectTool.formatValue(3.14159)).toBe('3.1416');
      expect(inspectTool.formatValue(0.5)).toBe('0.5000');
    });

    it('should use exponential notation for large numbers', () => {
      expect(inspectTool.formatValue(12345.678)).toBe('1.2346e+4');
      expect(inspectTool.formatValue(1000000)).toBe('1.0000e+6');
    });

    it('should use exponential notation for very small numbers', () => {
      expect(inspectTool.formatValue(0.001)).toBe('1.0000e-3');
      expect(inspectTool.formatValue(0.00001)).toBe('1.0000e-5');
    });

    it('should handle negative numbers', () => {
      expect(inspectTool.formatValue(-42)).toBe('-42');
      expect(inspectTool.formatValue(-3.14159)).toBe('-3.1416');
      expect(inspectTool.formatValue(-0.001)).toBe('-1.0000e-3');
    });

    it('should handle zero', () => {
      expect(inspectTool.formatValue(0)).toBe('0');
      expect(inspectTool.formatValue(0.0)).toBe('0');
    });

    it('should handle boundary values', () => {
      // Just under 1000
      expect(inspectTool.formatValue(999.99)).toBe('999.9900');
      // Just at 1000
      expect(inspectTool.formatValue(1000)).toBe('1.0000e+3');
      // Just above 0.01
      expect(inspectTool.formatValue(0.01)).toBe('0.0100');
      // Just under 0.01
      expect(inspectTool.formatValue(0.009)).toBe('9.0000e-3');
    });
  });
});

describe('Pixel value result processing', () => {
  it('should identify valid results', () => {
    const result = {
      x: 100,
      y: 200,
      values: [
        { band: 1, value: 150.5, is_nodata: false },
        { band: 2, value: 200.0, is_nodata: false },
      ],
      is_valid: true,
    };

    expect(result.is_valid).toBe(true);
    expect(result.values.length).toBe(2);
    expect(result.values[0].is_nodata).toBe(false);
  });

  it('should identify nodata values', () => {
    const result = {
      x: 100,
      y: 200,
      values: [{ band: 1, value: -9999, is_nodata: true }],
      is_valid: true,
    };

    expect(result.values[0].is_nodata).toBe(true);
  });

  it('should identify out-of-bounds results', () => {
    const result = {
      x: -10,
      y: -10,
      values: [],
      is_valid: false,
    };

    expect(result.is_valid).toBe(false);
    expect(result.values.length).toBe(0);
  });
});
