import 'maplibre-gl/dist/maplibre-gl.css';
import { invoke } from '@tauri-apps/api/core';
import { MapManager } from './lib/map-manager.js';
import { LayerManager } from './lib/layer-manager/index.js';
import { MeasureTool } from './lib/measure-tool.js';
import { InspectTool } from './lib/inspect-tool.js';
import { ExportTool } from './lib/export-tool.js';
import { ProfileTool } from './lib/profile-tool.js';
import { AnnotationTool } from './lib/annotation-tool.js';
import { ZoomRectTool } from './lib/zoom-rect-tool.js';
import { ProjectManager } from './lib/project-manager.js';
import { StacBrowser } from './lib/stac-browser.js';
import { setupUI } from './lib/ui.js';
import { logger } from './lib/logger.js';
import { getConfigManager } from './lib/config-manager.js';

// Initialize the application
async function init() {
  // Initialize config manager first
  const configManager = getConfigManager();
  try {
    await configManager.init();
    logger.info('Config loaded');
  } catch (error) {
    logger.warn('Could not load config, using defaults', error);
  }

  // Create the map with config manager
  const mapManager = new MapManager('map', configManager);
  await mapManager.init();

  // Create layer manager
  const layerManager = new LayerManager(mapManager);

  // Create measure tool
  const measureTool = new MeasureTool(mapManager);

  // Create inspect tool
  const inspectTool = new InspectTool(mapManager, layerManager);

  // Create export tool
  const exportTool = new ExportTool(mapManager);

  // Create profile tool
  const profileTool = new ProfileTool(mapManager, layerManager);

  // Create annotation tool
  const annotationTool = new AnnotationTool(mapManager);

  // Create zoom rectangle tool
  const zoomRectTool = new ZoomRectTool(mapManager);

  // Create project manager
  const projectManager = new ProjectManager(mapManager, layerManager, annotationTool);

  // Create STAC browser
  const stacBrowser = new StacBrowser(layerManager, mapManager);

  // Setup UI interactions
  setupUI(
    mapManager,
    layerManager,
    measureTool,
    inspectTool,
    exportTool,
    profileTool,
    annotationTool,
    zoomRectTool,
    projectManager,
    stacBrowser,
    configManager
  );

  // Fetch and display version
  try {
    const version = await invoke('get_version');
    const versionEl = document.getElementById('version-display');
    if (versionEl) {
      versionEl.textContent = `Heimdall ${version}`;
    }
    logger.info(`Heimdall ${version} initialized`);
  } catch (error) {
    logger.warn('Could not fetch version', error);
    logger.info('Heimdall initialized');
  }
}

// Start the app
init().catch(err => logger.error('Failed to initialize app', err));
