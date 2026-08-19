# ── Builder stage: install arduino-cli + the AVR core here only ────────────
# curl/tar live in this throwaway stage so the final image never needs to
# `apk del` them — that used to fail on some build hosts (busybox trigger
# script errors under cross-arch/QEMU builds: "execve: No such file or
# directory" on `busybox-*.trigger`). Not deleting packages sidesteps it.
FROM node:20-alpine AS builder

RUN apk add --no-cache curl tar

# arduino-cli is a static Go binary with no toolchain of its own; the actual
# avr-gcc etc. comes from `arduino-cli core install arduino:avr`, downloaded
# into /root/.arduino15. Both get copied into the final image below so cold
# starts don't re-download it. This is the one addition that makes
# compileController.js work — if this layer is ever stripped for a slim
# build, that endpoint fails closed with a 503 (see compileController.js)
# instead of crashing.
RUN curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | sh -s -- v1.0.4 \
    && mv bin/arduino-cli /usr/local/bin/arduino-cli \
    && rm -rf bin \
    && arduino-cli config init \
    && arduino-cli core update-index \
    && arduino-cli core install arduino:avr

# ── Final stage ──────────────────────────────────────────────────────────
FROM node:20-alpine

# tini for proper signal handling (prevents zombie processes). No curl/tar
# here — they were only ever needed to fetch arduino-cli in the builder.
RUN apk add --no-cache tini

# Pull in the arduino-cli binary + its AVR toolchain/config from the builder.
COPY --from=builder /usr/local/bin/arduino-cli /usr/local/bin/arduino-cli
COPY --from=builder /root/.arduino15 /root/.arduino15

WORKDIR /app

# Copy package files first (layer caching)
COPY package*.json ./

# Install production deps only
RUN npm install --omit=dev --prefer-offline && npm cache clean --force

# Copy source
COPY . .

# Run as non-root for security
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
USER nodejs

EXPOSE 3000

# Use tini as init to handle signals properly
ENTRYPOINT ["/sbin/tini", "--"]
# NOTE: raised from 200 to 400 — the 200MB ceiling was set while
# pdfController.js was reading entire large PDFs (up to 500MB) into memory
# synchronously just to hash them (see FIX comment in pdfController.js).
# That's now fixed with a streaming hash, so this limit no longer needs to
# be that tight. Adjust to match your actual Render plan's RAM if needed —
# this should stay comfortably under whatever the container's real memory
# limit is, so Node GCs proactively instead of the OS OOM-killing it.
CMD ["node", "--max-old-space-size=400", "src/server.js"]
