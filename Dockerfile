# ============================================================
# Midnight Files Render Server
# Node.js + FFmpeg + FFprobe + ASS/libass + Traditional Chinese
# ============================================================

FROM node:20-bookworm-slim

# ------------------------------------------------------------
# Install FFmpeg / FFprobe / CJK fonts / fontconfig
# ------------------------------------------------------------

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        fonts-noto-cjk \
        fontconfig \
        ca-certificates \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

# ------------------------------------------------------------
# Application directory
# ------------------------------------------------------------

WORKDIR /app

# ------------------------------------------------------------
# Install Node dependencies
# ------------------------------------------------------------

COPY package*.json ./

RUN npm install --omit=dev

# ------------------------------------------------------------
# Copy application source
# ------------------------------------------------------------

COPY . .

# ------------------------------------------------------------
# Runtime
# ------------------------------------------------------------

ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "start"]
