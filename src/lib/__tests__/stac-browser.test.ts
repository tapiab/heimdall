/**
 * Tests for StacBrowser
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock Tauri
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// Mock Tauri dialog plugin
vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn(),
}));

// Mock maplibre-gl
vi.mock('maplibre-gl', () => {
  class MockLngLatBounds {
    constructor() {
      this._coords = [];
    }
    extend() {
      return this;
    }
    isEmpty() {
      return false;
    }
  }
  return {
    default: {
      LngLatBounds: MockLngLatBounds,
    },
  };
});

// Mock notifications
vi.mock('../notifications.js', () => ({
  showToast: vi.fn(),
  showError: vi.fn(),
  showLoading: vi.fn(),
  hideLoading: vi.fn(),
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

// Create mock map
function createMockMap() {
  return {
    getSource: vi.fn(),
    getLayer: vi.fn(),
    addSource: vi.fn(),
    addLayer: vi.fn(),
    removeSource: vi.fn(),
    removeLayer: vi.fn(),
    setFeatureState: vi.fn(),
    getBounds: vi.fn(() => ({
      getWest: () => -10,
      getSouth: () => -20,
      getEast: () => 10,
      getNorth: () => 20,
    })),
    fitBounds: vi.fn(),
    getCanvas: vi.fn(() => ({ style: {} })),
    getZoom: vi.fn(() => 10),
    setLayoutProperty: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  };
}

function createMockMapManager() {
  const map = createMockMap();
  return {
    map,
  };
}

function createMockLayerManager() {
  return {
    layers: new Map(),
    layerOrder: [],
    setupTileProtocol: vi.fn(),
    updateLayerPanel: vi.fn(),
    selectLayer: vi.fn(),
  };
}

// Setup DOM elements before importing
function setupDOM() {
  // Panel
  const panel = document.createElement('div');
  panel.id = 'stac-panel';
  document.body.appendChild(panel);

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.id = 'stac-panel-close';
  document.body.appendChild(closeBtn);

  // API select dropdown
  const apiSelect = document.createElement('select');
  apiSelect.id = 'stac-api-select';
  apiSelect.innerHTML = `
    <option value="https://earth-search.aws.element84.com/v1">Earth Search (AWS)</option>
    <option value="https://planetarycomputer.microsoft.com/api/stac/v1">Planetary Computer</option>
    <option value="custom">Custom URL...</option>
  `;
  document.body.appendChild(apiSelect);

  // Custom URL row
  const customUrlRow = document.createElement('div');
  customUrlRow.id = 'stac-custom-url-row';
  customUrlRow.classList.add('hidden');
  document.body.appendChild(customUrlRow);

  // URL input
  const urlInput = document.createElement('input');
  urlInput.id = 'stac-url';
  urlInput.value = 'https://earth-search.aws.element84.com/v1';
  customUrlRow.appendChild(urlInput);

  // Connect button
  const connectBtn = document.createElement('button');
  connectBtn.id = 'stac-connect-btn';
  document.body.appendChild(connectBtn);

  // Catalog info
  const catalogInfo = document.createElement('div');
  catalogInfo.id = 'stac-catalog-info';
  catalogInfo.classList.add('hidden');
  document.body.appendChild(catalogInfo);

  // Collections section
  const collectionsSection = document.createElement('div');
  collectionsSection.id = 'stac-collections';
  collectionsSection.classList.add('hidden');
  document.body.appendChild(collectionsSection);

  // Collection select
  const collectionSelect = document.createElement('select');
  collectionSelect.id = 'stac-collection-select';
  document.body.appendChild(collectionSelect);

  // Collection info
  const collectionInfo = document.createElement('div');
  collectionInfo.id = 'stac-collection-info';
  document.body.appendChild(collectionInfo);

  // Search section
  const searchSection = document.createElement('div');
  searchSection.id = 'stac-search';
  searchSection.classList.add('hidden');
  document.body.appendChild(searchSection);

  // Use view button
  const useViewBtn = document.createElement('button');
  useViewBtn.id = 'stac-use-view';
  document.body.appendChild(useViewBtn);

  // Bbox display
  const bboxDisplay = document.createElement('span');
  bboxDisplay.id = 'stac-bbox-display';
  document.body.appendChild(bboxDisplay);

  // Date inputs
  const dateStart = document.createElement('input');
  dateStart.id = 'stac-date-start';
  dateStart.type = 'date';
  document.body.appendChild(dateStart);

  const dateEnd = document.createElement('input');
  dateEnd.id = 'stac-date-end';
  dateEnd.type = 'date';
  document.body.appendChild(dateEnd);

  // Cloud cover slider
  const cloudCover = document.createElement('input');
  cloudCover.id = 'stac-cloud-cover';
  cloudCover.type = 'range';
  cloudCover.value = '20';
  document.body.appendChild(cloudCover);

  const cloudValue = document.createElement('span');
  cloudValue.id = 'stac-cloud-value';
  document.body.appendChild(cloudValue);

  // Limit select
  const limitSelect = document.createElement('select');
  limitSelect.id = 'stac-limit';
  limitSelect.innerHTML = '<option value="20">20</option>';
  document.body.appendChild(limitSelect);

  // Search button
  const searchBtn = document.createElement('button');
  searchBtn.id = 'stac-search-btn';
  document.body.appendChild(searchBtn);

  // Results section
  const resultsSection = document.createElement('div');
  resultsSection.id = 'stac-results';
  resultsSection.classList.add('hidden');
  document.body.appendChild(resultsSection);

  // Results count
  const resultsCount = document.createElement('span');
  resultsCount.id = 'stac-results-count';
  document.body.appendChild(resultsCount);

  // Results list
  const resultsList = document.createElement('div');
  resultsList.id = 'stac-results-list';
  document.body.appendChild(resultsList);

  // Clear results button
  const clearResultsBtn = document.createElement('button');
  clearResultsBtn.id = 'stac-clear-results';
  document.body.appendChild(clearResultsBtn);

  // Toggle footprints button
  const toggleFootprintsBtn = document.createElement('button');
  toggleFootprintsBtn.id = 'stac-toggle-footprints';
  document.body.appendChild(toggleFootprintsBtn);

  // Draw bbox button
  const drawBboxBtn = document.createElement('button');
  drawBboxBtn.id = 'stac-draw-bbox';
  document.body.appendChild(drawBboxBtn);

  // Clear bbox button
  const clearBboxBtn = document.createElement('button');
  clearBboxBtn.id = 'stac-clear-bbox';
  document.body.appendChild(clearBboxBtn);

  // Item detail section
  const itemDetailSection = document.createElement('div');
  itemDetailSection.id = 'stac-item-detail';
  itemDetailSection.classList.add('hidden');
  document.body.appendChild(itemDetailSection);

  // Item title
  const itemTitle = document.createElement('div');
  itemTitle.id = 'stac-item-title';
  document.body.appendChild(itemTitle);

  // Item properties
  const itemProperties = document.createElement('div');
  itemProperties.id = 'stac-item-properties';
  document.body.appendChild(itemProperties);

  // Asset list
  const assetList = document.createElement('div');
  assetList.id = 'stac-asset-list';
  document.body.appendChild(assetList);

  // Back button
  const itemBackBtn = document.createElement('button');
  itemBackBtn.id = 'stac-item-back';
  document.body.appendChild(itemBackBtn);

  // STAC button
  const stacBtn = document.createElement('button');
  stacBtn.id = 'stac-btn';
  document.body.appendChild(stacBtn);
}

function cleanupDOM() {
  const elements = [
    'stac-panel',
    'stac-panel-close',
    'stac-api-select',
    'stac-custom-url-row',
    'stac-url',
    'stac-connect-btn',
    'stac-catalog-info',
    'stac-collections',
    'stac-collection-select',
    'stac-collection-info',
    'stac-search',
    'stac-use-view',
    'stac-bbox-display',
    'stac-date-start',
    'stac-date-end',
    'stac-cloud-cover',
    'stac-cloud-value',
    'stac-limit',
    'stac-search-btn',
    'stac-results',
    'stac-results-count',
    'stac-results-list',
    'stac-clear-results',
    'stac-toggle-footprints',
    'stac-draw-bbox',
    'stac-clear-bbox',
    'stac-item-detail',
    'stac-item-title',
    'stac-item-properties',
    'stac-asset-list',
    'stac-item-back',
    'stac-btn',
  ];
  elements.forEach(id => document.getElementById(id)?.remove());
}

// Import after mocks are set up
import { StacBrowser } from '../stac-browser.js';
import { invoke } from '@tauri-apps/api/core';
import { showToast, showError, showLoading, hideLoading } from '../notifications.js';

describe('StacBrowser', () => {
  let mockMapManager;
  let mockLayerManager;
  let stacBrowser;

  beforeEach(() => {
    vi.clearAllMocks();
    setupDOM();
    mockMapManager = createMockMapManager();
    mockLayerManager = createMockLayerManager();
    stacBrowser = new StacBrowser(mockLayerManager, mockMapManager);
  });

  afterEach(() => {
    cleanupDOM();
  });

  describe('constructor', () => {
    it('should initialize with null catalog state', () => {
      expect(stacBrowser.currentCatalogUrl).toBeNull();
      expect(stacBrowser.currentCatalog).toBeNull();
    });

    it('should initialize with empty collections', () => {
      expect(stacBrowser.collections).toEqual([]);
    });

    it('should initialize with null selected collection', () => {
      expect(stacBrowser.selectedCollection).toBeNull();
    });

    it('should initialize with empty search results', () => {
      expect(stacBrowser.searchResults).toEqual([]);
    });

    it('should initialize with null selected item', () => {
      expect(stacBrowser.selectedItem).toBeNull();
    });

    it('should initialize with null search bbox', () => {
      expect(stacBrowser.searchBbox).toBeNull();
    });

    it('should store layer manager reference', () => {
      expect(stacBrowser.layerManager).toBe(mockLayerManager);
    });

    it('should store map manager reference', () => {
      expect(stacBrowser.mapManager).toBe(mockMapManager);
    });

    it('should set default dates', () => {
      const today = new Date();
      const dateEnd = document.getElementById('stac-date-end');
      expect(dateEnd.value).toBe(today.toISOString().split('T')[0]);
    });
  });

  describe('panel visibility', () => {
    it('should show panel when show() is called', () => {
      stacBrowser.show();
      expect(stacBrowser.panel.classList.contains('visible')).toBe(true);
    });

    it('should add active class to button when shown', () => {
      stacBrowser.show();
      const btn = document.getElementById('stac-btn');
      expect(btn.classList.contains('active')).toBe(true);
    });

    it('should hide panel when hide() is called', () => {
      stacBrowser.show();
      stacBrowser.hide();
      expect(stacBrowser.panel.classList.contains('visible')).toBe(false);
    });

    it('should remove active class from button when hidden', () => {
      stacBrowser.show();
      stacBrowser.hide();
      const btn = document.getElementById('stac-btn');
      expect(btn.classList.contains('active')).toBe(false);
    });

    it('should toggle panel visibility', () => {
      expect(stacBrowser.isVisible()).toBe(false);

      stacBrowser.toggle();
      expect(stacBrowser.isVisible()).toBe(true);

      stacBrowser.toggle();
      expect(stacBrowser.isVisible()).toBe(false);
    });

    it('should return correct visibility state', () => {
      expect(stacBrowser.isVisible()).toBe(false);
      stacBrowser.show();
      expect(stacBrowser.isVisible()).toBe(true);
    });
  });

  describe('connect', () => {
    // Updated to use StacCatalogInfo format (returned by connect_stac_api)
    const mockCatalogInfo = {
      id: 'earth-search',
      title: 'Earth Search',
      description: 'A STAC catalog of public datasets',
      catalog_type: 'Api',
      base_url: 'https://earth-search.aws.element84.com/v1',
    };

    const mockCollections = [
      { id: 'sentinel-2-l2a', title: 'Sentinel-2 L2A' },
      { id: 'landsat-c2-l2', title: 'Landsat C2 L2' },
    ];

    it('should show error when URL is empty', async () => {
      // Set dropdown to custom and clear the URL input
      stacBrowser.apiSelect.value = 'custom';
      stacBrowser.urlInput.value = '';
      await stacBrowser.connect();
      expect(showError).toHaveBeenCalledWith('Invalid URL', expect.any(String));
    });

    it('should call connect_stac_api with URL', async () => {
      invoke.mockResolvedValueOnce(mockCatalogInfo).mockResolvedValueOnce(mockCollections);

      await stacBrowser.connect();

      expect(invoke).toHaveBeenCalledWith('connect_stac_api', {
        url: 'https://earth-search.aws.element84.com/v1',
        acceptInvalidCerts: false,
      });
    });

    it('should store catalog URL on success', async () => {
      invoke.mockResolvedValueOnce(mockCatalogInfo).mockResolvedValueOnce(mockCollections);

      await stacBrowser.connect();

      expect(stacBrowser.currentCatalogUrl).toBe('https://earth-search.aws.element84.com/v1');
    });

    it('should store catalog on success', async () => {
      invoke.mockResolvedValueOnce(mockCatalogInfo).mockResolvedValueOnce(mockCollections);

      await stacBrowser.connect();

      // Catalog is now reconstructed from catalog info
      expect(stacBrowser.currentCatalog.id).toBe('earth-search');
      expect(stacBrowser.currentCatalog.title).toBe('Earth Search');
    });

    it('should fetch and store collections', async () => {
      invoke.mockResolvedValueOnce(mockCatalogInfo).mockResolvedValueOnce(mockCollections);

      await stacBrowser.connect();

      expect(stacBrowser.collections).toEqual(mockCollections);
    });

    it('should show collections section on success', async () => {
      invoke.mockResolvedValueOnce(mockCatalogInfo).mockResolvedValueOnce(mockCollections);

      await stacBrowser.connect();

      expect(stacBrowser.collectionsSection.classList.contains('hidden')).toBe(false);
    });

    it('should show toast on success', async () => {
      invoke.mockResolvedValueOnce(mockCatalogInfo).mockResolvedValueOnce(mockCollections);

      await stacBrowser.connect();

      expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Earth Search'), 'success');
    });

    it('should show error on failure', async () => {
      invoke.mockRejectedValueOnce('Connection failed');

      await stacBrowser.connect();

      expect(showError).toHaveBeenCalledWith('Connection failed', 'Connection failed');
    });

    it('should disable connect button during connection', async () => {
      invoke.mockImplementation(
        () =>
          new Promise(resolve => {
            expect(stacBrowser.connectBtn.disabled).toBe(true);
            resolve(mockCatalogInfo);
          })
      );

      await stacBrowser.connect();
    });

    it('should re-enable connect button after connection', async () => {
      invoke.mockResolvedValueOnce(mockCatalogInfo).mockResolvedValueOnce(mockCollections);

      await stacBrowser.connect();

      expect(stacBrowser.connectBtn.disabled).toBe(false);
    });

    it('should detect TLS errors and prompt user to retry', async () => {
      const { ask } = await import('@tauri-apps/plugin-dialog');
      const mockAsk = vi.mocked(ask);
      mockAsk.mockResolvedValueOnce(false);

      invoke.mockRejectedValueOnce('[TLS_ERROR] error sending request');

      await stacBrowser.connect();

      expect(mockAsk).toHaveBeenCalledWith(
        expect.stringContaining('invalid or self-signed'),
        expect.objectContaining({ kind: 'warning' })
      );
      // User declined, so error is shown
      expect(showError).toHaveBeenCalledWith('Connection failed', expect.any(String));
    });

    it('should retry with acceptInvalidCerts when user accepts TLS warning', async () => {
      const { ask } = await import('@tauri-apps/plugin-dialog');
      const mockAsk = vi.mocked(ask);
      mockAsk.mockResolvedValueOnce(true);

      // First call fails with TLS error, retry succeeds
      invoke
        .mockRejectedValueOnce('[TLS_ERROR] certificate error')
        .mockResolvedValueOnce(mockCatalogInfo)
        .mockResolvedValueOnce(mockCollections);

      await stacBrowser.connect();

      // Second call should have acceptInvalidCerts: true
      expect(invoke).toHaveBeenCalledWith('connect_stac_api', {
        url: 'https://earth-search.aws.element84.com/v1',
        acceptInvalidCerts: true,
      });
      expect(stacBrowser.currentCatalogUrl).toBe('https://earth-search.aws.element84.com/v1');
    });

    it('should not prompt for non-TLS errors', async () => {
      const { ask } = await import('@tauri-apps/plugin-dialog');
      const mockAsk = vi.mocked(ask);

      invoke.mockRejectedValueOnce('DNS resolution failed');

      await stacBrowser.connect();

      expect(mockAsk).not.toHaveBeenCalled();
      expect(showError).toHaveBeenCalled();
    });
  });

  describe('populateCollections', () => {
    const collections = [
      { id: 'collection-1', title: 'Collection One' },
      { id: 'collection-2', title: 'Collection Two' },
      { id: 'collection-3' }, // No title
    ];

    it('should clear existing options', () => {
      stacBrowser.collectionSelect.innerHTML = '<option value="old">Old</option>';
      stacBrowser.populateCollections(collections);

      expect(stacBrowser.collectionSelect.querySelector('option[value="old"]')).toBeNull();
    });

    it('should add default option', () => {
      stacBrowser.populateCollections(collections);

      const defaultOption = stacBrowser.collectionSelect.querySelector('option[value=""]');
      expect(defaultOption).not.toBeNull();
      expect(defaultOption.textContent).toBe('Select a collection...');
    });

    it('should add collection options', () => {
      stacBrowser.populateCollections(collections);

      expect(stacBrowser.collectionSelect.querySelectorAll('option').length).toBe(4); // 3 + default
    });

    it('should use title when available', () => {
      stacBrowser.populateCollections(collections);

      const option = stacBrowser.collectionSelect.querySelector('option[value="collection-1"]');
      expect(option.textContent).toBe('Collection One');
    });

    it('should use id when title is not available', () => {
      stacBrowser.populateCollections(collections);

      const option = stacBrowser.collectionSelect.querySelector('option[value="collection-3"]');
      expect(option.textContent).toBe('collection-3');
    });
  });

  describe('useCurrentViewBbox', () => {
    it('should set bbox from map bounds', () => {
      stacBrowser.useCurrentViewBbox();

      expect(stacBrowser.searchBbox).toEqual([-10, -20, 10, 20]);
    });

    it('should display bbox in UI', () => {
      stacBrowser.useCurrentViewBbox();

      expect(stacBrowser.bboxDisplay.textContent).toBe('-10.0000, -20.0000, 10.0000, 20.0000');
    });

    it('should handle missing map gracefully', () => {
      stacBrowser.mapManager = null;

      expect(() => stacBrowser.useCurrentViewBbox()).not.toThrow();
    });
  });

  describe('search', () => {
    const mockSearchResult = {
      features: [
        {
          id: 'item-1',
          geometry: { type: 'Polygon', coordinates: [] },
          properties: { datetime: '2024-01-15T10:00:00Z', cloud_cover: 5.5 },
          bbox: [-10, -20, 10, 20],
        },
      ],
      number_matched: 100,
    };

    beforeEach(() => {
      stacBrowser.currentCatalogUrl = 'https://test.api';
      stacBrowser.selectedCollection = { id: 'sentinel-2-l2a' };
    });

    it('should show error when not connected', async () => {
      stacBrowser.currentCatalogUrl = null;

      await stacBrowser.search();

      expect(showError).toHaveBeenCalledWith('Not connected', expect.any(String));
    });

    it('should show error when no collection selected', async () => {
      stacBrowser.selectedCollection = null;

      await stacBrowser.search();

      expect(showError).toHaveBeenCalledWith('No collection selected', expect.any(String));
    });

    it('should call search_stac_items with params', async () => {
      invoke.mockResolvedValueOnce(mockSearchResult);

      await stacBrowser.search();

      expect(invoke).toHaveBeenCalledWith('search_stac_items', {
        url: 'https://test.api',
        params: expect.objectContaining({
          collections: ['sentinel-2-l2a'],
          limit: 20,
        }),
        acceptInvalidCerts: false,
      });
    });

    it('should include bbox when set', async () => {
      stacBrowser.searchBbox = [-10, -20, 10, 20];
      invoke.mockResolvedValueOnce(mockSearchResult);

      await stacBrowser.search();

      expect(invoke).toHaveBeenCalledWith(
        'search_stac_items',
        expect.objectContaining({
          params: expect.objectContaining({
            bbox: [-10, -20, 10, 20],
          }),
        })
      );
    });

    it('should include datetime when dates are set', async () => {
      stacBrowser.dateStart.value = '2024-01-01';
      stacBrowser.dateEnd.value = '2024-01-31';
      invoke.mockResolvedValueOnce(mockSearchResult);

      await stacBrowser.search();

      expect(invoke).toHaveBeenCalledWith(
        'search_stac_items',
        expect.objectContaining({
          params: expect.objectContaining({
            datetime: '2024-01-01T00:00:00Z/2024-01-31T23:59:59Z',
          }),
        })
      );
    });

    it('should not include cloud cover filter (filtering done client-side)', async () => {
      stacBrowser.cloudCover.value = '20';
      invoke.mockResolvedValueOnce(mockSearchResult);

      await stacBrowser.search();

      // Cloud cover filtering is done client-side, not in the STAC query
      expect(invoke).toHaveBeenCalledWith(
        'search_stac_items',
        expect.objectContaining({
          params: expect.not.objectContaining({
            filter: expect.anything(),
          }),
        })
      );
    });

    it('should store search results', async () => {
      invoke.mockResolvedValueOnce(mockSearchResult);

      await stacBrowser.search();

      expect(stacBrowser.searchResults).toEqual(mockSearchResult.features);
    });

    it('should show results section', async () => {
      invoke.mockResolvedValueOnce(mockSearchResult);

      await stacBrowser.search();

      expect(stacBrowser.resultsSection.classList.contains('hidden')).toBe(false);
    });

    it('should disable search button during search', async () => {
      invoke.mockImplementation(
        () =>
          new Promise(resolve => {
            expect(stacBrowser.searchBtn.disabled).toBe(true);
            resolve(mockSearchResult);
          })
      );

      await stacBrowser.search();
    });

    it('should re-enable search button after search', async () => {
      invoke.mockResolvedValueOnce(mockSearchResult);

      await stacBrowser.search();

      expect(stacBrowser.searchBtn.disabled).toBe(false);
    });
  });

  describe('renderResults', () => {
    const items = [
      {
        id: 'item-1',
        properties: { datetime: '2024-01-15T10:00:00Z', cloud_cover: 5.5 },
      },
      {
        id: 'item-2',
        properties: { datetime: '2024-01-16T10:00:00Z', cloud_cover: 10.2 },
      },
    ];

    it('should show results section', () => {
      stacBrowser.renderResults(items, 100);
      expect(stacBrowser.resultsSection.classList.contains('hidden')).toBe(false);
    });

    it('should display result count', () => {
      stacBrowser.renderResults(items, 100);
      expect(stacBrowser.resultsCount.textContent).toBe('(2 of 100)');
    });

    it('should render result items', () => {
      stacBrowser.renderResults(items, 100);
      const resultItems = stacBrowser.resultsList.querySelectorAll('.stac-result-item');
      expect(resultItems.length).toBe(2);
    });

    it('should show empty state when no items', () => {
      stacBrowser.renderResults([], 0);
      expect(stacBrowser.resultsList.innerHTML).toContain('No items found');
    });
  });

  describe('clearResults', () => {
    beforeEach(() => {
      stacBrowser.searchResults = [{ id: 'test' }];
      stacBrowser.selectedItem = { id: 'test' };
      stacBrowser.resultsSection.classList.remove('hidden');
    });

    it('should clear search results', () => {
      stacBrowser.clearResults();
      expect(stacBrowser.searchResults).toEqual([]);
    });

    it('should clear selected item', () => {
      stacBrowser.clearResults();
      expect(stacBrowser.selectedItem).toBeNull();
    });

    it('should hide results section', () => {
      stacBrowser.clearResults();
      expect(stacBrowser.resultsSection.classList.contains('hidden')).toBe(true);
    });
  });

  describe('displayFootprints', () => {
    const items = [
      {
        id: 'item-1',
        geometry: { type: 'Polygon', coordinates: [] },
        properties: { datetime: '2024-01-15', cloud_cover: 5 },
        bbox: [-10, -20, 10, 20],
      },
    ];

    it('should add source when it does not exist', () => {
      mockMapManager.map.getSource.mockReturnValue(null);

      stacBrowser.displayFootprints(items);

      expect(mockMapManager.map.addSource).toHaveBeenCalledWith(
        'stac-footprints',
        expect.objectContaining({
          type: 'geojson',
        })
      );
    });

    it('should add fill layer when source does not exist', () => {
      mockMapManager.map.getSource.mockReturnValue(null);

      stacBrowser.displayFootprints(items);

      expect(mockMapManager.map.addLayer).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'stac-footprints-fill',
          type: 'fill',
        })
      );
    });

    it('should add line layer when source does not exist', () => {
      mockMapManager.map.getSource.mockReturnValue(null);

      stacBrowser.displayFootprints(items);

      expect(mockMapManager.map.addLayer).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'stac-footprints-line',
          type: 'line',
        })
      );
    });

    it('should update existing source data', () => {
      const mockSource = { setData: vi.fn() };
      mockMapManager.map.getSource.mockReturnValue(mockSource);

      stacBrowser.displayFootprints(items);

      expect(mockSource.setData).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'FeatureCollection',
        })
      );
    });

    it('should fit bounds to footprints', () => {
      mockMapManager.map.getSource.mockReturnValue(null);

      stacBrowser.displayFootprints(items);

      expect(mockMapManager.map.fitBounds).toHaveBeenCalled();
    });
  });

  describe('clearFootprints', () => {
    it('should remove line layer if it exists', () => {
      mockMapManager.map.getLayer.mockReturnValue(true);
      mockMapManager.map.getSource.mockReturnValue(true);

      stacBrowser.clearFootprints();

      expect(mockMapManager.map.removeLayer).toHaveBeenCalledWith('stac-footprints-line');
    });

    it('should remove fill layer if it exists', () => {
      mockMapManager.map.getLayer.mockReturnValue(true);
      mockMapManager.map.getSource.mockReturnValue(true);

      stacBrowser.clearFootprints();

      expect(mockMapManager.map.removeLayer).toHaveBeenCalledWith('stac-footprints-fill');
    });

    it('should remove source if it exists', () => {
      mockMapManager.map.getLayer.mockReturnValue(true);
      mockMapManager.map.getSource.mockReturnValue(true);

      stacBrowser.clearFootprints();

      expect(mockMapManager.map.removeSource).toHaveBeenCalledWith('stac-footprints');
    });

    it('should not remove layers if they do not exist', () => {
      mockMapManager.map.getLayer.mockReturnValue(null);
      mockMapManager.map.getSource.mockReturnValue(null);

      stacBrowser.clearFootprints();

      expect(mockMapManager.map.removeLayer).not.toHaveBeenCalled();
      expect(mockMapManager.map.removeSource).not.toHaveBeenCalled();
    });
  });

  describe('loadAsset', () => {
    const mockItem = {
      id: 'test-item',
      collection: 'sentinel-2-l2a',
      assets: {
        visual: {
          href: 'https://example.com/visual.tif',
          title: 'Visual',
          media_type: 'image/tiff; application=geotiff; profile=cloud-optimized',
        },
      },
    };

    const mockMetadata = {
      id: 'asset-123',
      path: '/vsicurl/https://example.com/visual.tif',
      width: 10980,
      height: 10980,
      bands: 3,
      bounds: [-10, -20, 10, 20],
      band_stats: [{ band: 1, min: 0, max: 10000 }],
      is_georeferenced: true,
    };

    it('should show error when asset not found', async () => {
      await stacBrowser.loadAsset(mockItem, 'nonexistent');

      expect(showError).toHaveBeenCalledWith('Asset not found', expect.any(String));
    });

    it('should show loading indicator', async () => {
      invoke.mockResolvedValueOnce(mockMetadata);

      await stacBrowser.loadAsset(mockItem, 'visual');

      expect(showLoading).toHaveBeenCalledWith('Loading Visual...');
    });

    it('should call open_stac_asset with asset href', async () => {
      invoke.mockResolvedValueOnce(mockMetadata);

      await stacBrowser.loadAsset(mockItem, 'visual');

      expect(invoke).toHaveBeenCalledWith('open_stac_asset', {
        assetHref: 'https://example.com/visual.tif',
        acceptInvalidCerts: false,
        stacBbox: null,
      });
    });

    it('should show success toast on completion', async () => {
      invoke.mockResolvedValueOnce(mockMetadata);

      await stacBrowser.loadAsset(mockItem, 'visual');

      expect(showToast).toHaveBeenCalledWith('Loaded Visual', 'success');
    });

    it('should hide loading indicator on completion', async () => {
      invoke.mockResolvedValueOnce(mockMetadata);

      await stacBrowser.loadAsset(mockItem, 'visual');

      expect(hideLoading).toHaveBeenCalled();
    });

    it('should show error on failure', async () => {
      invoke.mockRejectedValueOnce('Failed to load');

      await stacBrowser.loadAsset(mockItem, 'visual');

      expect(showError).toHaveBeenCalledWith('Failed to load asset', 'Failed to load');
    });

    it('should hide loading indicator on failure', async () => {
      invoke.mockRejectedValueOnce('Failed to load');

      await stacBrowser.loadAsset(mockItem, 'visual');

      expect(hideLoading).toHaveBeenCalled();
    });
  });

  describe('getDefaultStretch', () => {
    it('should apply smart stretch for 16-bit reflectance data (max >= 10000)', () => {
      const bandStats = [
        { band: 1, min: 0, max: 10000 },
        { band: 2, min: 0, max: 8000 },
      ];

      const stretch = stacBrowser.getDefaultStretch(bandStats, 1);

      // Smart stretch caps high-range data to 3500 for better display
      expect(stretch).toEqual({ min: 0, max: 3500, gamma: 1.0 });
    });

    it('should apply smart stretch for mid-range data (1000 < max < 10000)', () => {
      const bandStats = [{ band: 1, min: 0, max: 5000 }];

      const stretch = stacBrowser.getDefaultStretch(bandStats, 1);

      // Smart stretch uses ~35% of max for good contrast
      expect(stretch).toEqual({ min: 0, max: 1750, gamma: 1.0 });
    });

    it('should preserve 8-bit data range (max <= 255)', () => {
      const bandStats = [{ band: 1, min: 0, max: 255 }];

      const stretch = stacBrowser.getDefaultStretch(bandStats, 1);

      expect(stretch).toEqual({ min: 0, max: 255, gamma: 1.0 });
    });

    it('should return default values when no stats', () => {
      const stretch = stacBrowser.getDefaultStretch(null, 1);

      // Default for no stats is 0-3000 (common reflectance range)
      expect(stretch).toEqual({ min: 0, max: 3000, gamma: 1.0 });
    });
  });

  describe('getDefaultRgbStretch', () => {
    it('should return smart stretch for RGB bands', () => {
      const bandStats = [
        { band: 1, min: 0, max: 255 },
        { band: 2, min: 0, max: 255 },
        { band: 3, min: 0, max: 255 },
      ];

      const rgbStretch = stacBrowser.getDefaultRgbStretch(bandStats);

      // 8-bit data preserves full range
      expect(rgbStretch.r).toEqual({ min: 0, max: 255, gamma: 1.0 });
      expect(rgbStretch.g).toEqual({ min: 0, max: 255, gamma: 1.0 });
      expect(rgbStretch.b).toEqual({ min: 0, max: 255, gamma: 1.0 });
    });
  });

  describe('showCatalogInfo', () => {
    it('should display catalog title', () => {
      stacBrowser.showCatalogInfo({ id: 'test', title: 'Test Catalog', description: 'A test' });

      expect(stacBrowser.catalogInfo.innerHTML).toContain('Test Catalog');
    });

    it('should display catalog description', () => {
      stacBrowser.showCatalogInfo({ id: 'test', title: 'Test Catalog', description: 'A test' });

      expect(stacBrowser.catalogInfo.innerHTML).toContain('A test');
    });

    it('should use id when title is not available', () => {
      stacBrowser.showCatalogInfo({ id: 'test-id' });

      expect(stacBrowser.catalogInfo.innerHTML).toContain('test-id');
    });

    it('should remove hidden class', () => {
      stacBrowser.showCatalogInfo({ id: 'test' });

      expect(stacBrowser.catalogInfo.classList.contains('hidden')).toBe(false);
    });
  });

  describe('onCollectionChange', () => {
    beforeEach(() => {
      stacBrowser.collections = [
        {
          id: 'sentinel-2-l2a',
          title: 'Sentinel-2 L2A',
          description: 'Sentinel-2 data',
          extent: { temporal: { interval: [['2015-01-01', null]] } },
        },
      ];
      // Add option to select so value can be set
      const option = document.createElement('option');
      option.value = 'sentinel-2-l2a';
      option.textContent = 'Sentinel-2 L2A';
      stacBrowser.collectionSelect.appendChild(option);
    });

    it('should set selected collection', () => {
      stacBrowser.collectionSelect.value = 'sentinel-2-l2a';

      stacBrowser.onCollectionChange();

      expect(stacBrowser.selectedCollection.id).toBe('sentinel-2-l2a');
    });

    it('should show search section when collection selected', () => {
      stacBrowser.collectionSelect.value = 'sentinel-2-l2a';

      stacBrowser.onCollectionChange();

      expect(stacBrowser.searchSection.classList.contains('hidden')).toBe(false);
    });

    it('should clear selection when empty value', () => {
      stacBrowser.selectedCollection = { id: 'previous' };
      stacBrowser.collectionSelect.value = '';

      stacBrowser.onCollectionChange();

      expect(stacBrowser.selectedCollection).toBeNull();
    });

    it('should hide search section when empty value', () => {
      stacBrowser.searchSection.classList.remove('hidden');
      stacBrowser.collectionSelect.value = '';

      stacBrowser.onCollectionChange();

      expect(stacBrowser.searchSection.classList.contains('hidden')).toBe(true);
    });
  });

  describe('selectItem', () => {
    beforeEach(() => {
      stacBrowser.searchResults = [
        {
          id: 'item-1',
          geometry: { type: 'Polygon', coordinates: [] },
          properties: { datetime: '2024-01-15T10:00:00Z', cloud_cover: 5.5 },
          bbox: [-10, -20, 10, 20],
          assets: {},
        },
      ];
    });

    it('should set selected item', () => {
      stacBrowser.selectItem('item-1');

      expect(stacBrowser.selectedItem.id).toBe('item-1');
    });

    it('should call highlightFootprint', () => {
      const highlightSpy = vi.spyOn(stacBrowser, 'highlightFootprint');

      stacBrowser.selectItem('item-1');

      expect(highlightSpy).toHaveBeenCalledWith('item-1');
    });

    it('should zoom to item bbox', () => {
      stacBrowser.selectItem('item-1');

      expect(mockMapManager.map.fitBounds).toHaveBeenCalled();
    });

    it('should do nothing for non-existent item', () => {
      stacBrowser.selectItem('non-existent');

      expect(stacBrowser.selectedItem).toBeNull();
    });
  });

  describe('showResultsList', () => {
    it('should hide item detail section', () => {
      stacBrowser.itemDetailSection.classList.remove('hidden');

      stacBrowser.showResultsList();

      expect(stacBrowser.itemDetailSection.classList.contains('hidden')).toBe(true);
    });

    it('should show results section', () => {
      stacBrowser.resultsSection.classList.add('hidden');

      stacBrowser.showResultsList();

      expect(stacBrowser.resultsSection.classList.contains('hidden')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Static STAC Catalog Support Tests
  // -------------------------------------------------------------------------

  describe('static catalog support', () => {
    describe('constructor with static catalog state', () => {
      it('should initialize catalogType as Api by default', () => {
        expect(stacBrowser.catalogType).toBe('Api');
      });

      it('should initialize staticCollections as empty array', () => {
        expect(stacBrowser.staticCollections).toEqual([]);
      });

      it('should initialize selectedStaticCollection as null', () => {
        expect(stacBrowser.selectedStaticCollection).toBeNull();
      });
    });

    describe('connect to static catalog', () => {
      const mockStaticCatalogInfo = {
        id: 'wyvern-catalog',
        title: 'Wyvern Open Data',
        description: 'Hyperspectral satellite imagery',
        catalog_type: 'Static',
        base_url: 'https://wyvern.s3.amazonaws.com/catalog.json',
        links: [
          {
            rel: 'child',
            href: 'https://wyvern.s3.amazonaws.com/collection.json',
            title: 'Surface Reflectance',
          },
        ],
      };

      const mockStaticChildren = [
        {
          href: 'https://wyvern.s3.amazonaws.com/year/catalog.json',
          title: 'By Year',
          entry_type: 'application/json',
        },
        {
          href: 'https://wyvern.s3.amazonaws.com/surface-reflectance/collection.json',
          title: 'Surface Reflectance',
          entry_type: 'application/json',
        },
      ];

      it('should detect static catalog type', async () => {
        invoke
          .mockResolvedValueOnce(mockStaticCatalogInfo)
          .mockResolvedValueOnce(mockStaticChildren);

        await stacBrowser.connect();

        expect(stacBrowser.catalogType).toBe('Static');
      });

      it('should store base_url as currentCatalogUrl', async () => {
        invoke
          .mockResolvedValueOnce(mockStaticCatalogInfo)
          .mockResolvedValueOnce(mockStaticChildren);

        await stacBrowser.connect();

        expect(stacBrowser.currentCatalogUrl).toBe('https://wyvern.s3.amazonaws.com/catalog.json');
      });

      it('should call get_static_catalog_children for static catalogs', async () => {
        invoke
          .mockResolvedValueOnce(mockStaticCatalogInfo)
          .mockResolvedValueOnce(mockStaticChildren);

        await stacBrowser.connect();

        expect(invoke).toHaveBeenCalledWith('get_static_catalog_children', {
          catalogUrl: 'https://earth-search.aws.element84.com/v1',
          acceptInvalidCerts: false,
        });
      });

      it('should populate staticCollections for static catalogs', async () => {
        invoke
          .mockResolvedValueOnce(mockStaticCatalogInfo)
          .mockResolvedValueOnce(mockStaticChildren);

        await stacBrowser.connect();

        expect(stacBrowser.staticCollections.length).toBe(2);
      });

      it('should show toast with Static label', async () => {
        invoke
          .mockResolvedValueOnce(mockStaticCatalogInfo)
          .mockResolvedValueOnce(mockStaticChildren);

        await stacBrowser.connect();

        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Static'), 'success');
      });
    });

    describe('connect to STAC API', () => {
      const mockApiCatalogInfo = {
        id: 'earth-search',
        title: 'Earth Search',
        description: 'A STAC API',
        catalog_type: 'Api',
        base_url: 'https://earth-search.aws.element84.com/v1',
      };

      const mockApiCollections = [{ id: 'sentinel-2-l2a', title: 'Sentinel-2 L2A' }];

      it('should detect API catalog type', async () => {
        invoke.mockResolvedValueOnce(mockApiCatalogInfo).mockResolvedValueOnce(mockApiCollections);

        await stacBrowser.connect();

        expect(stacBrowser.catalogType).toBe('Api');
      });

      it('should call list_stac_collections for API catalogs', async () => {
        invoke.mockResolvedValueOnce(mockApiCatalogInfo).mockResolvedValueOnce(mockApiCollections);

        await stacBrowser.connect();

        expect(invoke).toHaveBeenCalledWith('list_stac_collections', {
          url: 'https://earth-search.aws.element84.com/v1',
          acceptInvalidCerts: false,
        });
      });

      it('should populate collections for API catalogs', async () => {
        invoke.mockResolvedValueOnce(mockApiCatalogInfo).mockResolvedValueOnce(mockApiCollections);

        await stacBrowser.connect();

        expect(stacBrowser.collections.length).toBe(1);
        expect(stacBrowser.staticCollections.length).toBe(0);
      });
    });

    describe('showCatalogInfo with catalog type', () => {
      it('should show Static Catalog label for static catalogs', () => {
        stacBrowser.showCatalogInfo(
          { id: 'test', title: 'Test Catalog', description: 'A test' },
          'Static'
        );

        expect(stacBrowser.catalogInfo.innerHTML).toContain('(Static Catalog)');
      });

      it('should not show Static Catalog label for API catalogs', () => {
        stacBrowser.showCatalogInfo(
          { id: 'test', title: 'Test Catalog', description: 'A test' },
          'Api'
        );

        expect(stacBrowser.catalogInfo.innerHTML).not.toContain('(Static Catalog)');
      });
    });

    describe('populateStaticCollections', () => {
      const staticEntries = [
        { id: 'collection-1', title: 'Collection One', url: 'https://example.com/c1.json' },
        {
          id: 'collection-2',
          title: 'Collection Two',
          url: 'https://example.com/c2.json',
          description: 'Sub-catalog',
        },
      ];

      it('should clear existing options', () => {
        stacBrowser.collectionSelect.innerHTML = '<option value="old">Old</option>';
        stacBrowser.populateStaticCollections(staticEntries);

        expect(stacBrowser.collectionSelect.querySelector('option[value="old"]')).toBeNull();
      });

      it('should add default option', () => {
        stacBrowser.populateStaticCollections(staticEntries);

        const defaultOption = stacBrowser.collectionSelect.querySelector('option[value=""]');
        expect(defaultOption).not.toBeNull();
      });

      it('should use URL as option value', () => {
        stacBrowser.populateStaticCollections(staticEntries);

        const option = stacBrowser.collectionSelect.querySelector(
          'option[value="https://example.com/c1.json"]'
        );
        expect(option).not.toBeNull();
        expect(option.textContent).toBe('Collection One');
      });

      it('should set title attribute for description', () => {
        stacBrowser.populateStaticCollections(staticEntries);

        const option = stacBrowser.collectionSelect.querySelector(
          'option[value="https://example.com/c2.json"]'
        );
        expect(option.title).toBe('Sub-catalog');
      });
    });

    describe('onCollectionChange with static catalog', () => {
      beforeEach(() => {
        stacBrowser.catalogType = 'Static';
        stacBrowser.staticCollections = [
          {
            id: 'surface-reflectance',
            title: 'Surface Reflectance',
            url: 'https://example.com/collection.json',
            description: 'Static collection',
          },
        ];
        // Add option with URL value
        const option = document.createElement('option');
        option.value = 'https://example.com/collection.json';
        option.textContent = 'Surface Reflectance';
        stacBrowser.collectionSelect.appendChild(option);
      });

      it('should set selectedStaticCollection for static catalogs', () => {
        stacBrowser.collectionSelect.value = 'https://example.com/collection.json';

        stacBrowser.onCollectionChange();

        expect(stacBrowser.selectedStaticCollection).not.toBeNull();
        expect(stacBrowser.selectedStaticCollection.url).toBe(
          'https://example.com/collection.json'
        );
      });

      it('should clear selectedCollection for static catalogs', () => {
        stacBrowser.selectedCollection = { id: 'previous' };
        stacBrowser.collectionSelect.value = 'https://example.com/collection.json';

        stacBrowser.onCollectionChange();

        expect(stacBrowser.selectedCollection).toBeNull();
      });

      it('should show search section when static collection selected', () => {
        stacBrowser.collectionSelect.value = 'https://example.com/collection.json';

        stacBrowser.onCollectionChange();

        expect(stacBrowser.searchSection.classList.contains('hidden')).toBe(false);
      });
    });

    describe('search with static catalog', () => {
      const mockBrowseResult = {
        features: [
          {
            id: 'static-item-1',
            geometry: { type: 'Polygon', coordinates: [] },
            properties: { datetime: '2024-01-15T10:00:00Z' },
            bbox: [-10, -20, 10, 20],
          },
        ],
        number_returned: 1,
      };

      beforeEach(() => {
        stacBrowser.catalogType = 'Static';
        stacBrowser.currentCatalogUrl = 'https://example.com/catalog.json';
        stacBrowser.selectedStaticCollection = {
          id: 'surface-reflectance',
          url: 'https://example.com/collection.json',
        };
      });

      it('should call browse_static_collection for static catalogs', async () => {
        invoke.mockResolvedValueOnce(mockBrowseResult);

        await stacBrowser.search();

        expect(invoke).toHaveBeenCalledWith('browse_static_collection', {
          collectionUrl: 'https://example.com/collection.json',
          limit: 20,
          acceptInvalidCerts: false,
        });
      });

      it('should not call search_stac_items for static catalogs', async () => {
        invoke.mockResolvedValueOnce(mockBrowseResult);

        await stacBrowser.search();

        expect(invoke).not.toHaveBeenCalledWith('search_stac_items', expect.anything());
      });

      it('should store browse results', async () => {
        invoke.mockResolvedValueOnce(mockBrowseResult);

        await stacBrowser.search();

        expect(stacBrowser.searchResults).toEqual(mockBrowseResult.features);
      });

      it('should show Browsing... text on button for static catalogs', async () => {
        invoke.mockImplementation(
          () =>
            new Promise(resolve => {
              expect(stacBrowser.searchBtn.textContent).toBe('Browsing...');
              resolve(mockBrowseResult);
            })
        );

        await stacBrowser.search();
      });
    });

    describe('extractIdFromUrl', () => {
      it('should extract filename without extension', () => {
        const id = stacBrowser.extractIdFromUrl('https://example.com/path/collection.json');
        expect(id).toBe('collection');
      });

      it('should handle URLs without extension', () => {
        const id = stacBrowser.extractIdFromUrl('https://example.com/path/my-catalog');
        expect(id).toBe('my-catalog');
      });

      it('should handle nested paths', () => {
        const id = stacBrowser.extractIdFromUrl('https://example.com/a/b/c/item.json');
        expect(id).toBe('item');
      });
    });

    describe('resetState with static catalog fields', () => {
      beforeEach(() => {
        stacBrowser.catalogType = 'Static';
        stacBrowser.staticCollections = [{ id: 'test', url: 'https://example.com' }];
        stacBrowser.selectedStaticCollection = { id: 'test', url: 'https://example.com' };
        stacBrowser.catalogNavHistory = [{ url: 'https://example.com/root', title: 'Root' }];
      });

      it('should reset catalogType to Api', () => {
        stacBrowser.resetState();
        expect(stacBrowser.catalogType).toBe('Api');
      });

      it('should clear staticCollections', () => {
        stacBrowser.resetState();
        expect(stacBrowser.staticCollections).toEqual([]);
      });

      it('should clear selectedStaticCollection', () => {
        stacBrowser.resetState();
        expect(stacBrowser.selectedStaticCollection).toBeNull();
      });

      it('should clear catalogNavHistory', () => {
        stacBrowser.resetState();
        expect(stacBrowser.catalogNavHistory).toEqual([]);
      });
    });

    describe('sub-catalog navigation', () => {
      const mockSubCatalogChildren = [
        {
          href: 'https://example.com/2024/collection.json',
          title: '2024 Imagery',
          entry_type: 'application/json',
        },
        {
          href: 'https://example.com/2025/collection.json',
          title: '2025 Imagery',
          entry_type: 'application/json',
        },
      ];

      beforeEach(() => {
        stacBrowser.catalogType = 'Static';
        stacBrowser.currentCatalogUrl = 'https://example.com/catalog.json';
        stacBrowser.currentCatalog = {
          id: 'root-catalog',
          title: 'Root Catalog',
          description: 'Test catalog',
        };
        stacBrowser.staticCollections = [
          {
            id: 'by-year',
            title: 'By Year',
            url: 'https://example.com/year/catalog.json',
            isCatalog: true,
            description: '📁 Sub-catalog (click to explore)',
          },
          {
            id: 'surface-reflectance',
            title: 'Surface Reflectance',
            url: 'https://example.com/surface-reflectance/collection.json',
            isCatalog: false,
          },
        ];
        stacBrowser.catalogNavHistory = [];
      });

      describe('loadStaticCatalogChildren', () => {
        it('should identify sub-catalogs by catalog.json URL', async () => {
          const mockChildren = [
            {
              href: 'https://example.com/year/catalog.json',
              title: 'By Year',
              entry_type: 'application/json',
            },
            {
              href: 'https://example.com/collection.json',
              title: 'Surface Reflectance',
              entry_type: 'application/json',
            },
          ];
          invoke.mockResolvedValueOnce(mockChildren);

          await stacBrowser.loadStaticCatalogChildren('https://example.com/catalog.json');

          expect(stacBrowser.staticCollections.length).toBe(2);

          // First should be marked as a catalog
          const yearEntry = stacBrowser.staticCollections.find(c => c.title === 'By Year');
          expect(yearEntry?.isCatalog).toBe(true);
          expect(yearEntry?.description).toContain('Sub-catalog');

          // Second should be a collection (not a catalog)
          const collectionEntry = stacBrowser.staticCollections.find(
            c => c.title === 'Surface Reflectance'
          );
          expect(collectionEntry?.isCatalog).toBe(false);
        });

        it('should populate dropdown after loading children', async () => {
          invoke.mockResolvedValueOnce(mockSubCatalogChildren);

          await stacBrowser.loadStaticCatalogChildren('https://example.com/year/catalog.json');

          const options = stacBrowser.collectionSelect.querySelectorAll('option');
          // Default option + 2 children
          expect(options.length).toBe(3);
        });
      });

      describe('navigateToSubCatalog', () => {
        it('should add current location to navigation history', async () => {
          invoke.mockResolvedValueOnce(mockSubCatalogChildren);

          const subCatalogEntry = {
            id: 'by-year',
            title: 'By Year',
            url: 'https://example.com/year/catalog.json',
            isCatalog: true,
          };

          await stacBrowser.navigateToSubCatalog(subCatalogEntry);

          expect(stacBrowser.catalogNavHistory.length).toBe(1);
          expect(stacBrowser.catalogNavHistory[0].url).toBe('https://example.com/catalog.json');
          expect(stacBrowser.catalogNavHistory[0].title).toBe('Root Catalog');
        });

        it('should update currentCatalogUrl to sub-catalog URL', async () => {
          invoke.mockResolvedValueOnce(mockSubCatalogChildren);

          const subCatalogEntry = {
            id: 'by-year',
            title: 'By Year',
            url: 'https://example.com/year/catalog.json',
            isCatalog: true,
          };

          await stacBrowser.navigateToSubCatalog(subCatalogEntry);

          expect(stacBrowser.currentCatalogUrl).toBe('https://example.com/year/catalog.json');
        });

        it('should load sub-catalog children', async () => {
          invoke.mockResolvedValueOnce(mockSubCatalogChildren);

          const subCatalogEntry = {
            id: 'by-year',
            title: 'By Year',
            url: 'https://example.com/year/catalog.json',
            isCatalog: true,
          };

          await stacBrowser.navigateToSubCatalog(subCatalogEntry);

          expect(invoke).toHaveBeenCalledWith('get_static_catalog_children', {
            catalogUrl: 'https://example.com/year/catalog.json',
            acceptInvalidCerts: false,
          });
        });

        it('should hide search section after navigation', async () => {
          invoke.mockResolvedValueOnce(mockSubCatalogChildren);
          stacBrowser.searchSection.classList.remove('hidden');

          const subCatalogEntry = {
            id: 'by-year',
            title: 'By Year',
            url: 'https://example.com/year/catalog.json',
            isCatalog: true,
          };

          await stacBrowser.navigateToSubCatalog(subCatalogEntry);

          expect(stacBrowser.searchSection.classList.contains('hidden')).toBe(true);
        });

        it('should clear selectedStaticCollection after navigation', async () => {
          invoke.mockResolvedValueOnce(mockSubCatalogChildren);
          stacBrowser.selectedStaticCollection = { id: 'test', url: 'https://example.com' };

          const subCatalogEntry = {
            id: 'by-year',
            title: 'By Year',
            url: 'https://example.com/year/catalog.json',
            isCatalog: true,
          };

          await stacBrowser.navigateToSubCatalog(subCatalogEntry);

          expect(stacBrowser.selectedStaticCollection).toBeNull();
        });

        it('should not navigate if entry is not a catalog', async () => {
          const collectionEntry = {
            id: 'surface-reflectance',
            title: 'Surface Reflectance',
            url: 'https://example.com/collection.json',
            isCatalog: false,
          };

          await stacBrowser.navigateToSubCatalog(collectionEntry);

          expect(invoke).not.toHaveBeenCalled();
          expect(stacBrowser.catalogNavHistory.length).toBe(0);
        });

        it('should show toast on successful navigation', async () => {
          invoke.mockResolvedValueOnce(mockSubCatalogChildren);

          const subCatalogEntry = {
            id: 'by-year',
            title: 'By Year',
            url: 'https://example.com/year/catalog.json',
            isCatalog: true,
          };

          await stacBrowser.navigateToSubCatalog(subCatalogEntry);

          expect(showToast).toHaveBeenCalledWith('Opened By Year', 'success');
        });

        it('should show error on navigation failure', async () => {
          invoke.mockRejectedValueOnce(new Error('Network error'));

          const subCatalogEntry = {
            id: 'by-year',
            title: 'By Year',
            url: 'https://example.com/year/catalog.json',
            isCatalog: true,
          };

          await stacBrowser.navigateToSubCatalog(subCatalogEntry);

          expect(showError).toHaveBeenCalledWith('Navigation failed', expect.anything());
        });
      });

      describe('navigateBack', () => {
        beforeEach(() => {
          stacBrowser.catalogNavHistory = [
            { url: 'https://example.com/catalog.json', title: 'Root Catalog' },
          ];
          stacBrowser.currentCatalogUrl = 'https://example.com/year/catalog.json';
        });

        it('should pop from navigation history', async () => {
          invoke.mockResolvedValueOnce(mockSubCatalogChildren);

          await stacBrowser.navigateBack();

          expect(stacBrowser.catalogNavHistory.length).toBe(0);
        });

        it('should restore parent catalog URL', async () => {
          invoke.mockResolvedValueOnce(mockSubCatalogChildren);

          await stacBrowser.navigateBack();

          expect(stacBrowser.currentCatalogUrl).toBe('https://example.com/catalog.json');
        });

        it('should load parent catalog children', async () => {
          invoke.mockResolvedValueOnce(mockSubCatalogChildren);

          await stacBrowser.navigateBack();

          expect(invoke).toHaveBeenCalledWith('get_static_catalog_children', {
            catalogUrl: 'https://example.com/catalog.json',
            acceptInvalidCerts: false,
          });
        });

        it('should do nothing if history is empty', async () => {
          stacBrowser.catalogNavHistory = [];

          await stacBrowser.navigateBack();

          expect(invoke).not.toHaveBeenCalled();
        });

        it('should hide search section after navigating back', async () => {
          invoke.mockResolvedValueOnce(mockSubCatalogChildren);
          stacBrowser.searchSection.classList.remove('hidden');

          await stacBrowser.navigateBack();

          expect(stacBrowser.searchSection.classList.contains('hidden')).toBe(true);
        });
      });

      describe('onCollectionChange with sub-catalog', () => {
        beforeEach(() => {
          // Add options to dropdown
          const catalogOption = document.createElement('option');
          catalogOption.value = 'https://example.com/year/catalog.json';
          catalogOption.textContent = 'By Year';
          stacBrowser.collectionSelect.appendChild(catalogOption);

          const collectionOption = document.createElement('option');
          collectionOption.value = 'https://example.com/surface-reflectance/collection.json';
          collectionOption.textContent = 'Surface Reflectance';
          stacBrowser.collectionSelect.appendChild(collectionOption);
        });

        it('should navigate to sub-catalog when catalog entry is selected', async () => {
          invoke.mockResolvedValueOnce(mockSubCatalogChildren);
          stacBrowser.collectionSelect.value = 'https://example.com/year/catalog.json';

          stacBrowser.onCollectionChange();

          // Wait for async navigation
          await new Promise(resolve => setTimeout(resolve, 10));

          expect(invoke).toHaveBeenCalledWith('get_static_catalog_children', {
            catalogUrl: 'https://example.com/year/catalog.json',
            acceptInvalidCerts: false,
          });
        });

        it('should reset dropdown selection after navigating to sub-catalog', async () => {
          invoke.mockResolvedValueOnce(mockSubCatalogChildren);
          stacBrowser.collectionSelect.value = 'https://example.com/year/catalog.json';

          stacBrowser.onCollectionChange();

          expect(stacBrowser.collectionSelect.value).toBe('');
        });

        it('should not navigate when collection entry is selected', () => {
          stacBrowser.collectionSelect.value =
            'https://example.com/surface-reflectance/collection.json';

          stacBrowser.onCollectionChange();

          expect(invoke).not.toHaveBeenCalled();
          expect(stacBrowser.selectedStaticCollection).not.toBeNull();
        });

        it('should show search section when collection is selected', () => {
          stacBrowser.collectionSelect.value =
            'https://example.com/surface-reflectance/collection.json';

          stacBrowser.onCollectionChange();

          expect(stacBrowser.searchSection.classList.contains('hidden')).toBe(false);
        });
      });

      describe('catalog navigation history management', () => {
        it('should build navigation history through multiple levels', async () => {
          // First navigation: root -> year
          invoke.mockResolvedValueOnce([
            {
              href: 'https://example.com/year/2024/catalog.json',
              title: '2024',
              entry_type: 'application/json',
            },
          ]);

          await stacBrowser.navigateToSubCatalog({
            id: 'by-year',
            title: 'By Year',
            url: 'https://example.com/year/catalog.json',
            isCatalog: true,
          });

          expect(stacBrowser.catalogNavHistory.length).toBe(1);

          // Update current catalog for second navigation
          stacBrowser.currentCatalog = { id: 'year', title: 'By Year', description: '' };

          // Second navigation: year -> 2024
          invoke.mockResolvedValueOnce([
            {
              href: 'https://example.com/year/2024/collection.json',
              title: '2024 Collection',
              entry_type: 'application/json',
            },
          ]);

          await stacBrowser.navigateToSubCatalog({
            id: '2024',
            title: '2024',
            url: 'https://example.com/year/2024/catalog.json',
            isCatalog: true,
          });

          expect(stacBrowser.catalogNavHistory.length).toBe(2);
          expect(stacBrowser.catalogNavHistory[0].title).toBe('Root Catalog');
          expect(stacBrowser.catalogNavHistory[1].title).toBe('By Year');
        });

        it('should navigate back through multiple levels', async () => {
          stacBrowser.catalogNavHistory = [
            { url: 'https://example.com/catalog.json', title: 'Root' },
            { url: 'https://example.com/year/catalog.json', title: 'By Year' },
          ];
          stacBrowser.currentCatalogUrl = 'https://example.com/year/2024/catalog.json';

          // Navigate back once
          invoke.mockResolvedValueOnce([]);
          await stacBrowser.navigateBack();

          expect(stacBrowser.catalogNavHistory.length).toBe(1);
          expect(stacBrowser.currentCatalogUrl).toBe('https://example.com/year/catalog.json');

          // Navigate back again
          invoke.mockResolvedValueOnce([]);
          await stacBrowser.navigateBack();

          expect(stacBrowser.catalogNavHistory.length).toBe(0);
          expect(stacBrowser.currentCatalogUrl).toBe('https://example.com/catalog.json');
        });
      });
    });
  });
});
