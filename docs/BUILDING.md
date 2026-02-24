# Building Heimdall

This guide covers building Heimdall from source on various platforms.

## Prerequisites

- **Rust** (1.70+): https://rustup.rs/
- **Node.js** (20+): https://nodejs.org/

## Platform-Specific Dependencies

### macOS

```bash
brew install gdal
```

If the build fails with `'cpl_atomic_ops.h' file not found`, `pkg-config` can't locate the GDAL headers. Set the pkg-config path:

```bash
export PKG_CONFIG_PATH="$(brew --prefix gdal)/lib/pkgconfig:$PKG_CONFIG_PATH"
```

Add this to your `~/.zshrc` to make it persistent. Verify with:

```bash
pkg-config --cflags gdal
```

### Ubuntu/Debian

```bash
sudo apt-get update
sudo apt-get install -y \
    libgdal-dev \
    libgtk-3-dev \
    libwebkit2gtk-4.1-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    patchelf \
    xdg-utils
```

### Arch Linux

```bash
sudo pacman -S gdal gtk3 webkit2gtk-4.1 libayatana-appindicator librsvg patchelf xdg-utils
```

> **Note**: Building AppImage on Arch Linux requires Docker due to `linuxdeploy` compatibility issues. Use `make docker-build-linux` instead.

### Windows

Install GDAL via [GISInternals](https://www.gisinternals.com/release.php) or [OSGeo4W](https://trac.osgeo.org/osgeo4w/).

Set environment variables:
```powershell
$env:GDAL_HOME = "C:\path\to\gdal"
$env:GDAL_LIB_DIR = "C:\path\to\gdal\lib"
```

## Building

### Development Mode

```bash
# Clone the repository
git clone https://github.com/tapiab/heimdall.git
cd heimdall

# Install dependencies
npm install

# Run in development mode
make dev
```

### Production Build

```bash
# Build for production
make tauri-build
```

### Docker Build (Linux AppImage)

Build Linux AppImage from macOS, Windows, or non-Ubuntu Linux distros:

```bash
# Build x86_64 AppImage
make docker-build-linux

# Build ARM64 AppImage
make docker-build-linux-arm64
```

### Cross-Platform Builds (macOS)

```bash
# Build for Apple Silicon
npm run tauri:build -- --target aarch64-apple-darwin

# Build for Intel
npm run tauri:build -- --target x86_64-apple-darwin
```

## Build Outputs

Production builds are located in `src-tauri/target/release/bundle/`:

| Platform | Artifacts |
|----------|-----------|
| macOS | `.dmg`, `.app` |
| Windows | `.msi`, `.exe` |
| Linux | `.deb`, `.rpm`, `.AppImage` |

## CI/CD

The project includes GitHub Actions (`.github/workflows/ci.yml`) for automated multi-platform builds.

### Pipeline Stages

1. **Lint**: JavaScript and Rust linting
2. **Test**: Unit tests (Vitest + cargo test)
3. **Build**: Multi-platform builds

### Supported Build Targets

| Platform | Architecture | Artifacts |
|----------|--------------|-----------|
| Linux | x86_64 | `.deb`, `.rpm`, `.AppImage` |
| Linux | ARM64 | `.deb`, `.AppImage` |
| macOS | x86_64 | `.dmg` |
| macOS | ARM64 (Apple Silicon) | `.dmg` |
| Windows | x86_64 | `.msi`, `.exe` |

## Troubleshooting

### GDAL not found

Ensure GDAL is installed and `pkg-config` can find it:

```bash
pkg-config --modversion gdal
```

### WebKit errors on Linux

If you see `EGL_BAD_PARAMETER` errors, the application sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` automatically on startup.

### Windows build issues

Ensure all GDAL environment variables are set correctly and the GDAL DLLs are in your PATH.
