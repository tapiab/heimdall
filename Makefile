.PHONY: help dev build preview test test-run test-coverage check clean install \
        tauri-dev tauri-build tauri-build-debug lint-js lint-rust fmt-js fmt-rust cargo-check cargo-test \
        ci-install ci-lint-js ci-lint-rust ci-test-js ci-test-rust ci-build ci-build-target \
        docker-build-linux docker-build-linux-arm64 docker-build-linux-clean sync-version

# Default target
help:
	@echo "Heimdall - Geospatial Viewer"
	@echo ""
	@echo "Usage: make [target]"
	@echo ""
	@echo "Development:"
	@echo "  dev            Start Vite dev server (frontend only)"
	@echo "  tauri-dev      Start Tauri dev mode (full app with hot reload)"
	@echo "  preview        Preview production build"
	@echo ""
	@echo "Building:"
	@echo "  build          Build frontend for production"
	@echo "  tauri-build    Build Tauri app for release"
	@echo "  tauri-build-debug  Build Tauri app for debug"
	@echo ""
	@echo "Testing:"
	@echo "  test           Run tests in watch mode"
	@echo "  test-run       Run tests once"
	@echo "  test-coverage  Run tests with coverage"
	@echo "  check          Run all checks (JS tests + Rust check + Rust tests)"
	@echo ""
	@echo "Linting & Formatting:"
	@echo "  lint-js        Run ESLint on JavaScript"
	@echo "  lint-rust      Run clippy linter on Rust"
	@echo "  fmt-js         Check JavaScript formatting with Prettier"
	@echo "  fmt-rust       Check Rust formatting"
	@echo ""
	@echo "Rust:"
	@echo "  cargo-check    Run cargo check"
	@echo "  cargo-test     Run cargo tests"
	@echo ""
	@echo "CI (used by GitHub Actions):"
	@echo "  ci-install     Install dependencies for CI"
	@echo "  ci-lint-js     Run JS linting in CI"
	@echo "  ci-lint-rust   Run Rust linting in CI"
	@echo "  ci-test-js     Run JS tests in CI"
	@echo "  ci-test-rust   Run Rust tests in CI"
	@echo "  ci-build       Build Tauri app in CI"
	@echo "  ci-build-target TARGET=<target>  Build for specific target"
	@echo ""
	@echo "Docker (for building Linux packages from any OS):"
	@echo "  docker-build-linux        Build Linux x86_64 .deb/.rpm in Docker"
	@echo "  docker-build-linux-arm64  Build Linux ARM64 .deb/.rpm in Docker"
	@echo "  docker-build-linux-clean  Rebuild without cache"
	@echo ""
	@echo "Utilities:"
	@echo "  install        Install npm dependencies"
	@echo "  clean          Clean build artifacts"
	@echo "  sync-version   Sync version from git tag to config files"

# Development
dev:
	npm run dev

tauri-dev:
	npm run tauri:dev

preview:
	npm run preview

# Version sync
sync-version:
	@./scripts/sync-version.sh

# Building
build:
	npm run build

tauri-build: sync-version
	npm run tauri:build

tauri-build-debug:
	cd src-tauri && cargo build

# Testing
test:
	npm run test

test-run:
	npm run test:run

test-coverage:
	npm run test:coverage

check:
	npm run check

# Linting & Formatting
lint-js:
	npm run lint

fmt-js:
	npm run fmt

# Rust specific
cargo-check:
	cd src-tauri && cargo check

cargo-test:
	cd src-tauri && cargo test

lint-rust:
	npm run lint:rust

fmt-rust:
	npm run fmt:rust

# Utilities
install:
	npm install

clean:
	rm -rf dist
	rm -rf src-tauri/target
	rm -rf node_modules/.vite

# CI targets (used by GitHub Actions)
ci-install:
	npm ci

ci-lint-js:
	npm run lint
	npm run fmt

ci-lint-rust:
	cd src-tauri && cargo fmt --check
	cd src-tauri && cargo clippy -- -D warnings

ci-test-js:
	npm run test:run

ci-test-rust:
	cd src-tauri && cargo test --verbose

ci-build: sync-version
	npm run tauri:build

# Build for specific target (usage: make ci-build-target TARGET=aarch64-apple-darwin)
ci-build-target: sync-version
	npm run tauri:build -- --target $(TARGET)

# Docker build targets (for building Linux AppImage from any OS)
DOCKER_IMAGE_NAME := heimdall-linux-builder
DOCKER_OUTPUT_DIR := src-tauri/target/release/bundle
# Default to x86_64 for broader Linux compatibility
DOCKER_PLATFORM ?= linux/amd64

docker-build-linux: sync-version
	@echo "Building Linux packages in Docker container ($(DOCKER_PLATFORM))..."
	docker build --platform $(DOCKER_PLATFORM) -f Dockerfile.linux -t $(DOCKER_IMAGE_NAME) .
	docker run --rm --platform $(DOCKER_PLATFORM) -v "$(CURDIR)/$(DOCKER_OUTPUT_DIR):/app/$(DOCKER_OUTPUT_DIR)" $(DOCKER_IMAGE_NAME)
	@echo ""
	@echo "Build complete! Output files:"
	@ls -la $(DOCKER_OUTPUT_DIR)/deb/*.deb 2>/dev/null || echo "  (no .deb found)"
	@ls -la $(DOCKER_OUTPUT_DIR)/rpm/*.rpm 2>/dev/null || echo "  (no .rpm found)"

docker-build-linux-arm64: sync-version
	@echo "Building Linux ARM64 packages in Docker container..."
	$(MAKE) docker-build-linux DOCKER_PLATFORM=linux/arm64

docker-build-linux-clean: sync-version
	@echo "Rebuilding Linux packages in Docker (no cache)..."
	docker build --no-cache --platform $(DOCKER_PLATFORM) -f Dockerfile.linux -t $(DOCKER_IMAGE_NAME) .
	docker run --rm --platform $(DOCKER_PLATFORM) -v "$(CURDIR)/$(DOCKER_OUTPUT_DIR):/app/$(DOCKER_OUTPUT_DIR)" $(DOCKER_IMAGE_NAME)
	@echo ""
	@echo "Build complete! Output files:"
	@ls -la $(DOCKER_OUTPUT_DIR)/deb/*.deb 2>/dev/null || echo "  (no .deb found)"
	@ls -la $(DOCKER_OUTPUT_DIR)/rpm/*.rpm 2>/dev/null || echo "  (no .rpm found)"
