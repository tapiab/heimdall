/**
 * Split View - Toggleable dual map view for side-by-side comparison
 *
 * Features:
 * - Toggle split view on/off with keyboard shortcut or button
 * - Primary map (left) keeps current view/layers
 * - Secondary map (right) shows basemap for reference
 * - Independent pan/zoom for each map
 * - Optional sync mode to link map movements
 * - Integrates with georeferencing for GCP placement
 */

import { type Map as MapLibreMap } from 'maplibre-gl';
import { MapManager } from './map-manager';
import { LayerManager } from './layer-manager';
import { showToast } from './notifications';
import { LocationSearch } from './location-search';
import { openFileDialog } from './ui';

export interface SplitViewOptions {
  syncMovement?: boolean; // Sync pan/zoom between maps
}

// Use unknown for configManager since it's passed through to MapManager
// which has its own ConfigManager interface definition
type ConfigManagerLike = unknown;

export class SplitView {
  private primaryMapManager: MapManager;
  private secondaryMapManager: MapManager | null;
  private secondaryLayerManager: LayerManager | null;
  private configManager: ConfigManagerLike;
  private active: boolean;
  private syncMovement: boolean;
  private container: HTMLElement | null;
  private primaryContainer: HTMLElement | null;
  private secondaryContainer: HTMLElement | null;

  // Event handlers for syncing
  private primaryMoveHandler: (() => void) | null;
  private secondaryMoveHandler: (() => void) | null;
  private isSyncing: boolean;

  // Callbacks
  private onSecondaryMapClick: ((lng: number, lat: number) => void) | null;

  // Location search for secondary map
  private secondaryLocationSearch: LocationSearch | null;

  constructor(
    mapManager: MapManager,
    configManager: ConfigManagerLike = null,
    options: SplitViewOptions = {}
  ) {
    this.primaryMapManager = mapManager;
    this.secondaryMapManager = null;
    this.secondaryLayerManager = null;
    this.configManager = configManager;
    this.active = false;
    this.syncMovement = options.syncMovement ?? false;
    this.container = null;
    this.primaryContainer = null;
    this.secondaryContainer = null;
    this.primaryMoveHandler = null;
    this.secondaryMoveHandler = null;
    this.isSyncing = false;
    this.onSecondaryMapClick = null;
    this.secondaryLocationSearch = null;
  }

  /** Check if split view is active */
  isActive(): boolean {
    return this.active;
  }

  /** Toggle split view on/off */
  toggle(): boolean {
    if (this.active) {
      this.deactivate();
    } else {
      this.activate();
    }
    return this.active;
  }

  /** Get primary map */
  private get primaryMap(): MapLibreMap {
    return this.primaryMapManager.map!;
  }

  /** Get secondary map */
  private get secondaryMap(): MapLibreMap | null {
    return this.secondaryMapManager?.map ?? null;
  }

  /** Activate split view */
  activate(): void {
    if (this.active) return;

    // Get or create containers
    this.container = document.getElementById('map-container');
    if (!this.container) {
      // Wrap the existing map in a container
      const mapEl = document.getElementById('map');
      if (!mapEl || !mapEl.parentElement) {
        showToast('Could not initialize split view', 'error');
        return;
      }

      this.container = document.createElement('div');
      this.container.id = 'map-container';
      this.container.className = 'map-container';
      mapEl.parentElement.insertBefore(this.container, mapEl);
      this.container.appendChild(mapEl);
    }

    // Create primary container wrapper
    this.primaryContainer = document.getElementById('map');
    if (this.primaryContainer) {
      this.primaryContainer.classList.add('split-primary');
    }

    // Create secondary panel wrapper (contains map + floating layer panel)
    const secondaryPanel = document.createElement('div');
    secondaryPanel.id = 'split-secondary-panel';
    secondaryPanel.className = 'split-secondary-panel';

    // Create secondary map container
    this.secondaryContainer = document.createElement('div');
    this.secondaryContainer.id = 'map-secondary';
    this.secondaryContainer.className = 'split-secondary';
    secondaryPanel.appendChild(this.secondaryContainer);

    // Create floating layer panel (like primary's #left-panel)
    // Location search is integrated inside the layer panel
    const layerPanel = this.createSecondaryLayerPanel();
    secondaryPanel.appendChild(layerPanel);

    // Create collapse button (outside layer panel so it stays visible when collapsed)
    const collapseBtn = document.createElement('button');
    collapseBtn.id = 'split-panel-collapse';
    collapseBtn.className = 'split-panel-collapse';
    collapseBtn.title = 'Toggle layer panel';
    collapseBtn.innerHTML = '◀';
    collapseBtn.addEventListener('click', () => {
      const isCollapsed = layerPanel.classList.toggle('collapsed');
      collapseBtn.innerHTML = isCollapsed ? '▶' : '◀';
      collapseBtn.classList.toggle('panel-collapsed', isCollapsed);
    });
    secondaryPanel.appendChild(collapseBtn);

    this.container.appendChild(secondaryPanel);

    // Add split class to container
    this.container.classList.add('split-active');

    // Create secondary map using MapManager
    this.createSecondaryMap();

    // Initialize location search for secondary map
    if (this.secondaryMap) {
      this.secondaryLocationSearch = new LocationSearch(this.secondaryMap);
      this.secondaryLocationSearch.init('split-location-search');
    }

    // Resize primary map to fit new container size
    setTimeout(() => {
      this.primaryMap.resize();
      if (this.secondaryMap) {
        this.secondaryMap.resize();
      }
    }, 100);

    this.active = true;
    showToast('Split view enabled. Right panel shows basemap.', 'info', 2000);
  }

  /** Deactivate split view */
  deactivate(): void {
    if (!this.active) return;

    // Remove sync handlers
    this.disableSync();

    // Clean up secondary LayerManager
    if (this.secondaryLayerManager) {
      this.secondaryLayerManager.destroy();
      this.secondaryLayerManager = null;
    }

    this.secondaryLocationSearch = null;

    // Remove secondary map via MapManager
    if (this.secondaryMapManager?.map) {
      this.secondaryMapManager.map.remove();
      this.secondaryMapManager = null;
    }

    // Remove secondary panel (includes control bar and map container)
    const secondaryPanel = document.getElementById('split-secondary-panel');
    if (secondaryPanel) {
      secondaryPanel.remove();
    }
    this.secondaryContainer = null;

    // Remove split classes
    if (this.container) {
      this.container.classList.remove('split-active');
    }
    if (this.primaryContainer) {
      this.primaryContainer.classList.remove('split-primary');
    }

    // Resize primary map
    setTimeout(() => {
      this.primaryMap.resize();
    }, 100);

    this.active = false;
    this.onSecondaryMapClick = null;
  }

  /** Create the secondary map instance using MapManager */
  private async createSecondaryMap(): Promise<void> {
    if (!this.secondaryContainer) return;

    // Get current primary map center/zoom for initial position
    const center = this.primaryMap.getCenter();
    const zoom = this.primaryMap.getZoom();

    // Create secondary MapManager with status bar disabled (we share primary's status bar)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.secondaryMapManager = new MapManager('map-secondary', this.configManager as any, {
      enableStatusBar: false,
      elementIdPrefix: 'split',
    });

    await this.secondaryMapManager.init();

    // Create secondary LayerManager with secondary-specific element IDs
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.secondaryLayerManager = new LayerManager(this.secondaryMapManager as any, {
      layerListId: 'split-layer-list',
      dynamicControlsId: 'split-dynamic-controls',
      fitBoundsButtonId: 'split-fit-bounds',
      enablePopups: true,
      enableStatusBarUpdates: false, // Share primary's status bar
    });

    // Set initial view to match primary
    if (this.secondaryMap) {
      this.secondaryMap.setCenter([center.lng, center.lat]);
      this.secondaryMap.setZoom(Math.max(zoom, 2));

      // Set up click handler for the secondary map
      this.secondaryMap.on('click', e => {
        if (this.onSecondaryMapClick) {
          this.onSecondaryMapClick(e.lngLat.lng, e.lngLat.lat);
        }
      });

      // Set up sync if enabled
      if (this.syncMovement) {
        this.enableSync();
      }
    }
  }

  /** Create layer panel for secondary map (matches primary #left-panel structure) */
  private createSecondaryLayerPanel(): HTMLElement {
    // Container matching #left-panel
    const leftPanel = document.createElement('div');
    leftPanel.id = 'split-left-panel';
    leftPanel.className = 'split-left-panel';

    // Layer panel (matches #layer-panel)
    const layerPanelOuter = document.createElement('div');
    layerPanelOuter.id = 'split-layer-panel';
    layerPanelOuter.className = 'split-layer-panel-inner';

    // Header
    const header = document.createElement('h3');
    header.textContent = 'Layers';
    layerPanelOuter.appendChild(header);

    // Location search (integrated into panel)
    const locationSearch = document.createElement('div');
    locationSearch.id = 'split-location-search';
    locationSearch.className = 'location-search-inline';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'search-input';
    searchInput.placeholder = 'Search location... (/)';

    const searchClose = document.createElement('button');
    searchClose.className = 'search-close';
    searchClose.title = 'Clear';
    searchClose.innerHTML = '&times;';

    const searchResults = document.createElement('div');
    searchResults.className = 'search-results';

    locationSearch.appendChild(searchInput);
    locationSearch.appendChild(searchClose);
    locationSearch.appendChild(searchResults);
    layerPanelOuter.appendChild(locationSearch);

    // Basemap row (matches #basemap-row)
    const basemapRow = document.createElement('div');
    basemapRow.className = 'layer-item basemap-item';

    const basemapName = document.createElement('span');
    basemapName.className = 'layer-name';
    basemapName.textContent = 'Basemap';

    const basemapSelect = document.createElement('select');
    basemapSelect.id = 'split-basemap-select';
    basemapSelect.innerHTML = `
      <option value="osm">OSM</option>
      <option value="satellite">Satellite</option>
      <option value="topo">OpenTopoMap</option>
      <option value="carto-light">CartoDB Light</option>
      <option value="carto-dark">CartoDB Dark</option>
      <option value="custom">Custom</option>
      <option value="pixel">Pixel Grid</option>
      <option value="none">None</option>
    `;
    basemapSelect.addEventListener('change', () => {
      if (this.secondaryMapManager) {
        this.secondaryMapManager.setBasemap(
          basemapSelect.value as
            | 'osm'
            | 'satellite'
            | 'topo'
            | 'carto-light'
            | 'carto-dark'
            | 'custom'
            | 'pixel'
            | 'none'
        );
      }
    });

    basemapRow.appendChild(basemapName);
    basemapRow.appendChild(basemapSelect);
    layerPanelOuter.appendChild(basemapRow);

    // Sync row (additional control for split view)
    const syncRow = document.createElement('div');
    syncRow.className = 'layer-item sync-item';

    const syncLabel = document.createElement('label');
    syncLabel.className = 'sync-toggle-label';

    const syncCheckbox = document.createElement('input');
    syncCheckbox.type = 'checkbox';
    syncCheckbox.id = 'split-sync-toggle';
    syncCheckbox.checked = this.syncMovement;
    syncCheckbox.addEventListener('change', () => {
      if (syncCheckbox.checked) {
        this.enableSync();
      } else {
        this.disableSync();
      }
    });

    const syncText = document.createElement('span');
    syncText.className = 'layer-name';
    syncText.textContent = 'Sync with Primary';

    syncLabel.appendChild(syncCheckbox);
    syncLabel.appendChild(syncText);
    syncRow.appendChild(syncLabel);

    // Center button
    const centerBtn = document.createElement('button');
    centerBtn.className = 'icon-btn';
    centerBtn.title = 'Center on primary view';
    centerBtn.innerHTML = '⌖';
    centerBtn.addEventListener('click', () => {
      if (this.secondaryMap) {
        const center = this.primaryMap.getCenter();
        const zoom = this.primaryMap.getZoom();
        this.secondaryMap.flyTo({
          center: [center.lng, center.lat],
          zoom: Math.max(zoom, 2),
          duration: 1000,
        });
      }
    });
    syncRow.appendChild(centerBtn);

    layerPanelOuter.appendChild(syncRow);

    // Layer list - this is where LayerManager will render layers
    const layerList = document.createElement('div');
    layerList.id = 'split-layer-list';
    layerList.className = 'split-layer-list';
    layerPanelOuter.appendChild(layerList);

    leftPanel.appendChild(layerPanelOuter);

    // Add Layer panel
    const addLayerPanel = document.createElement('div');
    addLayerPanel.id = 'split-add-layer-panel';
    addLayerPanel.className = 'split-add-layer-panel';

    const addLayerHeader = document.createElement('div');
    addLayerHeader.className = 'panel-header';
    const addLayerTitle = document.createElement('h3');
    addLayerTitle.textContent = 'Add Layer';
    addLayerHeader.appendChild(addLayerTitle);
    addLayerPanel.appendChild(addLayerHeader);

    const addLayerButtons = document.createElement('div');
    addLayerButtons.className = 'add-layer-buttons';

    const addLayerBtn = document.createElement('button');
    addLayerBtn.id = 'split-add-layer-btn';
    addLayerBtn.className = 'add-layer-btn';
    addLayerBtn.textContent = '+ Add Layer';
    addLayerBtn.addEventListener('click', () => this.openSecondaryFileDialog());

    // Fit bounds button
    const fitBoundsBtn = document.createElement('button');
    fitBoundsBtn.id = 'split-fit-bounds';
    fitBoundsBtn.className = 'add-layer-btn';
    fitBoundsBtn.textContent = 'Fit Bounds';
    fitBoundsBtn.disabled = true;
    fitBoundsBtn.addEventListener('click', () => {
      if (this.secondaryLayerManager) {
        this.secondaryLayerManager.fitToAllLayers();
      }
    });

    addLayerButtons.appendChild(addLayerBtn);
    addLayerButtons.appendChild(fitBoundsBtn);
    addLayerPanel.appendChild(addLayerButtons);

    leftPanel.appendChild(addLayerPanel);

    // Controls panel (matches #controls-panel) - dynamic controls for selected layer
    const controlsPanel = document.createElement('div');
    controlsPanel.id = 'split-controls-panel';
    controlsPanel.className = 'split-controls-panel';

    const controlsHeader = document.createElement('div');
    controlsHeader.className = 'panel-header';
    const controlsTitle = document.createElement('h3');
    controlsTitle.textContent = 'Display';
    controlsHeader.appendChild(controlsTitle);
    controlsPanel.appendChild(controlsHeader);

    // Dynamic controls container - LayerManager will render controls here
    const dynamicControls = document.createElement('div');
    dynamicControls.id = 'split-dynamic-controls';
    dynamicControls.innerHTML = '<div class="no-layer-selected">Select a layer to adjust</div>';
    controlsPanel.appendChild(dynamicControls);

    leftPanel.appendChild(controlsPanel);

    return leftPanel;
  }

  /** Open file dialog and add layer via secondary LayerManager */
  private async openSecondaryFileDialog(): Promise<void> {
    if (!this.secondaryLayerManager) return;
    await openFileDialog(this.secondaryLayerManager);
  }

  /** Enable movement sync between maps */
  enableSync(): void {
    if (!this.secondaryMap || this.primaryMoveHandler) return;

    this.primaryMoveHandler = () => {
      if (this.isSyncing || !this.secondaryMap) return;
      this.isSyncing = true;
      this.secondaryMap.setCenter(this.primaryMap.getCenter());
      this.secondaryMap.setZoom(this.primaryMap.getZoom());
      this.secondaryMap.setBearing(this.primaryMap.getBearing());
      this.secondaryMap.setPitch(this.primaryMap.getPitch());
      this.isSyncing = false;
    };

    this.secondaryMoveHandler = () => {
      if (this.isSyncing || !this.secondaryMap) return;
      this.isSyncing = true;
      this.primaryMap.setCenter(this.secondaryMap.getCenter());
      this.primaryMap.setZoom(this.secondaryMap.getZoom());
      this.primaryMap.setBearing(this.secondaryMap.getBearing());
      this.primaryMap.setPitch(this.secondaryMap.getPitch());
      this.isSyncing = false;
    };

    this.primaryMap.on('move', this.primaryMoveHandler);
    this.secondaryMap.on('move', this.secondaryMoveHandler);
    this.syncMovement = true;
  }

  /** Disable movement sync */
  disableSync(): void {
    if (this.primaryMoveHandler) {
      this.primaryMap.off('move', this.primaryMoveHandler);
      this.primaryMoveHandler = null;
    }
    if (this.secondaryMoveHandler && this.secondaryMap) {
      this.secondaryMap.off('move', this.secondaryMoveHandler);
      this.secondaryMoveHandler = null;
    }
    this.syncMovement = false;
  }

  /** Toggle movement sync */
  toggleSync(): boolean {
    if (this.syncMovement) {
      this.disableSync();
    } else {
      this.enableSync();
    }
    return this.syncMovement;
  }

  /** Get the secondary map instance */
  getSecondaryMap(): MapLibreMap | null {
    return this.secondaryMap;
  }

  /** Set click handler for secondary map */
  setSecondaryMapClickHandler(handler: ((lng: number, lat: number) => void) | null): void {
    this.onSecondaryMapClick = handler;
  }

  /** Set basemap style on secondary map - delegates to MapManager */
  setSecondaryBasemap(
    style: 'osm' | 'satellite' | 'topo' | 'carto-light' | 'carto-dark' | 'custom' | 'pixel' | 'none'
  ): void {
    if (!this.secondaryMapManager) return;
    this.secondaryMapManager.setBasemap(style);

    // Update basemap selector UI
    const basemapSelect = document.getElementById(
      'split-basemap-select'
    ) as HTMLSelectElement | null;
    if (basemapSelect) {
      basemapSelect.value = style;
    }
  }

  /** Fly to location on secondary map */
  flyToOnSecondary(lng: number, lat: number, zoom?: number): void {
    const map = this.secondaryMap;
    if (!map) return;

    map.flyTo({
      center: [lng, lat],
      zoom: zoom ?? 14,
      duration: 1500,
    });
  }

  /** Update custom basemap config for secondary map's MapManager */
  setCustomBasemap(url: string, attribution: string = ''): void {
    if (this.secondaryMapManager) {
      this.secondaryMapManager.setCustomBasemapSource(url, attribution);
    }
  }

  /** Fly to location on both maps */
  flyToBoth(lng: number, lat: number, zoom?: number): void {
    const targetZoom = zoom ?? 14;

    this.primaryMap.flyTo({
      center: [lng, lat],
      zoom: targetZoom,
      duration: 1500,
    });

    const map = this.secondaryMap;
    if (map) {
      map.flyTo({
        center: [lng, lat],
        zoom: targetZoom,
        duration: 1500,
      });
    }
  }

  /** Get cursor style for secondary map */
  setSecondaryCursor(cursor: string): void {
    const map = this.secondaryMap;
    if (map) {
      map.getCanvas().style.cursor = cursor;
    }
  }

  /** Get secondary MapManager instance */
  getSecondaryMapManager(): MapManager | null {
    return this.secondaryMapManager;
  }

  /** Get secondary LayerManager instance */
  getSecondaryLayerManager(): LayerManager | null {
    return this.secondaryLayerManager;
  }
}
