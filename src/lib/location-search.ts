/**
 * Location Search - Geocoding search using Photon (Komoot)
 *
 * Photon API: https://photon.komoot.io/
 * Free, no API key needed, based on OpenStreetMap data
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { showToast } from './notifications';

const PHOTON_API = 'https://photon.komoot.io/api/';

export interface SearchResult {
  name: string;
  displayName: string;
  lng: number;
  lat: number;
  type: string;
  country?: string;
  city?: string;
  state?: string;
}

interface PhotonFeature {
  geometry: {
    type: string;
    coordinates: [number, number];
  };
  properties: {
    name?: string;
    country?: string;
    city?: string;
    state?: string;
    street?: string;
    housenumber?: string;
    postcode?: string;
    osm_key?: string;
    osm_value?: string;
    type?: string;
  };
}

interface PhotonResponse {
  type: string;
  features: PhotonFeature[];
}

export class LocationSearch {
  private map: MapLibreMap;
  private container: HTMLElement | null;
  private input: HTMLInputElement | null;
  private resultsList: HTMLElement | null;
  private results: SearchResult[];
  private selectedIndex: number;
  private debounceTimer: number | null;
  private visible: boolean;
  private onResultSelect: ((result: SearchResult) => void) | null;

  constructor(map: MapLibreMap) {
    this.map = map;
    this.container = null;
    this.input = null;
    this.resultsList = null;
    this.results = [];
    this.selectedIndex = -1;
    this.debounceTimer = null;
    this.visible = false;
    this.onResultSelect = null;
  }

  /** Initialize the search UI */
  init(containerId: string): void {
    this.container = document.getElementById(containerId);
    if (!this.container) {
      console.warn(`Location search container ${containerId} not found`);
      return;
    }

    // Create search input
    this.input = this.container.querySelector('.search-input') as HTMLInputElement;
    this.resultsList = this.container.querySelector('.search-results') as HTMLElement;

    if (!this.input || !this.resultsList) {
      console.warn('Search input or results list not found');
      return;
    }

    // Set up event listeners
    this.input.addEventListener('input', () => this.handleInput());
    this.input.addEventListener('keydown', e => this.handleKeydown(e));
    this.input.addEventListener('focus', () => this.showResults());
    this.input.addEventListener('blur', () => {
      // Delay hiding to allow click on results
      setTimeout(() => this.hideResults(), 200);
    });

    // Close button
    const closeBtn = this.container.querySelector('.search-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.clear());
    }
  }

  /** Handle input changes with debounce */
  private handleInput(): void {
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
    }

    const query = this.input?.value.trim() || '';

    if (query.length < 2) {
      this.clearResults();
      return;
    }

    // Check if input is coordinates
    const coords = this.parseCoordinates(query);
    if (coords) {
      this.showCoordinateResult(coords.lat, coords.lng);
      return;
    }

    // Debounce search
    this.debounceTimer = window.setTimeout(() => {
      this.search(query);
    }, 300);
  }

  /** Parse coordinate input in various formats */
  private parseCoordinates(input: string): { lat: number; lng: number } | null {
    // Normalize input: replace common separators
    const normalized = input
      .replace(/[;|/]/g, ',')  // Replace ; | / with comma
      .replace(/\s+/g, ' ')     // Normalize whitespace
      .trim();

    // Try various coordinate formats:
    // 1. "lat, lng" or "lat lng" (most common user input)
    // 2. "lng, lat" with explicit markers like "lon:" or negative western longitude
    // 3. DMS format: 37°46'30"N 122°25'10"W

    // Pattern for decimal degrees: optional minus, digits, optional decimal
    const decimalPattern = /-?\d+\.?\d*/g;
    const matches = normalized.match(decimalPattern);

    if (matches && matches.length >= 2) {
      const num1 = parseFloat(matches[0]);
      const num2 = parseFloat(matches[1]);

      // Validate ranges
      if (isNaN(num1) || isNaN(num2)) return null;

      // Determine which is lat and which is lng
      // Latitude: -90 to 90, Longitude: -180 to 180
      let lat: number, lng: number;

      // If first number could only be longitude (|val| > 90), swap
      if (Math.abs(num1) > 90 && Math.abs(num2) <= 90) {
        lng = num1;
        lat = num2;
      } else if (Math.abs(num2) > 90 && Math.abs(num1) <= 90) {
        // Second is longitude
        lat = num1;
        lng = num2;
      } else {
        // Both could be either - assume lat, lng order (Google Maps style)
        lat = num1;
        lng = num2;
      }

      // Final validation
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return null;
      }

      return { lat, lng };
    }

    return null;
  }

  /** Show a coordinate result for direct navigation */
  private showCoordinateResult(lat: number, lng: number): void {
    const result: SearchResult = {
      name: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
      displayName: `Coordinates: ${lat.toFixed(6)}°, ${lng.toFixed(6)}°`,
      lat,
      lng,
      type: 'coordinate',
    };

    this.results = [result];
    this.selectedIndex = 0;
    this.renderResults();
    this.showResults();
  }

  /** Handle keyboard navigation */
  private handleKeydown(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.selectNext();
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.selectPrevious();
        break;
      case 'Enter':
        e.preventDefault();
        if (this.selectedIndex >= 0 && this.results[this.selectedIndex]) {
          this.selectResult(this.results[this.selectedIndex]);
        } else if (this.results.length > 0) {
          this.selectResult(this.results[0]);
        }
        break;
      case 'Escape':
        this.clear();
        this.input?.blur();
        break;
    }
  }

  /** Search using Photon API */
  async search(query: string): Promise<void> {
    try {
      // Get map center for location bias
      const center = this.map.getCenter();

      const params = new URLSearchParams({
        q: query,
        limit: '7',
        lat: center.lat.toString(),
        lon: center.lng.toString(),
      });

      const response = await fetch(`${PHOTON_API}?${params}`);
      if (!response.ok) {
        throw new Error(`Search failed: ${response.statusText}`);
      }

      const data: PhotonResponse = await response.json();
      this.results = data.features.map(f => this.parseFeature(f));
      this.selectedIndex = -1;
      this.renderResults();
      this.showResults();
    } catch (error) {
      console.error('Search error:', error);
      this.results = [];
      this.renderResults();
    }
  }

  /** Parse Photon feature into SearchResult */
  private parseFeature(feature: PhotonFeature): SearchResult {
    const props = feature.properties;
    const [lng, lat] = feature.geometry.coordinates;

    // Build display name
    const parts: string[] = [];
    if (props.name) parts.push(props.name);
    if (props.street) {
      const streetPart = props.housenumber
        ? `${props.street} ${props.housenumber}`
        : props.street;
      if (streetPart !== props.name) parts.push(streetPart);
    }
    if (props.city && props.city !== props.name) parts.push(props.city);
    if (props.state && props.state !== props.city) parts.push(props.state);
    if (props.country) parts.push(props.country);

    const displayName = parts.join(', ') || 'Unknown location';

    return {
      name: props.name || displayName.split(',')[0],
      displayName,
      lng,
      lat,
      type: props.osm_value || props.type || 'place',
      country: props.country,
      city: props.city,
      state: props.state,
    };
  }

  /** Render search results */
  private renderResults(): void {
    if (!this.resultsList) return;

    if (this.results.length === 0) {
      this.resultsList.innerHTML =
        '<div class="search-no-results">No results found</div>';
      return;
    }

    this.resultsList.innerHTML = this.results
      .map(
        (result, index) => `
        <div class="search-result-item ${index === this.selectedIndex ? 'selected' : ''}"
             data-index="${index}">
          <span class="result-icon">${this.getTypeIcon(result.type)}</span>
          <div class="result-text">
            <div class="result-name">${this.escapeHtml(result.name)}</div>
            <div class="result-detail">${this.escapeHtml(result.displayName)}</div>
          </div>
        </div>
      `
      )
      .join('');

    // Add click handlers
    this.resultsList.querySelectorAll('.search-result-item').forEach(item => {
      item.addEventListener('click', () => {
        const index = parseInt((item as HTMLElement).dataset.index || '0', 10);
        if (this.results[index]) {
          this.selectResult(this.results[index]);
        }
      });
    });
  }

  /** Get icon for result type */
  private getTypeIcon(type: string): string {
    const icons: Record<string, string> = {
      city: '\u{1F3D9}', // 🏙
      town: '\u{1F3D8}', // 🏘
      village: '\u{1F3E0}', // 🏠
      locality: '\u{1F4CD}', // 📍
      street: '\u{1F6E3}', // 🛣
      address: '\u{1F3E2}', // 🏢
      country: '\u{1F30D}', // 🌍
      state: '\u{1F5FA}', // 🗺
      region: '\u{1F5FA}',
      peak: '\u{26F0}', // ⛰
      water: '\u{1F30A}', // 🌊
      forest: '\u{1F332}', // 🌲
      park: '\u{1F333}', // 🌳
      coordinate: '\u{1F4CD}', // 📍 (crosshairs would be ideal but this works)
    };
    return icons[type] || '\u{1F4CD}'; // 📍 default
  }

  /** Escape HTML for safe rendering */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /** Select next result */
  private selectNext(): void {
    if (this.results.length === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % this.results.length;
    this.renderResults();
  }

  /** Select previous result */
  private selectPrevious(): void {
    if (this.results.length === 0) return;
    this.selectedIndex =
      this.selectedIndex <= 0 ? this.results.length - 1 : this.selectedIndex - 1;
    this.renderResults();
  }

  /** Select a result and fly to it */
  selectResult(result: SearchResult): void {
    // Calculate appropriate zoom based on result type
    let zoom = 14;
    if (['country'].includes(result.type)) {
      zoom = 5;
    } else if (['state', 'region'].includes(result.type)) {
      zoom = 7;
    } else if (['city', 'town'].includes(result.type)) {
      zoom = 12;
    } else if (['village', 'locality'].includes(result.type)) {
      zoom = 14;
    } else if (['street'].includes(result.type)) {
      zoom = 16;
    } else if (['address'].includes(result.type)) {
      zoom = 18;
    } else if (['coordinate'].includes(result.type)) {
      // For direct coordinate input, use a moderate zoom or keep current if already zoomed in
      const currentZoom = this.map.getZoom();
      zoom = Math.max(currentZoom, 12);
    }

    // Fly to location
    this.map.flyTo({
      center: [result.lng, result.lat],
      zoom,
      duration: 1500,
    });

    // Update input with selected name
    if (this.input) {
      this.input.value = result.name;
    }

    // Hide results
    this.hideResults();

    // Notify callback
    if (this.onResultSelect) {
      this.onResultSelect(result);
    }

    showToast(`Navigated to ${result.name}`, 'info', 2000);
  }

  /** Show results dropdown */
  private showResults(): void {
    if (this.resultsList && this.results.length > 0) {
      this.resultsList.classList.add('visible');
      this.visible = true;
    }
  }

  /** Hide results dropdown */
  private hideResults(): void {
    if (this.resultsList) {
      this.resultsList.classList.remove('visible');
      this.visible = false;
    }
  }

  /** Clear results */
  private clearResults(): void {
    this.results = [];
    this.selectedIndex = -1;
    if (this.resultsList) {
      this.resultsList.innerHTML = '';
    }
    this.hideResults();
  }

  /** Clear search input and results */
  clear(): void {
    if (this.input) {
      this.input.value = '';
    }
    this.clearResults();
  }

  /** Set callback for result selection */
  setOnResultSelect(callback: (result: SearchResult) => void): void {
    this.onResultSelect = callback;
  }

  /** Focus the search input */
  focus(): void {
    this.input?.focus();
  }

  /** Check if search is visible/active */
  isVisible(): boolean {
    return this.visible;
  }

  /** Update the map reference (for split view) */
  setMap(map: MapLibreMap): void {
    this.map = map;
  }
}
