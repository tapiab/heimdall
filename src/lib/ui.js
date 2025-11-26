import { open } from '@tauri-apps/plugin-dialog';

export function setupUI(mapManager, layerManager) {
  // Open file button
  const openFileBtn = document.getElementById('open-file');
  if (openFileBtn) {
    openFileBtn.addEventListener('click', () => openFileDialog(layerManager));
  }

  // Fit bounds button
  const fitBoundsBtn = document.getElementById('fit-bounds');
  if (fitBoundsBtn) {
    fitBoundsBtn.addEventListener('click', () => layerManager.fitToAllLayers());
  }

  // Reset north button
  const resetRotationBtn = document.getElementById('reset-rotation');
  if (resetRotationBtn) {
    resetRotationBtn.addEventListener('click', () => mapManager.resetNorth());
  }

  // Basemap selector
  const basemapSelect = document.getElementById('basemap-select');
  if (basemapSelect) {
    basemapSelect.value = mapManager.getBasemap();
    basemapSelect.addEventListener('change', (e) => {
      mapManager.setBasemap(e.target.value);
    });
  }

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Don't trigger shortcuts when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      return;
    }

    // Ctrl+O to open file
    if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
      e.preventDefault();
      openFileDialog(layerManager);
    }
    // R to reset rotation
    if (e.key === 'r' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      mapManager.resetNorth();
    }
    // F to fit to extent
    if (e.key === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      layerManager.fitToAllLayers();
    }
    // B to cycle basemap (osm -> satellite -> none -> osm)
    if (e.key === 'b' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const current = mapManager.getBasemap();
      const next = current === 'osm' ? 'satellite' : current === 'satellite' ? 'none' : 'osm';
      mapManager.setBasemap(next);
      if (basemapSelect) {
        basemapSelect.value = next;
      }
    }
    // L to toggle layer panel
    if (e.key === 'l' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      toggleLayerPanel();
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
    // A to open attribute table for selected vector layer
    if (e.key === 'a' && !e.ctrlKey && !e.metaKey && !e.altKey) {
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
    // Escape to close panels
    if (e.key === 'Escape') {
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

function showShortcutsHelp() {
  const existingHelp = document.getElementById('shortcuts-help');
  if (existingHelp) {
    existingHelp.remove();
    return;
  }

  const helpDiv = document.createElement('div');
  helpDiv.id = 'shortcuts-help';
  helpDiv.innerHTML = `
    <div class="shortcuts-content">
      <h3>Keyboard Shortcuts</h3>
      <div class="shortcut-list">
        <div class="shortcut"><kbd>Ctrl+O</kbd> Open file</div>
        <div class="shortcut"><kbd>F</kbd> Fit to extent</div>
        <div class="shortcut"><kbd>R</kbd> Reset rotation</div>
        <div class="shortcut"><kbd>B</kbd> Cycle basemap</div>
        <div class="shortcut"><kbd>L</kbd> Toggle layer panel</div>
        <div class="shortcut"><kbd>V</kbd> Toggle layer visibility</div>
        <div class="shortcut"><kbd>A</kbd> Open attribute table</div>
        <div class="shortcut"><kbd>H</kbd> Show histogram</div>
        <div class="shortcut"><kbd>Del</kbd> Remove selected layer</div>
        <div class="shortcut"><kbd>Esc</kbd> Close panels</div>
        <div class="shortcut"><kbd>?</kbd> Show/hide this help</div>
        <hr>
        <div class="shortcut"><kbd>Ctrl+Drag</kbd> Rotate map</div>
        <div class="shortcut"><kbd>Scroll</kbd> Zoom in/out</div>
        <div class="shortcut"><kbd>Drag</kbd> Pan map</div>
      </div>
      <button class="close-help">Close</button>
    </div>
  `;
  document.body.appendChild(helpDiv);

  // Close on click outside or button
  helpDiv.addEventListener('click', (e) => {
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
          extensions: ['tif', 'tiff', 'geotiff', 'img', 'vrt', 'ntf', 'nitf', 'dt0', 'dt1', 'dt2', 'hgt', 'ers', 'ecw', 'jp2', 'j2k', 'sid', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'hdr', 'bil', 'bsq', 'bip', 'grd', 'asc', 'dem', 'nc', 'hdf', 'h5', 'shp', 'geojson', 'json', 'gpkg', 'kml', 'kmz', 'gml', 'gpx', 'fgb', 'tab', 'mif'],
        },
        {
          name: 'Vector Files',
          extensions: ['shp', 'geojson', 'json', 'gpkg', 'kml', 'kmz', 'gml', 'gpx', 'fgb', 'tab', 'mif'],
        },
        {
          name: 'Raster Images',
          extensions: ['tif', 'tiff', 'geotiff', 'img', 'vrt', 'ntf', 'nitf', 'dt0', 'dt1', 'dt2', 'hgt', 'ers', 'ecw', 'jp2', 'j2k', 'sid', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'hdr', 'bil', 'bsq', 'bip', 'grd', 'asc', 'dem', 'nc', 'hdf', 'h5'],
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
      const vectorExtensions = ['shp', 'geojson', 'json', 'gpkg', 'kml', 'kmz', 'gml', 'gpx', 'fgb', 'tab', 'mif'];

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
