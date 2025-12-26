/**
 * Annotation Tool - Add markers, lines, and polygons to the map
 */

import maplibregl, {
  type Map as MapLibreMap,
  type MapMouseEvent,
  type Marker,
  type Popup,
  type LngLat,
  type GeoJSONSource,
} from 'maplibre-gl';
import type { Feature, LineString, Polygon } from 'geojson';
import { showToast } from './notifications';

// Interface for MapManager (will be properly typed when MapManager is migrated)
interface MapManager {
  map: MapLibreMap;
}

type AnnotationMode = 'marker' | 'line' | 'polygon';
type Coordinate = [number, number];

interface MarkerAnnotation {
  id: string;
  type: 'marker';
  label: string;
  coordinates: Coordinate;
  marker: Marker;
}

interface LineAnnotation {
  id: string;
  type: 'line';
  label: string;
  coordinates: Coordinate[];
}

interface PolygonAnnotation {
  id: string;
  type: 'polygon';
  label: string;
  coordinates: Coordinate[];
}

type Annotation = MarkerAnnotation | LineAnnotation | PolygonAnnotation;

interface SerializedAnnotation {
  id: string;
  type: AnnotationMode;
  label: string;
  coordinates: Coordinate | Coordinate[];
}

export class AnnotationTool {
  private mapManager: MapManager;
  private map: MapLibreMap;
  private active: boolean;
  private mode: AnnotationMode | null;
  private annotations: Map<string, Annotation>;
  private currentPoints: Coordinate[];
  private tempMarkers: Marker[];
  private nextId: number;
  private currentPopup: Popup | null;

  constructor(mapManager: MapManager) {
    this.mapManager = mapManager;
    this.map = mapManager.map;
    this.active = false;
    this.mode = null;
    this.annotations = new Map();
    this.currentPoints = [];
    this.tempMarkers = [];
    this.nextId = 1;
    this.currentPopup = null;
    this.handleClick = this.handleClick.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handleDoubleClick = this.handleDoubleClick.bind(this);
  }

  activate(mode: AnnotationMode = 'marker'): void {
    if (this.active && this.mode === mode) return;

    if (this.active) {
      this.finishCurrentAnnotation();
    }

    this.active = true;
    this.mode = mode;
    this.currentPoints = [];
    this.clearTempMarkers();
    this.map.getCanvas().style.cursor = 'crosshair';
    this.map.on('click', this.handleClick);
    this.map.on('mousemove', this.handleMouseMove);
    this.map.on('dblclick', this.handleDoubleClick);

    const modeNames: Record<AnnotationMode, string> = {
      marker: 'Marker',
      line: 'Line',
      polygon: 'Polygon',
    };
    showToast(`${modeNames[mode]} mode: Click to place`, 'info', 2000);
  }

  deactivate(): void {
    if (!this.active) return;
    this.finishCurrentAnnotation();
    this.active = false;
    this.mode = null;
    this.map.getCanvas().style.cursor = '';
    this.map.off('click', this.handleClick);
    this.map.off('mousemove', this.handleMouseMove);
    this.map.off('dblclick', this.handleDoubleClick);
    this.clearTempMarkers();
    this.clearPreview();
  }

  setMode(mode: AnnotationMode): void {
    if (['marker', 'line', 'polygon'].includes(mode)) {
      this.activate(mode);
    }
  }

  isActive(): boolean {
    return this.active;
  }

  getMode(): AnnotationMode | null {
    return this.mode;
  }

  private handleClick(e: MapMouseEvent): void {
    const { lng, lat } = e.lngLat;

    if (this.mode === 'marker') {
      this.addMarkerAnnotation(lng, lat);
    } else if (this.mode === 'line' || this.mode === 'polygon') {
      this.currentPoints.push([lng, lat]);
      this.addTempMarker(lng, lat);
      this.updatePreview();

      if (this.mode === 'line' && this.currentPoints.length >= 2) {
        showToast('Double-click to finish line', 'info', 2000);
      } else if (this.mode === 'polygon' && this.currentPoints.length >= 3) {
        showToast('Double-click to finish polygon', 'info', 2000);
      }
    }
  }

  private handleMouseMove(e: MapMouseEvent): void {
    if (this.currentPoints.length > 0 && (this.mode === 'line' || this.mode === 'polygon')) {
      this.updatePreview(e.lngLat);
    }
  }

  private handleDoubleClick(e: MapMouseEvent): void {
    e.preventDefault();

    if (this.mode === 'line' && this.currentPoints.length >= 2) {
      this.addLineAnnotation();
    } else if (this.mode === 'polygon' && this.currentPoints.length >= 3) {
      this.addPolygonAnnotation();
    }
  }

  private addTempMarker(lng: number, lat: number): void {
    const el = document.createElement('div');
    el.className = 'annotation-temp-marker';
    el.textContent = String(this.currentPoints.length);

    const marker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(this.map);
    this.tempMarkers.push(marker);
  }

  private clearTempMarkers(): void {
    this.tempMarkers.forEach(m => m.remove());
    this.tempMarkers = [];
  }

  private updatePreview(currentLngLat: LngLat | null = null): void {
    const coords: Coordinate[] = [...this.currentPoints];
    if (currentLngLat) {
      coords.push([currentLngLat.lng, currentLngLat.lat]);
    }

    if (coords.length < 2) {
      this.clearPreview();
      return;
    }

    const geojson: Feature<LineString | Polygon> = {
      type: 'Feature',
      properties: {},
      geometry:
        this.mode === 'polygon'
          ? {
              type: 'Polygon',
              coordinates: [[...coords, coords[0]]],
            }
          : {
              type: 'LineString',
              coordinates: coords,
            },
    };

    const source = this.map.getSource('annotation-preview') as GeoJSONSource | undefined;
    if (source) {
      source.setData(geojson);
    } else {
      this.map.addSource('annotation-preview', { type: 'geojson', data: geojson });

      if (this.mode === 'polygon') {
        this.map.addLayer({
          id: 'annotation-preview-fill',
          type: 'fill',
          source: 'annotation-preview',
          paint: {
            'fill-color': '#3498db',
            'fill-opacity': 0.2,
          },
        });
      }

      this.map.addLayer({
        id: 'annotation-preview-line',
        type: 'line',
        source: 'annotation-preview',
        paint: {
          'line-color': '#3498db',
          'line-width': 2,
          'line-dasharray': [2, 2],
        },
      });
    }
  }

  private clearPreview(): void {
    if (this.map.getLayer('annotation-preview-fill')) {
      this.map.removeLayer('annotation-preview-fill');
    }
    if (this.map.getLayer('annotation-preview-line')) {
      this.map.removeLayer('annotation-preview-line');
    }
    if (this.map.getSource('annotation-preview')) {
      this.map.removeSource('annotation-preview');
    }
  }

  addMarkerAnnotation(lng: number, lat: number, label: string | null = null): string {
    const id = `annotation-marker-${this.nextId++}`;
    const displayLabel = label || `Marker ${this.annotations.size + 1}`;

    const el = document.createElement('div');
    el.className = 'annotation-marker';
    el.innerHTML = `<div class="annotation-marker-pin"></div><span class="annotation-marker-label">${displayLabel}</span>`;

    // Make marker editable on click
    el.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      this.showAnnotationPopup(id, [lng, lat]);
    });

    const marker = new maplibregl.Marker({ element: el, draggable: true })
      .setLngLat([lng, lat])
      .addTo(this.map);

    marker.on('dragend', () => {
      const lngLat = marker.getLngLat();
      const ann = this.annotations.get(id) as MarkerAnnotation | undefined;
      if (ann) {
        ann.coordinates = [lngLat.lng, lngLat.lat];
      }
    });

    this.annotations.set(id, {
      id,
      type: 'marker',
      label: displayLabel,
      coordinates: [lng, lat],
      marker,
    });

    showToast(`Added ${displayLabel}`, 'success', 1500);
    return id;
  }

  private addLineAnnotation(label: string | null = null): string | null {
    if (this.currentPoints.length < 2) return null;

    const id = `annotation-line-${this.nextId++}`;
    const displayLabel = label || `Line ${this.getCountByType('line') + 1}`;
    const coords = [...this.currentPoints];

    const geojson: Feature<LineString> = {
      type: 'Feature',
      properties: { id, label: displayLabel },
      geometry: { type: 'LineString', coordinates: coords },
    };

    this.map.addSource(id, {
      type: 'geojson',
      data: geojson,
    });

    this.map.addLayer({
      id: `${id}-layer`,
      type: 'line',
      source: id,
      paint: {
        'line-color': '#e74c3c',
        'line-width': 3,
      },
    });

    // Add click handler for the line
    this.map.on('click', `${id}-layer`, (e: MapMouseEvent) => {
      e.preventDefault();
      this.showAnnotationPopup(id, e.lngLat);
    });

    this.annotations.set(id, {
      id,
      type: 'line',
      label: displayLabel,
      coordinates: coords,
    });

    this.clearTempMarkers();
    this.clearPreview();
    this.currentPoints = [];

    showToast(`Added ${displayLabel}`, 'success', 1500);
    return id;
  }

  private addPolygonAnnotation(label: string | null = null): string | null {
    if (this.currentPoints.length < 3) return null;

    const id = `annotation-polygon-${this.nextId++}`;
    const displayLabel = label || `Polygon ${this.getCountByType('polygon') + 1}`;
    const coords: Coordinate[] = [...this.currentPoints, this.currentPoints[0]]; // Close the polygon

    const geojson: Feature<Polygon> = {
      type: 'Feature',
      properties: { id, label: displayLabel },
      geometry: { type: 'Polygon', coordinates: [coords] },
    };

    this.map.addSource(id, {
      type: 'geojson',
      data: geojson,
    });

    this.map.addLayer({
      id: `${id}-fill`,
      type: 'fill',
      source: id,
      paint: {
        'fill-color': '#9b59b6',
        'fill-opacity': 0.3,
      },
    });

    this.map.addLayer({
      id: `${id}-line`,
      type: 'line',
      source: id,
      paint: {
        'line-color': '#9b59b6',
        'line-width': 2,
      },
    });

    // Add click handler for the polygon
    this.map.on('click', `${id}-fill`, (e: MapMouseEvent) => {
      e.preventDefault();
      this.showAnnotationPopup(id, e.lngLat);
    });

    this.annotations.set(id, {
      id,
      type: 'polygon',
      label: displayLabel,
      coordinates: this.currentPoints.map(c => [...c] as Coordinate), // Copy without closing point
    });

    this.clearTempMarkers();
    this.clearPreview();
    this.currentPoints = [];

    showToast(`Added ${displayLabel}`, 'success', 1500);
    return id;
  }

  private getCountByType(type: AnnotationMode): number {
    let count = 0;
    for (const ann of this.annotations.values()) {
      if (ann.type === type) count++;
    }
    return count;
  }

  private showAnnotationPopup(id: string, lngLat: Coordinate | LngLat): void {
    const ann = this.annotations.get(id);
    if (!ann) return;

    // Remove existing popup
    if (this.currentPopup) {
      this.currentPopup.remove();
    }

    const content = document.createElement('div');
    content.className = 'annotation-popup';
    content.innerHTML = `
      <input type="text" class="annotation-label-input" value="${ann.label}" />
      <div class="annotation-popup-buttons">
        <button class="annotation-save-btn">Save</button>
        <button class="annotation-delete-btn">Delete</button>
      </div>
    `;

    const popupLngLat: [number, number] = Array.isArray(lngLat)
      ? lngLat
      : [lngLat.lng, lngLat.lat];

    const popup = new maplibregl.Popup({ closeOnClick: true })
      .setLngLat(popupLngLat)
      .setDOMContent(content)
      .addTo(this.map);

    this.currentPopup = popup;

    const input = content.querySelector('.annotation-label-input') as HTMLInputElement;
    input.focus();
    input.select();

    const saveBtn = content.querySelector('.annotation-save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        this.updateAnnotationLabel(id, input.value);
        popup.remove();
      });
    }

    const deleteBtn = content.querySelector('.annotation-delete-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => {
        this.deleteAnnotation(id);
        popup.remove();
      });
    }

    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        this.updateAnnotationLabel(id, input.value);
        popup.remove();
      } else if (e.key === 'Escape') {
        popup.remove();
      }
    });
  }

  private updateAnnotationLabel(id: string, newLabel: string): void {
    const ann = this.annotations.get(id);
    if (!ann) return;

    ann.label = newLabel;

    if (ann.type === 'marker') {
      const markerAnn = ann as MarkerAnnotation;
      const el = markerAnn.marker.getElement();
      const labelEl = el.querySelector('.annotation-marker-label');
      if (labelEl) {
        labelEl.textContent = newLabel;
      }
    }

    showToast('Annotation updated', 'success', 1500);
  }

  deleteAnnotation(id: string): void {
    const ann = this.annotations.get(id);
    if (!ann) return;

    if (ann.type === 'marker') {
      const markerAnn = ann as MarkerAnnotation;
      markerAnn.marker.remove();
    } else if (ann.type === 'line') {
      if (this.map.getLayer(`${id}-layer`)) {
        this.map.removeLayer(`${id}-layer`);
      }
      if (this.map.getSource(id)) {
        this.map.removeSource(id);
      }
    } else if (ann.type === 'polygon') {
      if (this.map.getLayer(`${id}-fill`)) {
        this.map.removeLayer(`${id}-fill`);
      }
      if (this.map.getLayer(`${id}-line`)) {
        this.map.removeLayer(`${id}-line`);
      }
      if (this.map.getSource(id)) {
        this.map.removeSource(id);
      }
    }

    this.annotations.delete(id);
    showToast('Annotation deleted', 'info', 1500);
  }

  private finishCurrentAnnotation(): void {
    if (this.mode === 'line' && this.currentPoints.length >= 2) {
      this.addLineAnnotation();
    } else if (this.mode === 'polygon' && this.currentPoints.length >= 3) {
      this.addPolygonAnnotation();
    }
    this.currentPoints = [];
    this.clearTempMarkers();
    this.clearPreview();
  }

  getAnnotations(): SerializedAnnotation[] {
    return Array.from(this.annotations.values()).map(ann => ({
      id: ann.id,
      type: ann.type,
      label: ann.label,
      coordinates: ann.type === 'marker' ? ann.coordinates : (ann as LineAnnotation | PolygonAnnotation).coordinates,
    }));
  }

  loadAnnotations(data: SerializedAnnotation[]): void {
    // Clear existing
    this.clearAll();

    for (const ann of data) {
      if (ann.type === 'marker') {
        const coords = ann.coordinates as Coordinate;
        this.addMarkerAnnotation(coords[0], coords[1], ann.label);
      } else if (ann.type === 'line') {
        this.currentPoints = ann.coordinates as Coordinate[];
        this.addLineAnnotation(ann.label);
      } else if (ann.type === 'polygon') {
        this.currentPoints = ann.coordinates as Coordinate[];
        this.addPolygonAnnotation(ann.label);
      }
    }
  }

  clearAll(): void {
    for (const id of this.annotations.keys()) {
      this.deleteAnnotation(id);
    }
    this.annotations.clear();
    this.currentPoints = [];
    this.clearTempMarkers();
    this.clearPreview();
  }

  getCount(): number {
    return this.annotations.size;
  }
}
