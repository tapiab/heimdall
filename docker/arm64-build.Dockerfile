# ARM64 build image for Heimdall
# Used with QEMU emulation on x86_64 runners

FROM --platform=linux/arm64 rust:latest

RUN apt-get update && apt-get install -y \
    clang \
    libclang-dev \
    libgdal-dev \
    libgtk-3-dev \
    libwebkit2gtk-4.1-dev \
    libayatana-appindicator3-dev \
    libappindicator3-dev \
    librsvg2-dev \
    libssl-dev \
    patchelf \
    xdg-utils \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

RUN rustup component add clippy rustfmt
RUN rustup default stable

# Install Node.js 20 (Debian's default might be older)
RUN npm install -g n && n 20
