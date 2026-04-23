#!/bin/bash
# Bundle GDAL and all non-system dylib dependencies into the macOS .app bundle,
# then recreate the DMG.
#
# Usage: ./scripts/bundle-macos-dylibs.sh <path-to-.app> <path-to-.dmg>
# Example:
#   ./scripts/bundle-macos-dylibs.sh \
#     src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Heimdall.app \
#     src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Heimdall_0.5.0_aarch64.dmg

set -euo pipefail

APP_PATH="$1"
DMG_PATH="$2"
BINARY="$APP_PATH/Contents/MacOS/heimdall"
FRAMEWORKS_DIR="$APP_PATH/Contents/Frameworks"
SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:--}"

if [ ! -f "$BINARY" ]; then
    echo "Error: Binary not found at $BINARY"
    exit 1
fi

mkdir -p "$FRAMEWORKS_DIR"

# Return non-system dylib dependencies (absolute paths only)
get_deps() {
    otool -L "$1" 2>/dev/null | tail -n +2 | awk '{print $1}' | \
        grep -v '^/usr/lib/' | grep -v '^/System/' | grep -v '^@' || true
}

# Return @rpath references (e.g. @rpath/libgeos.3.14.1.dylib)
get_rpath_deps() {
    otool -L "$1" 2>/dev/null | tail -n +2 | awk '{print $1}' | \
        grep '^@rpath/' || true
}

# Resolve an @rpath/libfoo.dylib to an actual file path by searching homebrew
resolve_rpath() {
    local ref="$1"
    local name="${ref#@rpath/}"
    local found
    found=$(find "$BREW_PREFIX/opt" "$BREW_PREFIX/lib" -name "$name" -not -type d 2>/dev/null | head -1)
    if [ -n "$found" ]; then
        echo "$found"
    fi
}

# Phase 1a: Add GDAL runtime dependencies loaded via dlopen (not visible to otool)
# GEOS is loaded by GDAL at runtime, so otool won't find it. Seed it here and
# the recursive walk in phase 1b will pick up any further transitive deps.
echo "=== Adding GDAL runtime dependencies ==="
BREW_PREFIX=$(brew --prefix)
RUNTIME_PKGS=(geos)
for pkg in "${RUNTIME_PKGS[@]}"; do
    pkg_lib="$BREW_PREFIX/opt/$pkg/lib"
    [ -d "$pkg_lib" ] || continue
    for lib in "$pkg_lib"/lib*.dylib; do
        [ -f "$lib" ] || continue
        name=$(basename "$lib")
        if [ ! -f "$FRAMEWORKS_DIR/$name" ]; then
            cp -L "$lib" "$FRAMEWORKS_DIR/$name"
            chmod 644 "$FRAMEWORKS_DIR/$name"
            echo "  Bundling (runtime): $name"
        fi
    done
done

# Phase 1b: Recursively collect all non-system dylibs (absolute paths and @rpath refs)
echo "=== Collecting linked dylibs ==="
CHANGED=true
while $CHANGED; do
    CHANGED=false
    for file in "$BINARY" "$FRAMEWORKS_DIR"/*.dylib; do
        [ -f "$file" ] || continue
        # Absolute path dependencies
        for dep in $(get_deps "$file"); do
            name=$(basename "$dep")
            if [ ! -f "$FRAMEWORKS_DIR/$name" ]; then
                echo "  Bundling: $dep"
                cp "$dep" "$FRAMEWORKS_DIR/$name"
                chmod 644 "$FRAMEWORKS_DIR/$name"
                CHANGED=true
            fi
        done
        # @rpath dependencies — resolve to actual files in homebrew
        for dep in $(get_rpath_deps "$file"); do
            name=$(basename "$dep")
            if [ ! -f "$FRAMEWORKS_DIR/$name" ]; then
                resolved=$(resolve_rpath "$dep")
                if [ -n "$resolved" ]; then
                    echo "  Bundling (@rpath): $resolved -> $name"
                    cp -L "$resolved" "$FRAMEWORKS_DIR/$name"
                    chmod 644 "$FRAMEWORKS_DIR/$name"
                    CHANGED=true
                else
                    echo "  Warning: could not resolve $dep"
                fi
            fi
        done
    done
done

# Phase 1c: Bundle GDAL and PROJ data files
echo "=== Bundling GDAL/PROJ data ==="
RESOURCES_DIR="$APP_PATH/Contents/Resources"
mkdir -p "$RESOURCES_DIR"

GDAL_DATA_SRC="$BREW_PREFIX/opt/gdal/share/gdal"
PROJ_DATA_SRC="$BREW_PREFIX/opt/proj/share/proj"

if [ -d "$GDAL_DATA_SRC" ]; then
    cp -R "$GDAL_DATA_SRC" "$RESOURCES_DIR/gdal"
    echo "  GDAL data: $(du -sh "$RESOURCES_DIR/gdal" | awk '{print $1}')"
else
    echo "  Warning: GDAL data not found at $GDAL_DATA_SRC"
fi

if [ -d "$PROJ_DATA_SRC" ]; then
    mkdir -p "$RESOURCES_DIR/proj"
    # Only bundle proj.db (essential ~10MB) — skip the 700MB+ grid shift files
    cp "$PROJ_DATA_SRC/proj.db" "$RESOURCES_DIR/proj/"
    echo "  PROJ data: $(du -sh "$RESOURCES_DIR/proj" | awk '{print $1}')"
else
    echo "  Warning: PROJ data not found at $PROJ_DATA_SRC"
fi

# Phase 2: Fix dylib install names and references
echo "=== Fixing dylib paths ==="

# Set the id of each bundled dylib
for dylib in "$FRAMEWORKS_DIR"/*.dylib; do
    [ -f "$dylib" ] || continue
    name=$(basename "$dylib")
    install_name_tool -id "@executable_path/../Frameworks/$name" "$dylib"
done

# Rewrite all non-system references in the binary and bundled dylibs
for file in "$BINARY" "$FRAMEWORKS_DIR"/*.dylib; do
    [ -f "$file" ] || continue
    # Rewrite absolute paths (e.g. /opt/homebrew/...)
    for dep in $(get_deps "$file"); do
        name=$(basename "$dep")
        install_name_tool -change "$dep" "@executable_path/../Frameworks/$name" "$file"
    done
    # Rewrite @rpath references (e.g. @rpath/libgeos.3.14.1.dylib)
    for dep in $(get_rpath_deps "$file"); do
        name=$(basename "$dep")
        install_name_tool -change "$dep" "@executable_path/../Frameworks/$name" "$file"
    done
done

# Phase 3: Codesign (dylibs first, then the main binary)
echo "=== Codesigning (identity: $SIGNING_IDENTITY) ==="
for dylib in "$FRAMEWORKS_DIR"/*.dylib; do
    [ -f "$dylib" ] || continue
    codesign --force --sign "$SIGNING_IDENTITY" "$dylib"
done
codesign --force --sign "$SIGNING_IDENTITY" "$BINARY"

DYLIB_COUNT=$(ls -1 "$FRAMEWORKS_DIR"/*.dylib 2>/dev/null | wc -l | tr -d ' ')
echo "=== Bundled $DYLIB_COUNT dylibs ==="
ls -lh "$FRAMEWORKS_DIR"/*.dylib 2>/dev/null || true

# Phase 4: Update DMG in-place (preserves Tauri's drag-to-install layout)
echo "=== Updating DMG ==="
APP_NAME=$(basename "$APP_PATH" .app)

# Detach any mounted volumes from the old DMG
for vol in /Volumes/"$APP_NAME"*; do
    [ -d "$vol" ] && hdiutil detach "$vol" -force 2>/dev/null || true
done

# Convert Tauri's compressed DMG to read-write, resize to fit new content, then mount
RW_DMG="${DMG_PATH%.dmg}-rw.dmg"
hdiutil convert "$DMG_PATH" -format UDRW -o "$RW_DMG"

# Calculate required size: modified .app + 20MB headroom for filesystem overhead
APP_SIZE_KB=$(du -sk "$APP_PATH" | awk '{print $1}')
REQUIRED_MB=$(( (APP_SIZE_KB / 1024) + 20 ))
echo "  App size: ${APP_SIZE_KB}KB, resizing DMG to ${REQUIRED_MB}MB"
hdiutil resize -size "${REQUIRED_MB}m" "$RW_DMG"

MOUNT_DIR=$(hdiutil attach "$RW_DMG" -nobrowse | grep '/Volumes/' | awk '{print substr($0, index($0,"/Volumes/"))}')
echo "  Mounted at: $MOUNT_DIR"

# Replace the .app inside the mounted DMG
DMG_APP="$MOUNT_DIR/$APP_NAME.app"
if [ -d "$DMG_APP" ]; then
    rm -rf "$DMG_APP"
    cp -R "$APP_PATH" "$DMG_APP"
    echo "  Replaced $APP_NAME.app in DMG"
else
    echo "  Warning: $APP_NAME.app not found in DMG, copying fresh"
    cp -R "$APP_PATH" "$DMG_APP"
fi

hdiutil detach "$MOUNT_DIR"

# Convert back to compressed read-only
rm -f "$DMG_PATH"
hdiutil convert "$RW_DMG" -format UDZO -o "$DMG_PATH"
rm -f "$RW_DMG"
echo "  DMG: $DMG_PATH ($(du -h "$DMG_PATH" | awk '{print $1}'))"

echo "Done!"
