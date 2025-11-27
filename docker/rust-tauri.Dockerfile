FROM rust:latest

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
    && rm -rf /var/lib/apt/lists/*

RUN rustup component add clippy rustfmt
RUN rustup default stable
