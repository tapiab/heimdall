/**
 * Profile Tool - Draw a line and show elevation profile along it
 *
 * This tool allows users to draw a polyline on the map and generate
 * an elevation profile chart showing height values along the path.
 * Supports both georeferenced DEMs and non-georeferenced raster images.
 *
 * @module profile-tool
 */

import { invoke } from '@tauri-apps/api/core';
import maplibregl, {
  type Map as MapLibreMap,
  type MapMouseEvent,
  type Marker,
  type LngLat,
  type GeoJSONSource,
} from 'maplibre-gl';
import type { Feature, LineString } from 'geojson';
import { showToast, showError, showLoading, hideLoading } from './notifications';

/**
 * Pixel extent information for non-georeferenced images
 */
interface PixelExtent {
  /** Scale factor from pixels to map units */
  scale?: number;
  /** X offset for coordinate transformation */
  offsetX?: number;
  /** Y offset for coordinate transformation */
  offsetY?: number;
}

/**
 * MapManager interface for map operations
 */
interface MapManager {
  /** The underlying MapLibre GL map instance */
  map: MapLibreMap;
  /** Check if currently in pixel coordinate mode */
  isPixelCoordMode: () => boolean;
  /** Current pixel extent configuration */
  pixelExtent: PixelExtent | null;
  /** Check if 3D terrain is enabled */
  isTerrainEnabled: () => boolean;
}

/**
 * Raster layer data structure
 */
interface RasterLayer {
  /** Unique layer identifier */
  id: string;
  /** Layer type discriminator */
  type: 'raster';
  /** Whether layer is currently visible */
  visible: boolean;
}

/**
 * LayerManager interface for layer operations
 */
interface LayerManager {
  /** Ordered list of layer IDs (bottom to top) */
  layerOrder: string[];
  /** Map of layer ID to layer data */
  layers: Map<string, RasterLayer>;
}

/** Geographic coordinate as [longitude, latitude] */
type Coordinate = [number, number];

/**
 * Single point in an elevation profile
 */
interface ProfilePoint {
  /** Distance from start of profile in meters */
  distance: number;
  /** Elevation value at this point */
  elevation: number;
  /** Whether this is a valid elevation value */
  is_valid: boolean;
}

/**
 * Complete elevation profile result from backend
 */
interface ElevationProfileResult {
  /** Array of sampled elevation points */
  points: ProfilePoint[];
  /** Total distance of the profile in meters */
  total_distance: number;
  /** Minimum elevation along the profile */
  min_elevation: number;
  /** Maximum elevation along the profile */
  max_elevation: number;
  /** Total elevation gain (sum of uphill segments) */
  elevation_gain: number;
  /** Total elevation loss (sum of downhill segments) */
  elevation_loss: number;
}

/**
 * Options for ProfileTool
 */
interface ProfileToolOptions {
  /** If true, use MapLibre terrain elevation instead of raster values */
  useTerrainElevation?: boolean;
}

/**
 * ProfileTool allows users to draw a line on the map and view an elevation profile.
 *
 * Features:
 * - Click to add points along the profile path
 * - Live preview line while drawing
 * - Press Enter to generate the elevation profile
 * - Interactive chart showing elevation, distance, gain/loss
 * - Hover on chart to see values at specific points
 *
 * @example
 * ```typescript
 * const profileTool = new ProfileTool(mapManager, layerManager);
 * profileTool.activate();
 * // User clicks points on map, then presses Enter
 * // Profile panel appears with elevation chart
 * profileTool.deactivate();
 * ```
 */
export class ProfileTool {
  private mapManager: MapManager;
  private layerManager: LayerManager;
  private map: MapLibreMap;
  private active: boolean;
  private points: Coordinate[];
  private markers: Marker[];
  private useTerrainElevation: boolean;

  /**
   * Create a new ProfileTool instance
   * @param mapManager - The MapManager instance for map access
   * @param layerManager - The LayerManager instance to find elevation data layers
   * @param options - Optional configuration
   */
  constructor(mapManager: MapManager, layerManager: LayerManager, options?: ProfileToolOptions) {
    this.mapManager = mapManager;
    this.layerManager = layerManager;
    this.map = mapManager.map;
    this.active = false;
    this.points = [];
    this.markers = [];
    this.useTerrainElevation = options?.useTerrainElevation ?? false;
    this.handleClick = this.handleClick.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
  }

  /**
   * Activate the profile tool
   * Sets up click/move/keyboard handlers and changes cursor to crosshair
   */
  activate(): void {
    if (this.active) return;

    // For elevation profile mode, enable terrain if not already enabled
    if (this.useTerrainElevation && !this.mapManager.isTerrainEnabled()) {
      const result = (
        this.mapManager as unknown as { enableTerrain: () => { success: boolean } }
      ).enableTerrain();
      if (!result.success) {
        showToast('Could not enable 3D terrain for elevation profile', 'error');
        return;
      }
      // Update terrain toggle UI
      const terrainToggle = document.getElementById('terrain-toggle') as HTMLInputElement | null;
      if (terrainToggle) terrainToggle.checked = true;
      const terrainExaggeration = document.getElementById('terrain-exaggeration');
      if (terrainExaggeration) terrainExaggeration.classList.remove('hidden');
      showToast('3D terrain enabled for elevation profile', 'success');
    }

    this.active = true;
    this.points = [];
    this.clearMarkers();
    this.map.getCanvas().style.cursor = 'crosshair';
    this.map.on('click', this.handleClick);
    this.map.on('mousemove', this.handleMouseMove);
    document.addEventListener('keydown', this.handleKeyDown);

    const instruction = this.useTerrainElevation
      ? 'Click to set elevation profile start point'
      : 'Click to set value profile start point';
    this.showInstruction(instruction);
  }

  /**
   * Deactivate the profile tool
   * Removes all handlers, clears drawn markers and lines
   */
  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.map.getCanvas().style.cursor = '';
    this.map.off('click', this.handleClick);
    this.map.off('mousemove', this.handleMouseMove);
    document.removeEventListener('keydown', this.handleKeyDown);
    this.hideInstruction();
    this.clearMarkers();
    this.clearLine();
  }

  /**
   * Toggle the profile tool on/off
   * @returns True if tool is now active, false if deactivated
   */
  toggle(): boolean {
    if (this.active) {
      this.deactivate();
    } else {
      this.activate();
    }
    return this.active;
  }

  /**
   * Check if the profile tool is currently active
   * @returns True if tool is active
   */
  isActive(): boolean {
    return this.active;
  }

  private showInstruction(text: string): void {
    let instruction = document.getElementById('profile-instruction') as HTMLDivElement | null;
    if (!instruction) {
      instruction = document.createElement('div');
      instruction.id = 'profile-instruction';
      document.body.appendChild(instruction);
    }
    instruction.textContent = text;
    instruction.style.display = 'block';
  }

  private hideInstruction(): void {
    const instruction = document.getElementById('profile-instruction');
    if (instruction) {
      instruction.style.display = 'none';
    }
  }

  private handleClick(e: MapMouseEvent): void {
    const { lng, lat } = e.lngLat;
    this.points.push([lng, lat]);

    // Add marker
    const markerEl = document.createElement('div');
    markerEl.className = 'profile-marker';
    markerEl.textContent = String(this.points.length);

    const marker = new maplibregl.Marker({ element: markerEl })
      .setLngLat([lng, lat])
      .addTo(this.map);
    this.markers.push(marker);

    if (this.points.length === 1) {
      this.showInstruction(
        'Click to set profile end point (or keep clicking for multi-point profile)'
      );
    } else {
      this.drawLine();
      this.showInstruction('Click to add more points, or press Enter to generate profile');
    }
  }

  private handleMouseMove(e: MapMouseEvent): void {
    if (this.points.length > 0) {
      this.drawPreviewLine(e.lngLat);
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && this.points.length >= 2) {
      e.preventDefault();
      this.generateProfile();
    }
  }

  private drawLine(): void {
    const geojson: Feature<LineString> = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: this.points,
      },
    };

    const source = this.map.getSource('profile-line') as GeoJSONSource | undefined;
    if (source) {
      source.setData(geojson);
    } else {
      this.map.addSource('profile-line', { type: 'geojson', data: geojson });
      this.map.addLayer({
        id: 'profile-line-layer',
        type: 'line',
        source: 'profile-line',
        paint: {
          'line-color': '#27ae60',
          'line-width': 3,
          'line-dasharray': [2, 1],
        },
      });
    }
  }

  private drawPreviewLine(currentLngLat: LngLat): void {
    if (this.points.length === 0) return;

    const coords: Coordinate[] = [...this.points, [currentLngLat.lng, currentLngLat.lat]];
    const geojson: Feature<LineString> = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: coords,
      },
    };

    const source = this.map.getSource('profile-preview') as GeoJSONSource | undefined;
    if (source) {
      source.setData(geojson);
    } else {
      this.map.addSource('profile-preview', { type: 'geojson', data: geojson });
      this.map.addLayer({
        id: 'profile-preview-layer',
        type: 'line',
        source: 'profile-preview',
        paint: {
          'line-color': '#27ae60',
          'line-width': 2,
          'line-opacity': 0.5,
          'line-dasharray': [2, 2],
        },
      });
    }
  }

  private clearLine(): void {
    if (this.map.getLayer('profile-line-layer')) {
      this.map.removeLayer('profile-line-layer');
    }
    if (this.map.getSource('profile-line')) {
      this.map.removeSource('profile-line');
    }
    if (this.map.getLayer('profile-preview-layer')) {
      this.map.removeLayer('profile-preview-layer');
    }
    if (this.map.getSource('profile-preview')) {
      this.map.removeSource('profile-preview');
    }
  }

  private clearMarkers(): void {
    this.markers.forEach(m => m.remove());
    this.markers = [];
    this.points = [];
  }

  private async generateProfile(): Promise<void> {
    if (this.points.length < 2) {
      showToast('Need at least 2 points for profile', 'error');
      return;
    }

    // Use terrain elevation if configured for this tool instance
    if (this.useTerrainElevation) {
      if (!this.mapManager.isTerrainEnabled()) {
        showToast('3D terrain not available for elevation profile', 'error');
        return;
      }
      this.generateTerrainProfile();
      return;
    }

    // Find a suitable raster layer for value profile
    const rasterLayer = this.findElevationLayer();
    if (!rasterLayer) {
      showToast('No raster layer found for value profile', 'error');
      return;
    }

    showLoading('Generating value profile...');

    try {
      let result: ElevationProfileResult;

      if (this.mapManager.isPixelCoordMode() && this.mapManager.pixelExtent) {
        // Convert pseudo-geographic coordinates to pixel coordinates
        const extent = this.mapManager.pixelExtent;
        const scale = extent.scale || 0.01;
        const offsetX = extent.offsetX || 0;
        const offsetY = extent.offsetY || 0;

        const pixelCoords = this.points.map(([lng, lat]) => [
          Math.floor((lng + offsetX) / scale),
          Math.floor((offsetY - lat) / scale),
        ]);

        result = await invoke<ElevationProfileResult>('get_elevation_profile_pixels', {
          id: rasterLayer.id,
          pixel_coords: pixelCoords,
          num_samples: 200,
        });
      } else {
        result = await invoke<ElevationProfileResult>('get_elevation_profile', {
          id: rasterLayer.id,
          coords: this.points,
          num_samples: 200,
        });
      }

      this.showProfilePanel(result);
    } catch (error) {
      console.error('Profile generation failed:', error);
      showError('Profile failed', error instanceof Error ? error : String(error));
    } finally {
      hideLoading();
    }
  }

  /**
   * Generate elevation profile using MapLibre terrain data.
   */
  private generateTerrainProfile(): void {
    const { map } = this.mapManager;
    const numSamples = 200;

    // Calculate total distance and sample points along the line
    const samplePoints: { lngLat: { lng: number; lat: number }; distance: number }[] = [];
    let totalDistance = 0;

    // Calculate distances between consecutive points
    const segmentDistances: number[] = [];
    for (let i = 1; i < this.points.length; i++) {
      const [lng1, lat1] = this.points[i - 1];
      const [lng2, lat2] = this.points[i];
      const dist = this.haversineDistance(lat1, lng1, lat2, lng2);
      segmentDistances.push(dist);
      totalDistance += dist;
    }

    // Sample points evenly along the entire path
    const sampleInterval = totalDistance / (numSamples - 1);
    let currentDistance = 0;
    let segmentIndex = 0;
    let segmentProgress = 0;

    for (let i = 0; i < numSamples; i++) {
      const targetDistance = i * sampleInterval;

      // Find which segment this sample falls on
      while (
        segmentIndex < segmentDistances.length - 1 &&
        currentDistance + segmentDistances[segmentIndex] < targetDistance
      ) {
        currentDistance += segmentDistances[segmentIndex];
        segmentIndex++;
      }

      // Interpolate within the segment
      const segmentDist = segmentDistances[segmentIndex] || 1;
      segmentProgress = (targetDistance - currentDistance) / segmentDist;
      segmentProgress = Math.max(0, Math.min(1, segmentProgress));

      const [lng1, lat1] = this.points[segmentIndex];
      const [lng2, lat2] = this.points[segmentIndex + 1] || this.points[segmentIndex];

      const lng = lng1 + (lng2 - lng1) * segmentProgress;
      const lat = lat1 + (lat2 - lat1) * segmentProgress;

      samplePoints.push({ lngLat: { lng, lat }, distance: targetDistance });
    }

    // Query terrain elevation for each sample point
    const profilePoints: ProfilePoint[] = [];
    let minElevation = Infinity;
    let maxElevation = -Infinity;
    let elevationGain = 0;
    let elevationLoss = 0;
    let lastElevation: number | null = null;

    for (const sample of samplePoints) {
      const elevation = map.queryTerrainElevation(sample.lngLat);
      const isValid = elevation !== null && elevation !== undefined;
      const elev = isValid ? elevation : 0;

      profilePoints.push({
        distance: sample.distance,
        elevation: elev,
        is_valid: isValid,
      });

      if (isValid) {
        minElevation = Math.min(minElevation, elev);
        maxElevation = Math.max(maxElevation, elev);

        if (lastElevation !== null) {
          const diff = elev - lastElevation;
          if (diff > 0) elevationGain += diff;
          else elevationLoss += Math.abs(diff);
        }
        lastElevation = elev;
      }
    }

    // Handle case where no valid elevations were found
    if (minElevation === Infinity) minElevation = 0;
    if (maxElevation === -Infinity) maxElevation = 0;

    const result: ElevationProfileResult = {
      points: profilePoints,
      total_distance: totalDistance,
      min_elevation: minElevation,
      max_elevation: maxElevation,
      elevation_gain: elevationGain,
      elevation_loss: elevationLoss,
    };

    this.showProfilePanel(result);
  }

  /**
   * Calculate distance between two points using Haversine formula.
   */
  private haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371000; // Earth's radius in meters
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private findElevationLayer(): RasterLayer | null {
    // Find the topmost visible raster layer (including non-georeferenced)
    const layerOrder = [...this.layerManager.layerOrder].reverse();
    for (const id of layerOrder) {
      const layer = this.layerManager.layers.get(id);
      if (layer && layer.type === 'raster' && layer.visible) {
        return layer;
      }
    }
    return null;
  }

  private showProfilePanel(result: ElevationProfileResult): void {
    // Remove existing panel
    const existing = document.getElementById('profile-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'profile-panel';
    panel.innerHTML = `
      <div id="profile-panel-header">
        <h4>Elevation Profile</h4>
        <div class="profile-stats">
          <span>Distance: ${this.formatDistance(result.total_distance)}</span>
          <span>↑ ${result.elevation_gain.toFixed(1)}m</span>
          <span>↓ ${result.elevation_loss.toFixed(1)}m</span>
        </div>
        <button id="profile-panel-close">&times;</button>
      </div>
      <div id="profile-content">
        <canvas id="profile-canvas" width="600" height="200"></canvas>
        <div id="profile-hover-info"></div>
      </div>
      <div id="profile-range">
        <span>Min: ${result.min_elevation.toFixed(1)}m</span>
        <span>Max: ${result.max_elevation.toFixed(1)}m</span>
      </div>
    `;

    document.body.appendChild(panel);

    // Close button
    const closeBtn = document.getElementById('profile-panel-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        panel.remove();
        this.deactivate();
      });
    }

    // Draw the chart
    this.drawProfileChart(result);

    // Add hover interaction
    this.setupChartHover(result);
  }

  private drawProfileChart(result: ElevationProfileResult): void {
    const canvas = document.getElementById('profile-canvas') as HTMLCanvasElement | null;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width, height } = canvas;
    const padding = { top: 20, right: 20, bottom: 30, left: 50 };

    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    // Clear
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, width, height);

    // Filter valid points
    const validPoints = result.points.filter(p => p.is_valid);
    if (validPoints.length < 2) {
      ctx.fillStyle = '#666';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No valid elevation data', width / 2, height / 2);
      return;
    }

    // Calculate scales
    const xScale = chartWidth / result.total_distance;
    const elevRange = result.max_elevation - result.min_elevation;
    const yScale = elevRange > 0 ? chartHeight / (elevRange * 1.1) : 1;
    const yOffset = result.min_elevation - elevRange * 0.05;

    // Draw grid
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      const y = padding.top + (chartHeight * i) / 5;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
    }

    // Draw axes
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, height - padding.bottom);
    ctx.lineTo(width - padding.right, height - padding.bottom);
    ctx.stroke();

    // Draw profile line
    ctx.beginPath();
    ctx.strokeStyle = '#27ae60';
    ctx.lineWidth = 2;

    let first = true;
    for (const point of result.points) {
      if (!point.is_valid) continue;

      const x = padding.left + point.distance * xScale;
      const y = height - padding.bottom - (point.elevation - yOffset) * yScale;

      if (first) {
        ctx.moveTo(x, y);
        first = false;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // Fill under line
    ctx.lineTo(padding.left + result.total_distance * xScale, height - padding.bottom);
    ctx.lineTo(padding.left, height - padding.bottom);
    ctx.closePath();
    ctx.fillStyle = 'rgba(39, 174, 96, 0.2)';
    ctx.fill();

    // Draw labels
    ctx.fillStyle = '#888';
    ctx.font = '11px monospace';

    // Y axis labels
    ctx.textAlign = 'right';
    for (let i = 0; i <= 5; i++) {
      const elev = result.min_elevation + (elevRange * 1.1 * (5 - i)) / 5 - elevRange * 0.05;
      const y = padding.top + (chartHeight * i) / 5;
      ctx.fillText(`${elev.toFixed(0)}m`, padding.left - 5, y + 4);
    }

    // X axis labels
    ctx.textAlign = 'center';
    ctx.fillText('0', padding.left, height - 10);
    ctx.fillText(this.formatDistance(result.total_distance), width - padding.right, height - 10);
  }

  private setupChartHover(result: ElevationProfileResult): void {
    const canvas = document.getElementById('profile-canvas') as HTMLCanvasElement | null;
    const hoverInfo = document.getElementById('profile-hover-info') as HTMLDivElement | null;
    if (!canvas || !hoverInfo) return;

    const padding = { left: 50, right: 20, top: 20, bottom: 30 };
    const chartWidth = canvas.width - padding.left - padding.right;

    canvas.addEventListener('mousemove', (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const relX = x - padding.left;

      if (relX < 0 || relX > chartWidth) {
        hoverInfo.style.display = 'none';
        return;
      }

      const distance = (relX / chartWidth) * result.total_distance;

      // Find closest point
      let closest = result.points[0];
      let minDiff = Math.abs(closest.distance - distance);
      for (const point of result.points) {
        const diff = Math.abs(point.distance - distance);
        if (diff < minDiff) {
          minDiff = diff;
          closest = point;
        }
      }

      if (closest.is_valid) {
        hoverInfo.innerHTML = `
          <strong>${closest.elevation.toFixed(1)}m</strong> at ${this.formatDistance(closest.distance)}
        `;
        hoverInfo.style.display = 'block';
        hoverInfo.style.left = `${x}px`;
      } else {
        hoverInfo.style.display = 'none';
      }
    });

    canvas.addEventListener('mouseleave', () => {
      hoverInfo.style.display = 'none';
    });
  }

  private formatDistance(meters: number): string {
    if (meters < 1000) {
      return `${meters.toFixed(0)}m`;
    }
    return `${(meters / 1000).toFixed(2)}km`;
  }
}
