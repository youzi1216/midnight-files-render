# ============================================================
# Midnight Files Render Server
# Node.js + FFmpeg + FFprobe + Traditional Chinese Fonts
# ============================================================

FROM node:20-bookworm-slim

# ------------------------------------------------------------
# Install FFmpeg / FFprobe / Chinese fonts
# ------------------------------------------------------------

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        fonts-noto-cjk \
        fontconfig \
        ca-certificates \
    && fc-cache -f -v \
    && rm -rf /var/lib/apt/lists/*

# ------------------------------------------------------------
# Application directory
# ------------------------------------------------------------

WORKDIR /app

# ------------------------------------------------------------
# Install Node dependencies first
# ------------------------------------------------------------

COPY package*.json ./

RUN npm install --omit=dev

# ------------------------------------------------------------
# Copy application
# ------------------------------------------------------------

COPY . .

# ------------------------------------------------------------
# Runtime
# ------------------------------------------------------------

ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "start"]
