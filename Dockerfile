# ============================================
# STAGE 1: Build TypeScript + Generate Prisma
# ============================================
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
COPY prisma/ prisma/
COPY tsconfig.json ./

RUN npm ci

# Generar Prisma Client (tipos TypeScript)
RUN npx prisma generate

COPY src/ src/

RUN npm run build:server

# ============================================
# STAGE 2: Runtime
# ============================================
FROM node:20-slim

# Dependencias del sistema: ffmpeg, python/whisper, yt-dlp
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    ca-certificates \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# Whisper en venv aislado
RUN python3 -m venv /opt/whisper-venv \
    && /opt/whisper-venv/bin/pip install --no-cache-dir openai-whisper

# yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

ENV PATH="/opt/whisper-venv/bin:$PATH"

WORKDIR /app

# Solo producción
COPY package*.json ./
COPY prisma/ prisma/
RUN npm ci --omit=dev

# Regenerar Prisma Client en imagen runtime
RUN npx prisma generate

# Copiar build compilado
COPY --from=builder /app/dist/ dist/

# Assets
COPY public/ public/
COPY fonts/ fonts/

RUN mkdir -p output uploads

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -f http://localhost:3001/api/health || exit 1

# Prisma migrate deploy + start server
# (mismo patrón que alembic upgrade head en start.sh de ClinicForge)
CMD ["sh", "-c", "npx prisma migrate deploy && npx prisma db seed || true && node dist/server/index.js"]