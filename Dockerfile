# ============================================
# STAGE 1: Build
# ============================================
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
COPY tsconfig*.json ./
COPY drizzle.config.ts ./

RUN npm ci

COPY src/ src/
COPY index.html ./
COPY vite.config.ts ./
COPY postcss.config.js ./
COPY public/ public/

# Build client + server
RUN npm run build:client && npm run build:server

# Generate drizzle migrations
RUN npx drizzle-kit generate

# ============================================
# STAGE 2: Runtime
# ============================================
FROM node:20-slim

# System deps: ffmpeg + yt-dlp (no Python/Whisper needed — using OpenAI API)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    ca-certificates \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp binary
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# Production deps only
COPY package*.json ./
RUN npm ci --omit=dev

# Compiled output from builder
COPY --from=builder /app/dist/ dist/

# Drizzle migrations
COPY --from=builder /app/drizzle/ drizzle/

# Static assets
COPY public/ public/

RUN mkdir -p output uploads

ENV NODE_ENV=production

EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -f http://localhost:${PORT:-10000}/api/health || exit 1

CMD ["node", "dist/server/index.js"]
