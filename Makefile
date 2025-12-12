.PHONY: help dev build preview test test-run test-coverage check clean install \
        tauri-dev tauri-build tauri-build-debug lint-rust fmt-rust cargo-check cargo-test

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
	@echo "Rust:"
	@echo "  cargo-check    Run cargo check"
	@echo "  cargo-test     Run cargo tests"
	@echo "  lint-rust      Run clippy linter"
	@echo "  fmt-rust       Check Rust formatting"
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
