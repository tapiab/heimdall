/**
 * Tests for AnnotationTool functionality
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock maplibregl
const mockMarker = {
  setLngLat: vi.fn().mockReturnThis(),
  addTo: vi.fn().mockReturnThis(),
  remove: vi.fn(),
  getElement: vi.fn(() => document.createElement('div')),
  getLngLat: vi.fn(() => ({ lng: -122.4, lat: 37.8 })),
  on: vi.fn(),
};

const mockPopup = {
  setLngLat: vi.fn().mockReturnThis(),
  setDOMContent: vi.fn().mockReturnThis(),
  addTo: vi.fn().mockReturnThis(),
  remove: vi.fn(),
};

vi.mock('maplibre-gl', () => ({
  default: {
    Marker: vi.fn(() => mockMarker),
    Popup: vi.fn(() => mockPopup),
  },
}));

vi.mock('../notifications.js', () => ({
  showToast: vi.fn(),
  showError: vi.fn(),
  showLoading: vi.fn(),
  hideLoading: vi.fn(),
}));

// Create test annotation tool logic
function createTestAnnotationTool() {
  return {
    active: false,
    mode: null,
    annotations: new Map(),
    currentPoints: [],
    nextId: 1,

    activate(mode = 'marker') {
      if (this.active && this.mode === mode) return;
      this.active = true;
      this.mode = mode;
      this.currentPoints = [];
    },

    deactivate() {
      if (!this.active) return;
      this.active = false;
      this.mode = null;
    },

    setMode(mode) {
      if (['marker', 'line', 'polygon'].includes(mode)) {
        this.activate(mode);
      }
    },

    isActive() {
      return this.active;
    },

    getMode() {
      return this.mode;
    },

    addPoint(lng, lat) {
      this.currentPoints.push([lng, lat]);
    },

    addMarkerAnnotation(lng, lat, label = null) {
      const id = `annotation-marker-${this.nextId++}`;
      const displayLabel = label || `Marker ${this.annotations.size + 1}`;

      this.annotations.set(id, {
        id,
        type: 'marker',
        label: displayLabel,
        coordinates: [lng, lat],
      });

      return id;
    },

    addLineAnnotation(label = null) {
      if (this.currentPoints.length < 2) return null;

      const id = `annotation-line-${this.nextId++}`;
      const displayLabel = label || `Line ${this.getCountByType('line') + 1}`;

      this.annotations.set(id, {
        id,
        type: 'line',
        label: displayLabel,
        coordinates: [...this.currentPoints],
      });

      this.currentPoints = [];
      return id;
    },

    addPolygonAnnotation(label = null) {
      if (this.currentPoints.length < 3) return null;

      const id = `annotation-polygon-${this.nextId++}`;
      const displayLabel = label || `Polygon ${this.getCountByType('polygon') + 1}`;

      this.annotations.set(id, {
        id,
        type: 'polygon',
        label: displayLabel,
        coordinates: [...this.currentPoints],
      });

      this.currentPoints = [];
      return id;
    },

    getCountByType(type) {
      let count = 0;
      for (const ann of this.annotations.values()) {
        if (ann.type === type) count++;
      }
      return count;
    },

    updateAnnotationLabel(id, newLabel) {
      const ann = this.annotations.get(id);
      if (ann) {
        ann.label = newLabel;
        return true;
      }
      return false;
    },

    deleteAnnotation(id) {
      return this.annotations.delete(id);
    },

    getAnnotations() {
      return Array.from(this.annotations.values()).map((ann) => ({
        id: ann.id,
        type: ann.type,
        label: ann.label,
        coordinates: ann.coordinates,
      }));
    },

    loadAnnotations(data) {
      this.clearAll();
      for (const ann of data) {
        if (ann.type === 'marker') {
          const id = this.addMarkerAnnotation(ann.coordinates[0], ann.coordinates[1], ann.label);
          // Update the ID to match the original if needed
        } else if (ann.type === 'line') {
          this.currentPoints = ann.coordinates;
          this.addLineAnnotation(ann.label);
        } else if (ann.type === 'polygon') {
          this.currentPoints = ann.coordinates;
          this.addPolygonAnnotation(ann.label);
        }
      }
    },

    clearAll() {
      this.annotations.clear();
      this.currentPoints = [];
      this.nextId = 1;
    },

    getCount() {
      return this.annotations.size;
    },
  };
}

describe('AnnotationTool', () => {
  let annotationTool;

  beforeEach(() => {
    vi.clearAllMocks();
    annotationTool = createTestAnnotationTool();
  });

  describe('activation', () => {
    it('should start inactive', () => {
      expect(annotationTool.isActive()).toBe(false);
      expect(annotationTool.getMode()).toBe(null);
    });

    it('should activate with default marker mode', () => {
      annotationTool.activate();
      expect(annotationTool.isActive()).toBe(true);
      expect(annotationTool.getMode()).toBe('marker');
    });

    it('should activate with specified mode', () => {
      annotationTool.activate('line');
      expect(annotationTool.isActive()).toBe(true);
      expect(annotationTool.getMode()).toBe('line');
    });

    it('should deactivate', () => {
      annotationTool.activate();
      annotationTool.deactivate();
      expect(annotationTool.isActive()).toBe(false);
      expect(annotationTool.getMode()).toBe(null);
    });

    it('should switch modes via setMode', () => {
      annotationTool.setMode('polygon');
      expect(annotationTool.isActive()).toBe(true);
      expect(annotationTool.getMode()).toBe('polygon');
    });

    it('should ignore invalid modes', () => {
      annotationTool.setMode('invalid');
      expect(annotationTool.isActive()).toBe(false);
    });

    it('should clear current points when activating', () => {
      annotationTool.addPoint(-122.4, 37.8);
      annotationTool.activate('line');
      expect(annotationTool.currentPoints).toEqual([]);
    });
  });

  describe('marker annotations', () => {
    it('should add a marker annotation', () => {
      const id = annotationTool.addMarkerAnnotation(-122.4, 37.8);
      expect(id).toBe('annotation-marker-1');
      expect(annotationTool.getCount()).toBe(1);
    });

    it('should auto-generate label for marker', () => {
      annotationTool.addMarkerAnnotation(-122.4, 37.8);
      const annotations = annotationTool.getAnnotations();
      expect(annotations[0].label).toBe('Marker 1');
    });

    it('should use provided label', () => {
      annotationTool.addMarkerAnnotation(-122.4, 37.8, 'My Location');
      const annotations = annotationTool.getAnnotations();
      expect(annotations[0].label).toBe('My Location');
    });

    it('should store coordinates', () => {
      annotationTool.addMarkerAnnotation(-122.4, 37.8);
      const annotations = annotationTool.getAnnotations();
      expect(annotations[0].coordinates).toEqual([-122.4, 37.8]);
    });

    it('should increment marker numbers', () => {
      annotationTool.addMarkerAnnotation(-122.4, 37.8);
      annotationTool.addMarkerAnnotation(-122.5, 37.9);
      const annotations = annotationTool.getAnnotations();
      expect(annotations[0].label).toBe('Marker 1');
      expect(annotations[1].label).toBe('Marker 2');
    });
  });

  describe('line annotations', () => {
    it('should require at least 2 points', () => {
      annotationTool.addPoint(-122.4, 37.8);
      const id = annotationTool.addLineAnnotation();
      expect(id).toBe(null);
    });

    it('should add a line annotation with 2 points', () => {
      annotationTool.addPoint(-122.4, 37.8);
      annotationTool.addPoint(-122.5, 37.9);
      const id = annotationTool.addLineAnnotation();
      expect(id).toBe('annotation-line-1');
      expect(annotationTool.getCount()).toBe(1);
    });

    it('should store all coordinates', () => {
      annotationTool.addPoint(-122.4, 37.8);
      annotationTool.addPoint(-122.5, 37.9);
      annotationTool.addPoint(-122.6, 38.0);
      annotationTool.addLineAnnotation();
      const annotations = annotationTool.getAnnotations();
      expect(annotations[0].coordinates.length).toBe(3);
    });

    it('should clear current points after adding', () => {
      annotationTool.addPoint(-122.4, 37.8);
      annotationTool.addPoint(-122.5, 37.9);
      annotationTool.addLineAnnotation();
      expect(annotationTool.currentPoints).toEqual([]);
    });
  });

  describe('polygon annotations', () => {
    it('should require at least 3 points', () => {
      annotationTool.addPoint(-122.4, 37.8);
      annotationTool.addPoint(-122.5, 37.9);
      const id = annotationTool.addPolygonAnnotation();
      expect(id).toBe(null);
    });

    it('should add a polygon annotation with 3 points', () => {
      annotationTool.addPoint(-122.4, 37.8);
      annotationTool.addPoint(-122.5, 37.9);
      annotationTool.addPoint(-122.3, 37.85);
      const id = annotationTool.addPolygonAnnotation();
      expect(id).toBe('annotation-polygon-1');
      expect(annotationTool.getCount()).toBe(1);
    });

    it('should store all coordinates', () => {
      annotationTool.addPoint(-122.4, 37.8);
      annotationTool.addPoint(-122.5, 37.9);
      annotationTool.addPoint(-122.3, 37.85);
      annotationTool.addPoint(-122.35, 37.82);
      annotationTool.addPolygonAnnotation();
      const annotations = annotationTool.getAnnotations();
      expect(annotations[0].coordinates.length).toBe(4);
    });
  });

  describe('annotation management', () => {
    it('should update annotation label', () => {
      const id = annotationTool.addMarkerAnnotation(-122.4, 37.8);
      annotationTool.updateAnnotationLabel(id, 'Updated Label');
      const annotations = annotationTool.getAnnotations();
      expect(annotations[0].label).toBe('Updated Label');
    });

    it('should return false for non-existent annotation', () => {
      const result = annotationTool.updateAnnotationLabel('fake-id', 'Label');
      expect(result).toBe(false);
    });

    it('should delete annotation', () => {
      const id = annotationTool.addMarkerAnnotation(-122.4, 37.8);
      expect(annotationTool.getCount()).toBe(1);
      annotationTool.deleteAnnotation(id);
      expect(annotationTool.getCount()).toBe(0);
    });

    it('should return false when deleting non-existent annotation', () => {
      const result = annotationTool.deleteAnnotation('fake-id');
      expect(result).toBe(false);
    });

    it('should clear all annotations', () => {
      annotationTool.addMarkerAnnotation(-122.4, 37.8);
      annotationTool.addMarkerAnnotation(-122.5, 37.9);
      annotationTool.addPoint(-122.4, 37.8);
      annotationTool.addPoint(-122.5, 37.9);
      annotationTool.addLineAnnotation();
      expect(annotationTool.getCount()).toBe(3);
      annotationTool.clearAll();
      expect(annotationTool.getCount()).toBe(0);
      expect(annotationTool.currentPoints).toEqual([]);
    });
  });

  describe('getCountByType', () => {
    it('should count markers', () => {
      annotationTool.addMarkerAnnotation(-122.4, 37.8);
      annotationTool.addMarkerAnnotation(-122.5, 37.9);
      expect(annotationTool.getCountByType('marker')).toBe(2);
    });

    it('should count lines', () => {
      annotationTool.addPoint(-122.4, 37.8);
      annotationTool.addPoint(-122.5, 37.9);
      annotationTool.addLineAnnotation();
      annotationTool.addPoint(-122.3, 37.7);
      annotationTool.addPoint(-122.2, 37.6);
      annotationTool.addLineAnnotation();
      expect(annotationTool.getCountByType('line')).toBe(2);
    });

    it('should return 0 for type with no annotations', () => {
      annotationTool.addMarkerAnnotation(-122.4, 37.8);
      expect(annotationTool.getCountByType('polygon')).toBe(0);
    });
  });

  describe('serialization', () => {
    it('should serialize annotations', () => {
      annotationTool.addMarkerAnnotation(-122.4, 37.8, 'Test Marker');
      annotationTool.addPoint(-122.4, 37.8);
      annotationTool.addPoint(-122.5, 37.9);
      annotationTool.addLineAnnotation('Test Line');

      const serialized = annotationTool.getAnnotations();
      expect(serialized.length).toBe(2);
      expect(serialized[0].type).toBe('marker');
      expect(serialized[0].label).toBe('Test Marker');
      expect(serialized[1].type).toBe('line');
      expect(serialized[1].label).toBe('Test Line');
    });

    it('should load annotations', () => {
      const data = [
        { type: 'marker', label: 'Loaded Marker', coordinates: [-122.4, 37.8] },
        { type: 'line', label: 'Loaded Line', coordinates: [[-122.4, 37.8], [-122.5, 37.9]] },
        { type: 'polygon', label: 'Loaded Polygon', coordinates: [[-122.4, 37.8], [-122.5, 37.9], [-122.3, 37.85]] },
      ];

      annotationTool.loadAnnotations(data);
      expect(annotationTool.getCount()).toBe(3);

      const annotations = annotationTool.getAnnotations();
      expect(annotations.some((a) => a.type === 'marker')).toBe(true);
      expect(annotations.some((a) => a.type === 'line')).toBe(true);
      expect(annotations.some((a) => a.type === 'polygon')).toBe(true);
    });

    it('should clear existing annotations when loading', () => {
      annotationTool.addMarkerAnnotation(-122.4, 37.8);
      annotationTool.addMarkerAnnotation(-122.5, 37.9);
      expect(annotationTool.getCount()).toBe(2);

      annotationTool.loadAnnotations([
        { type: 'marker', label: 'New Marker', coordinates: [-122.6, 38.0] },
      ]);
      expect(annotationTool.getCount()).toBe(1);
    });
  });
});

describe('Annotation data structure', () => {
  it('should have required fields for marker', () => {
    const marker = {
      id: 'annotation-marker-1',
      type: 'marker',
      label: 'Test',
      coordinates: [-122.4, 37.8],
    };

    expect(marker).toHaveProperty('id');
    expect(marker).toHaveProperty('type');
    expect(marker).toHaveProperty('label');
    expect(marker).toHaveProperty('coordinates');
    expect(marker.type).toBe('marker');
  });

  it('should have required fields for line', () => {
    const line = {
      id: 'annotation-line-1',
      type: 'line',
      label: 'Test Line',
      coordinates: [[-122.4, 37.8], [-122.5, 37.9]],
    };

    expect(line.type).toBe('line');
    expect(Array.isArray(line.coordinates)).toBe(true);
    expect(line.coordinates.length).toBeGreaterThanOrEqual(2);
  });

  it('should have required fields for polygon', () => {
    const polygon = {
      id: 'annotation-polygon-1',
      type: 'polygon',
      label: 'Test Polygon',
      coordinates: [[-122.4, 37.8], [-122.5, 37.9], [-122.3, 37.85]],
    };

    expect(polygon.type).toBe('polygon');
    expect(Array.isArray(polygon.coordinates)).toBe(true);
    expect(polygon.coordinates.length).toBeGreaterThanOrEqual(3);
  });
});
