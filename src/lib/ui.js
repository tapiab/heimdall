import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { showToast } from './notifications.js';

const VECTOR_EXTENSIONS = [
  'shp',
  'geojson',
  'json',
  'gpkg',
  'kml',
  'kmz',
  'gml',
  'gpx',
  'fgb',
  'tab',
  'mif',
];

// Setup drag and drop file handling
async function setupDragAndDrop(layerManager) {
  let dropOverlay = document.getElementById('drop-overlay');
  if (!dropOverlay) {
    dropOverlay = document.createElement('div');
    dropOverlay.id = 'drop-overlay';
    dropOverlay.innerHTML = '<div class="drop-message">Drop files to open</div>';
    document.body.appendChild(dropOverlay);
  }

  // Listen for drag enter
  await listen('tauri://drag-enter', () => {
    dropOverlay.classList.add('visible');
  });

  // Listen for drag leave
  await listen('tauri://drag-leave', () => {
    dropOverlay.classList.remove('visible');
  });

  // Listen for file drop
  await listen('tauri://drag-drop', async event => {
    dropOverlay.classList.remove('visible');

    const { paths } = event.payload;
    if (!paths || paths.length === 0) return;

    for (const filePath of paths) {
      try {
        const ext = filePath.split('.').pop().toLowerCase();
        if (VECTOR_EXTENSIONS.includes(ext)) {
          await layerManager.addVectorLayer(filePath);
        } else {
          await layerManager.addRasterLayer(filePath);
        }
      } catch (error) {
        console.error('Failed to open dropped file:', error);
        showToast(`Failed to open ${filePath.split('/').pop()}`, 'error');
      }
    }
  });
}

// Helper to deactivate tools
function deactivateTools(tools) {
  const { measureTool, inspectTool, profileTool, annotationTool, zoomRectTool } = tools;

  if (measureTool && measureTool.isActive()) {
    measureTool.deactivate();
    const btn = document.getElementById('measure-btn');
    if (btn) btn.classList.remove('active');
  }
  if (inspectTool && inspectTool.isActive()) {
    inspectTool.deactivate();
    const btn = document.getElementById('inspect-btn');
    if (btn) btn.classList.remove('active');
  }
  if (profileTool && profileTool.isActive()) {
    profileTool.deactivate();
    const btn = document.getElementById('profile-btn');
    if (btn) btn.classList.remove('active');
  }
  if (annotationTool && annotationTool.isActive()) {
    annotationTool.deactivate();
    const btn = document.getElementById('annotate-btn');
    if (btn) btn.classList.remove('active');
  }
  if (zoomRectTool && zoomRectTool.isActive()) {
    zoomRectTool.deactivate();
    const btn = document.getElementById('zoom-rect-btn');
    if (btn) btn.classList.remove('active');
  }
}

export function setupUI(
  mapManager,
  layerManager,
  measureTool = null,
  inspectTool = null,
  exportTool = null,
  profileTool = null,
  annotationTool = null,
  zoomRectTool = null,
  projectManager = null,
  stacBrowser = null
) {
  // File menu
  const fileMenuBtn = document.getElementById('file-menu-btn');
  const fileMenuDropdown = document.getElementById('file-menu-dropdown');
  if (fileMenuBtn && fileMenuDropdown) {
    fileMenuBtn.addEventListener('click', e => {
      e.stopPropagation();
      const isVisible = fileMenuDropdown.classList.toggle('visible');
      if (isVisible) {
        // Position dropdown below button
        const rect = fileMenuBtn.getBoundingClientRect();
        fileMenuDropdown.style.top = `${rect.bottom + 2}px`;
        fileMenuDropdown.style.left = `${rect.left}px`;
      }
      // Close annotation dropdown if open
      const annotationDropdown = document.getElementById('annotation-dropdown');
      if (annotationDropdown) annotationDropdown.classList.remove('visible');
    });

    // Handle file menu actions
    fileMenuDropdown.querySelectorAll('.menu-item').forEach(item => {
      item.addEventListener('click', e => {
        e.stopPropagation();
        const { action } = item.dataset;
        fileMenuDropdown.classList.remove('visible');

        switch (action) {
          case 'open-file':
            openFileDialog(layerManager);
            break;
          case 'save-project':
            if (projectManager) projectManager.saveProject();
            break;
          case 'load-project':
            if (projectManager) projectManager.loadProject();
            break;
          case 'export-png':
            if (exportTool) exportTool.exportView('png');
            break;
          case 'export-highres':
            if (exportTool) exportTool.exportHighRes(2, 'png');
            break;
          case 'copy-clipboard':
            if (exportTool) exportTool.copyToClipboard();
            break;
        }
      });
    });
  }

  // Fit bounds button
  const fitBoundsBtn = document.getElementById('fit-bounds');
  if (fitBoundsBtn) {
    fitBoundsBtn.addEventListener('click', () => layerManager.fitToAllLayers());
  }

  // Zoom rectangle button
  const zoomRectBtn = document.getElementById('zoom-rect-btn');
  if (zoomRectBtn && zoomRectTool) {
    zoomRectBtn.addEventListener('click', () => {
      deactivateTools({ measureTool, inspectTool, profileTool, annotationTool });
      const active = zoomRectTool.toggle();
      zoomRectBtn.classList.toggle('active', active);
    });
  }

  // Measure button
  const measureBtn = document.getElementById('measure-btn');
  if (measureBtn && measureTool) {
    measureBtn.addEventListener('click', () => {
      deactivateTools({ inspectTool, profileTool, annotationTool, zoomRectTool });
      const active = measureTool.toggle();
      measureBtn.classList.toggle('active', active);
    });
  }

  // Inspect button
  const inspectBtn = document.getElementById('inspect-btn');
  if (inspectBtn && inspectTool) {
    inspectBtn.addEventListener('click', () => {
      deactivateTools({ measureTool, profileTool, annotationTool, zoomRectTool });
      const active = inspectTool.toggle();
      inspectBtn.classList.toggle('active', active);
    });
  }

  // Profile button
  const profileBtn = document.getElementById('profile-btn');
  if (profileBtn && profileTool) {
    profileBtn.addEventListener('click', () => {
      // Deactivate other tools
      deactivateTools({ measureTool, inspectTool, annotationTool, zoomRectTool });
      const active = profileTool.toggle();
      profileBtn.classList.toggle('active', active);
    });
  }

  // STAC button
  const stacBtn = document.getElementById('stac-btn');
  if (stacBtn && stacBrowser) {
    stacBtn.addEventListener('click', () => {
      stacBrowser.toggle();
    });
  }

  // Annotation button and dropdown
  const annotateBtn = document.getElementById('annotate-btn');
  const annotationDropdown = document.getElementById('annotation-dropdown');
  if (annotateBtn && annotationTool) {
    annotateBtn.addEventListener('click', e => {
      e.stopPropagation();
      // Toggle dropdown
      if (annotationDropdown) {
        const isVisible = annotationDropdown.classList.toggle('visible');
        if (isVisible) {
          // Position dropdown below button
          const rect = annotateBtn.getBoundingClientRect();
          annotationDropdown.style.top = `${rect.bottom + 2}px`;
          annotationDropdown.style.left = `${rect.left}px`;
        }
        // Close file menu if open
        const fileMenuDropdown = document.getElementById('file-menu-dropdown');
        if (fileMenuDropdown) fileMenuDropdown.classList.remove('visible');
      }
    });

    // Handle mode selection
    if (annotationDropdown) {
      annotationDropdown.querySelectorAll('.menu-item').forEach(option => {
        option.addEventListener('click', e => {
          e.stopPropagation();
          const { mode } = option.dataset;

          // Deactivate other tools
          deactivateTools({ measureTool, inspectTool, profileTool, zoomRectTool });

          // Set annotation mode
          annotationTool.setMode(mode);
          annotateBtn.classList.add('active');
          annotationDropdown.classList.remove('visible');

          // Update active state in dropdown
          annotationDropdown.querySelectorAll('.menu-item').forEach(opt => {
            opt.classList.toggle('active', opt.dataset.mode === mode);
          });
        });
      });
    }
  }

  // Close all dropdowns when clicking elsewhere
  document.addEventListener('click', () => {
    const fileMenuDropdown = document.getElementById('file-menu-dropdown');
    const annotationDropdown = document.getElementById('annotation-dropdown');
    if (fileMenuDropdown) fileMenuDropdown.classList.remove('visible');
    if (annotationDropdown) annotationDropdown.classList.remove('visible');
  });

  // Setup drag and drop
  setupDragAndDrop(layerManager);

  // Reset north button
  const resetRotationBtn = document.getElementById('reset-rotation');
  if (resetRotationBtn) {
    resetRotationBtn.addEventListener('click', () => mapManager.resetNorth());
  }

  // Basemap selector
  const basemapSelect = document.getElementById('basemap-select');
  if (basemapSelect) {
    basemapSelect.value = mapManager.getBasemap();
    basemapSelect.addEventListener('change', e => {
      mapManager.setBasemap(e.target.value);
    });
  }

  // Reset view button
  const resetViewBtn = document.getElementById('reset-view');
  if (resetViewBtn) {
    resetViewBtn.addEventListener('click', () => mapManager.resetView());
  }

  // Terrain controls
  const terrainToggle = document.getElementById('terrain-toggle');
  const terrainExaggeration = document.getElementById('terrain-exaggeration');
  const exaggerationSlider = document.getElementById('exaggeration-slider');
  const exaggerationValue = document.getElementById('exaggeration-value');

  if (terrainToggle) {
    terrainToggle.addEventListener('change', e => {
      if (e.target.checked) {
        const result = mapManager.enableTerrain();
        if (!result.success) {
          // Terrain not available (e.g., in pixel coord mode or network error)
          e.target.checked = false;
          console.warn('Failed to enable terrain:', result.error);
          alert(`3D terrain is not available: ${result.error}`);
          return;
        }
        if (terrainExaggeration) {
          terrainExaggeration.classList.remove('hidden');
        }
      } else {
        mapManager.disableTerrain();
        if (terrainExaggeration) {
          terrainExaggeration.classList.add('hidden');
        }
      }
    });
  }

  if (exaggerationSlider) {
    exaggerationSlider.addEventListener('input', e => {
      const value = parseFloat(e.target.value);
      if (exaggerationValue) {
        exaggerationValue.textContent = value.toFixed(1);
      }
      mapManager.setTerrainExaggeration(value);
    });
  }

  // Controls panel toggle button
  const controlsPanelToggle = document.getElementById('controls-panel-toggle');
  if (controlsPanelToggle) {
    controlsPanelToggle.addEventListener('click', () => toggleControlsPanel());
  }

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    // Don't trigger shortcuts when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      return;
    }

    // Ctrl+O to open file
    if ((e.ctrlKey || e.metaKey) && e.key === 'o' && !e.shiftKey) {
      e.preventDefault();
      openFileDialog(layerManager);
    }
    // Ctrl+S to save project
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (projectManager) {
        projectManager.saveProject();
      }
    }
    // Ctrl+Shift+O to load project
    if ((e.ctrlKey || e.metaKey) && e.key === 'O' && e.shiftKey) {
      e.preventDefault();
      if (projectManager) {
        projectManager.loadProject();
      }
    }
    // R to reset rotation
    if (e.key === 'r' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      mapManager.resetNorth();
    }
    // F to fit to extent
    if (e.key === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      layerManager.fitToAllLayers();
    }
    // B to cycle basemap (osm -> satellite -> pixel -> none -> osm)
    if (e.key === 'b' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const current = mapManager.getBasemap();
      let next;
      if (current === 'osm') next = 'satellite';
      else if (current === 'satellite') next = mapManager.isPixelCoordMode() ? 'pixel' : 'none';
      else if (current === 'pixel') next = 'none';
      else next = 'osm';
      mapManager.setBasemap(next);
      if (basemapSelect) {
        basemapSelect.value = next;
      }
    }
    // T to toggle 3D terrain
    if (e.key === 't' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const result = mapManager.toggleTerrain();
      const terrainToggle = document.getElementById('terrain-toggle');
      const terrainExaggeration = document.getElementById('terrain-exaggeration');

      if (!result.success && result.error) {
        console.warn('Failed to toggle terrain:', result.error);
        return;
      }

      const { enabled } = result;
      if (terrainToggle) {
        terrainToggle.checked = enabled;
      }
      if (terrainExaggeration) {
        if (enabled) {
          terrainExaggeration.classList.remove('hidden');
        } else {
          terrainExaggeration.classList.add('hidden');
        }
      }
    }
    // L to toggle layer panel
    if (e.key === 'l' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      toggleLayerPanel();
    }
    // D to toggle display/controls panel
    if (e.key === 'd' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      toggleControlsPanel();
    }
    // Delete/Backspace to remove selected layer
    if ((e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey && !e.metaKey) {
      if (layerManager.selectedLayerId) {
        layerManager.removeLayer(layerManager.selectedLayerId);
      }
    }
    // V to toggle selected layer visibility
    if (e.key === 'v' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (layerManager.selectedLayerId) {
        layerManager.toggleLayerVisibility(layerManager.selectedLayerId);
      }
    }
    // Shift+A to open attribute table for selected vector layer (A is now for annotate)
    if (e.key === 'A' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (layerManager.selectedLayerId) {
        const layer = layerManager.layers.get(layerManager.selectedLayerId);
        if (layer && layer.type === 'vector') {
          layerManager.showAttributeTable(layerManager.selectedLayerId);
        }
      }
    }
    // H to show histogram for selected raster layer
    if (e.key === 'h' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (layerManager.selectedLayerId) {
        const layer = layerManager.layers.get(layerManager.selectedLayerId);
        if (layer && layer.type === 'raster') {
          layerManager.showHistogram(layerManager.selectedLayerId, layer.band || 1);
        }
      }
    }
    // Z to toggle zoom rectangle mode
    if (e.key === 'z' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (zoomRectTool) {
        deactivateTools({ measureTool, inspectTool, profileTool, annotationTool });
        const active = zoomRectTool.toggle();
        const zoomRectBtn = document.getElementById('zoom-rect-btn');
        if (zoomRectBtn) {
          zoomRectBtn.classList.toggle('active', active);
        }
      }
    }
    // M to toggle measure mode
    if (e.key === 'm' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (measureTool) {
        deactivateTools({ inspectTool, profileTool, annotationTool, zoomRectTool });
        const active = measureTool.toggle();
        const measureBtn = document.getElementById('measure-btn');
        if (measureBtn) {
          measureBtn.classList.toggle('active', active);
        }
      }
    }
    // I to toggle inspect mode
    if (e.key === 'i' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (inspectTool) {
        deactivateTools({ measureTool, profileTool, annotationTool, zoomRectTool });
        const active = inspectTool.toggle();
        const inspectBtn = document.getElementById('inspect-btn');
        if (inspectBtn) {
          inspectBtn.classList.toggle('active', active);
        }
      }
    }
    // A to toggle annotation mode (marker by default)
    if (e.key === 'a' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      if (annotationTool) {
        if (annotationTool.isActive()) {
          annotationTool.deactivate();
          const annotateBtn = document.getElementById('annotate-btn');
          if (annotateBtn) annotateBtn.classList.remove('active');
        } else {
          deactivateTools({ measureTool, inspectTool, profileTool, zoomRectTool });
          annotationTool.activate('marker');
          const annotateBtn = document.getElementById('annotate-btn');
          if (annotateBtn) annotateBtn.classList.add('active');
        }
      }
    }
    // E to export view
    if (e.key === 'e' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (exportTool) {
        exportTool.exportView('png');
      }
    }
    // Ctrl+Shift+E to export high-res (2x)
    if (e.key === 'E' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
      e.preventDefault();
      if (exportTool) {
        exportTool.exportHighRes(2, 'png');
      }
    }
    // Ctrl+Shift+C to copy to clipboard
    if (e.key === 'C' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
      e.preventDefault();
      if (exportTool) {
        exportTool.copyToClipboard();
      }
    }
    // P to toggle profile mode
    if (e.key === 'p' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (profileTool) {
        deactivateTools({ measureTool, inspectTool, annotationTool, zoomRectTool });
        const active = profileTool.toggle();
        const profileBtn = document.getElementById('profile-btn');
        if (profileBtn) {
          profileBtn.classList.toggle('active', active);
        }
      }
    }
    // C to toggle STAC browser
    if (e.key === 'c' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (stacBrowser && typeof stacBrowser.toggle === 'function') {
        stacBrowser.toggle();
      }
    }
    // Enter to generate profile when in profile mode
    if (e.key === 'Enter' && profileTool && profileTool.isActive()) {
      e.preventDefault();
      profileTool.generateProfile();
    }
    // Escape to close panels and cancel tools
    if (e.key === 'Escape') {
      // Cancel all active tools
      deactivateTools({ measureTool, inspectTool, profileTool, annotationTool, zoomRectTool });
      // Close profile panel
      const profilePanel = document.getElementById('profile-panel');
      if (profilePanel) {
        profilePanel.remove();
      }
      // Close attribute panel
      const attrPanel = document.getElementById('attribute-panel');
      if (attrPanel && attrPanel.classList.contains('visible')) {
        attrPanel.classList.remove('visible');
      }
      // Close histogram panel
      const histPanel = document.getElementById('histogram-panel');
      if (histPanel && histPanel.classList.contains('visible')) {
        histPanel.classList.remove('visible');
      }
      // Close STAC panel
      if (stacBrowser && typeof stacBrowser.isVisible === 'function' && stacBrowser.isVisible()) {
        stacBrowser.hide();
      }
      // Close shortcuts help
      const helpPanel = document.getElementById('shortcuts-help');
      if (helpPanel) {
        helpPanel.remove();
      }
    }
    // ? to show help
    if (e.key === '?' || (e.shiftKey && e.key === '/')) {
      showShortcutsHelp();
    }
  });
}

function toggleLayerPanel() {
  const panel = document.getElementById('layer-panel');
  if (panel) {
    panel.classList.toggle('collapsed');
  }
}

function toggleControlsPanel() {
  const panel = document.getElementById('controls-panel');
  const toggleBtn = document.getElementById('controls-panel-toggle');
  if (panel) {
    panel.classList.toggle('collapsed');
    if (toggleBtn) {
      toggleBtn.textContent = panel.classList.contains('collapsed') ? '+' : '−';
    }
  }
}

function showShortcutsHelp() {
  const existingHelp = document.getElementById('shortcuts-help');
  if (existingHelp) {
    existingHelp.remove();
    return;
  }

  const helpDiv = document.createElement('div');
  helpDiv.id = 'shortcuts-help';
  const versionEl = document.getElementById('version-display');
  const versionText = versionEl ? versionEl.textContent : 'Heimdall';

  helpDiv.innerHTML = `
    <div class="shortcuts-content">
      <h3>Keyboard Shortcuts</h3>
      <div class="shortcut-list">
        <div class="shortcut"><kbd>Ctrl+O</kbd> Open file</div>
        <div class="shortcut"><kbd>Ctrl+S</kbd> Save project</div>
        <div class="shortcut"><kbd>Ctrl+Shift+O</kbd> Load project</div>
        <div class="shortcut"><kbd>F</kbd> Fit to extent</div>
        <div class="shortcut"><kbd>M</kbd> Measure distance</div>
        <div class="shortcut"><kbd>I</kbd> Inspect pixel values</div>
        <div class="shortcut"><kbd>E</kbd> Export view as PNG</div>
        <div class="shortcut"><kbd>P</kbd> Elevation profile</div>
        <div class="shortcut"><kbd>C</kbd> STAC catalog browser</div>
        <div class="shortcut"><kbd>A</kbd> Add annotation</div>
        <div class="shortcut"><kbd>R</kbd> Reset rotation</div>
        <div class="shortcut"><kbd>B</kbd> Cycle basemap</div>
        <div class="shortcut"><kbd>T</kbd> Toggle 3D terrain</div>
        <div class="shortcut"><kbd>L</kbd> Toggle layer panel</div>
        <div class="shortcut"><kbd>D</kbd> Toggle display panel</div>
        <div class="shortcut"><kbd>V</kbd> Toggle layer visibility</div>
        <div class="shortcut"><kbd>Shift+A</kbd> Attribute table</div>
        <div class="shortcut"><kbd>H</kbd> Show histogram</div>
        <div class="shortcut"><kbd>Del</kbd> Remove selected layer</div>
        <div class="shortcut"><kbd>Esc</kbd> Close panels / cancel</div>
        <div class="shortcut"><kbd>?</kbd> Show/hide this help</div>
        <hr>
        <div class="shortcut"><kbd>Ctrl+Drag</kbd> Rotate map</div>
        <div class="shortcut"><kbd>Right-Drag</kbd> Pitch/tilt (3D)</div>
        <div class="shortcut"><kbd>Scroll</kbd> Zoom in/out</div>
        <div class="shortcut"><kbd>Drag</kbd> Pan map</div>
      </div>
      <div class="help-version">${versionText}</div>
      <button class="close-help">Close</button>
    </div>
  `;
  document.body.appendChild(helpDiv);

  // Close on click outside or button
  helpDiv.addEventListener('click', e => {
    if (e.target === helpDiv || e.target.classList.contains('close-help')) {
      helpDiv.remove();
    }
  });
}

async function openFileDialog(layerManager) {
  try {
    const selected = await open({
      multiple: true,
      filters: [
        {
          name: 'Geospatial Files',
          extensions: [
            'tif',
            'tiff',
            'geotiff',
            'img',
            'vrt',
            'ntf',
            'nitf',
            'dt0',
            'dt1',
            'dt2',
            'hgt',
            'ers',
            'ecw',
            'jp2',
            'j2k',
            'sid',
            'png',
            'jpg',
            'jpeg',
            'gif',
            'bmp',
            'hdr',
            'bil',
            'bsq',
            'bip',
            'grd',
            'asc',
            'dem',
            'nc',
            'hdf',
            'h5',
            'shp',
            'geojson',
            'json',
            'gpkg',
            'kml',
            'kmz',
            'gml',
            'gpx',
            'fgb',
            'tab',
            'mif',
          ],
        },
        {
          name: 'Vector Files',
          extensions: [
            'shp',
            'geojson',
            'json',
            'gpkg',
            'kml',
            'kmz',
            'gml',
            'gpx',
            'fgb',
            'tab',
            'mif',
          ],
        },
        {
          name: 'Raster Images',
          extensions: [
            'tif',
            'tiff',
            'geotiff',
            'img',
            'vrt',
            'ntf',
            'nitf',
            'dt0',
            'dt1',
            'dt2',
            'hgt',
            'ers',
            'ecw',
            'jp2',
            'j2k',
            'sid',
            'png',
            'jpg',
            'jpeg',
            'gif',
            'bmp',
            'hdr',
            'bil',
            'bsq',
            'bip',
            'grd',
            'asc',
            'dem',
            'nc',
            'hdf',
            'h5',
          ],
        },
        {
          name: 'All Files',
          extensions: ['*'],
        },
      ],
    });

    if (selected) {
      // Handle both single and multiple file selection
      const files = Array.isArray(selected) ? selected : [selected];
      const vectorExtensions = [
        'shp',
        'geojson',
        'json',
        'gpkg',
        'kml',
        'kmz',
        'gml',
        'gpx',
        'fgb',
        'tab',
        'mif',
      ];

      for (const file of files) {
        const ext = file.split('.').pop().toLowerCase();
        if (vectorExtensions.includes(ext)) {
          await layerManager.addVectorLayer(file);
        } else {
          await layerManager.addRasterLayer(file);
        }
      }
    }
  } catch (error) {
    console.error('Failed to open file:', error);
    alert(`Failed to open file: ${error}`);
  }
}
