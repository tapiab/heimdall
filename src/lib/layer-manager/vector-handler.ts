/**
 * Vector layer handling - loading, styling, and interactions
 * @module layer-manager/vector-handler
 */

import { invoke } from '@tauri-apps/api/core';
import maplibregl, { type LngLat } from 'maplibre-gl';
import { showToast, showError, showLoading, hideLoading } from '../notifications';
import {
  DEFAULT_VECTOR_STYLE,
  CATEGORICAL_COLORS,
  type LayerManagerInterface,
  type VectorLayer,
  type VectorStyle,
  type VectorField,
} from './types';
import { logger } from '../logger';

const log = logger.child('LayerManager:Vector');

/** Metadata returned from backend when opening a vector file */
interface VectorMetadata {
  id: string;
  path: string;
  bounds: [number, number, number, number];
  feature_count: number;
  geometry_type: string;
  fields: VectorField[];
}

/** Response from open_vector backend call */
interface VectorResponse {
  metadata: VectorMetadata;
  geojson: GeoJSON.FeatureCollection;
}

/** GeoJSON feature with layer info from MapLibre */
interface MapFeature {
  properties: Record<string, unknown>;
  layer: { id: string };
}

/**
 * Add a vector layer from a file path
 * @param manager - The LayerManager instance
 * @param filePath - Path to the vector file
 * @returns Layer metadata
 */
export async function addVectorLayer(
  manager: LayerManagerInterface,
  filePath: string
): Promise<VectorMetadata> {
  const fileName = filePath.split('/').pop()?.split('\\').pop() || 'Unknown';
  showLoading(`Loading ${fileName}...`);
  try {
    // Open the vector in the backend
    const data = await invoke<VectorResponse>('open_vector', { path: filePath });
    const { metadata, geojson } = data;

    log.debug('Opened vector', { id: metadata.id, fileName, features: metadata.feature_count });

    // Store layer info
    const layerData: VectorLayer = {
      ...metadata,
      visible: true,
      opacity: 1.0,
      type: 'vector',
      geojson,
      style: { ...DEFAULT_VECTOR_STYLE },
    };

    manager.layers.set(metadata.id, layerData);
    manager.layerOrder.push(metadata.id);

    // Add to map as GeoJSON source
    const sourceId = `vector-source-${metadata.id}`;

    manager.mapManager.addSource(sourceId, {
      type: 'geojson',
      data: geojson,
    });

    // Always add all layer types with geometry filters
    // This handles mixed geometry GeoJSON properly
    addAllVectorLayers(manager, metadata.id, sourceId, layerData.style);

    // Select this layer for controls
    manager.selectedLayerId = metadata.id;

    // Update UI
    manager.updateLayerPanel();
    manager.updateDynamicControls();

    // Fit to layer bounds
    manager.mapManager.fitBounds([
      [metadata.bounds[0], metadata.bounds[1]],
      [metadata.bounds[2], metadata.bounds[3]],
    ]);

    showToast(`Loaded ${fileName} (${metadata.feature_count} features)`, 'success', 2000);
    return metadata;
  } catch (error) {
    log.error('Failed to add vector layer', { error: String(error) });
    showError('Failed to load vector', error instanceof Error ? error : String(error));
    throw error;
  } finally {
    hideLoading();
  }
}

/** Build a MapLibre filter expression combining geometry type with feature filters */
function buildFilterFor(
  geomFilter: unknown[],
  featureFilters: VectorStyle['featureFilters']
): unknown[] {
  const fieldFilters: unknown[] = [];
  if (featureFilters) {
    for (const [field, allowed] of Object.entries(featureFilters)) {
      if (!Array.isArray(allowed)) continue;
      // Empty array = exclude all features for this field
      if (allowed.length === 0) {
        return ['==', ['literal', 0], 1];
      }
      // Legacy "in" filter: ['in', fieldName, val1, val2, ...]
      fieldFilters.push(['in', field, ...allowed]);
    }
  }
  if (fieldFilters.length === 0) return geomFilter;
  return ['all', geomFilter, ...fieldFilters];
}

/** Apply current feature filters to all sublayers of a vector layer */
export function applyVectorFilters(manager: LayerManagerInterface, id: string): void {
  const layer = manager.layers.get(id) as VectorLayer | undefined;
  if (!layer || layer.type !== 'vector') return;
  const { map } = manager.mapManager;
  if (!map) return;
  const { featureFilters } = layer.style;

  const fillFilter = buildFilterFor(['==', '$type', 'Polygon'], featureFilters);
  const lineFilter = buildFilterFor(
    ['any', ['==', '$type', 'LineString'], ['==', '$type', 'Polygon']],
    featureFilters
  );
  const circleFilter = buildFilterFor(['==', '$type', 'Point'], featureFilters);

  try {
    map.setFilter(`vector-fill-${id}`, fillFilter as maplibregl.FilterSpecification);
  } catch (_e) {
    /* layer may not exist */
  }
  try {
    map.setFilter(`vector-line-${id}`, lineFilter as maplibregl.FilterSpecification);
  } catch (_e) {
    /* layer may not exist */
  }
  try {
    map.setFilter(`vector-circle-${id}`, circleFilter as maplibregl.FilterSpecification);
  } catch (_e) {
    /* layer may not exist */
  }
}

/**
 * Set the allowed values for a field filter on a vector layer.
 * Passing null or a full set restores "show all" for that field.
 */
export function setVectorFeatureFilter(
  manager: LayerManagerInterface,
  id: string,
  fieldName: string,
  allowedValues: Array<string | number> | null
): void {
  const layer = manager.layers.get(id) as VectorLayer | undefined;
  if (!layer || layer.type !== 'vector') return;

  if (!layer.style.featureFilters) layer.style.featureFilters = {};

  if (allowedValues === null) {
    delete layer.style.featureFilters[fieldName];
  } else {
    layer.style.featureFilters[fieldName] = allowedValues;
  }

  applyVectorFilters(manager, id);
}

/**
 * Compute unique values + counts for each field that looks filterable
 * (categorical: ≤ MAX_UNIQUE_VALUES unique entries).
 */
export interface FieldValueStats {
  value: string | number;
  count: number;
}
export interface FilterableField {
  name: string;
  displayName: string;
  values: FieldValueStats[];
}

const MAX_UNIQUE_VALUES = 50;

const FILTER_FIELD_LABEL_OVERRIDES: Record<string, string> = {
  class: 'Layer',
  class_name: 'Layer',
  classname: 'Layer',
  category: 'Category',
  type: 'Type',
  kind: 'Kind',
  label: 'Label',
};

function humanizeFieldName(name: string): string {
  const lower = name.toLowerCase();
  if (FILTER_FIELD_LABEL_OVERRIDES[lower]) return FILTER_FIELD_LABEL_OVERRIDES[lower];
  const spaced = lower.replace(/[_-]+/g, ' ').trim();
  return spaced.replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Canonical partition signature: for each feature, the order-of-first-appearance
 * index of its value. Two fields with the same partition (e.g. numeric class id
 * vs. string class_name) produce identical signatures.
 */
function canonicalPartition(
  features: GeoJSON.Feature[],
  fieldName: string,
  fieldType: string
): string {
  const isNumericField = fieldType !== 'String';
  const seen = new Map<string, number>();
  const seq: number[] = [];
  for (const f of features) {
    const raw = f.properties?.[fieldName];
    let key: string;
    if (raw === null || raw === undefined) key = '__null__';
    else if (typeof raw === 'string' || typeof raw === 'number') key = String(raw);
    else key = JSON.stringify(raw);
    let id = seen.get(key);
    if (id === undefined) {
      id = seen.size;
      seen.set(key, id);
    }
    seq.push(id);
  }
  return (isNumericField ? 'N|' : 'S|') + seq.join(',');
}

export function computeFilterableFields(layer: VectorLayer): FilterableField[] {
  const features = layer.geojson?.features || [];
  if (features.length === 0) return [];

  const candidates: Array<{
    name: string;
    fieldType: string;
    values: FieldValueStats[];
  }> = [];

  for (const f of layer.fields || []) {
    const counts = new Map<string | number, number>();
    let abort = false;
    for (const feat of features) {
      const raw = feat.properties?.[f.name];
      if (raw === null || raw === undefined) continue;
      if (typeof raw !== 'string' && typeof raw !== 'number') continue;
      counts.set(raw, (counts.get(raw) || 0) + 1);
      if (counts.size > MAX_UNIQUE_VALUES) {
        abort = true;
        break;
      }
    }
    if (abort || counts.size === 0) continue;
    const values = Array.from(counts.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count);
    candidates.push({ name: f.name, fieldType: f.type, values });
  }

  // Dedupe fields that partition features identically (e.g. `class` ↔ `class_name`).
  // Strip the field-type prefix so a numeric and string field with the same
  // partition collide and only one wins.
  const groups = new Map<string, typeof candidates>();
  for (const c of candidates) {
    const sig = canonicalPartition(features, c.name, c.fieldType).slice(2);
    let bucket = groups.get(sig);
    if (!bucket) {
      bucket = [];
      groups.set(sig, bucket);
    }
    bucket.push(c);
  }

  const out: FilterableField[] = [];
  // Preserve original field order — emit one entry per partition group, using
  // the first candidate seen in `candidates` order.
  const emitted = new Set<string>();
  for (const c of candidates) {
    const sig = canonicalPartition(features, c.name, c.fieldType).slice(2);
    if (emitted.has(sig)) continue;
    emitted.add(sig);

    const bucket = groups.get(sig) || [c];
    // Prefer string-typed field (human-readable labels) when partition matches.
    const preferred =
      bucket.find(b => b.fieldType === 'String') ||
      bucket.slice().sort((a, b) => b.name.length - a.name.length)[0];

    out.push({
      name: preferred.name,
      displayName: humanizeFieldName(preferred.name),
      values: preferred.values,
    });
  }
  return out;
}

/** Add all vector layer types (for mixed geometry) */
function addAllVectorLayers(
  manager: LayerManagerInterface,
  id: string,
  sourceId: string,
  style: VectorStyle
): void {
  const { map } = manager.mapManager;
  if (!map) {
    log.error('Map not available when adding vector layers');
    return;
  }

  // Check if source was added
  if (!map.getSource(sourceId)) {
    log.error('Source not found', { sourceId });
    return;
  }

  const fillFilter = buildFilterFor(['==', '$type', 'Polygon'], style.featureFilters);
  const lineFilter = buildFilterFor(
    ['any', ['==', '$type', 'LineString'], ['==', '$type', 'Polygon']],
    style.featureFilters
  );
  const circleFilter = buildFilterFor(['==', '$type', 'Point'], style.featureFilters);

  // Add fill layer for polygons
  map.addLayer({
    id: `vector-fill-${id}`,
    type: 'fill',
    source: sourceId,
    filter: fillFilter as maplibregl.FilterSpecification,
    paint: {
      'fill-color': style.fillColor,
      'fill-opacity': style.fillOpacity,
    },
  });

  // Add line layer for lines and polygon outlines
  map.addLayer({
    id: `vector-line-${id}`,
    type: 'line',
    source: sourceId,
    filter: lineFilter as maplibregl.FilterSpecification,
    paint: {
      'line-color': style.strokeColor,
      'line-width': style.strokeWidth,
    },
  });

  // Add circle layer for points
  map.addLayer({
    id: `vector-circle-${id}`,
    type: 'circle',
    source: sourceId,
    filter: circleFilter as maplibregl.FilterSpecification,
    paint: {
      'circle-color': style.fillColor,
      'circle-radius': style.pointRadius,
      'circle-stroke-color': style.strokeColor,
      'circle-stroke-width': 1,
    },
  });

  log.debug('Added vector layers', {
    fill: map.getLayer(`vector-fill-${id}`) ? 'ok' : 'missing',
    line: map.getLayer(`vector-line-${id}`) ? 'ok' : 'missing',
    circle: map.getLayer(`vector-circle-${id}`) ? 'ok' : 'missing',
  });
}

/**
 * Set a vector style property
 * @param manager - The LayerManager instance
 * @param id - Layer ID
 * @param property - Style property name
 * @param value - Property value
 */
export function setVectorStyle(
  manager: LayerManagerInterface,
  id: string,
  property: keyof VectorStyle,
  value: string | number
): void {
  const layer = manager.layers.get(id) as VectorLayer | undefined;
  if (!layer || layer.type !== 'vector') return;

  // TypeScript-safe property assignment
  switch (property) {
    case 'fillColor':
      layer.style.fillColor = value as string;
      break;
    case 'fillOpacity':
      layer.style.fillOpacity = value as number;
      break;
    case 'strokeColor':
      layer.style.strokeColor = value as string;
      break;
    case 'strokeWidth':
      layer.style.strokeWidth = value as number;
      break;
    case 'pointRadius':
      layer.style.pointRadius = value as number;
      break;
  }

  // Apply style changes to map
  try {
    if (property === 'fillColor') {
      manager.mapManager.map.setPaintProperty(`vector-fill-${id}`, 'fill-color', value);
      manager.mapManager.map.setPaintProperty(`vector-circle-${id}`, 'circle-color', value);
    } else if (property === 'fillOpacity') {
      manager.mapManager.map.setPaintProperty(
        `vector-fill-${id}`,
        'fill-opacity',
        (value as number) * layer.opacity
      );
    } else if (property === 'strokeColor') {
      manager.mapManager.map.setPaintProperty(`vector-line-${id}`, 'line-color', value);
      manager.mapManager.map.setPaintProperty(`vector-circle-${id}`, 'circle-stroke-color', value);
    } else if (property === 'strokeWidth') {
      manager.mapManager.map.setPaintProperty(`vector-line-${id}`, 'line-width', value);
    } else if (property === 'pointRadius') {
      manager.mapManager.map.setPaintProperty(`vector-circle-${id}`, 'circle-radius', value);
    }
  } catch (_e) {
    // Layer might not exist for this geometry type
  }
}

/**
 * Set color by field for a vector layer
 * @param manager - The LayerManager instance
 * @param id - Layer ID
 * @param fieldName - Field name to color by
 */
export function setColorByField(
  manager: LayerManagerInterface,
  id: string,
  fieldName: string | null
): void {
  const layer = manager.layers.get(id) as VectorLayer | undefined;
  if (!layer || layer.type !== 'vector') return;

  layer.style.colorByField = fieldName;

  if (!fieldName) {
    // Reset to solid color
    const { fillColor } = layer.style;
    try {
      manager.mapManager.map.setPaintProperty(`vector-fill-${id}`, 'fill-color', fillColor);
      manager.mapManager.map.setPaintProperty(`vector-circle-${id}`, 'circle-color', fillColor);
    } catch (_e) {
      /* Layer might not exist */
    }
    return;
  }

  // Get unique values for the field
  const features = layer.geojson?.features || [];
  const values = [
    ...new Set(
      features.map(f => f.properties?.[fieldName]).filter(v => v !== null && v !== undefined)
    ),
  ] as (string | number)[];

  if (values.length === 0) return;

  // Check if numeric or categorical
  const isNumeric = values.every(v => typeof v === 'number');

  let colorExpression: unknown[];

  if (isNumeric && values.length > 2) {
    // Graduated color scheme for numeric values
    const sortedValues = (values as number[]).sort((a, b) => a - b);
    const min = sortedValues[0];
    const max = sortedValues[sortedValues.length - 1];

    // Use interpolate for smooth color ramp (blue -> white -> red)
    colorExpression = [
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
  } else {
    // Categorical color scheme
    const matchExpr: unknown[] = ['match', ['get', fieldName]];
    values.forEach((val, idx) => {
      matchExpr.push(val);
      matchExpr.push(CATEGORICAL_COLORS[idx % CATEGORICAL_COLORS.length]);
    });
    matchExpr.push('#888888'); // Default color

    colorExpression = matchExpr;
  }

  // Apply to layers
  try {
    manager.mapManager.map.setPaintProperty(`vector-fill-${id}`, 'fill-color', colorExpression);
  } catch (_e) {
    /* Layer might not exist */
  }
  try {
    manager.mapManager.map.setPaintProperty(`vector-circle-${id}`, 'circle-color', colorExpression);
  } catch (_e) {
    /* Layer might not exist */
  }
}

/**
 * Show feature popup on click
 * @param manager - The LayerManager instance
 * @param feature - GeoJSON feature
 * @param lngLat - Click location
 */
export function showFeaturePopup(
  manager: LayerManagerInterface,
  feature: MapFeature,
  lngLat: LngLat
): void {
  // Remove existing popup
  if (manager.popup) {
    manager.popup.remove();
  }

  const properties = feature.properties || {};
  const layerId = feature.layer.id.replace(/^vector-(fill|line|circle)-/, '');
  const layer = manager.layers.get(layerId);
  const layerName = layer ? layer.path.split('/').pop()?.split('\\').pop() : 'Feature';

  // Build popup HTML
  let html = `<div class="feature-popup">`;
  html += `<div class="feature-popup-header">${layerName}</div>`;
  html += `<div class="feature-popup-content">`;

  const keys = Object.keys(properties);
  if (keys.length === 0) {
    html += `<div class="feature-popup-empty">No attributes</div>`;
  } else {
    for (const key of keys) {
      const value = properties[key];
      const displayValue =
        value === null || value === undefined
          ? '<em>null</em>'
          : typeof value === 'object'
            ? JSON.stringify(value)
            : String(value);
      html += `<div class="feature-popup-row">`;
      html += `<span class="feature-popup-key">${key}</span>`;
      html += `<span class="feature-popup-value">${displayValue}</span>`;
      html += `</div>`;
    }
  }

  html += `</div></div>`;

  manager.popup = new maplibregl.Popup({
    closeButton: true,
    closeOnClick: false,
    maxWidth: '320px',
  })
    .setLngLat(lngLat)
    .setHTML(html)
    .addTo(manager.mapManager.map);
}

/**
 * Show attribute table for a vector layer
 * @param manager - The LayerManager instance
 * @param layerId - Layer ID
 */
export function showAttributeTable(manager: LayerManagerInterface, layerId: string): void {
  const layer = manager.layers.get(layerId) as VectorLayer | undefined;
  if (!layer || layer.type !== 'vector') return;

  const panel = document.getElementById('attribute-panel');
  const title = document.getElementById('attribute-panel-title');
  const thead = document.querySelector('#attribute-table thead');
  const tbody = document.querySelector('#attribute-table tbody');
  const closeBtn = document.getElementById('attribute-panel-close');

  if (!panel || !thead || !tbody) return;

  // Set title
  const layerName = layer.path.split('/').pop()?.split('\\').pop() || 'Unknown';
  if (title) title.textContent = `${layerName} (${layer.feature_count} features)`;

  // Get field names from layer metadata
  const fields = layer.fields || [];
  const fieldNames = fields.map(f => f.name);

  // Build header row
  thead.innerHTML = `<tr>${fieldNames.map(name => `<th>${name}</th>`).join('')}</tr>`;

  // Build body rows from geojson features
  const features = layer.geojson?.features || [];
  tbody.innerHTML = features
    .map((feature, idx) => {
      const props = feature.properties || {};
      return `<tr data-feature-idx="${idx}">${fieldNames
        .map(name => {
          const value = props[name];
          const displayValue =
            value === null || value === undefined
              ? ''
              : typeof value === 'object'
                ? JSON.stringify(value)
                : String(value);
          return `<td title="${displayValue}">${displayValue}</td>`;
        })
        .join('')}</tr>`;
    })
    .join('');

  // Add click handler for row selection and zoom
  tbody.querySelectorAll('tr').forEach((row, idx) => {
    row.addEventListener('click', () => {
      // Highlight row
      tbody.querySelectorAll('tr').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');

      // Zoom to feature
      const feature = features[idx];
      if (feature?.geometry) {
        const bounds = getFeatureBounds(feature.geometry);
        if (bounds) {
          manager.mapManager.fitBounds(bounds, { padding: 100, maxZoom: 18 });
        }
      }
    });
  });

  // Setup close button
  if (closeBtn) {
    closeBtn.onclick = () => {
      panel.classList.remove('visible');
    };
  }

  // Show panel
  panel.classList.add('visible');
}

/** Coordinate type for bounds calculation */
type Coordinate = number[];

/**
 * Get bounds of a GeoJSON geometry
 * @param geometry - GeoJSON geometry
 * @returns Bounds as [[minX, minY], [maxX, maxY]]
 */
export function getFeatureBounds(
  geometry: GeoJSON.Geometry | null
): [[number, number], [number, number]] | null {
  if (!geometry || !('coordinates' in geometry)) return null;

  const coords: Coordinate[] = [];
  const extractCoords = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === 'number') {
      coords.push(c as Coordinate);
    } else if (Array.isArray(c)) {
      c.forEach(extractCoords);
    }
  };
  extractCoords(geometry.coordinates);

  if (coords.length === 0) return null;

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const coord of coords) {
    const [x, y] = coord;
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
