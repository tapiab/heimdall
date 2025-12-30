#!/bin/bash
# Sync version from git tag to all config files
# Converts git describe to valid semver:
#   0.3.0 -> 0.3.0
#   0.3.0-2-gabcdef -> 0.3.0-dev.2
#   0.3.0-dirty -> 0.3.0-dirty
#   0.3.0-2-gabcdef-dirty -> 0.3.0-dev.2.dirty
#
# Usage: ./sync-version.sh [--windows]
#   --windows: Use 0.0.0 for Windows MSI/NSIS compatibility

set -e

WINDOWS_MODE=false
if [[ "$1" == "--windows" ]]; then
    WINDOWS_MODE=true
fi

if [[ "$WINDOWS_MODE" == true ]]; then
    # Windows: just use 0.0.0 (MSI/NSIS don't support pre-release tags)
    VERSION="0.0.0"
else
    # Get version from git describe
    GIT_DESCRIBE=$(git describe --tags --always --dirty 2>/dev/null || echo "0.0.0")
    # Remove 'v' prefix if present
    GIT_DESCRIBE="${GIT_DESCRIBE#v}"

    # Parse and convert to valid semver
    if [[ "$GIT_DESCRIBE" =~ ^([0-9]+\.[0-9]+\.[0-9]+)(-([0-9]+)-g[a-f0-9]+)?(-dirty)?$ ]]; then
        BASE="${BASH_REMATCH[1]}"
        COMMITS="${BASH_REMATCH[3]}"
        DIRTY="${BASH_REMATCH[4]}"

        VERSION="$BASE"
        if [[ -n "$COMMITS" ]] && [[ -n "$DIRTY" ]]; then
            VERSION="${BASE}-dev${COMMITS}"
        elif [[ -n "$COMMITS" ]]; then
            VERSION="${BASE}-dev${COMMITS}"
        elif [[ -n "$DIRTY" ]]; then
            VERSION="${BASE}-dev0"
        fi
    else
        # No valid tag found (shallow clone or no tags) - use fallback
        VERSION="0.0.0-dev"
    fi
fi

echo "Setting version to: $VERSION"

# Get the repo root
REPO_ROOT="$(git rev-parse --show-toplevel)"

# Update package.json
if [[ -f "$REPO_ROOT/package.json" ]]; then
    if [[ "$(uname)" == "Darwin" ]]; then
        sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$REPO_ROOT/package.json"
    else
        sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$REPO_ROOT/package.json"
    fi
    echo "  Updated package.json"
fi

# Update tauri.conf.json
if [[ -f "$REPO_ROOT/src-tauri/tauri.conf.json" ]]; then
    if [[ "$(uname)" == "Darwin" ]]; then
        sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$REPO_ROOT/src-tauri/tauri.conf.json"
    else
        sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$REPO_ROOT/src-tauri/tauri.conf.json"
    fi
    echo "  Updated src-tauri/tauri.conf.json"
fi

# Update Cargo.toml
if [[ -f "$REPO_ROOT/src-tauri/Cargo.toml" ]]; then
    if [[ "$(uname)" == "Darwin" ]]; then
        sed -i '' "s/^version = \"[^\"]*\"/version = \"$VERSION\"/" "$REPO_ROOT/src-tauri/Cargo.toml"
    else
        sed -i "s/^version = \"[^\"]*\"/version = \"$VERSION\"/" "$REPO_ROOT/src-tauri/Cargo.toml"
    fi
    echo "  Updated src-tauri/Cargo.toml"
fi

echo "Done!"
