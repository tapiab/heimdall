# Architecture

## Overview

Heimdall is a desktop application built with Tauri, combining a Rust backend for high-performance geospatial operations with a JavaScript frontend for the user interface.

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (JavaScript)                     │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              MapLibre GL JS (WebGL)                    │ │
│  │  ┌──────────────────────────────────────────────────┐  │ │
│  │  │  Basemap Layer (OSM/Satellite)                   │  │ │
│  │  ├──────────────────────────────────────────────────┤  │ │
│  │  │  Raster Layers (Custom tile protocol)            │  │ │
│  │  │  - Grayscale with stretch                        │  │ │
│  │  │  - RGB composite                                 │  │ │
│  │  │  - Cross-layer RGB                               │  │ │
│  │  ├──────────────────────────────────────────────────┤  │ │
│  │  │  Vector Layers (GeoJSON source)                  │  │ │
│  │  │  - Fill, Line, Circle layers                     │  │ │
│  │  │  - Categorical/graduated styling                 │  │ │
│  │  └──────────────────────────────────────────────────┘  │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ LayerManager│  │ MapManager  │  │    UI Components    │  │
│  │ - layers    │  │ - map       │  │ - Layer panel       │  │
│  │ - protocols │  │ - basemap   │  │ - Dynamic controls  │  │
│  │ - tiles     │  │ - coords    │  │ - Keyboard handler  │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ ConfigManager - User settings persistence (basemaps)   │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Tools: GeoreferenceTool, MeasureTool, AnnotationTool...│ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                        ↕ IPC (Tauri Commands)
┌─────────────────────────────────────────────────────────────┐
│                      Backend (Rust)                          │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                   Tauri Commands                        │ │
│  │  Raster: open_raster, get_tile, get_tile_stretched,   │ │
│  │    get_rgb_tile, get_cross_layer_rgb_tile,            │ │
│  │    get_pixel_tile, get_raster_stats, close_dataset    │ │
│  │  Vector: open_vector (returns GeoJSON)                │ │
│  └────────────────────────────────────────────────────────┘ │
│                            ↓                                 │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                    GDAL Module                          │ │
│  │  ┌──────────────────┐  ┌─────────────────────────────┐ │ │
│  │  │  DatasetCache    │  │     TileExtractor           │ │ │
│  │  │  - LRU cache     │  │  - extract_tile             │ │ │
│  │  │  - path storage  │  │  - extract_rgb_tile         │ │ │
│  │  │  - thread-safe   │  │  - extract_pixel_tile       │ │ │
│  │  └──────────────────┘  │  - coordinate transforms    │ │ │
│  │                        │  - PNG encoding             │ │ │
│  │                        └─────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
heimdall/
├── src/                          # Frontend code
│   ├── main.js                   # App entry point
│   ├── lib/
│   │   ├── map-manager.js        # MapLibre initialization & controls
│   │   ├── layer-manager.js      # Layer state, tile protocols, UI
│   │   ├── config-manager.js     # User configuration persistence
│   │   ├── geo-utils.js          # Geospatial utility functions
│   │   ├── ui.js                 # Keyboard shortcuts, file dialog
│   │   ├── georeference-tool.ts  # GCP collection & georeferencing workflow
│   │   ├── georeference-panel.ts # Georeferencing UI panel
│   │   ├── georeference-types.ts # TypeScript types for georeferencing
│   │   └── __tests__/            # JavaScript unit tests
│   │       ├── geo-utils.test.js # Utility function tests
│   │       ├── config-manager.test.js # Config manager tests
│   │       ├── georeference-types.test.ts # Georeferencing type tests
│   │       ├── fixtures.test.js  # Fixture-based tests
│   │       └── fixtures.js       # Test data fixtures
│   └── styles/
│       └── main.css              # Application styles
│
├── src-tauri/                    # Backend code (Rust)
│   ├── Cargo.toml                # Rust dependencies
│   ├── tauri.conf.json           # Tauri configuration
│   └── src/
│       ├── main.rs               # Tauri app setup, command registration
│       ├── commands/
│       │   ├── mod.rs            # Module exports
│       │   ├── raster.rs         # Raster commands (open, tile, stats)
│       │   ├── vector.rs         # Vector commands (open, read features)
│       │   └── georef.rs         # Georeferencing commands (transformation, output)
│       └── gdal/
│           ├── mod.rs            # Module exports
│           ├── dataset_cache.rs  # LRU cache for dataset paths
│           └── tile_extractor.rs # Core tile extraction logic + tests
│
├── docs/                         # Documentation
│   └── ARCHITECTURE.md           # This file
│
├── .github/workflows/ci.yml      # CI/CD pipeline configuration
├── vitest.config.js              # JavaScript test configuration
├── index.html                    # HTML entry point
├── package.json                  # Node.js dependencies
└── README.md                     # Project overview
```

## Data Flow

### Opening a Raster

```
User clicks Open → File Dialog → Selected path(s)
                                       ↓
                              invoke('open_raster', path)
                                       ↓
                              Rust: GDAL opens dataset
                                       ↓
                              Extract metadata:
                              - dimensions, bands, bounds
                              - projection, pixel size
                              - band statistics
                              - is_georeferenced flag
                                       ↓
                              Store path in DatasetCache
                                       ↓
                              Return RasterMetadata to frontend
                                       ↓
                              LayerManager creates layer
                              - Setup tile protocol
                              - Add MapLibre source/layer
                              - Update UI
```

### Tile Loading

```
MapLibre requests tile (z/x/y)
           ↓
Custom protocol handler (raster-{id}://)
           ↓
Check layer display mode:
├─ grayscale → get_tile_stretched / get_pixel_tile
├─ rgb → get_rgb_tile
└─ crossLayerRgb → get_cross_layer_rgb_tile / get_cross_layer_pixel_rgb_tile
           ↓
Rust backend:
1. Open dataset from cached path
2. Calculate tile bounds (Web Mercator → Geographic)
3. Check if tile intersects dataset
4. For georeferenced: GDAL reproject to tile
   For non-geo: Convert synthetic coords to pixels
5. Apply stretch (min/max/gamma)
6. Encode as PNG
           ↓
Return PNG bytes to frontend
           ↓
MapLibre renders tile
```

### Georeferencing

```
User clicks Georeference tool (G key)
           ↓
Panel shows: source layer dropdown, transform type
           ↓
User clicks "+ Add GCP"
           ↓
State: COLLECTING_SOURCE
User clicks on non-georeferenced image
           ↓
Source pixel recorded, red marker placed
State: COLLECTING_TARGET
           ↓
User clicks on basemap (or enters coords manually)
           ↓
Target coordinates recorded, green marker placed
GCP added to list, repeat for more GCPs
           ↓
User clicks "Calculate"
invoke('calculate_transformation', gcps, transform_type)
           ↓
Rust backend:
1. Build design matrix from GCPs
2. Solve least-squares for transform coefficients
3. Calculate RMS error and per-point residuals
           ↓
Frontend displays RMS error, updates residuals in GCP list
           ↓
User clicks "Apply & Save"
invoke('apply_georeference', ...)
           ↓
Rust backend:
1. For affine: set geotransform directly
2. For polynomial2/3/TPS: warp image using inverse transform
3. Write output GeoTIFF with CRS
           ↓
New georeferenced layer loaded automatically
```

## Key Components

### Frontend

#### MapManager (`map-manager.js`)
- Initializes MapLibre GL JS map
- Manages basemap layers (OSM, Satellite, Custom)
- Supports configurable satellite imagery (default: Sentinel-2 Cloudless)
- Supports custom tile URL configuration
- Handles coordinate display (geographic or pixel)
- Provides layer/source management helpers

#### ConfigManager (`config-manager.js`)
- Manages user configuration stored in app data directory
- Persists custom basemap URL and attribution
- Singleton pattern for app-wide access
- Uses Tauri's fs plugin for file operations

#### LayerManager (`layer-manager.js`)
- Maintains layer state (visibility, opacity, stretch params)
- Registers custom tile protocols with MapLibre
- Handles display modes (grayscale, RGB, cross-layer RGB)
- Manages layer panel UI and dynamic controls
- Coordinates tile requests to backend

#### UI (`ui.js`)
- File open dialog integration
- Keyboard shortcut handling
- Help overlay

#### GeoreferenceTool (`georeference-tool.ts`)
- State machine for GCP collection (IDLE → COLLECTING_SOURCE → COLLECTING_TARGET)
- MapLibre marker management for source (red) and target (green) GCPs
- Click handlers on image and basemap for coordinate capture
- Manual coordinate entry dialog for precise survey points
- Integration with backend for transformation calculation and output generation
- Progress event listener for warping feedback

### Backend

#### DatasetCache (`dataset_cache.rs`)
- LRU cache storing dataset file paths
- Thread-safe access via Mutex
- Datasets opened fresh per request (GDAL thread safety)

#### TileExtractor (`tile_extractor.rs`)
- `tile_to_web_mercator_bounds()` - Convert z/x/y to EPSG:3857
- `tile_to_geo_bounds()` - Convert z/x/y to EPSG:4326
- `extract_raw_tile()` - GDAL reproject for georeferenced data
- `extract_raw_pixel_tile()` - Direct pixel read for non-geo
- `apply_stretch()` - Min/max/gamma transformation
- `encode_png()` - Image encoding

#### Raster Commands (`raster.rs`)
- `open_raster` - Open dataset, return metadata
- `get_tile` - Auto-stretched grayscale tile
- `get_tile_stretched` - Custom stretch grayscale
- `get_rgb_tile` - RGB composite from single dataset
- `get_cross_layer_rgb_tile` - RGB from multiple datasets
- `get_pixel_tile` - Non-georeferenced grayscale
- `get_cross_layer_pixel_rgb_tile` - Non-geo cross-layer RGB
- `get_raster_stats` - Band statistics
- `get_histogram` - Histogram data for band
- `close_dataset` - Remove from cache

#### Georeferencing Commands (`georef.rs`)
- `calculate_transformation` - Compute transformation coefficients from GCPs
- `apply_georeference` - Generate georeferenced GeoTIFF output

**Transformation Types:**
- **Polynomial 1 (Affine)** - 3+ GCPs, linear transformation
- **Polynomial 2** - 6+ GCPs, quadratic terms for moderate distortion
- **Polynomial 3** - 10+ GCPs, cubic terms for complex distortion
- **Thin Plate Spline (TPS)** - 3+ GCPs, rubber-sheet transformation

**Workflow:**
1. User places Ground Control Points (GCPs) on non-georeferenced image
2. For each GCP: click on image (source pixel) then basemap (target coordinates)
3. Frontend sends GCPs to backend for transformation calculation
4. Backend computes transformation coefficients and returns RMS error + per-point residuals
5. On apply, backend warps image using computed transform and writes GeoTIFF

#### STAC Commands (`stac.rs`)
- `connect_stac_api` - Connect to STAC API or static catalog, returns `StacCatalogInfo` with auto-detected type
- `list_stac_collections` - List collections from STAC API
- `search_stac_items` - Search items using STAC API `/search` endpoint
- `open_stac_asset` - Open COG asset via `/vsicurl/`
- `get_static_catalog_children` - Get child links from static catalog
- `fetch_stac_resource` - Fetch arbitrary STAC resource by URL
- `browse_static_collection` - Browse items in static collection by following links

**Static vs API Detection:**
The backend automatically detects catalog type by:
1. Checking `conformsTo` for STAC API conformance URIs
2. Probing the `/search` endpoint as a fallback
3. Defaulting to static catalog if neither succeeds

## Coordinate Systems

### Georeferenced Images
- Stored in native CRS (e.g., UTM, geographic)
- Transformed to EPSG:4326 for bounds
- Tiles extracted in EPSG:3857 (Web Mercator) via GDAL warp

### Non-Georeferenced Images
- Use synthetic geographic coordinates
- Scale: 0.01° per pixel
- Centered at (0, 0)
- Height clamped to ±85° (Web Mercator limits)
- All non-geo images share same coordinate space (stack at center)

## Performance Considerations

1. **Dataset Caching** - Paths cached, datasets opened per-request
2. **Tile Caching** - MapLibre handles tile caching automatically
3. **Overview Selection** - GDAL automatically uses overviews when available
4. **Decimation Reading** - RasterIO resamples to tile size
5. **PNG Encoding** - Efficient image crate encoding

## Testing

### JavaScript Tests (Vitest)
- Located in `src/lib/__tests__/`
- Test geospatial utilities, color expressions, file utilities
- Run with: `npm run test:run`

### Rust Tests
- Located in `src-tauri/src/gdal/tile_extractor.rs`
- Test coordinate conversion, bounds intersection, stretch calculations
- Run with: `cd src-tauri && cargo test`

## CI/CD

GitHub Actions pipeline (`.github/workflows/ci.yml`) provides:
- **Check stage**: Linting (clippy, fmt) and JS tests
- **Test stage**: Full unit test suites
- **Build stage**: Multi-platform builds (Linux/macOS/Windows, x86_64/ARM64)

## Future Enhancements

- Band math (NDVI, etc.)
- Tile caching in backend
- Advanced color ramps and styling options
- Batch georeferencing from GCP files
