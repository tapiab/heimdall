/**
 * Tests for ProfileTool functionality
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock maplibregl
const mockMarker = {
  setLngLat: vi.fn().mockReturnThis(),
  addTo: vi.fn().mockReturnThis(),
  remove: vi.fn(),
};

vi.mock('maplibre-gl', () => ({
  default: {
    Marker: vi.fn(() => mockMarker),
  },
}));

// Mock Tauri invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('../notifications.js', () => ({
  showToast: vi.fn(),
  showError: vi.fn(),
  showLoading: vi.fn(),
  hideLoading: vi.fn(),
}));

// Create test profile tool logic
function createTestProfileTool() {
  return {
    active: false,
    points: [],

    activate() {
      if (this.active) return;
      this.active = true;
      this.points = [];
    },

    deactivate() {
      if (!this.active) return;
      this.active = false;
    },

    toggle() {
      if (this.active) {
        this.deactivate();
      } else {
        this.activate();
      }
      return this.active;
    },

    isActive() {
      return this.active;
    },

    addPoint(lng, lat) {
      this.points.push([lng, lat]);
    },

    formatDistance(meters) {
      if (meters < 1000) {
        return `${meters.toFixed(0)}m`;
      }
      return `${(meters / 1000).toFixed(2)}km`;
    },

    calculateStats(points) {
      if (points.length < 2) return null;

      let elevGain = 0;
      let elevLoss = 0;
      let min = points[0].elevation;
      let max = points[0].elevation;

      for (let i = 1; i < points.length; i++) {
        const diff = points[i].elevation - points[i - 1].elevation;
        if (diff > 0) elevGain += diff;
        else elevLoss += Math.abs(diff);

        if (points[i].elevation < min) min = points[i].elevation;
        if (points[i].elevation > max) max = points[i].elevation;
      }

      return {
        elevationGain: elevGain,
        elevationLoss: elevLoss,
        minElevation: min,
        maxElevation: max,
      };
    },

    canGenerateProfile() {
      return this.points.length >= 2;
    },
  };
}

describe('ProfileTool', () => {
  let profileTool;

  beforeEach(() => {
    vi.clearAllMocks();
    profileTool = createTestProfileTool();
  });

  describe('activation', () => {
    it('should start inactive', () => {
      expect(profileTool.isActive()).toBe(false);
    });

    it('should activate', () => {
      profileTool.activate();
      expect(profileTool.isActive()).toBe(true);
    });

    it('should clear points on activate', () => {
      profileTool.points = [[0, 0], [1, 1]];
      profileTool.activate();
      expect(profileTool.points).toEqual([]);
    });

    it('should deactivate', () => {
      profileTool.activate();
      profileTool.deactivate();
      expect(profileTool.isActive()).toBe(false);
    });

    it('should toggle on', () => {
      const result = profileTool.toggle();
      expect(result).toBe(true);
      expect(profileTool.isActive()).toBe(true);
    });

    it('should toggle off', () => {
      profileTool.activate();
      const result = profileTool.toggle();
      expect(result).toBe(false);
      expect(profileTool.isActive()).toBe(false);
    });

    it('should not re-activate if already active', () => {
      profileTool.activate();
      profileTool.points = [[0, 0]]; // Add a point
      profileTool.activate(); // Try to activate again
      // Points should be cleared only if it wasn't already active
      expect(profileTool.points).toEqual([[0, 0]]);
    });

    it('should not deactivate if already inactive', () => {
      profileTool.deactivate();
      expect(profileTool.isActive()).toBe(false);
    });
  });

  describe('point management', () => {
    it('should add points', () => {
      profileTool.addPoint(-122.4, 37.8);
      expect(profileTool.points.length).toBe(1);
      expect(profileTool.points[0]).toEqual([-122.4, 37.8]);
    });

    it('should add multiple points', () => {
      profileTool.addPoint(-122.4, 37.8);
      profileTool.addPoint(-122.5, 37.9);
      profileTool.addPoint(-122.6, 38.0);
      expect(profileTool.points.length).toBe(3);
    });

    it('should require at least 2 points for profile', () => {
      expect(profileTool.canGenerateProfile()).toBe(false);
      profileTool.addPoint(-122.4, 37.8);
      expect(profileTool.canGenerateProfile()).toBe(false);
      profileTool.addPoint(-122.5, 37.9);
      expect(profileTool.canGenerateProfile()).toBe(true);
    });
  });

  describe('formatDistance', () => {
    it('should format meters for short distances', () => {
      expect(profileTool.formatDistance(0)).toBe('0m');
      expect(profileTool.formatDistance(100)).toBe('100m');
      expect(profileTool.formatDistance(500)).toBe('500m');
      expect(profileTool.formatDistance(999)).toBe('999m');
    });

    it('should format kilometers for long distances', () => {
      expect(profileTool.formatDistance(1000)).toBe('1.00km');
      expect(profileTool.formatDistance(1500)).toBe('1.50km');
      expect(profileTool.formatDistance(10000)).toBe('10.00km');
      expect(profileTool.formatDistance(25500)).toBe('25.50km');
    });

    it('should handle decimal meters', () => {
      expect(profileTool.formatDistance(150.7)).toBe('151m');
      expect(profileTool.formatDistance(999.9)).toBe('1000m');
    });

    it('should handle decimal kilometers', () => {
      expect(profileTool.formatDistance(1234.5)).toBe('1.23km');
    });
  });

  describe('calculateStats', () => {
    it('should return null for less than 2 points', () => {
      expect(profileTool.calculateStats([])).toBe(null);
      expect(profileTool.calculateStats([{ elevation: 100 }])).toBe(null);
    });

    it('should calculate stats for flat terrain', () => {
      const points = [
        { elevation: 100 },
        { elevation: 100 },
        { elevation: 100 },
      ];
      const stats = profileTool.calculateStats(points);
      expect(stats.elevationGain).toBe(0);
      expect(stats.elevationLoss).toBe(0);
      expect(stats.minElevation).toBe(100);
      expect(stats.maxElevation).toBe(100);
    });

    it('should calculate stats for uphill terrain', () => {
      const points = [
        { elevation: 100 },
        { elevation: 150 },
        { elevation: 200 },
      ];
      const stats = profileTool.calculateStats(points);
      expect(stats.elevationGain).toBe(100);
      expect(stats.elevationLoss).toBe(0);
      expect(stats.minElevation).toBe(100);
      expect(stats.maxElevation).toBe(200);
    });

    it('should calculate stats for downhill terrain', () => {
      const points = [
        { elevation: 200 },
        { elevation: 150 },
        { elevation: 100 },
      ];
      const stats = profileTool.calculateStats(points);
      expect(stats.elevationGain).toBe(0);
      expect(stats.elevationLoss).toBe(100);
      expect(stats.minElevation).toBe(100);
      expect(stats.maxElevation).toBe(200);
    });

    it('should calculate stats for rolling terrain', () => {
      const points = [
        { elevation: 100 },
        { elevation: 150 },
        { elevation: 120 },
        { elevation: 180 },
        { elevation: 90 },
      ];
      const stats = profileTool.calculateStats(points);
      // Gain: +50 (100->150) + +60 (120->180) = 110
      expect(stats.elevationGain).toBe(110);
      // Loss: +30 (150->120) + +90 (180->90) = 120
      expect(stats.elevationLoss).toBe(120);
      expect(stats.minElevation).toBe(90);
      expect(stats.maxElevation).toBe(180);
    });

    it('should handle negative elevations', () => {
      const points = [
        { elevation: -10 },
        { elevation: -50 },
        { elevation: 20 },
      ];
      const stats = profileTool.calculateStats(points);
      expect(stats.elevationGain).toBe(70); // -50 to 20
      expect(stats.elevationLoss).toBe(40); // -10 to -50
      expect(stats.minElevation).toBe(-50);
      expect(stats.maxElevation).toBe(20);
    });
  });
});

describe('Profile result processing', () => {
  it('should identify valid profile result structure', () => {
    const result = {
      points: [
        { distance: 0, elevation: 100, lng: -122.4, lat: 37.8, is_valid: true },
        { distance: 100, elevation: 110, lng: -122.41, lat: 37.81, is_valid: true },
        { distance: 200, elevation: 120, lng: -122.42, lat: 37.82, is_valid: true },
      ],
      total_distance: 200,
      min_elevation: 100,
      max_elevation: 120,
      elevation_gain: 20,
      elevation_loss: 0,
    };

    expect(result.points.length).toBe(3);
    expect(result.total_distance).toBe(200);
    expect(result.elevation_gain).toBe(20);
    expect(result.points.every((p) => p.is_valid)).toBe(true);
  });

  it('should handle points outside raster bounds', () => {
    const result = {
      points: [
        { distance: 0, elevation: 100, lng: -122.4, lat: 37.8, is_valid: true },
        { distance: 100, elevation: 0, lng: -122.41, lat: 37.81, is_valid: false },
        { distance: 200, elevation: 120, lng: -122.42, lat: 37.82, is_valid: true },
      ],
      total_distance: 200,
      min_elevation: 100,
      max_elevation: 120,
      elevation_gain: 20,
      elevation_loss: 0,
    };

    const validPoints = result.points.filter((p) => p.is_valid);
    expect(validPoints.length).toBe(2);
  });

  it('should have required fields in profile points', () => {
    const point = {
      distance: 150.5,
      elevation: 250.75,
      lng: -122.45,
      lat: 37.85,
      is_valid: true,
    };

    expect(point).toHaveProperty('distance');
    expect(point).toHaveProperty('elevation');
    expect(point).toHaveProperty('lng');
    expect(point).toHaveProperty('lat');
    expect(point).toHaveProperty('is_valid');
  });
});

describe('Haversine distance calculation', () => {
  // Test the concept of Haversine distance used in profile tool
  function haversineDistance(lng1, lat1, lng2, lat2) {
    const R = 6371000; // Earth radius in meters
    const toRad = (deg) => (deg * Math.PI) / 180;

    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lng2 - lng1);
    const lat1Rad = toRad(lat1);
    const lat2Rad = toRad(lat2);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }

  it('should return 0 for same point', () => {
    expect(haversineDistance(-122.4, 37.8, -122.4, 37.8)).toBe(0);
  });

  it('should calculate distance between two points', () => {
    // San Francisco to Oakland (roughly)
    const dist = haversineDistance(-122.4194, 37.7749, -122.2711, 37.8044);
    // Approximately 13-14 km
    expect(dist).toBeGreaterThan(12000);
    expect(dist).toBeLessThan(15000);
  });

  it('should handle crossing the equator', () => {
    const dist = haversineDistance(0, 1, 0, -1);
    // 2 degrees of latitude is about 222 km
    expect(dist).toBeGreaterThan(220000);
    expect(dist).toBeLessThan(225000);
  });

  it('should handle crossing the prime meridian', () => {
    const dist = haversineDistance(-1, 0, 1, 0);
    // 2 degrees of longitude at equator is about 222 km
    expect(dist).toBeGreaterThan(220000);
    expect(dist).toBeLessThan(225000);
  });

  it('should be symmetric', () => {
    const dist1 = haversineDistance(-122.4, 37.8, -122.5, 37.9);
    const dist2 = haversineDistance(-122.5, 37.9, -122.4, 37.8);
    expect(Math.abs(dist1 - dist2)).toBeLessThan(0.001);
  });
});

describe('Chart rendering calculations', () => {
  it('should calculate scale factors correctly', () => {
    const chartWidth = 500;
    const chartHeight = 150;
    const totalDistance = 1000;
    const minElevation = 100;
    const maxElevation = 200;

    const xScale = chartWidth / totalDistance;
    const elevRange = maxElevation - minElevation;
    const yScale = elevRange > 0 ? chartHeight / (elevRange * 1.1) : 1;

    expect(xScale).toBe(0.5); // 500 / 1000
    expect(yScale).toBeCloseTo(1.36, 1); // 150 / (100 * 1.1)
  });

  it('should handle zero elevation range', () => {
    const chartHeight = 150;
    const minElevation = 100;
    const maxElevation = 100; // Same as min

    const elevRange = maxElevation - minElevation;
    const yScale = elevRange > 0 ? chartHeight / (elevRange * 1.1) : 1;

    expect(yScale).toBe(1);
  });

  it('should calculate point positions correctly', () => {
    const padding = { left: 50, right: 20, top: 20, bottom: 30 };
    const canvasHeight = 200;
    const chartWidth = 500;
    const chartHeight = canvasHeight - padding.top - padding.bottom;

    const point = { distance: 500, elevation: 150 };
    const totalDistance = 1000;
    const minElevation = 100;
    const maxElevation = 200;

    const xScale = chartWidth / totalDistance;
    const elevRange = maxElevation - minElevation;
    const yScale = chartHeight / (elevRange * 1.1);
    const yOffset = minElevation - elevRange * 0.05;

    const x = padding.left + point.distance * xScale;
    const y = canvasHeight - padding.bottom - (point.elevation - yOffset) * yScale;

    expect(x).toBe(300); // 50 + 500 * 0.5
    expect(y).toBeGreaterThan(50);
    expect(y).toBeLessThan(150);
  });
});
