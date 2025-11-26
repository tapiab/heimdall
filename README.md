# Geo Viewer

A lightweight, fast geospatial raster and vector viewer built with Tauri, Rust, and MapLibre GL. Designed as a modern replacement for OpenEV.

## Features

- **Fast raster viewing** - GDAL-powered tile extraction with automatic reprojection
- **Vector support** - Load shapefiles, GeoJSON, GeoPackage, KML, and more
- **Multi-layer support** - Load multiple files, drag to reorder
- **Dynamic adjustment** - Real-time min/max/gamma controls per band
- **RGB compositing** - Combine bands from single or multiple files
- **Vector styling** - Color by field, adjust fill/stroke, view attribute table
- **Basemaps** - OpenStreetMap, Satellite imagery, or none
- **Non-georeferenced images** - View regular images with pixel coordinates
- **Keyboard-driven** - Full keyboard shortcuts for power users

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+O` | Open file(s) |
| `F` | Fit to extent |
| `R` | Reset rotation |
| `B` | Cycle basemap (OSM → Satellite → None) |
| `L` | Toggle layer panel |
| `V` | Toggle selected layer visibility |
| `A` | Open attribute table (vector layers) |
| `H` | Show histogram (raster layers) |
| `Del` | Remove selected layer |
| `Esc` | Close panels |
| `?` | Show keyboard shortcuts |
| `Ctrl+Drag` | Rotate map |
| `Scroll` | Zoom in/out |

## Supported Formats

### Raster Formats
Any raster format supported by GDAL, including:
- GeoTIFF (.tif, .tiff)
- JPEG2000 (.jp2, .j2k)
- PNG, JPEG, GIF, BMP
- ERDAS Imagine (.img)
- ENVI (.hdr, .bil, .bsq)
- NetCDF (.nc)
- HDF5 (.h5, .hdf)
- VRT (.vrt)
- And many more...

### Vector Formats
- Shapefile (.shp)
- GeoJSON (.geojson, .json)
- GeoPackage (.gpkg)
- KML/KMZ (.kml, .kmz)
- GML (.gml)
- GPX (.gpx)
- FlatGeobuf (.fgb)
- MapInfo TAB (.tab, .mif)

## Installation

### Prerequisites

- **Rust** (1.70+): https://rustup.rs/
- **Node.js** (18+): https://nodejs.org/
- **GDAL** (3.0+):
  - macOS: `brew install gdal`
  - Ubuntu: `sudo apt install libgdal-dev`
  - Windows: OSGeo4W or GISInternals

### Build from Source

```bash
# Clone the repository
git clone https://github.com/yourusername/geo-viewer.git
cd geo-viewer

# Install dependencies
npm install

# Run in development mode
npm run tauri dev

# Build for production
npm run tauri build
```

The production build outputs are located in `src-tauri/target/release/bundle/`:
- **macOS**: `.dmg` and `.app`
- **Windows**: `.msi` and `.exe`
- **Linux**: `.deb`, `.rpm`, and `.AppImage`

## Testing

The project includes comprehensive unit tests for both the Rust backend and JavaScript frontend.

### Running All Tests

```bash
# Run JavaScript tests
npm run test:run

# Run Rust tests
cd src-tauri && cargo test

# Run both
npm run test:run && cd src-tauri && cargo test
```

### JavaScript Tests (Vitest)

```bash
# Run tests once
npm run test:run

# Run tests in watch mode (for development)
npm run test

# Run tests with coverage
npm run test:coverage
```

Tests are located in `src/lib/__tests__/` and cover:
- Geospatial utility functions (bounds extraction, intersection)
- Color expression builders (categorical and graduated)
- File path utilities and format detection

### Rust Tests

```bash
cd src-tauri

# Run all tests
cargo test

# Run tests with output
cargo test -- --nocapture

# Run specific test
cargo test test_bounds_intersect
```

Tests are located in `src-tauri/src/gdal/tile_extractor.rs` and cover:
- Coordinate conversion (tile to geographic/Web Mercator)
- Bounds intersection logic
- Stretch parameter calculations

### Code Quality Checks

```bash
# JavaScript linting (if configured)
npm run lint

# Rust checks
cd src-tauri
cargo check      # Type checking
cargo clippy     # Linting
cargo fmt --check # Formatting
```

## Usage

1. **Open files**: Click "Open" or press `Ctrl+O`
2. **Navigate**: Pan with mouse drag, zoom with scroll wheel
3. **Adjust display**: Use the controls panel to adjust min/max/gamma
4. **RGB composite**: Select "RGB Composite" or "Cross-Layer RGB" mode
5. **Layer management**: Toggle visibility, adjust opacity, reorder by dragging

## CI/CD

The project includes GitLab CI configuration (`.gitlab-ci.yml`) for automated testing and multi-platform builds.

### Pipeline Stages

1. **Check**: Linting and formatting (JS tests, Rust clippy/fmt)
2. **Test**: Unit tests (JS via Vitest, Rust via cargo test)
3. **Build**: Multi-platform builds (Linux, macOS, Windows)

### Supported Build Targets

| Platform | Architecture | Artifacts |
|----------|--------------|-----------|
| Linux | x86_64 | `.deb`, `.rpm`, `.AppImage` |
| Linux | ARM64 | `.deb`, `.AppImage` |
| macOS | x86_64 | `.dmg`, `.app` |
| macOS | ARM64 (Apple Silicon) | `.dmg`, `.app` |
| Windows | x86_64 | `.msi`, `.exe` |
| Windows | ARM64 | `.msi`, `.exe` |

### Running Builds Locally

```bash
# Build for current platform
npm run tauri:build

# Build for specific target (macOS example)
npm run tauri:build -- --target aarch64-apple-darwin
npm run tauri:build -- --target x86_64-apple-darwin
```

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for technical details.

## Tech Stack

- **Frontend**: Vanilla JavaScript + MapLibre GL JS
- **Backend**: Rust + GDAL
- **Framework**: Tauri 2.0
- **Rendering**: WebGL via MapLibre

## License

MIT

## Acknowledgments

Inspired by OpenEV, the lightweight geospatial viewer that set the standard for fast raster viewing.
