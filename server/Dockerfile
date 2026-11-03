# syntax=docker/dockerfile:1
# SessionHistoryServer Container Image
# Self-contained build: a Maven stage compiles the server, a builder
# stage provides the TEN VAD native library (x86-64 prebuilt, arm64
# compiled from source against onnxruntime), a second builder stage
# builds the MP4Box (GPAC) CLI the owner export authors its MP4
# through, and a slim JRE stage runs the result. The host needs
# nothing but Docker.
#
# External resources are pinned for reproducible builds: the base
# images by digest (manifest-list, valid for all architectures), TEN
# VAD by exact commit, and onnxruntime, FFmpeg and GPAC by version or
# commit plus sha256. Only the apt packages and Maven dependencies
# float so that builds pick up security fixes; bump the ARGs and
# digests below to move forward.
#
# Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
# Visualization and Interaction - Aarhus University
# SPDX-License-Identifier: MIT

# --- pinned external resources -------------------------------- -----
ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
ARG TEMURIN_IMAGE=eclipse-temurin:17-jre@sha256:207ecae0b2b104dfc6dfa763d1e9cd2041cb344800a180e24cb1a28ed533ff90
ARG MAVEN_IMAGE=maven:3.9-eclipse-temurin-17@sha256:1a352420f7aba21f5ad08df31bab55f74c013fb491f1ae8ab1dd7ff9ed698584
# TEN VAD source and prebuilt (commit = immutable content address)
ARG TEN_VAD_COMMIT=d68ab71c8d5fbd8f98e97ae7c9986af76b5d72b1
# onnxruntime (release tag = mutable, hence additionally checksummed)
ARG ONNXRUNTIME_VERSION=1.31.0
ARG ONNXRUNTIME_SHA256=c5b8b3cca31f3d643a3b313b8f42e2d0f16a4fcefd02cda343d97bd5306afaab
# FFmpeg (release tag = mutable, hence additionally checksummed): a
# demux-only build - the Matroska demuxer and the stream parsers the
# export remux needs, nothing that encodes, decodes or talks to the
# network. GPAC's MP4Box reads the recorded .mkv media through it.
# Standalone x86 assembly is off (the parsers' C paths are all a
# demux/remux needs), so the builder needs no assembler - without
# this, ffmpeg's configure dies on x86-64 hosts ("nasm not found").
ARG FFMPEG_VERSION=n9.0.2
ARG FFMPEG_SHA256=6e374ed621e48faa40639307dff48ba6fe574a509977956d2cce9669b7cc27e9
# GPAC (MP4Box; the export needs GPAC >= 2.2): v26.07.0 is the current
# release, but its configure still links -lpostproc, which FFmpeg >= 8
# removed - this commit is the v26.07.0 tree plus the FFmpeg-9
# configure fix. Switch to a release tag once one carries the fix.
# (Ubuntu's archives stopped shipping the orphaned gpac package after
# 24.04; that is why both build from source here.)
ARG GPAC_COMMIT=12177a199999
ARG GPAC_SHA256=b24c3f116031fd7ba20675c278e4853f18562993537d88e1690e22b5dbb96485

# ---------------------------------------------------------------- -----
# Stage 1: build the server JAR
# ---------------------------------------------------------------- -----
FROM ${MAVEN_IMAGE} AS server-builder
WORKDIR /build
COPY pom.xml .
COPY libs libs
COPY src src
RUN --mount=type=cache,target=/root/.m2 \
    mvn -B clean package

# ---------------------------------------------------------------- -----
# Stage 2: provide libten_vad.so for the target architecture
# ---------------------------------------------------------------- -----
FROM ${UBUNTU_IMAGE} AS tenvad
ARG TARGETARCH
ARG TEN_VAD_COMMIT
ARG ONNXRUNTIME_VERSION
ARG ONNXRUNTIME_SHA256

# amd64 uses the official prebuilt (self-contained, linked against
# LLVM libc++). arm64 compiles from source - the current ten-vad
# sources require the onnxruntime C API and load the VAD model from
# a path relative to the working directory ('onnx_model/ten-vad.onnx').
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates curl g++; \
    mkdir -p /out; \
    case "$TARGETARCH" in \
    amd64) \
        curl -fsSL -o /out/libten_vad.so \
            "https://github.com/TEN-framework/ten-vad/raw/${TEN_VAD_COMMIT}/lib/Linux/x64/libten_vad.so" \
        ;; \
    arm64) \
        curl -fsSL -o /tmp/ten-vad.tgz \
            "https://codeload.github.com/TEN-framework/ten-vad/tar.gz/${TEN_VAD_COMMIT}"; \
        tar -C /tmp -xzf /tmp/ten-vad.tgz --no-same-owner; \
        TEN_VAD="/tmp/ten-vad-${TEN_VAD_COMMIT}"; \
        curl -fsSL -o /tmp/ort.tgz \
            "https://github.com/microsoft/onnxruntime/releases/download/v${ONNXRUNTIME_VERSION}/onnxruntime-linux-aarch64-${ONNXRUNTIME_VERSION}.tgz"; \
        echo "${ONNXRUNTIME_SHA256}  /tmp/ort.tgz" | sha256sum -c -; \
        tar -C /tmp -xzf /tmp/ort.tgz --no-same-owner; \
        ORT="/tmp/onnxruntime-linux-aarch64-${ONNXRUNTIME_VERSION}"; \
        gcc -c -fPIC -O2 "$TEN_VAD/src/fftw.c" -o /tmp/fftw.o; \
        g++ -shared -fPIC -O2 -std=c++17 -fvisibility=hidden \
            -I"$TEN_VAD/include" -I"$ORT/include" \
            "$TEN_VAD"/src/*.cc /tmp/fftw.o \
            -L"$ORT/lib" -lonnxruntime -Wl,-rpath,'$ORIGIN' \
            -o /out/libten_vad.so; \
        cp -L "$ORT/lib/libonnxruntime.so.1" /out/; \
        mkdir -p /out/onnx_model; \
        cp "$TEN_VAD/src/onnx_model/ten-vad.onnx" /out/onnx_model/ \
        ;; \
    *) \
        echo "unsupported architecture for TEN VAD: $TARGETARCH"; exit 1 \
        ;; \
    esac

# ---------------------------------------------------------------- -----
# Stage 3: build MP4Box (GPAC + a demux-only FFmpeg) for the export
# ---------------------------------------------------------------- -----
# The owner export (/session/{sessionId}/export?type=raw) authors its
# MP4 through the MP4Box CLI (GPAC >= 2.2), which reads the recorded
# Matroska media through FFmpeg - GPAC has no Matroska support of its
# own. Neither is in the Ubuntu archives anymore (gpac was removed
# from Debian in 2024, orphaned with open CVEs, and every Ubuntu
# release after 24.04 inherited the removal), so both build here from
# the pinned sources. Only the finished MP4Box binary travels into the
# runtime image: GPAC links itself and the demux-only FFmpeg
# statically into that one binary, so its dynamic dependencies are
# just zlib and the libc family (libm rides along with libc). No
# other -dev packages are installed in this stage on purpose -
# configure then finds nothing beyond zlib to link, which keeps the
# build reproducible and the binary small.
# The smoke check at the end of the stage runs the installed binary and
# requires its filter registry to load the FFmpeg demuxer (the ffdmx
# entry) - the module every export's .mkv read goes through. (There is
# no empty-file round-trip to smoke: in current GPAC, MP4Box -new
# without media to import writes no file at all.)
# The FFmpeg flags ride the configure line twice, each part load-bearing
# where nothing else reaches them. --extra-ff-ldflags backs configure's
# own --use-ffmpeg probe: GPAC's built-in order lists -lavcodec before
# -lavformat, but static libavformat's members call back into
# libavcodec, so the probe program only links with the full ordered
# list appended. --extra-libs lands the libraries on every
# application's final link line after the gpac archive: static.mak
# appends the FFmpeg libs before -lgpac_static, and applications/gpac
# (unlike applications/mp4box, which re-appends them after) would
# otherwise link with every FFmpeg symbol undefined - ld scans archives
# left to right, once, so the -l set must also appear after the gpac
# archive. -Wl,--start-group makes the order inside the group
# irrelevant: FFmpeg's static libraries reference one another
# (libavformat into libavcodec, and libavfilter into swscale in fuller
# builds than this demux-only one), and which members the linker pulls
# varies with version and configuration, so a flat hand-ordered list
# is one FFmpeg bump away from this same failure. The -L/ffmpeg/lib
# riding the same flag keeps configure's remaining probes resolvable:
# the IPv6 and poll checks link with these libraries, and ld fails on
# any -l it cannot locate even when nothing references it - without
# that -L both probes would fail and silently disable their features.
FROM ${UBUNTU_IMAGE} AS mp4box
ARG FFMPEG_VERSION
ARG FFMPEG_SHA256
ARG GPAC_COMMIT
ARG GPAC_SHA256
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates curl gcc g++ make zlib1g-dev; \
    curl -fsSL -o /tmp/ffmpeg.tgz \
        "https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/${FFMPEG_VERSION}"; \
    echo "${FFMPEG_SHA256}  /tmp/ffmpeg.tgz" | sha256sum -c -; \
    tar -C /tmp -xzf /tmp/ffmpeg.tgz --no-same-owner; \
    cd "/tmp/FFmpeg-${FFMPEG_VERSION}"; \
    ./configure --disable-everything --disable-programs --disable-doc \
        --disable-network --disable-autodetect --disable-x86asm \
        --enable-demuxer=matroska \
        --enable-parser=h264,hevc,vp8,vp9,av1,opus,aac \
        --enable-protocol=file --enable-zlib \
        --enable-static --disable-shared --prefix=/ffmpeg; \
    make -j"$(nproc)"; \
    make install; \
    cd /tmp; \
    curl -fsSL -o /tmp/gpac.tgz \
        "https://codeload.github.com/gpac/gpac/tar.gz/${GPAC_COMMIT}"; \
    echo "${GPAC_SHA256}  /tmp/gpac.tgz" | sha256sum -c -; \
    tar -C /tmp -xzf /tmp/gpac.tgz --no-same-owner; \
    cd "/tmp/gpac-${GPAC_COMMIT}"; \
    ./configure --static-build --use-ffmpeg=/ffmpeg --use-zlib=system \
        --extra-ff-ldflags="-lavformat -lavcodec -lavutil -lswscale -lswresample -lavdevice -lavfilter -lz -lm -lpthread" \
        --extra-libs="-L/ffmpeg/lib -Wl,--start-group -lavformat -lavcodec -lavutil -lswscale -lswresample -lavdevice -lavfilter -Wl,--end-group -lz -lm -lpthread" \
        --prefix=/usr/local; \
    make -j"$(nproc)"; \
    make install DESTDIR=/stage; \
    /stage/usr/local/bin/MP4Box -version | head -1; \
    /stage/usr/local/bin/MP4Box -hx ffdmx | grep -q 'see filter ffdmx'

# ---------------------------------------------------------------- -----
# Stage 4: runtime image
# ---------------------------------------------------------------- -----
FROM ${TEMURIN_IMAGE}

# GStreamer runtime, the plugin sets and the libnice plugin required
# by the self-test, and LLVM's libc++ (the x86-64 TEN VAD prebuilt is
# linked against libc++, not libstdc++; the arm64 build uses libstdc++
# which is already part of the base image). gstreamer1.0-nice ships
# the 'nice' plugin webrtcbin needs for ICE connectivity - Ubuntu
# packages it separately from the plugin sets (it is not part of
# plugins-bad), and without it every WebRTC ingest negotiation fails.
# zlib1g is the one package MP4Box (copied in below) needs beyond the
# libc family the base image already ships: the binary's NEEDED set is
# libc.so.6, libm.so.6 (both from libc6) and libz.so.1, nothing else.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        libgstreamer1.0-0 \
        gstreamer1.0-plugins-base \
        gstreamer1.0-plugins-good \
        gstreamer1.0-plugins-bad \
        gstreamer1.0-nice \
        zlib1g; \
    apt-get install -y --no-install-recommends libc++1 libc++abi1 \
        || apt-get install -y --no-install-recommends \
               "$(apt-cache pkgnames libc++1- | sort -V | tail -1)" \
               "$(apt-cache pkgnames libc++abi1- | sort -V | tail -1)"; \
    rm -rf /var/lib/apt/lists/*

# TEN VAD library; on arm64 also onnxruntime and the VAD model
# (the model is loaded relative to the working directory, hence /app)
COPY --from=tenvad /out/ /stage/
RUN set -eux; \
    mv /stage/libten_vad.so /usr/local/lib/; \
    if [ -f /stage/libonnxruntime.so.1 ]; then \
        mv /stage/libonnxruntime.so.1 /usr/local/lib/; \
    fi; \
    mkdir -p /app/onnx_model; \
    if [ -f /stage/onnx_model/ten-vad.onnx ]; then \
        mv /stage/onnx_model/ten-vad.onnx /app/onnx_model/; \
    fi; \
    rm -rf /stage; \
    ldconfig

# MP4Box for the owner export, built by the mp4box stage above (zlib1g
# from the apt install is its one dynamic dependency beyond libc)
COPY --from=mp4box /stage/usr/local/bin/MP4Box /usr/local/bin/MP4Box

WORKDIR /app
COPY --from=server-builder /build/target/SessionHistoryServer-*.jar app.jar

# Sessions are recorded under /app/sessions - mount it to keep them
EXPOSE 3001
CMD ["java", "-jar", "app.jar"]
