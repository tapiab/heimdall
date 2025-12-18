/**
 * Annotation Tool - Add markers, lines, and polygons to the map
 */

import maplibregl from 'maplibre-gl';
import { showToast } from './notifications.js';

export class AnnotationTool {
  constructor(mapManager) {
    this.mapManager = mapManager;
    this.map = mapManager.map;
    this.active = false;
    this.mode = null; // 'marker', 'line', 'polygon'
    this.annotations = new Map();
    this.currentPoints = [];
    this.tempMarkers = [];
    this.nextId = 1;
    this.clickHandler = this.handleClick.bind(this);
    this.moveHandler = this.handleMouseMove.bind(this);
    this.dblClickHandler = this.handleDoubleClick.bind(this);
  }

  activate(mode = 'marker') {
    if (this.active && this.mode === mode) return;

    if (this.active) {
      this.finishCurrentAnnotation();
    }

    this.active = true;
    this.mode = mode;
    this.currentPoints = [];
    this.clearTempMarkers();
    this.map.getCanvas().style.cursor = 'crosshair';
    this.map.on('click', this.clickHandler);
    this.map.on('mousemove', this.moveHandler);
    this.map.on('dblclick', this.dblClickHandler);

    const modeNames = { marker: 'Marker', line: 'Line', polygon: 'Polygon' };
    showToast(`${modeNames[mode]} mode: Click to place`, 'info', 2000);
  }

  deactivate() {
    if (!this.active) return;
    this.finishCurrentAnnotation();
    this.active = false;
    this.mode = null;
    this.map.getCanvas().style.cursor = '';
    this.map.off('click', this.clickHandler);
    this.map.off('mousemove', this.moveHandler);
    this.map.off('dblclick', this.dblClickHandler);
    this.clearTempMarkers();
    this.clearPreview();
  }

  setMode(mode) {
    if (['marker', 'line', 'polygon'].includes(mode)) {
      this.activate(mode);
    }
  }

  isActive() {
    return this.active;
  }

  getMode() {
    return this.mode;
  }

  handleClick(e) {
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

  handleMouseMove(e) {
    if (this.currentPoints.length > 0 && (this.mode === 'line' || this.mode === 'polygon')) {
      this.updatePreview(e.lngLat);
    }
  }

  handleDoubleClick(e) {
    e.preventDefault();

    if (this.mode === 'line' && this.currentPoints.length >= 2) {
      this.addLineAnnotation();
    } else if (this.mode === 'polygon' && this.currentPoints.length >= 3) {
      this.addPolygonAnnotation();
    }
  }

  addTempMarker(lng, lat) {
    const el = document.createElement('div');
    el.className = 'annotation-temp-marker';
    el.textContent = this.currentPoints.length;

    const marker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(this.map);
    this.tempMarkers.push(marker);
  }

  clearTempMarkers() {
    this.tempMarkers.forEach(m => m.remove());
    this.tempMarkers = [];
  }

  updatePreview(currentLngLat = null) {
    const coords = [...this.currentPoints];
    if (currentLngLat) {
      coords.push([currentLngLat.lng, currentLngLat.lat]);
    }

    if (coords.length < 2) {
      this.clearPreview();
      return;
    }

    const geojson = {
      type: 'Feature',
      geometry: {
        type: this.mode === 'polygon' ? 'Polygon' : 'LineString',
        coordinates: this.mode === 'polygon' ? [[...coords, coords[0]]] : coords,
      },
    };

    if (this.map.getSource('annotation-preview')) {
      this.map.getSource('annotation-preview').setData(geojson);
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

  clearPreview() {
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

  addMarkerAnnotation(lng, lat, label = null) {
    const id = `annotation-marker-${this.nextId++}`;
    const displayLabel = label || `Marker ${this.annotations.size + 1}`;

    const el = document.createElement('div');
    el.className = 'annotation-marker';
    el.innerHTML = `<div class="annotation-marker-pin"></div><span class="annotation-marker-label">${displayLabel}</span>`;

    // Make marker editable on click
    el.addEventListener('click', e => {
      e.stopPropagation();
      this.showAnnotationPopup(id, [lng, lat]);
    });

    const marker = new maplibregl.Marker({ element: el, draggable: true })
      .setLngLat([lng, lat])
      .addTo(this.map);

    marker.on('dragend', () => {
      const lngLat = marker.getLngLat();
      const ann = this.annotations.get(id);
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

  addLineAnnotation(label = null) {
    if (this.currentPoints.length < 2) return null;

    const id = `annotation-line-${this.nextId++}`;
    const displayLabel = label || `Line ${this.getCountByType('line') + 1}`;
    const coords = [...this.currentPoints];

    this.map.addSource(id, {
      type: 'geojson',
      data: {
        type: 'Feature',
        properties: { id, label: displayLabel },
        geometry: { type: 'LineString', coordinates: coords },
      },
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
    this.map.on('click', `${id}-layer`, e => {
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

  addPolygonAnnotation(label = null) {
    if (this.currentPoints.length < 3) return null;

    const id = `annotation-polygon-${this.nextId++}`;
    const displayLabel = label || `Polygon ${this.getCountByType('polygon') + 1}`;
    const coords = [...this.currentPoints, this.currentPoints[0]]; // Close the polygon

    this.map.addSource(id, {
      type: 'geojson',
      data: {
        type: 'Feature',
        properties: { id, label: displayLabel },
        geometry: { type: 'Polygon', coordinates: [coords] },
      },
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
    this.map.on('click', `${id}-fill`, e => {
      e.preventDefault();
      this.showAnnotationPopup(id, e.lngLat);
    });

    this.annotations.set(id, {
      id,
      type: 'polygon',
      label: displayLabel,
      coordinates: this.currentPoints.map(c => [...c]), // Copy without closing point
    });

    this.clearTempMarkers();
    this.clearPreview();
    this.currentPoints = [];

    showToast(`Added ${displayLabel}`, 'success', 1500);
    return id;
  }

  getCountByType(type) {
    let count = 0;
    for (const ann of this.annotations.values()) {
      if (ann.type === type) count++;
    }
    return count;
  }

  showAnnotationPopup(id, lngLat) {
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

    const popup = new maplibregl.Popup({ closeOnClick: true })
      .setLngLat(lngLat)
      .setDOMContent(content)
      .addTo(this.map);

    this.currentPopup = popup;

    const input = content.querySelector('.annotation-label-input');
    input.focus();
    input.select();

    content.querySelector('.annotation-save-btn').addEventListener('click', () => {
      this.updateAnnotationLabel(id, input.value);
      popup.remove();
    });

    content.querySelector('.annotation-delete-btn').addEventListener('click', () => {
      this.deleteAnnotation(id);
      popup.remove();
    });

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        this.updateAnnotationLabel(id, input.value);
        popup.remove();
      } else if (e.key === 'Escape') {
        popup.remove();
      }
    });
  }

  updateAnnotationLabel(id, newLabel) {
    const ann = this.annotations.get(id);
    if (!ann) return;

    ann.label = newLabel;

    if (ann.type === 'marker' && ann.marker) {
      const el = ann.marker.getElement();
      const labelEl = el.querySelector('.annotation-marker-label');
      if (labelEl) {
        labelEl.textContent = newLabel;
      }
    }

    showToast('Annotation updated', 'success', 1500);
  }

  deleteAnnotation(id) {
    const ann = this.annotations.get(id);
    if (!ann) return;

    if (ann.type === 'marker' && ann.marker) {
      ann.marker.remove();
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

  finishCurrentAnnotation() {
    if (this.mode === 'line' && this.currentPoints.length >= 2) {
      this.addLineAnnotation();
    } else if (this.mode === 'polygon' && this.currentPoints.length >= 3) {
      this.addPolygonAnnotation();
    }
    this.currentPoints = [];
    this.clearTempMarkers();
    this.clearPreview();
  }

  getAnnotations() {
    return Array.from(this.annotations.values()).map(ann => ({
      id: ann.id,
      type: ann.type,
      label: ann.label,
      coordinates: ann.coordinates,
    }));
  }

  loadAnnotations(data) {
    // Clear existing
    this.clearAll();

    for (const ann of data) {
      if (ann.type === 'marker') {
        this.addMarkerAnnotation(ann.coordinates[0], ann.coordinates[1], ann.label);
      } else if (ann.type === 'line') {
        this.currentPoints = ann.coordinates;
        this.addLineAnnotation(ann.label);
      } else if (ann.type === 'polygon') {
        this.currentPoints = ann.coordinates;
        this.addPolygonAnnotation(ann.label);
      }
    }
  }

  clearAll() {
    for (const id of this.annotations.keys()) {
      this.deleteAnnotation(id);
    }
    this.annotations.clear();
    this.currentPoints = [];
    this.clearTempMarkers();
    this.clearPreview();
  }

  getCount() {
    return this.annotations.size;
  }
}
