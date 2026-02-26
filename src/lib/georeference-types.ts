/**
 * TypeScript interfaces for manual georeferencing
 */

/** Ground Control Point - links a pixel coordinate to a geographic coordinate */
export interface GCP {
  id: string;
  sourceX: number; // Pixel X coordinate in source image
  sourceY: number; // Pixel Y coordinate in source image
  targetLng: number; // Target longitude (EPSG:4326)
  targetLat: number; // Target latitude (EPSG:4326)
  enabled: boolean; // Include in transformation calculation
  residual?: number; // Per-point RMS error after transformation
}

/** Supported transformation types */
export type TransformationType = 'polynomial1' | 'polynomial2' | 'polynomial3' | 'tps';

/** Transformation type info for UI display */
export interface TransformationInfo {
  type: TransformationType;
  name: string;
  minGcps: number;
  description: string;
}

/** Available transformation types */
export const TRANSFORMATIONS: TransformationInfo[] = [
  {
    type: 'polynomial1',
    name: 'Polynomial 1 (Affine)',
    minGcps: 3,
    description: 'Linear transformation - rotation, scale, translation, skew',
  },
  {
    type: 'polynomial2',
    name: 'Polynomial 2',
    minGcps: 6,
    description: '2nd order polynomial - handles moderate distortion',
  },
  {
    type: 'polynomial3',
    name: 'Polynomial 3',
    minGcps: 10,
    description: '3rd order polynomial - handles complex distortion',
  },
  {
    type: 'tps',
    name: 'Thin Plate Spline',
    minGcps: 3,
    description: 'Flexible rubber-sheeting transformation',
  },
];

/** GCP data format for backend */
export interface GCPData {
  pixel_x: number;
  pixel_y: number;
  geo_x: number;
  geo_y: number;
}

/** Result of transformation calculation from backend */
export interface TransformResult {
  success: boolean;
  rms_error?: number;
  residuals?: number[];
  forward_transform?: number[];
  error?: string;
}

/** Result of applying georeferencing from backend */
export interface GeoreferenceResult {
  success: boolean;
  output_path?: string;
  error?: string;
}

/** State of the GCP collection workflow */
export type GCPCollectionState = 'idle' | 'collecting_source' | 'collecting_target';

/** Get minimum GCPs required for a transformation type */
export function getMinGcps(transformType: TransformationType): number {
  const info = TRANSFORMATIONS.find(t => t.type === transformType);
  return info?.minGcps ?? 3;
}
