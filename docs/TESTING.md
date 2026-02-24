# Testing Heimdall

The project includes comprehensive unit tests for both the Rust backend and JavaScript frontend.

## Running All Tests

```bash
# Run JavaScript tests
npm run test:run

# Run Rust tests
cd src-tauri && cargo test

# Run both
npm run test:run && cd src-tauri && cargo test
```

## JavaScript Tests (Vitest)

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
- Distance measurement (Haversine geodesic and pixel Euclidean)
- Pixel grid basemap (grid spacing calculation, coordinate conversion)
- Terrain functionality (enable/disable, exaggeration)

## Rust Tests

```bash
cd src-tauri

# Run all tests
cargo test

# Run tests with output
cargo test -- --nocapture

# Run specific test
cargo test test_bounds_intersect
```

Tests are located in `src-tauri/src/` and cover:

- **Tile extraction** (`gdal/tile_extractor.rs`): Coordinate conversion, bounds intersection, stretch calculations
- **Histogram computation** (`commands/raster.rs`): Histogram binning, nodata handling
- **STAC API** (`commands/stac.rs`): Data structure serialization/deserialization, URL construction, extent parsing

### Running Specific Test Suites

```bash
# Run STAC-specific tests
cargo test stac

# Run tile extractor tests
cargo test tile_extractor

# Run integration test with real COG (requires network)
cargo test test_vsicurl_real_cog -- --ignored
```

## Code Quality Checks

```bash
# JavaScript/TypeScript
npm run lint          # ESLint
npm run type-check    # TypeScript type checking

# Rust
cd src-tauri
cargo check           # Type checking
cargo clippy          # Linting
cargo fmt --check     # Formatting
```

## Pre-commit Checks

Before committing, run:

```bash
# Full CI check
make ci-lint-js
make ci-lint-rust
make ci-test-js
make ci-test-rust
```

Or use the Makefile targets:

```bash
make lint    # Run all linters
make test    # Run all tests
```
