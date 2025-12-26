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

    // Determine what layer types to add based on geometry
    const geomType = metadata.geometry_type.toLowerCase();

    // For unknown/mixed geometry types, add all layer types
    if (geomType.includes('unknown') || geomType === '') {
      addAllVectorLayers(manager, metadata.id, sourceId, layerData.style);
    } else if (geomType.includes('polygon') || geomType.includes('multipolygon')) {
      addPolygonLayers(manager, metadata.id, sourceId, layerData.style);
    } else if (geomType.includes('line') || geomType.includes('multiline')) {
      addLineLayers(manager, metadata.id, sourceId, layerData.style);
    } else if (geomType.includes('point') || geomType.includes('multipoint')) {
      addPointLayers(manager, metadata.id, sourceId, layerData.style);
    } else {
      // Unknown geometry - add both fill and line as fallback
      addPolygonLayers(manager, metadata.id, sourceId, layerData.style);
      addPointLayers(manager, metadata.id, sourceId, layerData.style);
    }

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

/** Add all vector layer types (for mixed geometry) */
function addAllVectorLayers(
  manager: LayerManagerInterface,
  id: string,
  sourceId: string,
  style: VectorStyle
): void {
  // Add fill layer for polygons
  manager.mapManager.addLayer({
    id: `vector-fill-${id}`,
    type: 'fill',
    source: sourceId,
    filter: ['==', '$type', 'Polygon'],
    paint: {
      'fill-color': style.fillColor,
      'fill-opacity': style.fillOpacity,
    },
  });
  // Add line layer for lines and polygon outlines
  manager.mapManager.addLayer({
    id: `vector-line-${id}`,
    type: 'line',
    source: sourceId,
    filter: ['any', ['==', '$type', 'LineString'], ['==', '$type', 'Polygon']],
    paint: {
      'line-color': style.strokeColor,
      'line-width': style.strokeWidth,
    },
  });
  // Add circle layer for points
  manager.mapManager.addLayer({
    id: `vector-circle-${id}`,
    type: 'circle',
    source: sourceId,
    filter: ['==', '$type', 'Point'],
    paint: {
      'circle-color': style.fillColor,
      'circle-radius': style.pointRadius,
      'circle-stroke-color': style.strokeColor,
      'circle-stroke-width': 1,
    },
  });
}

/** Add polygon layers */
function addPolygonLayers(
  manager: LayerManagerInterface,
  id: string,
  sourceId: string,
  style: VectorStyle
): void {
  manager.mapManager.addLayer({
    id: `vector-fill-${id}`,
    type: 'fill',
    source: sourceId,
    paint: {
      'fill-color': style.fillColor,
      'fill-opacity': style.fillOpacity,
    },
  });
  manager.mapManager.addLayer({
    id: `vector-line-${id}`,
    type: 'line',
    source: sourceId,
    paint: {
      'line-color': style.strokeColor,
      'line-width': style.strokeWidth,
    },
  });
}

/** Add line layers */
function addLineLayers(
  manager: LayerManagerInterface,
  id: string,
  sourceId: string,
  style: VectorStyle
): void {
  manager.mapManager.addLayer({
    id: `vector-line-${id}`,
    type: 'line',
    source: sourceId,
    paint: {
      'line-color': style.strokeColor,
      'line-width': style.strokeWidth,
    },
  });
}

/** Add point layers */
function addPointLayers(
  manager: LayerManagerInterface,
  id: string,
  sourceId: string,
  style: VectorStyle
): void {
  manager.mapManager.addLayer({
    id: `vector-circle-${id}`,
    type: 'circle',
    source: sourceId,
    paint: {
      'circle-color': style.fillColor,
      'circle-radius': style.pointRadius,
      'circle-stroke-color': style.strokeColor,
      'circle-stroke-width': 1,
    },
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
      features
        .map(f => f.properties?.[fieldName])
        .filter(v => v !== null && v !== undefined)
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
export function showAttributeTable(
  manager: LayerManagerInterface,
  layerId: string
): void {
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
