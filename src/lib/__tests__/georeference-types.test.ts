/**
 * Tests for georeference types and utilities
 */

import { describe, it, expect } from 'vitest';
import {
  getMinGcps,
  TRANSFORMATIONS,
  type GCP,
  type TransformationType,
  type TransformResult,
  type GeoreferenceResult,
} from '../georeference-types';

describe('georeference-types', () => {
  describe('TRANSFORMATIONS', () => {
    it('should have all required transformation types', () => {
      const types = TRANSFORMATIONS.map(t => t.type);
      expect(types).toContain('polynomial1');
      expect(types).toContain('polynomial2');
      expect(types).toContain('polynomial3');
      expect(types).toContain('tps');
    });

    it('should have correct names for transformations', () => {
      const poly1 = TRANSFORMATIONS.find(t => t.type === 'polynomial1');
      const poly2 = TRANSFORMATIONS.find(t => t.type === 'polynomial2');
      const poly3 = TRANSFORMATIONS.find(t => t.type === 'polynomial3');
      const tps = TRANSFORMATIONS.find(t => t.type === 'tps');

      expect(poly1?.name).toBe('Polynomial 1 (Affine)');
      expect(poly2?.name).toBe('Polynomial 2');
      expect(poly3?.name).toBe('Polynomial 3');
      expect(tps?.name).toBe('Thin Plate Spline');
    });

    it('should have correct minimum GCP counts', () => {
      const poly1 = TRANSFORMATIONS.find(t => t.type === 'polynomial1');
      const poly2 = TRANSFORMATIONS.find(t => t.type === 'polynomial2');
      const poly3 = TRANSFORMATIONS.find(t => t.type === 'polynomial3');
      const tps = TRANSFORMATIONS.find(t => t.type === 'tps');

      expect(poly1?.minGcps).toBe(3);
      expect(poly2?.minGcps).toBe(6);
      expect(poly3?.minGcps).toBe(10);
      expect(tps?.minGcps).toBe(3);
    });

    it('should have 4 transformation types', () => {
      expect(TRANSFORMATIONS).toHaveLength(4);
    });
  });

  describe('getMinGcps', () => {
    it('should return correct count for polynomial1', () => {
      expect(getMinGcps('polynomial1')).toBe(3);
    });

    it('should return correct count for polynomial2', () => {
      expect(getMinGcps('polynomial2')).toBe(6);
    });

    it('should return correct count for polynomial3', () => {
      expect(getMinGcps('polynomial3')).toBe(10);
    });

    it('should return correct count for tps', () => {
      expect(getMinGcps('tps')).toBe(3);
    });

    it('should return 3 for unknown types', () => {
      expect(getMinGcps('unknown' as TransformationType)).toBe(3);
    });
  });

  describe('GCP type', () => {
    it('should allow creating valid GCP objects', () => {
      const gcp: GCP = {
        id: 'gcp-1',
        sourceX: 100,
        sourceY: 200,
        targetLng: -122.5,
        targetLat: 37.8,
        enabled: true,
      };

      expect(gcp.id).toBe('gcp-1');
      expect(gcp.sourceX).toBe(100);
      expect(gcp.sourceY).toBe(200);
      expect(gcp.targetLng).toBe(-122.5);
      expect(gcp.targetLat).toBe(37.8);
      expect(gcp.enabled).toBe(true);
    });

    it('should allow optional residual field', () => {
      const gcp: GCP = {
        id: 'gcp-1',
        sourceX: 100,
        sourceY: 200,
        targetLng: -122.5,
        targetLat: 37.8,
        enabled: true,
        residual: 0.001,
      };

      expect(gcp.residual).toBe(0.001);
    });
  });

  describe('TransformResult type', () => {
    it('should represent successful transformation', () => {
      const result: TransformResult = {
        success: true,
        rms_error: 0.0001,
        residuals: [0.00005, 0.00008, 0.00012],
        forward_transform: [0, 0.01, 0, 0, 0, -0.01],
      };

      expect(result.success).toBe(true);
      expect(result.rms_error).toBe(0.0001);
      expect(result.residuals).toHaveLength(3);
      expect(result.forward_transform).toHaveLength(6);
    });

    it('should represent failed transformation', () => {
      const result: TransformResult = {
        success: false,
        error: 'Need at least 3 GCPs',
      };

      expect(result.success).toBe(false);
      expect(result.error).toBe('Need at least 3 GCPs');
      expect(result.rms_error).toBeUndefined();
    });
  });

  describe('GeoreferenceResult type', () => {
    it('should represent successful georeferencing', () => {
      const result: GeoreferenceResult = {
        success: true,
        output_path: '/path/to/output.tif',
      };

      expect(result.success).toBe(true);
      expect(result.output_path).toBe('/path/to/output.tif');
    });

    it('should represent failed georeferencing', () => {
      const result: GeoreferenceResult = {
        success: false,
        error: 'Failed to open source image',
      };

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to open source image');
      expect(result.output_path).toBeUndefined();
    });
  });

  describe('TransformationType', () => {
    it('should accept valid transformation types', () => {
      const types: TransformationType[] = [
        'polynomial1',
        'polynomial2',
        'polynomial3',
        'tps',
      ];

      expect(types).toHaveLength(4);
      types.forEach(t => {
        const info = TRANSFORMATIONS.find(tr => tr.type === t);
        expect(info).toBeDefined();
      });
    });
  });
});
