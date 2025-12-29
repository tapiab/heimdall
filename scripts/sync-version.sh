#!/bin/bash
# Sync version from git tag to all config files
# Supports dirty builds: v0.3.0 -> 0.3.0, v0.3.0-5-gabcdef-dirty -> 0.3.0-dev.5

set -e

# Get version from git
GIT_DESCRIBE=$(git describe --tags --always --dirty 2>/dev/null || echo "0.0.0")

# Remove 'v' prefix if present
GIT_DESCRIBE="${GIT_DESCRIBE#v}"

# Convert git describe format to semver-ish format
# e.g., "0.3.0-5-gabcdef-dirty" -> "0.3.0-dev.5+gabcdef.dirty"
if [[ "$GIT_DESCRIBE" =~ ^([0-9]+\.[0-9]+\.[0-9]+)(-([0-9]+)-g([a-f0-9]+))?(-dirty)?$ ]]; then
    BASE_VERSION="${BASH_REMATCH[1]}"
    COMMITS_AHEAD="${BASH_REMATCH[3]}"
    COMMIT_HASH="${BASH_REMATCH[4]}"
    IS_DIRTY="${BASH_REMATCH[5]}"

    if [[ -n "$COMMITS_AHEAD" ]] || [[ -n "$IS_DIRTY" ]]; then
        # Development version
        VERSION="$BASE_VERSION"
        if [[ -n "$COMMITS_AHEAD" ]]; then
            VERSION="${VERSION}-dev.${COMMITS_AHEAD}"
        elif [[ -n "$IS_DIRTY" ]]; then
            VERSION="${VERSION}-dirty"
        fi
    else
        # Clean tagged version
        VERSION="$BASE_VERSION"
    fi
else
    # Fallback: use as-is (might be just a commit hash)
    VERSION="0.0.0-dev"
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
