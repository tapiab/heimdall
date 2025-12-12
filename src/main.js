import 'maplibre-gl/dist/maplibre-gl.css';
import maplibregl from 'maplibre-gl';
import { invoke } from '@tauri-apps/api/core';
import { MapManager } from './lib/map-manager.js';
import { LayerManager } from './lib/layer-manager.js';
import { setupUI } from './lib/ui.js';

// Initialize the application
async function init() {
  // Create the map
  const mapManager = new MapManager('map');
  await mapManager.init();

  // Create layer manager
  const layerManager = new LayerManager(mapManager);

  // Setup UI interactions
  setupUI(mapManager, layerManager);

  // Fetch and display version
  try {
    const version = await invoke('get_version');
    const versionEl = document.getElementById('version-display');
    if (versionEl) {
      versionEl.textContent = `Heimdall ${version}`;
    }
    console.log(`Heimdall ${version} initialized`);
  } catch (error) {
    console.warn('Could not fetch version:', error);
    console.log('Heimdall initialized');
  }

  // Expose for debugging
  window.mapManager = mapManager;
  window.layerManager = layerManager;
}

// Start the app
init().catch(console.error);
