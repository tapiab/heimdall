/**
 * Georeference Panel - UI for GCP management and transformation controls
 */

import { showToast } from './notifications';
import type { GeoreferenceTool } from './georeference-tool';
import { TRANSFORMATIONS, getMinGcps, type TransformationType } from './georeference-types';

export class GeoreferencePanel {
  private tool: GeoreferenceTool;
  private panel: HTMLElement | null;
  private lastRmsError: number | null;

  constructor(tool: GeoreferenceTool) {
    this.tool = tool;
    this.panel = null;
    this.lastRmsError = null;

    // Set up callback for GCP changes
    this.tool.setOnGcpChange(() => this.updateGcpList());
  }

  /** Initialize the panel */
  init(): void {
    this.panel = document.getElementById('georef-panel');
    if (!this.panel) return;

    this.setupEventListeners();
    this.updateLayerDropdown();
    this.updateTransformDropdown();
    this.updateGcpList();
    this.updateButtons();
  }

  /** Set up event listeners for panel controls */
  private setupEventListeners(): void {
    // Close button
    const closeBtn = document.getElementById('georef-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        this.tool.deactivate();
      });
    }

    // Layer dropdown
    const layerSelect = document.getElementById('georef-layer-select') as HTMLSelectElement | null;
    if (layerSelect) {
      layerSelect.addEventListener('change', () => {
        const value = layerSelect.value;
        if (!value) {
          this.tool.setSourceLayerWithManager(null, 'primary');
        } else {
          // Parse "source:layerId" format
          const colonIndex = value.indexOf(':');
          const source = value.substring(0, colonIndex) as 'primary' | 'secondary';
          const layerId = value.substring(colonIndex + 1);
          this.tool.setSourceLayerWithManager(layerId, source);
        }
        this.updateButtons();
      });
    }

    // Transform dropdown
    const transformSelect = document.getElementById(
      'georef-transform-select'
    ) as HTMLSelectElement | null;
    if (transformSelect) {
      transformSelect.addEventListener('change', () => {
        this.tool.setTransformationType(transformSelect.value as TransformationType);
        this.updateMinGcpsLabel();
        this.updateButtons();
      });
    }

    // Add GCP button
    const addGcpBtn = document.getElementById('georef-add-gcp-btn');
    if (addGcpBtn) {
      addGcpBtn.addEventListener('click', () => {
        this.tool.startGcpCollection();
        this.updateStateDisplay();
      });
    }

    // Clear all button
    const clearAllBtn = document.getElementById('georef-clear-all-btn');
    if (clearAllBtn) {
      clearAllBtn.addEventListener('click', () => {
        if (confirm('Clear all GCPs?')) {
          this.tool.clearGcps();
          this.lastRmsError = null;
          this.updateRmsDisplay();
        }
      });
    }

    // Calculate button
    const calculateBtn = document.getElementById('georef-calculate-btn');
    if (calculateBtn) {
      calculateBtn.addEventListener('click', () => this.handleCalculate());
    }

    // Apply button
    const applyBtn = document.getElementById('georef-apply-btn');
    if (applyBtn) {
      applyBtn.addEventListener('click', () => this.handleApply());
    }

    // Cancel collection button
    const cancelBtn = document.getElementById('georef-cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        this.tool.cancelCollection();
        this.updateStateDisplay();
      });
    }

    // Manual coordinate entry
    const manualEntryBtn = document.getElementById('georef-manual-entry-btn');
    if (manualEntryBtn) {
      manualEntryBtn.addEventListener('click', () => this.showManualEntryDialog());
    }
  }

  /** Update the layer dropdown with non-georeferenced layers */
  updateLayerDropdown(): void {
    const select = document.getElementById('georef-layer-select') as HTMLSelectElement | null;
    if (!select) return;

    const layers = this.tool.getNonGeoreferencedLayers();
    const currentSelection = this.tool.getSourceLayerId();

    select.innerHTML = '<option value="">-- Select layer --</option>';
    for (const layer of layers) {
      const option = document.createElement('option');
      // Encode both id and source in the value
      option.value = `${layer.source}:${layer.id}`;
      option.textContent = layer.name;
      if (layer.id === currentSelection) {
        option.selected = true;
      }
      select.appendChild(option);
    }

    // If no layers available
    if (layers.length === 0) {
      select.innerHTML = '<option value="">No non-georeferenced layers</option>';
    }
  }

  /** Update the transform type dropdown */
  private updateTransformDropdown(): void {
    const select = document.getElementById(
      'georef-transform-select'
    ) as HTMLSelectElement | null;
    if (!select) return;

    const current = this.tool.getTransformationType();

    select.innerHTML = '';
    for (const t of TRANSFORMATIONS) {
      const option = document.createElement('option');
      option.value = t.type;
      option.textContent = `${t.name} (${t.minGcps}+ GCPs)`;
      option.title = t.description;
      if (t.type === current) {
        option.selected = true;
      }
      select.appendChild(option);
    }

    this.updateMinGcpsLabel();
  }

  /** Update the minimum GCPs label */
  private updateMinGcpsLabel(): void {
    const label = document.getElementById('georef-min-gcps-label');
    if (label) {
      const minGcps = getMinGcps(this.tool.getTransformationType());
      label.textContent = `Minimum ${minGcps} GCPs required`;
    }
  }

  /** Update the GCP list in the panel */
  updateGcpList(): void {
    const listContainer = document.getElementById('georef-gcp-list');
    if (!listContainer) return;

    const gcps = this.tool.getGcps();

    if (gcps.length === 0) {
      listContainer.innerHTML = '<div class="georef-no-gcps">No GCPs added yet</div>';
      this.updateButtons();
      return;
    }

    listContainer.innerHTML = '';

    gcps.forEach((gcp, index) => {
      const row = document.createElement('div');
      row.className = 'georef-gcp-row';
      if (!gcp.enabled) {
        row.classList.add('disabled');
      }

      // Number
      const numCell = document.createElement('span');
      numCell.className = 'georef-gcp-num';
      numCell.textContent = String(index + 1);
      row.appendChild(numCell);

      // Source coordinates
      const srcCell = document.createElement('span');
      srcCell.className = 'georef-gcp-coords';
      srcCell.textContent = `${gcp.sourceX.toFixed(2)}, ${gcp.sourceY.toFixed(2)}`;
      srcCell.title = 'Source (pixel) coordinates';
      row.appendChild(srcCell);

      // Target coordinates
      const tgtCell = document.createElement('span');
      tgtCell.className = 'georef-gcp-coords';
      tgtCell.textContent = `${gcp.targetLng.toFixed(6)}, ${gcp.targetLat.toFixed(6)}`;
      tgtCell.title = 'Target (geographic) coordinates';
      row.appendChild(tgtCell);

      // Residual
      const resCell = document.createElement('span');
      resCell.className = 'georef-gcp-residual';
      if (gcp.residual !== undefined) {
        resCell.textContent = gcp.residual.toFixed(6);
        resCell.title = 'Residual error';
      } else {
        resCell.textContent = '-';
      }
      row.appendChild(resCell);

      // Actions
      const actionsCell = document.createElement('span');
      actionsCell.className = 'georef-gcp-actions';

      // Enable/disable checkbox
      const enableCb = document.createElement('input');
      enableCb.type = 'checkbox';
      enableCb.checked = gcp.enabled;
      enableCb.title = 'Include in transformation';
      enableCb.addEventListener('change', () => {
        this.tool.updateGcp(gcp.id, { enabled: enableCb.checked });
      });
      actionsCell.appendChild(enableCb);

      // Delete button
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'georef-gcp-delete';
      deleteBtn.textContent = '\u00d7';
      deleteBtn.title = 'Delete GCP';
      deleteBtn.addEventListener('click', () => {
        this.tool.deleteGcp(gcp.id);
      });
      actionsCell.appendChild(deleteBtn);

      row.appendChild(actionsCell);
      listContainer.appendChild(row);
    });

    this.updateButtons();
  }

  /** Update button states based on current state */
  private updateButtons(): void {
    const gcps = this.tool.getEnabledGcps();
    const minGcps = getMinGcps(this.tool.getTransformationType());
    const hasEnoughGcps = gcps.length >= minGcps;
    const hasSourceLayer = this.tool.getSourceLayerId() !== null;

    const addBtn = document.getElementById('georef-add-gcp-btn') as HTMLButtonElement | null;
    const calculateBtn = document.getElementById('georef-calculate-btn') as HTMLButtonElement | null;
    const applyBtn = document.getElementById('georef-apply-btn') as HTMLButtonElement | null;
    const clearBtn = document.getElementById('georef-clear-all-btn') as HTMLButtonElement | null;

    if (addBtn) {
      addBtn.disabled = !hasSourceLayer;
    }
    if (calculateBtn) {
      calculateBtn.disabled = !hasEnoughGcps;
    }
    if (applyBtn) {
      applyBtn.disabled = !hasEnoughGcps || !hasSourceLayer;
    }
    if (clearBtn) {
      clearBtn.disabled = this.tool.getGcps().length === 0;
    }

    // Update GCP count display
    const countDisplay = document.getElementById('georef-gcp-count');
    if (countDisplay) {
      countDisplay.textContent = `${gcps.length} / ${minGcps} GCPs`;
      countDisplay.className = hasEnoughGcps ? 'enough' : 'not-enough';
    }
  }

  /** Update the state display (collecting source/target) */
  updateStateDisplay(): void {
    const stateDisplay = document.getElementById('georef-state-display');
    const cancelBtn = document.getElementById('georef-cancel-btn');
    const manualBtn = document.getElementById('georef-manual-entry-btn');

    const state = this.tool.getState();

    if (stateDisplay) {
      switch (state) {
        case 'idle':
          stateDisplay.textContent = '';
          stateDisplay.className = 'georef-state idle';
          break;
        case 'collecting_source':
          stateDisplay.textContent = 'Click on image to set source point...';
          stateDisplay.className = 'georef-state collecting';
          break;
        case 'collecting_target':
          stateDisplay.textContent = 'Click on basemap to set target, or enter manually...';
          stateDisplay.className = 'georef-state collecting';
          break;
      }
    }

    if (cancelBtn) {
      (cancelBtn as HTMLButtonElement).style.display =
        state !== 'idle' ? 'inline-block' : 'none';
    }

    if (manualBtn) {
      (manualBtn as HTMLButtonElement).style.display =
        state === 'collecting_target' ? 'inline-block' : 'none';
    }
  }

  /** Update RMS error display */
  private updateRmsDisplay(): void {
    const rmsDisplay = document.getElementById('georef-rms-display');
    if (rmsDisplay) {
      if (this.lastRmsError !== null) {
        rmsDisplay.textContent = `RMS Error: ${this.lastRmsError.toFixed(8)}`;
        rmsDisplay.style.display = 'block';
      } else {
        rmsDisplay.style.display = 'none';
      }
    }
  }

  /** Handle calculate button click */
  private async handleCalculate(): Promise<void> {
    const result = await this.tool.calculateTransformation();

    if (result.success && result.rms_error !== undefined) {
      this.lastRmsError = result.rms_error;
      this.updateRmsDisplay();
      this.updateGcpList(); // Update residuals
      showToast(`Transformation calculated. RMS Error: ${result.rms_error.toFixed(6)}`, 'success');
    } else {
      showToast(`Calculation failed: ${result.error}`, 'error');
    }
  }

  /** Handle apply button click */
  private async handleApply(): Promise<void> {
    const result = await this.tool.applyGeoreference();

    if (!result.success) {
      showToast(`Failed to apply: ${result.error}`, 'error');
    }
  }

  /** Show manual coordinate entry dialog */
  private showManualEntryDialog(): void {
    const dialog = document.createElement('div');
    dialog.className = 'georef-manual-dialog';
    dialog.innerHTML = `
      <div class="georef-manual-content">
        <h4>Enter Target Coordinates</h4>
        <div class="georef-input-row">
          <label>Longitude:</label>
          <input type="number" id="manual-lng" step="any" placeholder="-122.4194">
        </div>
        <div class="georef-input-row">
          <label>Latitude:</label>
          <input type="number" id="manual-lat" step="any" placeholder="37.7749">
        </div>
        <div class="georef-dialog-buttons">
          <button id="manual-ok">OK</button>
          <button id="manual-cancel">Cancel</button>
        </div>
      </div>
    `;

    document.body.appendChild(dialog);

    const lngInput = dialog.querySelector('#manual-lng') as HTMLInputElement;
    const latInput = dialog.querySelector('#manual-lat') as HTMLInputElement;
    const okBtn = dialog.querySelector('#manual-ok');
    const cancelBtn = dialog.querySelector('#manual-cancel');

    lngInput.focus();

    const close = () => {
      dialog.remove();
    };

    okBtn?.addEventListener('click', () => {
      const lng = parseFloat(lngInput.value);
      const lat = parseFloat(latInput.value);

      if (isNaN(lng) || isNaN(lat)) {
        showToast('Please enter valid coordinates', 'error');
        return;
      }

      if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
        showToast('Coordinates out of range', 'error');
        return;
      }

      this.tool.setTargetManually(lng, lat);
      close();
    });

    cancelBtn?.addEventListener('click', close);

    // Close on Escape
    dialog.addEventListener('keydown', e => {
      if (e.key === 'Escape') close();
      if (e.key === 'Enter') okBtn?.dispatchEvent(new Event('click'));
    });
  }
}
