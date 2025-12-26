.PHONY: help dev build preview test test-run test-coverage check clean install \
        tauri-dev tauri-build tauri-build-debug lint-js lint-rust fmt-js fmt-rust cargo-check cargo-test \
        ci-install ci-lint-js ci-lint-rust ci-test-js ci-test-rust ci-build ci-build-target

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
	@echo "Utilities:"
	@echo "  install        Install npm dependencies"
	@echo "  clean          Clean build artifacts"

# Development
dev:
	npm run dev

tauri-dev:
	npm run tauri:dev

preview:
	npm run preview

# Building
build:
	npm run build

tauri-build:
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

ci-build:
	npm run tauri:build

# Build for specific target (usage: make ci-build-target TARGET=aarch64-apple-darwin)
ci-build-target:
	npm run tauri:build -- --target $(TARGET)
