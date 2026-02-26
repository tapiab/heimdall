# Heimdall - Project Context for AI Agents

## Overview

Heimdall is a desktop geospatial image viewer built with Tauri. It combines a Rust backend for high-performance GDAL operations with a TypeScript/JavaScript frontend using MapLibre GL JS for WebGL rendering.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | Tauri 2.x |
| Backend | Rust |
| Frontend | TypeScript/JavaScript |
| Map Rendering | MapLibre GL JS |
| Raster Processing | GDAL (via gdal-rs) |
| Testing | Vitest (JS), cargo test (Rust) |
| Build | Vite, Cargo |

## Project Structure

```
heimdall/
├── src/                      # Frontend (TypeScript/JavaScript)
│   ├── main.js               # App entry point
│   ├── lib/
│   │   ├── map-manager.ts    # MapLibre map initialization
│   │   ├── layer-manager/    # Layer state and tile protocols
│   │   ├── ui.ts             # UI components and keyboard shortcuts
│   │   ├── georeference-*.ts # Georeferencing tool
│   │   ├── measure-tool.ts   # Distance/area measurement
│   │   ├── annotation-tool.ts# Drawing annotations
│   │   ├── stac-browser.ts   # STAC catalog browsing
│   │   └── __tests__/        # Vitest unit tests
│   └── styles/
│       └── main.css
├── src-tauri/                # Backend (Rust)
│   ├── Cargo.toml
│   ├── src/
│   │   ├── main.rs           # Tauri app setup
│   │   ├── commands/         # Tauri command handlers
│   │   │   ├── raster.rs     # Raster operations
│   │   │   ├── vector.rs     # Vector/GeoJSON operations
│   │   │   ├── georef.rs     # Georeferencing
│   │   │   └── stac.rs       # STAC API/catalog
│   │   └── gdal/             # GDAL utilities
│   │       ├── dataset_cache.rs
│   │       └── tile_extractor.rs
├── index.html
├── package.json
└── docs/ARCHITECTURE.md      # Detailed architecture docs
```

## Key Commands

```bash
# Development
npm run dev              # Start Tauri dev server
npm run build            # Build for production

# Testing
npm run test:run         # Run JS tests (Vitest)
cargo test --manifest-path src-tauri/Cargo.toml  # Run Rust tests

# Linting
npm run lint             # ESLint
cargo clippy --manifest-path src-tauri/Cargo.toml  # Rust lints
npm run type-check       # TypeScript type checking
```

## Core Features

### Raster Viewing
- Opens GeoTIFF, COG, and other GDAL-supported formats
- Supports georeferenced and non-georeferenced images
- Grayscale with min/max/gamma stretch
- RGB composite from single or multiple layers
- Pixel grid mode for inspection

### Layer Management
- Multiple layers with opacity control
- Layer reordering via drag-and-drop
- Band selection for multi-band images
- Cross-layer RGB composites

### Georeferencing
- Manual GCP (Ground Control Point) placement
- Transformation types: Polynomial 1/2/3, Thin Plate Spline
- RMS error calculation and per-point residuals
- Outputs georeferenced GeoTIFF

### STAC Integration
- Connects to STAC APIs and static catalogs
- Auto-detects catalog type
- Searches collections with bbox/datetime filters
- Opens COG assets directly via /vsicurl/

### Tools
- Measure: Distance and area measurement
- Annotate: Draw points, lines, polygons
- Profile: Elevation/value profiles along lines
- Export: Screenshot and data export
- Inspect: Pixel value inspection

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| O | Open file |
| G | Georeference tool |
| M | Measure tool |
| A | Annotate tool |
| P | Profile tool |
| I | Inspect tool |
| E | Export |
| V | Toggle split view |
| ? | Help |

## Architecture Notes

### Tile Protocol
MapLibre uses custom tile protocols (`raster-{id}://`) that invoke Tauri commands to fetch PNG tiles. The backend extracts, reprojects, stretches, and encodes tiles on demand.

### Non-Georeferenced Images
Non-geo images use synthetic coordinates (0.01°/pixel, centered at 0,0) so they can be displayed alongside georeferenced data in the same map view.

### Dataset Caching
Rust backend maintains an LRU cache of dataset paths. Datasets are opened fresh per request for thread safety with GDAL.

### Split View
Supports side-by-side comparison with synchronized or independent pan/zoom. Each view has its own LayerManager instance.

## Testing Patterns

### JavaScript (Vitest)
- Tests in `src/lib/__tests__/*.test.ts`
- Mock Tauri's `invoke` function for backend calls
- Use `vi.fn()` for mocking MapLibre and DOM

### Rust
- Tests use `#[cfg(test)]` module at bottom of files
- Test transformation math, coordinate conversions
- No GDAL file I/O in unit tests (use integration tests)

## Common Tasks

### Adding a New Tool
1. Create `src/lib/{tool-name}-tool.ts` with activate/deactivate lifecycle
2. Add to `ToolCollection` in `src/lib/ui.ts`
3. Add toolbar button in `index.html`
4. Add keyboard shortcut in `setupKeyboardShortcuts()`
5. Add CSS styles in `src/styles/main.css`

### Adding a Tauri Command
1. Add function in appropriate `src-tauri/src/commands/*.rs`
2. Add `#[tauri::command]` attribute
3. Register in `src-tauri/src/main.rs` invoke_handler
4. Call from frontend with `invoke('command_name', { args })`

### Adding Tests
- JS: Create `src/lib/__tests__/{feature}.test.ts`
- Rust: Add `#[test]` functions in `mod tests` block

## Dependencies

### Key Rust Crates
- `gdal` - Geospatial data abstraction
- `image` - PNG encoding
- `tauri` - Desktop framework
- `rayon` - Parallel processing
- `serde` - Serialization

### Key NPM Packages
- `maplibre-gl` - WebGL map rendering
- `@tauri-apps/api` - Tauri IPC
- `vitest` - Testing framework
- `typescript` - Type checking
