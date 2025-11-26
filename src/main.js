import 'maplibre-gl/dist/maplibre-gl.css';
import maplibregl from 'maplibre-gl';
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

  // Expose for debugging
  window.mapManager = mapManager;
  window.layerManager = layerManager;

  console.log('Heimdall initialized');
}

// Start the app
init().catch(console.error);
